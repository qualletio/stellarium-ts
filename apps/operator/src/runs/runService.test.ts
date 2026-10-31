import { eq } from 'drizzle-orm';
import { CombinationResourceInvoker } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from '../db/database.js';
import { nodesTable, organizationsTable, receiptsTable, runsTable } from '../db/schema.js';
import type { OperationError } from '../errors.js';
import type { OrganizationService } from '../organizations.js';
import { PaymentService } from '../payments/paymentService.js';
import { createTestDatabase, generateNodeKeys, ledgerProblems, type NodeKeys, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations } from '../testing.js';
import { ApiClientService } from './clients.js';
import { contractMaxTokens, RUN_LIFETIME_MS, RunService, scriptMaxTokens, tokenCharge } from './runService.js';
import { RunTokenSigner } from './tokens.js';

const DOWNSTREAM_ORGANIZATION = 'org_downstream';
/** 250 micro-USD a token. */
const PRICE = 250_000_000;
/** Four tokens: `return`, `1`, `+`, `2`. */
const SOURCE = 'request R {\n  return 1 + 2\n}';
/** Also four tokens. */
const CONTRACT = 'contract com.example.Sum(a: int32): int32 {\n  return a + 2\n}';

describe('RunService', () => {
    let db: Database;
    let close: () => Promise<void>;
    let organizations: OrganizationService;
    let payments: PaymentService;
    let clients: ApiClientService;
    let signer: RunTokenSigner;
    let service: RunService;
    let provider: NodeKeys;
    let payer: NodeKeys;
    let downstream: NodeKeys;
    let clientId: string;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        ({ organizations, provider, payer } = await seedOrganizations(db, 100_000));
        await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: PRICE }).where(eq(nodesTable.publicKey, provider.publicKey));
        // A third organization whose functions the provider's scripts call.
        downstream = generateNodeKeys();
        await organizations.create('Downstream', { id: DOWNSTREAM_ORGANIZATION });
        await organizations.setPayoutsEnabled(DOWNSTREAM_ORGANIZATION, true);
        await organizations.enroll(DOWNSTREAM_ORGANIZATION, downstream.publicKey);

        payments = new PaymentService(db, organizations, { platformFeeBps: 2000 });
        signer = new RunTokenSigner(generateNodeKeys().privateKey);
        clients = new ApiClientService(db, signer);
        service = new RunService(db, organizations, clients, payments, signer);
        ({ client: { id: clientId } } = await clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey, maxRunCostMicroUsd: 50_000 }));
    });

    afterEach(async () => {
        await close();
    });

    const rejection = (promise: Promise<unknown>) => promise.then(
        () => { throw new Error('expected a rejection'); },
        (error: OperationError) => ({ status: error.statusCode, message: error.message }),
    );

    async function balances(id: string) {
        const [row] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, id));
        return { balance: row!.balanceMicroUsd, held: row!.heldMicroUsd, payable: row!.payableMicroUsd };
    }

    async function run(runId: string) {
        const [row] = await db.select().from(runsTable).where(eq(runsTable.runId, runId));
        return row!;
    }

    const expectLedgerConsistent = async () => expect(await ledgerProblems(db)).toEqual([]);

    async function token(id = clientId, nodePublicKey = provider.publicKey) {
        return (await signer.sign({ clientId: id, organizationId: (await clients.get(id))!.organizationId, nodePublicKey })).token;
    }

    async function authorize(options: { runId?: string, source?: string, token?: string, node?: NodeKeys } = {}) {
        const runId = options.runId ?? crypto.randomUUID();
        const result = await service.authorize((options.node ?? provider).publicKey, { token: options.token ?? await token(), runId, source: options.source ?? SOURCE });
        return { runId, result };
    }

    /** A voucher the provider signs, as its node does for a paid call made by the run's script. */
    function runVoucher(runId: string, options: { amount?: number, recipientOrganizationId?: string, keys?: NodeKeys } = {}) {
        const keys = options.keys ?? provider;
        const invoker = new CombinationResourceInvoker(undefined as never, 0, keys.publicKey, keys.privateKey);
        return invoker.createPaymentVoucher(options.recipientOrganizationId ?? DOWNSTREAM_ORGANIZATION, options.amount ?? 10_000, 'com.example', 'Weather', 'temperature', [{ name: 'city', value: 'Oslo' }], runId);
    }

    test('scriptMaxTokens and tokenCharge price the costliest path, rounding up', () => {
        expect(scriptMaxTokens(SOURCE)).toBe(4);
        expect(scriptMaxTokens('request R {\n  if (true) { return 1 } else { return 1 + 2 + 3 }\n}')).toBe(5 + 1 + 3 + 6);
        expect(tokenCharge(4, PRICE)).toBe(1_000);
        expect(tokenCharge(1, 1)).toBe(1);
        expect(tokenCharge(0, PRICE)).toBe(0);
    });

    describe('authorize', () => {
        test('holds the client\'s maximum run cost and records the script\'s token budget', async () => {
            const { runId, result } = await authorize();

            expect(result).toEqual({ status: 'held', heldMicroUsd: 50_000, maxTokens: 4, tokenBudgetMicroUsd: 1_000 });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000, held: 50_000, payable: 0 });
            expect(await run(runId)).toMatchObject({ status: 'held', clientId, payerOrganizationId: PAYER_ORGANIZATION, recipientOrganizationId: PROVIDER_ORGANIZATION, priceMicroUsdPerMillionTokens: PRICE });
        });

        test('holds what the balance allows when it is below the maximum run cost', async () => {
            const { client } = await clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey, maxRunCostMicroUsd: 1_000_000 });

            const { result } = await authorize({ token: await token(client.id) });

            expect(result.heldMicroUsd).toBe(100_000);
        });

        test('a retried authorization gets the same hold, and another client can\'t reuse the run id', async () => {
            const { runId, result } = await authorize();
            const { client } = await clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey });

            expect((await authorize({ runId })).result).toEqual(result);
            expect(await rejection(authorize({ runId, token: await token(client.id) }))).toMatchObject({ status: 409 });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ held: 50_000 });
        });

        test('refuses a script that may cost more than the client\'s maximum run cost', async () => {
            const source = `request R {\n  return ${Array(300).fill('1').join(' + ')}\n}`;

            expect(await rejection(authorize({ source }))).toMatchObject({ status: 402, message: expect.stringContaining('maximum run cost of 50000') });
        });

        test('refuses when the balance can\'t cover the script\'s tokens, but holds nothing for a free node', async () => {
            await db.update(organizationsTable).set({ heldMicroUsd: 99_500 }).where(eq(organizationsTable.id, PAYER_ORGANIZATION));
            expect(await rejection(authorize())).toMatchObject({ status: 402, message: expect.stringContaining('Insufficient balance') });

            await db.update(nodesTable).set({ priceMicroUsdPerMillionTokens: 0 }).where(eq(nodesTable.publicKey, provider.publicKey));
            expect((await authorize()).result).toMatchObject({ heldMicroUsd: 500, tokenBudgetMicroUsd: 0 });
        });

        test('counts held and charged runs against the monthly cap', async () => {
            const { client } = await clients.create(PAYER_ORGANIZATION, { nodePublicKey: provider.publicKey, maxRunCostMicroUsd: 50_000, monthlyCapMicroUsd: 50_000 });
            const first = await authorize({ token: await token(client.id) });

            expect(await rejection(authorize({ token: await token(client.id) }))).toMatchObject({ status: 402, message: 'The API client has reached its monthly cap' });

            await service.capture(provider.publicKey, { runId: first.runId, tokens: 4 });
            expect((await authorize({ token: await token(client.id) })).result.heldMicroUsd).toBe(49_000);
        });

        test.each([
            ['the node\'s own organization', async () => {
                const { client } = await clients.create(PROVIDER_ORGANIZATION, { nodePublicKey: provider.publicKey });
                return { token: await token(client.id) };
            }, 422],
            ['a token for another node', async () => ({ token: await token(clientId, downstream.publicKey), node: downstream }), 401],
            ['a token from another signer', async () => ({
                token: (await new RunTokenSigner(generateNodeKeys().privateKey).sign({ clientId, organizationId: PAYER_ORGANIZATION, nodePublicKey: provider.publicKey })).token,
            }), 401],
            ['a revoked client', async () => {
                const issued = await token();
                await clients.revoke(PAYER_ORGANIZATION, clientId);
                return { token: issued };
            }, 401],
            ['an unlisted node', async () => {
                const issued = await token();
                await organizations.updateListing(PROVIDER_ORGANIZATION, provider.publicKey, { listed: false });
                return { token: issued };
            }, 403],
        ])('refuses %s', async (_, setup, status) => {
            expect(await rejection(authorize(await setup()))).toMatchObject({ status });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ held: 0 });
        });
    });

    test('a contract source authorizes a deploy, with no tokens to run', async () => {
        const { result } = await authorize({ source: CONTRACT });

        expect(result).toEqual({ status: 'held', heldMicroUsd: 50_000, maxTokens: 0, tokenBudgetMicroUsd: 0 });
    });

    describe('capture and release', () => {
        test('charges the executed tokens at the node\'s price, less the fee, and releases the rest of the hold', async () => {
            const { runId } = await authorize();

            expect(await service.capture(provider.publicKey, { runId, tokens: 3 })).toEqual({ status: 'captured', amountMicroUsd: 750 });

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 99_250, held: 0, payable: 0 });
            expect(await balances(PROVIDER_ORGANIZATION)).toMatchObject({ payable: 600 });
            expect(await run(runId)).toMatchObject({ status: 'captured', tokens: 3, amountMicroUsd: 750, feeMicroUsd: 150, heldMicroUsd: 0 });
            await expectLedgerConsistent();
        });

        test('caps the reported tokens at the script\'s maximum, and a retried capture charges once', async () => {
            const { runId } = await authorize();

            await service.capture(provider.publicKey, { runId, tokens: 1_000_000 });
            expect(await service.capture(provider.publicKey, { runId, tokens: 1_000_000 })).toEqual({ status: 'captured', amountMicroUsd: 1_000 });

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 99_000, held: 0, payable: 0 });
            await expectLedgerConsistent();
        });

        test('a run on a free node releases its hold at capture', async () => {
            await db.update(nodesTable).set({ priceMicroUsdPerMillionTokens: 0 }).where(eq(nodesTable.publicKey, provider.publicKey));
            const { runId } = await authorize();

            expect(await service.capture(provider.publicKey, { runId, tokens: 4 })).toEqual({ status: 'released' });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000, held: 0, payable: 0 });
            expect(await run(runId)).toMatchObject({ status: 'released', tokens: 4 });
        });

        test('release frees the hold, after which capture is refused', async () => {
            const { runId } = await authorize();

            await service.release(provider.publicKey, { runId });

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000, held: 0, payable: 0 });
            expect(await rejection(service.capture(provider.publicKey, { runId, tokens: 4 }))).toMatchObject({ status: 409 });
        });

        test('only the run\'s node can settle it', async () => {
            const { runId } = await authorize();

            expect(await rejection(service.capture(downstream.publicKey, { runId, tokens: 4 }))).toMatchObject({ status: 403 });
            expect(await rejection(service.release(downstream.publicKey, { runId }))).toMatchObject({ status: 403 });
            expect(await rejection(service.capture(provider.publicKey, { runId: crypto.randomUUID(), tokens: 4 }))).toMatchObject({ status: 404 });
        });

        test('releases runs whose hold expired', async () => {
            const { runId } = await authorize();

            expect(await service.releaseExpiredRuns()).toBe(0);
            expect(await service.releaseExpiredRuns(new Date(Date.now() + RUN_LIFETIME_MS * 2))).toBe(1);

            expect(await run(runId)).toMatchObject({ status: 'released' });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ held: 0 });
        });
    });

    describe('paid calls the run makes', () => {
        test('draw on the run\'s hold, and are charged to the run\'s payer', async () => {
            const { runId } = await authorize();
            const voucher = runVoucher(runId);

            expect(await payments.authorize(downstream.publicKey, voucher)).toEqual({ status: 'held', heldMicroUsd: 10_000 });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ held: 50_000 });
            expect(await run(runId)).toMatchObject({ heldMicroUsd: 40_000 });

            await payments.capture(downstream.publicKey, { voucher });
            await service.capture(provider.publicKey, { runId, tokens: 4 });

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 89_000, held: 0, payable: 0 });
            expect(await balances(DOWNSTREAM_ORGANIZATION)).toMatchObject({ payable: 8_000 });
            expect(await balances(PROVIDER_ORGANIZATION)).toMatchObject({ payable: 800 });
            const [receipt] = await db.select().from(receiptsTable);
            expect(receipt).toMatchObject({ payerOrganizationId: PAYER_ORGANIZATION, payerPublicKey: provider.publicKey, runId: (await run(runId)).id });
            await expectLedgerConsistent();
        });

        test('settle on their own after the run is captured', async () => {
            const { runId } = await authorize();
            const captured = runVoucher(runId);
            const released = runVoucher(runId);
            await payments.authorize(downstream.publicKey, captured);
            await payments.authorize(downstream.publicKey, released);

            await service.capture(provider.publicKey, { runId, tokens: 2 });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ held: 20_000 });
            await payments.capture(downstream.publicKey, { voucher: captured });
            await payments.release(downstream.publicKey, released);

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000 - 500 - 10_000, held: 0, payable: 0 });
            await expectLedgerConsistent();
        });

        test('include the node\'s own paid functions, paid to its own organization', async () => {
            const { runId } = await authorize();
            const voucher = runVoucher(runId, { recipientOrganizationId: PROVIDER_ORGANIZATION });

            await payments.authorize(provider.publicKey, voucher);
            await payments.capture(provider.publicKey, { voucher });

            expect(await balances(PROVIDER_ORGANIZATION)).toMatchObject({ payable: 8_000 });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ balance: 90_000 });
        });

        test('are refused once the run\'s budget, less its token budget, is spent', async () => {
            const { runId } = await authorize();
            await payments.authorize(downstream.publicKey, runVoucher(runId, { amount: 45_000 }));

            // 5,000 left, of which 1,000 is kept for the script's tokens.
            expect(await rejection(payments.authorize(downstream.publicKey, runVoucher(runId, { amount: 4_001 })))).toMatchObject({ status: 402 });
            expect(await payments.authorize(downstream.publicKey, runVoucher(runId, { amount: 4_000 }))).toMatchObject({ status: 'held' });
        });

        test('are refused when signed by a node other than the run\'s, or after the run is settled', async () => {
            const { runId } = await authorize();

            expect(await rejection(payments.authorize(downstream.publicKey, runVoucher(runId, { keys: payer })))).toMatchObject({ status: 403 });
            expect(await rejection(payments.authorize(downstream.publicKey, runVoucher(crypto.randomUUID())))).toMatchObject({ status: 404 });

            await service.capture(provider.publicKey, { runId, tokens: 4 });
            expect(await rejection(payments.authorize(downstream.publicKey, runVoucher(runId)))).toMatchObject({ status: 409 });
        });
    });

    describe('contract calls', () => {
        /** A voucher a caller node signs to call the provider's contract. */
        function contractVoucher(options: { keys?: NodeKeys, maxAmount?: number, price?: number, runId?: string, recipientOrganizationId?: string } = {}) {
            const keys = options.keys ?? payer;
            const invoker = new CombinationResourceInvoker(undefined as never, 0, keys.publicKey, keys.privateKey);
            return invoker.createContractVoucher(options.recipientOrganizationId ?? PROVIDER_ORGANIZATION, options.price ?? PRICE, options.maxAmount ?? 20_000, 'com.example', 'Sum', 'run', [{ name: 'a', value: 1 }], options.runId);
        }

        const authorizeContract = (voucher: ReturnType<typeof contractVoucher>, node = provider) =>
            service.authorizeContract(node.publicKey, { voucher, source: CONTRACT });

        test('contractMaxTokens prices a contract, and refuses a request script', () => {
            expect(contractMaxTokens(CONTRACT)).toBe(4);
            expect(() => contractMaxTokens(SOURCE)).toThrow('contract');
        });

        test('holds up to maxAmount on the signer\'s organization, and charges the tokens at the node\'s price', async () => {
            const voucher = contractVoucher();

            expect(await authorizeContract(voucher)).toEqual({ status: 'held', heldMicroUsd: 20_000, maxTokens: 4, tokenBudgetMicroUsd: 1_000, payerOrganizationId: PAYER_ORGANIZATION });
            expect(await run(voucher.invocationId)).toMatchObject({ kind: 'contract', clientId: null, parentRunId: null, payerOrganizationId: PAYER_ORGANIZATION });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ held: 20_000 });
            // A retried call with the same voucher finds the same run.
            expect(await authorizeContract(voucher)).toMatchObject({ status: 'held', heldMicroUsd: 20_000 });

            expect(await service.capture(provider.publicKey, { runId: voucher.invocationId, tokens: 4 })).toEqual({ status: 'captured', amountMicroUsd: 1_000 });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 99_000, held: 0, payable: 0 });
            expect(await balances(PROVIDER_ORGANIZATION)).toMatchObject({ payable: 800 });
            await expectLedgerConsistent();
        });

        test('pays the contract\'s own paid calls from its hold', async () => {
            const voucher = contractVoucher();
            await authorizeContract(voucher);

            const call = runVoucher(voucher.invocationId, { amount: 5_000 });
            await payments.authorize(downstream.publicKey, call);
            await payments.capture(downstream.publicKey, { voucher: call });
            await service.capture(provider.publicKey, { runId: voucher.invocationId, tokens: 4 });

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 94_000, held: 0, payable: 0 });
            await expectLedgerConsistent();
        });

        test('is free for the node\'s own organization, without a run', async () => {
            const voucher = contractVoucher({ keys: provider });

            expect(await authorizeContract(voucher)).toEqual({ status: 'free', payerOrganizationId: PROVIDER_ORGANIZATION });
            expect(await db.select().from(runsTable)).toEqual([]);
        });

        test('a call from a run is held from the run\'s hold, and gives back what it didn\'t use', async () => {
            // The payer's node runs a script for an API client of the provider's organization... so the provider
            // is the caller here: its run is billed to the payer, and it calls a contract on the downstream node.
            await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: PRICE }).where(eq(nodesTable.publicKey, downstream.publicKey));
            const parent = await authorize();
            const voucher = contractVoucher({ keys: provider, runId: parent.runId, recipientOrganizationId: DOWNSTREAM_ORGANIZATION });

            // At most the parent's hold less its own token budget.
            expect(await authorizeContract(voucher, downstream)).toMatchObject({ status: 'held', heldMicroUsd: 20_000, payerOrganizationId: PAYER_ORGANIZATION });
            expect(await run(parent.runId)).toMatchObject({ heldMicroUsd: 30_000 });
            expect(await run(voucher.invocationId)).toMatchObject({ payerOrganizationId: PAYER_ORGANIZATION, parentRunId: (await run(parent.runId)).id });

            await service.capture(downstream.publicKey, { runId: voucher.invocationId, tokens: 4 });
            expect(await run(parent.runId)).toMatchObject({ heldMicroUsd: 49_000 });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 99_000, held: 49_000, payable: 0 });

            await service.capture(provider.publicKey, { runId: parent.runId, tokens: 4 });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 98_000, held: 0, payable: 0 });
            await expectLedgerConsistent();
        });

        test('a call settled after its parent run gives its hold back to the payer', async () => {
            await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: PRICE }).where(eq(nodesTable.publicKey, downstream.publicKey));
            const parent = await authorize();
            const voucher = contractVoucher({ keys: provider, runId: parent.runId, recipientOrganizationId: DOWNSTREAM_ORGANIZATION });
            await authorizeContract(voucher, downstream);

            await service.capture(provider.publicKey, { runId: parent.runId, tokens: 4 });
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 99_000, held: 20_000, payable: 0 });
            await service.release(downstream.publicKey, { runId: voucher.invocationId });

            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 99_000, held: 0, payable: 0 });
            await expectLedgerConsistent();
        });

        test('expired calls are released before their parent runs', async () => {
            await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: PRICE }).where(eq(nodesTable.publicKey, downstream.publicKey));
            const parent = await authorize();
            await authorizeContract(contractVoucher({ keys: provider, runId: parent.runId, recipientOrganizationId: DOWNSTREAM_ORGANIZATION }), downstream);

            expect(await service.releaseExpiredRuns(new Date(Date.now() + 2 * RUN_LIFETIME_MS))).toBe(2);
            expect(await balances(PAYER_ORGANIZATION)).toEqual({ balance: 100_000, held: 0, payable: 0 });
        });

        test.each([
            ['a maxAmount below the contract\'s token budget', () => ({ voucher: contractVoucher({ maxAmount: 999 }) }), 402],
            ['a voucher paying another organization', () => ({ voucher: contractVoucher({ recipientOrganizationId: DOWNSTREAM_ORGANIZATION }) }), 403],
            ['a tampered voucher', () => ({ voucher: { ...contractVoucher(), maxAmount: 1_000_000 } }), 401],
            ['a request script as the contract', () => ({ voucher: contractVoucher(), source: SOURCE }), 400],
        ])('refuses %s', async (_, setup, status) => {
            const { voucher, source } = setup() as { voucher: ReturnType<typeof contractVoucher>, source?: string };
            expect(await rejection(service.authorizeContract(provider.publicKey, { voucher, source: source ?? CONTRACT }))).toMatchObject({ status });
            expect(await balances(PAYER_ORGANIZATION)).toMatchObject({ held: 0 });
        });

        test('charges at most the price the caller signed', async () => {
            const voucher = contractVoucher({ price: PRICE / 2 });

            expect(await authorizeContract(voucher)).toMatchObject({ tokenBudgetMicroUsd: 500 });
            expect(await service.capture(provider.publicKey, { runId: voucher.invocationId, tokens: 4 })).toEqual({ status: 'captured', amountMicroUsd: 500 });
        });

        test('refuses an unlisted node', async () => {
            await organizations.updateListing(PROVIDER_ORGANIZATION, provider.publicKey, { listed: false });
            expect(await rejection(authorizeContract(contractVoucher()))).toMatchObject({ status: 403 });
        });
    });
});
