import { createPublicKey, verify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from '../db/database.js';
import { authMembersTable, authOrganizationsTable, authUsersTable, contractFundingTable, contractMoneyLogTable, moneyChangesTable, nodesTable, organizationsTable, runsTable, topUpsTable } from '../db/schema.js';
import type { OperationError } from '../errors.js';
import type { OrganizationService } from '../organizations.js';
import { accounts, adjustOrganization, postLedgerTransaction } from '../ledger.js';
import { ApiClientService } from '../runs/clients.js';
import { RunTokenSigner } from '../runs/tokens.js';
import { createService, type Service } from '../service.js';
import {
    createTestDatabase, generateNodeKeys, ledgerProblems, type NodeKeys, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations, signedContractVoucher, APPLY_BEFORE_VERIFYING } from '../testing.js';
import { type ContractRef, moneyReadPayload, payFee, type RandomRead, randomValuePayload } from './moneyService.js';

const COURIER = 'org_courier';
const ARBITER = 'org_arbiter';
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_SOURCE = 'payable contract com.example.Job(action: string): string { return action }';
const MARKET_SOURCE = 'payable contract com.example.Market(action: string): string { return action }';
const FEE_BPS = 100;

describe('MoneyService', () => {
    let db: Database;
    let close: () => Promise<void>;
    let service: Service;
    let organizations: OrganizationService;
    let provider: NodeKeys;
    let payer: NodeKeys;
    let job: ContractRef;
    let market: ContractRef;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        ({ organizations, provider, payer } = await seedOrganizations(db, 0));
        service = createService(db, { money: APPLY_BEFORE_VERIFYING, platformFeeBps: FEE_BPS, runTokenPrivateKey: generateNodeKeys().privateKey });
        await organizations.create('Courier', { id: COURIER });
        await organizations.setPayoutsEnabled(COURIER, true);
        await organizations.create('Arbiter', { id: ARBITER });
        // The payer topped up $100 today. The provider node hosts the contracts, and is listed at no price.
        await topUp(PAYER_ORGANIZATION, 100_000_000, new Date());
        await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, provider.publicKey));
        await organizations.setNodeMoneyLimits(provider.publicKey, { maxContractBalanceMicroUsd: 1_000_000_000 });
        await organizations.setNodeMoneyLimits(payer.publicKey, { maxApiKeyRunValueMicroUsd: 50_000_000, monthlyApiKeyValueCapMicroUsd: 200_000_000 });
        job = await register('com.example.Job', JOB_SOURCE);
        market = await register('com.example.Market', MARKET_SOURCE);
    });

    afterEach(async () => {
        expect(await ledgerProblems(db)).toEqual([]);
        await close();
    });

    const rejection = (promise: Promise<unknown>) => promise.then(
        () => { throw new Error('expected a rejection'); },
        (error: OperationError) => ({ status: error.statusCode, message: error.message }),
    );

    /** A succeeded top-up, credited through the ledger like a real one. */
    async function topUp(organizationId: string, amount: number, createdAt: Date) {
        await organizations.grantPromotion(organizationId, amount);
        await db.insert(topUpsTable).values({ organizationId, amountMicroUsd: amount, status: 'succeeded', createdAt });
    }

    async function register(name: string, source: string, version = '1'): Promise<ContractRef> {
        await service.money.register(provider.publicKey, { name, version, payable: true, source, requestscriptVersion: '1.8.0', dependencies: [] });
        return { nodePublicKey: provider.publicKey, name, version };
    }

    const local = (ref: ContractRef) => ({ name: ref.name, version: ref.version });

    async function organization(id: string) {
        const [row] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, id));
        return { balance: row!.balanceMicroUsd, held: row!.heldMicroUsd, payable: row!.payableMicroUsd };
    }

    async function contractBalance(ref: ContractRef) {
        return (await service.money.publicContract(ref))!.balanceMicroUsd;
    }

    async function treeOutcome(runId: string) {
        const [run] = await db.select().from(runsTable).where(eq(runsTable.runId, runId));
        return run!.treeOutcome;
    }

    /** A free root run on the payer's node, as an API-key script would open. */
    async function openRoot(node = payer) {
        const runId = crypto.randomUUID();
        await service.runs.open(node.publicKey, { runId });
        return runId;
    }

    /** A call from the root's script to a contract on the provider node: a contract run below the root. */
    async function contractRun(parentRunId: string, caller = payer) {
        const voucher = signedContractVoucher(caller, { runId: parentRunId });
        const authorization = await service.runs.authorizeContract(provider.publicKey, { voucher, source: 'contract com.example.Job(action: string): string { return action }' });
        expect(authorization.status).toBe('held');
        return voucher.invocationId;
    }

    async function attachFromScript(runId: string, amount: number, options: { to?: ContractRef, payees?: string[], callIndex?: number } = {}) {
        const attachmentId = crypto.randomUUID();
        await service.money.stage(payer.publicKey, {
            runId,
            callIndex: options.callIndex ?? 0,
            function: 'attach',
            parameters: { to: options.to ?? job, amount, attachmentId, payees: options.payees ?? [COURIER] },
        });
        return attachmentId;
    }

    const succeed = (node: NodeKeys, runId: string) => service.runs.capture(node.publicKey, { runId, tokens: 0 });

    /** The buyer funds a job with `amount`, earmarked `key`, in one applied tree. */
    async function fundJob(amount: number, key = 'job-1') {
        const root = await openRoot();
        const child = await contractRun(root);
        const attachmentId = await attachFromScript(root, amount);
        await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'earmark', parameters: { attachmentId, key } });
        await succeed(provider, child);
        await succeed(payer, root);
        expect(await treeOutcome(root)).toBe('applied');
    }

    /** A tree in which the provider node runs one of its contracts, called by the payer's script. */
    async function providerTree() {
        const root = await openRoot();
        const child = await contractRun(root);
        return { root, child };
    }

    describe('registration', () => {
        test('is idempotent, and a version never changes', async () => {
            const again = await service.money.register(provider.publicKey, { name: 'com.example.Job', version: '1', payable: true, source: JOB_SOURCE, requestscriptVersion: '1.8.0', dependencies: [] });
            expect(again.ownerOrganizationId).toBe(PROVIDER_ORGANIZATION);
            expect(await rejection(service.money.register(provider.publicKey, { name: 'com.example.Job', version: '1', payable: true, source: `${JOB_SOURCE} `, requestscriptVersion: '1.8.0', dependencies: [] })))
                .toMatchObject({ status: 409 });
        });

        test('takes its owner from the deploying client\'s run token', async () => {
            const signer = new RunTokenSigner(generateNodeKeys().privateKey);
            service = createService(db, { money: APPLY_BEFORE_VERIFYING, platformFeeBps: FEE_BPS, runTokenPrivateKey: undefined });
            const clients = new ApiClientService(db, signer);
            const { client } = await clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey });
            const { token } = await signer.sign({ clientId: client.id, organizationId: PAYER_ORGANIZATION, nodePublicKey: provider.publicKey });
            // The operator verifies tokens with its own key.
            expect(await rejection(service.money.register(provider.publicKey, { name: 'com.example.Tenant', version: '1', payable: true, source: 's', requestscriptVersion: '1.8.0', dependencies: [], token })))
                .toMatchObject({ status: 503 });
            const { MoneyService, DEFAULT_MONEY_POLICY } = await import('./moneyService.js');
            const money = new MoneyService(db, { ...DEFAULT_MONEY_POLICY, platformFeeBps: FEE_BPS }, signer);
            const contract = await money.register(provider.publicKey, { name: 'com.example.Tenant', version: '1', payable: true, source: 's', requestscriptVersion: '1.8.0', dependencies: [], token });
            expect(contract.ownerOrganizationId).toBe(PAYER_ORGANIZATION);
        });

        test('refuses payable contracts named as escrow or deposit accounts', async () => {
            expect(await rejection(register('com.example.JobEscrow', JOB_SOURCE))).toMatchObject({ status: 422 });
            expect(await rejection(register('com.example.Deposit', JOB_SOURCE))).toMatchObject({ status: 422 });
        });

        test('publishes source, owner and balance, and the log without funders', async () => {
            await fundJob(20_000_000);
            const published = await service.money.publicContract(job);
            expect(published).toMatchObject({ name: 'com.example.Job', version: '1', source: JOB_SOURCE, ownerOrganizationId: PROVIDER_ORGANIZATION, hostOrganizationId: PROVIDER_ORGANIZATION, balanceMicroUsd: 20_000_000 });
            expect(published!.log).toEqual([{ kind: 'inflow', amountMicroUsd: 20_000_000, createdAt: expect.any(Date) }]);
        });
    });

    describe('attaching money from a request script', () => {
        test('holds it on the payer until the tree applies, then funds the contract', async () => {
            const root = await openRoot();
            await attachFromScript(root, 20_000_000);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000, held: 20_000_000 });
            expect(await contractBalance(job)).toBe(0);

            await succeed(payer, root);
            expect(await treeOutcome(root)).toBe('applied');
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 80_000_000, held: 0 });
            expect(await contractBalance(job)).toBe(20_000_000);
        });

        test('drops it when the root is released', async () => {
            const root = await openRoot();
            await attachFromScript(root, 20_000_000);
            await service.runs.release(payer.publicKey, { runId: root });
            expect(await treeOutcome(root)).toBe('dropped');
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000, held: 0 });
            expect(await contractBalance(job)).toBe(0);
        });

        test('drops it when the root fails', async () => {
            const root = await openRoot();
            await attachFromScript(root, 20_000_000);
            await service.runs.capture(payer.publicKey, { runId: root, tokens: 0, failed: true });
            expect(await treeOutcome(root)).toBe('dropped');
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ held: 0 });
        });

        test('is staged once per run and call index', async () => {
            const root = await openRoot();
            const attachmentId = crypto.randomUUID();
            const request = { runId: root, callIndex: 0, function: 'attach' as const, parameters: { to: job, amount: 1_000_000, attachmentId, payees: [COURIER] } };
            await service.money.stage(payer.publicKey, request);
            await service.money.stage(payer.publicKey, request);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ held: 1_000_000 });
            expect(await rejection(service.money.stage(payer.publicKey, { ...request, parameters: { ...request.parameters, amount: 2_000_000 } })))
                .toMatchObject({ status: 409 });
            await succeed(payer, root);
        });

        test('needs payees, a payable contract and valid amounts', async () => {
            const root = await openRoot();
            expect(await rejection(attachFromScript(root, 1_000, { payees: [] }))).toMatchObject({ status: 422 });
            expect(await rejection(attachFromScript(root, 0))).toMatchObject({ status: 422 });
            expect(await rejection(attachFromScript(root, 1.5))).toMatchObject({ status: 422 });
            expect(await rejection(attachFromScript(root, -5))).toMatchObject({ status: 422 });
            await service.money.register(provider.publicKey, { name: 'com.example.Free', version: '1', payable: false, source: 'contract', requestscriptVersion: '1.8.0', dependencies: [] });
            expect(await rejection(attachFromScript(root, 1_000, { to: { ...job, name: 'com.example.Free' } }))).toMatchObject({ status: 422 });
            await succeed(payer, root);
        });

        test('spends only recent top-up credit', async () => {
            await db.delete(topUpsTable);
            await db.insert(topUpsTable).values({ organizationId: PAYER_ORGANIZATION, amountMicroUsd: 100_000_000, status: 'succeeded', createdAt: new Date(Date.now() - 8 * DAY_MS) });
            const root = await openRoot();
            expect(await rejection(attachFromScript(root, 1_000_000))).toMatchObject({ status: 402 });
            // A new top-up holds the newest credit.
            await topUp(PAYER_ORGANIZATION, 5_000_000, new Date());
            await attachFromScript(root, 5_000_000);
            expect(await rejection(attachFromScript(root, 1, { callIndex: 1 }))).toMatchObject({ status: 402 });
            await succeed(payer, root);
        });

        test('keeps to the node\'s API-key limits, which default to 0', async () => {
            const root = await openRoot();
            expect(await rejection(attachFromScript(root, 50_000_001))).toMatchObject({ status: 402 });
            await organizations.setNodeMoneyLimits(payer.publicKey, { maxApiKeyRunValueMicroUsd: 0 });
            expect(await rejection(attachFromScript(root, 1))).toMatchObject({ status: 402 });
            await succeed(payer, root);
        });

        test('keeps to the API client\'s value limit, which defaults to 0, and its monthly cap', async () => {
            const signer = new RunTokenSigner(generateNodeKeys().privateKey);
            service = createService(db, { money: APPLY_BEFORE_VERIFYING, platformFeeBps: FEE_BPS, runTokenPrivateKey: undefined });
            const { RunService } = await import('../runs/runService.js');
            const { PaymentService } = await import('../payments/paymentService.js');
            const { MoneyService, DEFAULT_MONEY_POLICY } = await import('./moneyService.js');
            const clients = new ApiClientService(db, signer);
            const runs = new RunService(db, organizations, clients, new PaymentService(db, organizations, { platformFeeBps: FEE_BPS }), signer);
            const money = new MoneyService(db, { ...DEFAULT_MONEY_POLICY, platformFeeBps: FEE_BPS }, signer);
            runs.settlement = money;
            // The payer's client runs scripts on the provider's listed node.
            const { client } = await clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey, maxRunCostMicroUsd: 1_000, monthlyCapMicroUsd: 10_000_000 });
            const token = async () => (await signer.sign({ clientId: client.id, organizationId: PAYER_ORGANIZATION, nodePublicKey: provider.publicKey })).token;
            const attach = (runId: string, amount: number) => money.stage(provider.publicKey, {
                runId, callIndex: 0, function: 'attach', parameters: { to: job, amount, attachmentId: crypto.randomUUID(), payees: [COURIER] },
            });

            const first = crypto.randomUUID();
            await runs.authorize(provider.publicKey, { token: await token(), runId: first, source: 'request R { return 1 }' });
            expect(await rejection(attach(first, 1))).toMatchObject({ status: 402, message: expect.stringContaining('per run') });

            await clients.updateLimits(PAYER_ORGANIZATION, client.id, { maxRunValueMicroUsd: 8_000_000 });
            await attach(first, 8_000_000);
            await runs.capture(provider.publicKey, { runId: first, tokens: 0 });
            expect(await contractBalance(job)).toBe(8_000_000);

            // Attached money counts toward the monthly cap.
            const second = crypto.randomUUID();
            await runs.authorize(provider.publicKey, { token: await token(), runId: second, source: 'request R { return 1 }' });
            expect(await rejection(attach(second, 2_000_000))).toMatchObject({ status: 402, message: expect.stringContaining('monthly cap') });
            await runs.release(provider.publicKey, { runId: second });
        });

        test('keeps to the host node\'s contract balance limit, and each funder to a quarter of it', async () => {
            await organizations.setNodeMoneyLimits(provider.publicKey, { maxContractBalanceMicroUsd: 40_000_000 });
            const root = await openRoot();
            expect(await rejection(attachFromScript(root, 10_000_001))).toMatchObject({ status: 402, message: expect.stringContaining('quarter') });
            await attachFromScript(root, 10_000_000);
            await succeed(payer, root);

            await organizations.setNodeMoneyLimits(provider.publicKey, { maxContractBalanceMicroUsd: 0 });
            const next = await openRoot();
            expect(await rejection(attachFromScript(next, 1))).toMatchObject({ status: 402 });
            await succeed(payer, next);
        });
    });

    describe('spending', () => {
        test('pays a payee, less the fee rounded up, in the same tree that funded the contract', async () => {
            const { root, child } = await providerTree();
            const attachmentId = await attachFromScript(root, 1_000_001);
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'earmark', parameters: { attachmentId, key: 'job-1' } });
            const { result } = await service.money.stage(provider.publicKey, {
                runId: child, callIndex: 1, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 1_000_001, from: PAYER_ORGANIZATION, key: 'job-1' },
            });
            expect(result).toBe(0);
            await succeed(provider, child);
            await succeed(payer, root);

            const fee = payFee(1_000_001, FEE_BPS);
            expect(fee).toBe(10_001);
            expect(await organization(COURIER)).toMatchObject({ payable: 1_000_001 - fee });
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000 - 1_000_001, held: 0 });
            expect(await contractBalance(job)).toBe(0);
        });

        test('pays only the funding\'s payees, and only what the funder\'s key holds', async () => {
            await fundJob(20_000_000);
            const { root, child } = await providerTree();
            const pay = (callIndex: number, parameters: { to: string, amount: number, from: string, key?: string | null }) =>
                service.money.stage(provider.publicKey, { runId: child, callIndex, contract: local(job), function: 'pay', parameters });
            await organizations.setPayoutsEnabled(ARBITER, true);
            expect(await rejection(pay(0, { to: ARBITER, amount: 1, from: PAYER_ORGANIZATION, key: 'job-1' }))).toMatchObject({ status: 422, message: expect.stringContaining('payees') });
            expect(await rejection(pay(1, { to: COURIER, amount: 20_000_001, from: PAYER_ORGANIZATION, key: 'job-1' }))).toMatchObject({ status: 422 });
            // Unearmarked funding is a different key.
            expect(await rejection(pay(2, { to: COURIER, amount: 1, from: PAYER_ORGANIZATION }))).toMatchObject({ status: 422 });
            expect(await pay(3, { to: COURIER, amount: 15_000_000, from: PAYER_ORGANIZATION, key: 'job-1' })).toEqual({ result: 5_000_000 });
            // The tree sees its own staged spending.
            expect(await rejection(pay(4, { to: COURIER, amount: 5_000_001, from: PAYER_ORGANIZATION, key: 'job-1' }))).toMatchObject({ status: 422 });
            await succeed(provider, child);
            await succeed(payer, root);
            expect(await contractBalance(job)).toBe(5_000_000);
        });

        test('tryPay pays nothing to an organization that can\'t receive payouts, and pay refuses', async () => {
            await fundJob(20_000_000);
            await organizations.setPayoutsEnabled(COURIER, false);
            const { root, child } = await providerTree();
            const parameters = { to: COURIER, amount: 1_000_000, from: PAYER_ORGANIZATION, key: 'job-1' };
            expect(await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { ...parameters, try: true } }))
                .toEqual({ result: false });
            expect(await rejection(service.money.stage(provider.publicKey, { runId: child, callIndex: 1, contract: local(job), function: 'pay', parameters })))
                .toMatchObject({ status: 422 });
            await succeed(provider, child);
            await succeed(payer, root);
            expect(await contractBalance(job)).toBe(20_000_000);
        });

        test('only the host node stages changes on a contract\'s account', async () => {
            await fundJob(20_000_000);
            const root = await openRoot();
            expect(await rejection(service.money.stage(payer.publicKey, {
                runId: root, callIndex: 0, contract: local(job), function: 'refund', parameters: { to: PAYER_ORGANIZATION, amount: 1, key: 'job-1' },
            }))).toMatchObject({ status: 404 });
            expect(await rejection(service.money.stage(payer.publicKey, {
                runId: (await providerTree()).child, callIndex: 0, contract: local(job), function: 'refund', parameters: { to: PAYER_ORGANIZATION, amount: 1 },
            }))).toMatchObject({ status: 403 });
            await succeed(payer, root);
        });

        test('a failed contract run drops its changes, and the rest of the tree applies', async () => {
            await fundJob(20_000_000);
            const root = await openRoot();
            const failing = await contractRun(root);
            const working = await contractRun(root);
            await service.money.stage(provider.publicKey, { runId: failing, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 20_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            await service.runs.capture(provider.publicKey, { runId: failing, tokens: 0, failed: true });
            // Its lock is gone, so another run can spend the same funding.
            await service.money.stage(provider.publicKey, { runId: working, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 3_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            await succeed(provider, working);
            await succeed(payer, root);
            expect(await contractBalance(job)).toBe(17_000_000);
            const statuses = await db.select({ status: moneyChangesTable.status }).from(moneyChangesTable).where(eq(moneyChangesTable.rootRunId, (await db.select().from(runsTable).where(eq(runsTable.runId, root)))[0]!.id));
            expect(statuses.map(row => row.status).sort()).toEqual(['applied', 'dropped']);
        });

        test('earmarks the money attached to its call once', async () => {
            const { root, child } = await providerTree();
            const attachmentId = await attachFromScript(root, 1_000_000);
            const earmark = (callIndex: number, key: string) => service.money.stage(provider.publicKey, { runId: child, callIndex, contract: local(job), function: 'earmark', parameters: { attachmentId, key } });
            await earmark(0, 'a');
            expect(await rejection(earmark(1, 'b'))).toMatchObject({ status: 422 });
            expect(await rejection(service.money.stage(provider.publicKey, { runId: child, callIndex: 2, contract: local(job), function: 'earmark', parameters: { attachmentId: crypto.randomUUID(), key: 'c' } })))
                .toMatchObject({ status: 422 });
            await succeed(provider, child);
            await succeed(payer, root);
        });
    });

    describe('contracts sending money to contracts', () => {
        /** The buyer funds the marketplace, which passes 6 of its 10 on to a job, narrowing payees to the courier. */
        async function marketFundsJob() {
            const root = await openRoot();
            const marketRun = await contractRun(root);
            await attachFromScript(root, 10_000_000, { to: market, payees: [COURIER, ARBITER] });
            await service.money.stage(provider.publicKey, {
                runId: marketRun, callIndex: 0, contract: local(market), function: 'attach',
                parameters: { to: job, amount: 6_000_000, attachmentId: crypto.randomUUID(), from: PAYER_ORGANIZATION, payees: [COURIER] },
            });
            await succeed(provider, marketRun);
            await succeed(payer, root);
        }

        test('keep their funder, payees or fewer, and time', async () => {
            await marketFundsJob();
            expect(await contractBalance(market)).toBe(4_000_000);
            expect(await contractBalance(job)).toBe(6_000_000);
            const jobFunding = await db.select().from(contractFundingTable).where(eq(contractFundingTable.status, 'active'));
            const [inJob] = jobFunding.filter(lot => lot.amountMicroUsd === 6_000_000);
            const [inMarket] = jobFunding.filter(lot => lot.amountMicroUsd === 4_000_000);
            expect(inJob).toMatchObject({ funderOrganizationId: PAYER_ORGANIZATION, payees: [COURIER], sourceFundingId: inMarket!.id });
            expect(inJob!.fundedAt).toEqual(inMarket!.fundedAt);
        });

        test('can only narrow payees', async () => {
            const root = await openRoot();
            const marketRun = await contractRun(root);
            await attachFromScript(root, 10_000_000, { to: market, payees: [COURIER] });
            expect(await rejection(service.money.stage(provider.publicKey, {
                runId: marketRun, callIndex: 0, contract: local(market), function: 'attach',
                parameters: { to: job, amount: 1, attachmentId: crypto.randomUUID(), from: PAYER_ORGANIZATION, payees: [ARBITER] },
            }))).toMatchObject({ status: 422, message: expect.stringContaining('narrow') });
            await succeed(provider, marketRun);
            await succeed(payer, root);
        });

        test('refunds go one step back, into the sending contract', async () => {
            await marketFundsJob();
            const { root, child } = await providerTree();
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'refund', parameters: { to: PAYER_ORGANIZATION, amount: 6_000_000 } });
            await succeed(provider, child);
            await succeed(payer, root);
            expect(await contractBalance(job)).toBe(0);
            expect(await contractBalance(market)).toBe(10_000_000);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 90_000_000 });
            // The marketplace refunds the buyer itself.
            const next = await providerTree();
            await service.money.stage(provider.publicKey, { runId: next.child, callIndex: 0, contract: local(market), function: 'refund', parameters: { to: PAYER_ORGANIZATION, amount: 10_000_000 } });
            await succeed(provider, next.child);
            await succeed(payer, next.root);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000 });
        });
    });

    describe('settling trees', () => {
        test('waits for a run that staged changes and hasn\'t settled, then applies', async () => {
            await fundJob(20_000_000);
            const { root, child } = await providerTree();
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 1_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            await succeed(payer, root);
            expect(await treeOutcome(root)).toBe('pending');
            expect(await service.money.outcome(payer.publicKey, root)).toEqual({ outcome: 'pending' });
            await succeed(provider, child);
            expect(await treeOutcome(root)).toBe('applied');
            expect(await service.money.outcome(provider.publicKey, child)).toEqual({ outcome: 'applied' });
            expect(await contractBalance(job)).toBe(19_000_000);
        });

        test('drops a slow run\'s changes after the deadline, and applies the rest', async () => {
            await fundJob(20_000_000);
            const root = await openRoot();
            const slow = await contractRun(root);
            const quick = await contractRun(root);
            await service.money.stage(provider.publicKey, { runId: slow, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 1_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            await service.money.stage(provider.publicKey, { runId: quick, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 2_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            await succeed(provider, quick);
            await succeed(payer, root);
            expect(await treeOutcome(root)).toBe('pending');
            expect(await service.money.settleTrees(new Date(Date.now() + 10 * 60 * 1000))).toBe(1);
            expect(await treeOutcome(root)).toBe('applied');
            expect(await contractBalance(job)).toBe(18_000_000);
            // Too late: the slow run's capture changes nothing.
            await succeed(provider, slow);
            expect(await contractBalance(job)).toBe(18_000_000);
        });

        test('drops the whole tree when a failed run created funding others spent', async () => {
            const root = await openRoot();
            const marketRun = await contractRun(root);
            const jobRun = await contractRun(root);
            await attachFromScript(root, 10_000_000, { to: market });
            const attachmentId = crypto.randomUUID();
            await service.money.stage(provider.publicKey, {
                runId: marketRun, callIndex: 0, contract: local(market), function: 'attach', parameters: { to: job, amount: 5_000_000, attachmentId, from: PAYER_ORGANIZATION },
            });
            await service.money.stage(provider.publicKey, { runId: jobRun, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 5_000_000, from: PAYER_ORGANIZATION } });
            await succeed(provider, jobRun);
            await service.runs.capture(provider.publicKey, { runId: marketRun, tokens: 0, failed: true });
            expect(await treeOutcome(root)).toBe('dropped');
            expect(await rejection(attachFromScript(root, 1, { callIndex: 9 }))).toMatchObject({ status: 409 });
            await succeed(payer, root);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000, held: 0 });
            expect(await organization(COURIER)).toMatchObject({ payable: 0 });
        });

        test('settles roots a crash left undecided', async () => {
            const root = await openRoot();
            await attachFromScript(root, 1_000_000);
            const runs = service.runs;
            runs.settlement = undefined;
            await succeed(payer, root);
            expect(await treeOutcome(root)).toBeNull();
            expect(await service.money.settleTrees()).toBeGreaterThanOrEqual(1);
            expect(await treeOutcome(root)).toBe('applied');
            runs.settlement = service.money;
        });
    });

    describe('reads', () => {
        test('include the tree\'s staged changes, and are signed by the operator', async () => {
            await fundJob(20_000_000);
            const { root, child } = await providerTree();
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 1_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            const read = await service.money.read(provider.publicKey, { runId: child, callIndex: 1, contract: local(job), function: 'fundingOf', parameters: { org: PAYER_ORGANIZATION, key: 'job-1' } });
            expect(read.response).toBe(19_000_000);
            const payload = moneyReadPayload({ runId: child, callIndex: 1, function: 'fundingOf', parameters: { org: PAYER_ORGANIZATION, key: 'job-1' }, response: read.response, signedAt: read.signedAt });
            const key = createPublicKey({ key: Buffer.from(read.publicKey, 'base64url'), format: 'der', type: 'spki' });
            expect(verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(read.signature, 'base64url'))).toBe(true);
            expect((await service.money.read(provider.publicKey, { runId: child, callIndex: 2, contract: local(job), function: 'balance', parameters: {} })).response).toBe(19_000_000);
            expect((await service.money.read(provider.publicKey, { runId: child, callIndex: 3, contract: local(job), function: 'canReceive', parameters: { org: ARBITER } })).response).toBe(false);
            await succeed(provider, child);
            await succeed(payer, root);
        });
    });

    describe('randomness', () => {
        const request = (runId: string, key: string, callIndex = 0) => service.money.stage(provider.publicKey, { runId, callIndex, contract: local(job), function: 'random_request', parameters: { key } });
        const value = (runId: string, key: string, callIndex = 1) => service.money.read(provider.publicKey, { runId, callIndex, contract: local(job), function: 'random', parameters: { key } });

        test('a value is drawn once its request\'s tree applies, signed for the contract and key', async () => {
            const first = await providerTree();
            await request(first.child, 'draw-1');
            // Not drawn while the request's tree is undecided, so the run can't read and retry.
            expect(await rejection(value(first.child, 'draw-1'))).toMatchObject({ status: 404 });
            await succeed(provider, first.child);
            await succeed(payer, first.root);
            expect(await treeOutcome(first.root)).toBe('applied');

            const later = await providerTree();
            const read = await value(later.child, 'draw-1', 0);
            const drawn = read.response as RandomRead;
            expect(drawn.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const key = createPublicKey({ key: Buffer.from(read.publicKey, 'base64url'), format: 'der', type: 'spki' });
            const payload = randomValuePayload({ nodePublicKey: provider.publicKey, name: job.name, version: job.version, key: 'draw-1', value: drawn.value });
            expect(verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(drawn.signature, 'base64url'))).toBe(true);
            // Each key is requested once, so a contract can't redraw.
            expect(await rejection(request(later.child, 'draw-1', 1))).toMatchObject({ status: 409 });
            await succeed(provider, later.child);
            await succeed(payer, later.root);
        });

        test('a failed run\'s request draws nothing, and the key can be requested again', async () => {
            const { root, child } = await providerTree();
            await request(child, 'draw-2');
            await service.runs.capture(provider.publicKey, { runId: child, tokens: 0, failed: true });
            await succeed(payer, root);
            expect(await treeOutcome(root)).toBe('applied');
            const again = await providerTree();
            expect(await rejection(value(again.child, 'draw-2', 0))).toMatchObject({ status: 404 });
            await request(again.child, 'draw-2', 1);
            await succeed(provider, again.child);
            await succeed(payer, again.root);
            expect(await treeOutcome(again.root)).toBe('applied');
        });
    });

    describe('verifying before money moves', () => {
        /** A tree in which the buyer funds Job, which earmarks it: a change only a replay can vouch for. */
        async function fundedTree() {
            const root = await openRoot();
            const child = await contractRun(root);
            const attachmentId = await attachFromScript(root, 20_000_000);
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'earmark', parameters: { attachmentId, key: 'job-1' } });
            await succeed(provider, child);
            await succeed(payer, root);
            const [row] = await db.select().from(runsTable).where(eq(runsTable.runId, root));
            return { root, rootId: row!.id };
        }

        test('by default, a tree whose contracts moved money waits for verification, and moves then', async () => {
            service = createService(db, { platformFeeBps: FEE_BPS, runTokenPrivateKey: generateNodeKeys().privateKey });
            const { root, rootId } = await fundedTree();
            expect(await treeOutcome(root)).toBe('verifying');
            expect(await service.money.outcome(payer.publicKey, root)).toEqual({ outcome: 'pending' });
            expect(await contractBalance(job)).toBe(0);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000, held: 20_000_000 });

            await service.money.applyVerified(rootId);
            expect(await treeOutcome(root)).toBe('applied');
            expect(await contractBalance(job)).toBe(20_000_000);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 80_000_000, held: 0 });
        });

        test('a tree found fraudulent before it moved is dropped, and moves nothing', async () => {
            service = createService(db, { platformFeeBps: FEE_BPS, runTokenPrivateKey: generateNodeKeys().privateKey });
            const { root, rootId } = await fundedTree();
            await service.money.dropUnverified(rootId);
            expect(await treeOutcome(root)).toBe('dropped');
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000, held: 0 });
        });

        test('a small tree applies first, until its host has enough applied unverified', async () => {
            service = createService(db, { platformFeeBps: FEE_BPS, runTokenPrivateKey: generateNodeKeys().privateKey, money: { optimisticVerifyLimitMicroUsd: 50_000_000, maxUnverifiedMicroUsdPerNode: 30_000_000 } });
            // Earmarking moves nothing, so funding applies first.
            await fundJob(20_000_000, 'job-1');
            await fundJob(20_000_000, 'job-2');
            const release = async (key: string) => {
                const { root, child } = await providerTree();
                await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 20_000_000, from: PAYER_ORGANIZATION, key } });
                await succeed(provider, child);
                await succeed(payer, root);
                return root;
            };
            expect(await treeOutcome(await release('job-1'))).toBe('applied');
            // Another 20,000,000 would take the host's applied, unverified payments past 30,000,000.
            expect(await treeOutcome(await release('job-2'))).toBe('verifying');
        });
    });

    test('fraud returns the buyer everything: from the payee\'s credit, then the fraudster, then the platform as a debt', async () => {
        await fundJob(20_000_000);
        const { root, child } = await providerTree();
        await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 20_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
        await succeed(provider, child);
        await succeed(payer, root);
        // 20,000,000 less the 1% fee was credited. Say 15,000,000 of it already left in a payout.
        await db.transaction(async (tx) => {
            await postLedgerTransaction(tx, 'payout', [{ account: accounts.payable(COURIER), amountMicroUsd: -15_000_000 }, { account: accounts.payouts, amountMicroUsd: 15_000_000 }]);
            await adjustOrganization(tx, COURIER, { payable: -15_000_000 });
        });
        // The host's organization has 5,000,000 of its own.
        await organizations.grantPromotion(PROVIDER_ORGANIZATION, 5_000_000);
        const [row] = await db.select().from(runsTable).where(eq(runsTable.runId, root));

        await service.fraud.recordFraud(row!.id, provider.publicKey, 'test', 'proof', 'operator');
        expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000 });
        expect(await organization(COURIER)).toMatchObject({ payable: 0 });
        expect(await organization(PROVIDER_ORGANIZATION)).toMatchObject({ balance: 0 });
        const [fraudCase] = await service.governance.fraudCases();
        // The courier still held 4,800,000; the host gave 5,000,000; the platform covered the 10,000,000 left, and its 200,000 fee.
        expect(fraudCase).toMatchObject({ reversedMicroUsd: 20_000_000, recoveredMicroUsd: 5_000_000, shortfallMicroUsd: 10_000_000 });
    });

    describe('card-fraud limits', () => {
        const withPolicy = (money: Record<string, number>) => {
            service = createService(db, { money: { ...APPLY_BEFORE_VERIFYING, ...money }, platformFeeBps: FEE_BPS, runTokenPrivateKey: generateNodeKeys().privateKey });
        };

        test('a contract takes changes from a limited number of unsettled trees', async () => {
            withPolicy({ maxPendingMoneyRunsPerContract: 1 });
            const first = await openRoot();
            await attachFromScript(first, 1_000_000);
            const second = await openRoot();
            expect(await rejection(attachFromScript(second, 1_000_000))).toMatchObject({ status: 429 });
            await succeed(payer, first);
            await attachFromScript(second, 1_000_000);
            await succeed(payer, second);
        });

        test('a payer attaches up to its limit, which rises with its payment history', async () => {
            withPolicy({ attachLimitBaseMicroUsd: 10_000_000 });
            const root = await openRoot();
            expect(await rejection(attachFromScript(root, 10_000_001))).toMatchObject({ status: 402, message: expect.stringContaining('payment history') });
            // A top-up older than the window counts as history.
            await topUp(PAYER_ORGANIZATION, 5_000_000, new Date(Date.now() - 40 * DAY_MS));
            await attachFromScript(root, 15_000_000);
            await succeed(payer, root);
        });

        test('attaching past the monthly threshold needs the payer\'s identity verified', async () => {
            withPolicy({ payerKycThresholdMicroUsd: 5_000_000 });
            const root = await openRoot();
            expect(await rejection(attachFromScript(root, 6_000_000))).toMatchObject({ status: 402, message: expect.stringContaining('identity') });
            await service.governance.propose('alice', 'verify_identity', { organizationId: PAYER_ORGANIZATION }, 'Checked their documents');
            await attachFromScript(root, 6_000_000);
            await succeed(payer, root);
        });

        test('an organization blocked for sanctions can\'t be paid', async () => {
            await fundJob(20_000_000);
            await service.governance.propose('alice', 'block_sanctions', { organizationId: COURIER }, 'Screening match');
            const { root, child } = await providerTree();
            const pay = { to: COURIER, amount: 1_000_000, from: PAYER_ORGANIZATION, key: 'job-1' };
            expect(await rejection(service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: pay }))).toMatchObject({ status: 422 });
            expect(await service.money.stage(provider.publicKey, { runId: child, callIndex: 1, contract: local(job), function: 'pay', parameters: { ...pay, try: true } })).toEqual({ result: false });
            await succeed(provider, child);
            await succeed(payer, root);
        });

        test('a payment between organizations that share a member is flagged, and holds the payee\'s payouts', async () => {
            // The buyer's and the courier's dashboard organizations share a user.
            await db.insert(authUsersTable).values({ id: 'user_shared', name: 'Shared', email: 'shared@acme.test', emailVerified: true });
            for (const [auth, org] of [['auth_payer', PAYER_ORGANIZATION], ['auth_courier', COURIER]] as const) {
                await db.insert(authOrganizationsTable).values({ id: auth, name: auth, slug: auth, createdAt: new Date() });
                await db.insert(authMembersTable).values({ id: `member_${auth}`, organizationId: auth, userId: 'user_shared', role: 'owner', createdAt: new Date() });
                await db.update(organizationsTable).set({ authOrganizationId: auth }).where(eq(organizationsTable.id, org));
            }
            await fundJob(20_000_000);
            const { root, child } = await providerTree();
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 1_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            await succeed(provider, child);
            await succeed(payer, root);
            const [flag] = await service.governance.openPaymentFlags();
            expect(flag).toMatchObject({ payeeOrganizationId: COURIER, funderOrganizationId: PAYER_ORGANIZATION, reason: expect.stringContaining('shared@acme.test') });
            await service.governance.propose('alice', 'clear_payment_flag', { flagId: flag!.id }, 'Same company, two accounts');
            expect(await service.governance.openPaymentFlags()).toEqual([]);
        });
    });

    describe('recovering and closing', () => {
        test('a dispute that leaves a balance negative is recovered from the organization\'s contract funding', async () => {
            await fundJob(20_000_000);
            // A dispute took 90,000,000 of the 80,000,000 left.
            await db.transaction(async (tx) => {
                await postLedgerTransaction(tx, 'dispute', [{ account: accounts.balance(PAYER_ORGANIZATION), amountMicroUsd: -90_000_000 }, { account: accounts.stripe, amountMicroUsd: 90_000_000 }]);
                await adjustOrganization(tx, PAYER_ORGANIZATION, { balance: -90_000_000 });
            });
            expect(await service.money.recoverFromFunding(PAYER_ORGANIZATION, 10_000_000)).toBe(10_000_000);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 0 });
            expect(await contractBalance(job)).toBe(10_000_000);
            const [notice] = await service.notifications.forOrganization(PAYER_ORGANIZATION);
            expect(notice).toMatchObject({ kind: 'dispute_recovered', details: { amountMicroUsd: 10_000_000 } });
        });

        test('closing an organization takes two staff members, and refunds its contract funding first', async () => {
            await fundJob(20_000_000);
            const action = await service.governance.propose('alice', 'close_organization', { organizationId: PAYER_ORGANIZATION }, 'The customer asked');
            expect(action.status).toBe('proposed');
            await service.governance.approve(action.id, 'bob');
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000 });
            expect(await contractBalance(job)).toBe(0);
            expect((await db.select().from(organizationsTable).where(eq(organizationsTable.id, PAYER_ORGANIZATION)))[0]!.closedAt).not.toBeNull();
            expect(await rejection(service.runs.open(payer.publicKey, { runId: crypto.randomUUID() }))).toMatchObject({ status: 403 });
        });
    });

    describe('notifications and alerts', () => {
        test('a safety net tells the funders, by email and a webhook signed with the operator\'s key', async () => {
            const posts: { url: string, body: string, headers: Record<string, string> }[] = [];
            const { NotificationService } = await import('../governance/notifications.js');
            const signer = new RunTokenSigner(generateNodeKeys().privateKey);
            const notifications = new NotificationService(db, undefined, signer, async (url, body, headers) => { posts.push({ url, body, headers }); return true; });
            service.money.notify = (organizationId, kind, details) => notifications.notify(organizationId, kind, details);
            await notifications.setWebhook(PAYER_ORGANIZATION, 'https://payer.test/hooks');
            await fundJob(20_000_000);
            expect(await service.money.refundExpired(new Date(Date.now() + 15 * DAY_MS))).toBe(20_000_000);
            await vi.waitFor(() => expect(posts).toHaveLength(1));
            const body = JSON.parse(posts[0]!.body);
            expect(body).toMatchObject({ kind: 'funding_returned', organizationId: PAYER_ORGANIZATION, details: { reason: 'expiry_refund', amountMicroUsd: 20_000_000 } });
            const key = createPublicKey({ key: Buffer.from(posts[0]!.headers['Stellarium-Key']!, 'base64url'), format: 'der', type: 'spki' });
            expect(verify(null, Buffer.from(posts[0]!.body), key, Buffer.from(posts[0]!.headers['Stellarium-Signature']!, 'base64url'))).toBe(true);
        });

        test('a node whose contracts pay its own organization raises an alert, once', async () => {
            // The buyer names the host's own organization as the payee, and the contract pays it.
            const { root, child } = await providerTree();
            await attachFromScript(root, 2_000_000, { payees: [PROVIDER_ORGANIZATION] });
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: PROVIDER_ORGANIZATION, amount: 2_000_000, from: PAYER_ORGANIZATION } });
            await succeed(provider, child);
            await succeed(payer, root);
            const { AlertService, DEFAULT_ALERT_POLICY } = await import('../governance/alerts.js');
            const alerts = new AlertService(db, service.audit, { ...DEFAULT_ALERT_POLICY, selfPaymentMicroUsd: 1_000_000 });
            expect(await alerts.check()).toMatchObject([{ kind: 'self_payment', nodePublicKey: provider.publicKey, details: { paidMicroUsd: 2_000_000 } }]);
            expect(await alerts.check()).toEqual([]);
        });
    });

    describe('safety nets', () => {
        test('the time limit refunds funding straight to its original funder, from where the clock started', async () => {
            await marketFundsJobForExpiry();
            expect(await service.money.refundExpired(new Date(Date.now() + 13 * DAY_MS))).toBe(0);
            expect(await service.money.refundExpired(new Date(Date.now() + 15 * DAY_MS))).toBe(10_000_000);
            expect(await contractBalance(job)).toBe(0);
            expect(await contractBalance(market)).toBe(0);
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000 });
            const kinds = (await db.select().from(contractMoneyLogTable)).map(entry => entry.kind);
            expect(kinds.filter(kind => kind === 'expiry_refund')).toHaveLength(2);
        });

        async function marketFundsJobForExpiry() {
            const root = await openRoot();
            const marketRun = await contractRun(root);
            await attachFromScript(root, 10_000_000, { to: market });
            await service.money.stage(provider.publicKey, {
                runId: marketRun, callIndex: 0, contract: local(market), function: 'attach', parameters: { to: job, amount: 6_000_000, attachmentId: crypto.randomUUID(), from: PAYER_ORGANIZATION },
            });
            await succeed(provider, marketRun);
            await succeed(payer, root);
        }

        test('locked funding waits for its tree', async () => {
            await fundJob(20_000_000);
            const { root, child } = await providerTree();
            await service.money.stage(provider.publicKey, { runId: child, callIndex: 0, contract: local(job), function: 'pay', parameters: { to: COURIER, amount: 5_000_000, from: PAYER_ORGANIZATION, key: 'job-1' } });
            expect(await service.money.refundExpired(new Date(Date.now() + 15 * DAY_MS))).toBe(15_000_000);
            await succeed(provider, child);
            await succeed(payer, root);
            expect(await contractBalance(job)).toBe(0);
            expect(await organization(COURIER)).toMatchObject({ payable: 5_000_000 - payFee(5_000_000, FEE_BPS) });
        });

        test('refund-all returns the funding to its funders, and the version refuses money', async () => {
            await fundJob(20_000_000);
            const [contract] = await service.money.ownedContracts(PROVIDER_ORGANIZATION);
            expect(await rejection(service.money.refundAll(PAYER_ORGANIZATION, contract!.id))).toMatchObject({ status: 404 });
            const jobId = (await service.money.ownedContracts(PROVIDER_ORGANIZATION)).find(c => c.name === 'com.example.Job')!.id;
            expect(await service.money.refundAll(PROVIDER_ORGANIZATION, jobId)).toEqual({ refundedMicroUsd: 20_000_000 });
            expect(await organization(PAYER_ORGANIZATION)).toMatchObject({ balance: 100_000_000 });
            const root = await openRoot();
            expect(await rejection(attachFromScript(root, 1))).toMatchObject({ status: 422 });
            await succeed(payer, root);
            expect((await service.money.moneyLog(PAYER_ORGANIZATION, jobId)).map(entry => entry.kind)).toEqual(['inflow', 'refund_all']);
        });
    });

    test('a free run opened by a node is never listed as spending', async () => {
        await openRoot();
        expect(await organizations.listRuns(PAYER_ORGANIZATION, 'payer', { limit: 10 })).toEqual([]);
        // Root runs left held are released by maintenance in other tests; this one settles here.
        await db.update(runsTable).set({ status: 'released', heldMicroUsd: 0 });
    });
});
