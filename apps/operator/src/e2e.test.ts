import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { StellariumNode, type StellariumResource } from 'stellarium-ts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from './db/database.js';
import { contractVersionsTable, fraudCasesTable, moneyChangesTable, nodesTable, randomRequestsTable, runReceiptsTable, runsTable, topUpsTable } from './db/schema.js';
import type { OrganizationService } from './organizations.js';
import routes from './routes/index.js';
import { createService, type Service } from './service.js';
import { createTestDatabase, generateNodeKeys, ledgerProblems, PAYER_ORGANIZATION, PROVIDER_ORGANIZATION, seedOrganizations } from './testing.js';

const temperatureSource = 'request Temperature {\n  const weather: com.example.Weather\n\n  return weather.temperature(city: "Oslo")\n}';

/** A third organization's paid function, which scripts on the provider's node call. */
function forecastResource(baseUrl: string): StellariumResource {
    return {
        id: 2,
        baseUrl,
        metadata: {},
        path: 'com.example',
        name: 'Forecast',
        functions: [{
            name: 'tomorrow',
            parameters: [{ name: 'city', type: 'string' }],
            returnType: 'int32',
            exec: async () => 9,
            paymentManifest: { costMicroUsd: 5_000 },
        }],
    };
}

function weatherResource(baseUrl: string): StellariumResource {
    return {
        id: 1,
        baseUrl,
        metadata: {},
        path: 'com.example',
        name: 'Weather',
        functions: [{
            name: 'temperature',
            parameters: [{ name: 'city', type: 'string' }],
            returnType: 'int32',
            exec: async () => 12,
            paymentManifest: { costMicroUsd: 10_000 },
        }],
    };
}

/** Real stellarium-ts nodes paying through this operator over HTTP: the wire formats and request signing, end to end. */
describe('nodes paying through the operator', { timeout: 30_000 }, () => {
    const servers: FastifyInstance[] = [];
    let db: Database;
    let close: () => Promise<void>;
    let organizations: OrganizationService;
    let dir: string;
    let operatorUrl: string;
    let service: Service;
    let verifier: NodeJS.Timeout;

    beforeEach(async () => {
        ({ db, close } = await createTestDatabase());
        dir = await mkdtemp(path.join(tmpdir(), 'stellarium-operator-e2e-'));
        const operator = Fastify();
        servers.push(operator);
        service = createService(db, { platformFeeBps: 2000, runTokenPrivateKey: generateNodeKeys().privateKey });
        // The operator's maintenance verifies trees, before their money moves: here, every 100 milliseconds.
        verifier = setInterval(() => { void service.verification.verifyTrees().catch(() => undefined); }, 100);
        await operator.register(routes, { prefix: '/v1', service });
        operatorUrl = `${await operator.listen({ port: 0, host: '127.0.0.1' })}/v1`;
    });

    afterEach(async () => {
        clearInterval(verifier);
        await Promise.all(servers.splice(0).map(server => server.close()));
        await close();
        await rm(dir, { recursive: true, force: true });
    });

    /** Starts a node on a free port. A provider registers the weather resource before starting. */
    async function startNode(keys: { publicKey: string, privateKey: string }, options: { provider?: boolean, resources?: (baseUrl: string) => StellariumResource[], startingPeer?: string, enrollmentToken?: string, contractDeployFeeMicroUsd?: number, contractCostLimitMicroUsd?: number } = {}) {
        const fastify = Fastify();
        servers.push(fastify);
        // Listening first gives the node its port, which its resources' base URL needs.
        await fastify.listen({ port: 0, host: '127.0.0.1' });
        const { port } = fastify.server.address() as { port: number };
        await fastify.close();
        const baseUrl = `http://127.0.0.1:${port}`;
        const node = new StellariumNode();
        if (options.provider) await node.register(weatherResource(baseUrl));
        for (const resource of options.resources?.(baseUrl) ?? []) await node.register(resource);
        const app = Fastify();
        servers.push(app);
        await node.start(app, {
            host: '127.0.0.1', port, baseUrl, ...keys, apiKey: 'key', operatorUrl,
            databasePath: path.join(dir, `${port}.db`), startingPeer: options.startingPeer, enrollmentToken: options.enrollmentToken,
            contractDeployFeeMicroUsd: options.contractDeployFeeMicroUsd, contractCostLimitMicroUsd: options.contractCostLimitMicroUsd,
        });
        return baseUrl;
    }

    const run = (url: string, source = temperatureSource, authorization = 'Bearer key') => fetch(`${url}/v1/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ source }),
    }).then(response => response.json() as Promise<any>);

    /** A run token for a new API client of `organizationId` on `nodePublicKey`, from the token endpoint. */
    async function runToken(organizationId: string, nodePublicKey: string): Promise<string> {
        const { client, clientSecret } = await service.clients.create(organizationId, { nodePublicKey });
        const response = await fetch(`${operatorUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client.id, client_secret: clientSecret }),
        });
        return (await response.json() as { access_token: string }).access_token;
    }

    test('a paid call holds, then captures, the caller organization\'s balance', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true });
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });

        expect(await run(callerUrl)).toEqual({ returnValue: { value: 12, error: null }, usage: { tokens: 17 } });

        // Capture runs after the response is sent.
        await vi.waitFor(async () => expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 8_000 }));
        expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 90_000, heldMicroUsd: 0 });
    });

    test('a provider enrolls with a token at startup, and a caller without balance is refused before the call runs', async () => {
        const seeded = await seedOrganizations(db, 0);
        organizations = seeded.organizations;
        const { token } = await organizations.createEnrollmentToken(PROVIDER_ORGANIZATION);
        const newProvider = generateNodeKeys();
        const providerUrl = await startNode(newProvider, { provider: true, enrollmentToken: token });
        expect(await organizations.getNode(newProvider.publicKey)).toMatchObject({ organizationId: PROVIDER_ORGANIZATION });
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });

        const result = await run(callerUrl);

        expect(result.returnValue.value).toBeNull();
        expect(result.returnValue.error.message).toContain('Insufficient balance');
    });

    test('an API client\'s run on a listed node pays for the tokens it executed and for every paid call it makes', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const downstream = generateNodeKeys();
        await organizations.create('Downstream', { id: 'org_downstream' });
        await organizations.setPayoutsEnabled('org_downstream', true);
        await organizations.enroll('org_downstream', downstream.publicKey);
        const downstreamUrl = await startNode(downstream, { resources: (baseUrl) => [forecastResource(baseUrl)] });
        // The listed node hosts the paid Weather function and learns the paid Forecast function from its peer.
        const providerUrl = await startNode(seeded.provider, { provider: true, startingPeer: downstreamUrl });
        await db.update(nodesTable).set({ listed: true, priceMicroUsdPerMillionTokens: 1_000_000 }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        const token = await runToken(PAYER_ORGANIZATION, seeded.provider.publicKey);
        // The else branch, which isn't taken, costs more tokens than the branch that is.
        const source = [
            'request Forecast {',
            '  const weather: com.example.Weather',
            '  const forecast: com.example.Forecast',
            '  var today = weather.temperature(city: "Oslo").value',
            '  if (today < 100) {',
            '    return { today: today, tomorrow: forecast.tomorrow(city: "Oslo").value }',
            '  } else {',
            '    return 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20',
            '  }',
            '}',
        ].join('\n');

        const result = await run(providerUrl, source, `Bearer ${token}`);

        expect(result.returnValue).toEqual({ today: 12, tomorrow: 9 });
        const tokens = result.usage.tokens;
        await vi.waitFor(async () => expect(await organizations.get('org_downstream')).toMatchObject({ payableMicroUsd: 4_000 }));
        await vi.waitFor(async () => expect((await db.select().from(runsTable))[0]).toMatchObject({ status: 'captured', tokens }));
        const [recorded] = await db.select().from(runsTable);
        expect(tokens).toBeLessThan(recorded!.maxTokens);
        // Weather (10,000) and Forecast (5,000) from the run's hold, and a micro-USD a token.
        expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 100_000 - 15_000 - tokens, heldMicroUsd: 0 });
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 8_000 + tokens - Math.floor(tokens * 0.2) });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('the node\'s own organization runs free with a run token, as with the API key', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true });
        const token = await runToken(PROVIDER_ORGANIZATION, seeded.provider.publicKey);

        expect((await run(providerUrl, temperatureSource, `Bearer ${token}`)).returnValue).toEqual({ value: 12, error: null });
        expect((await run(providerUrl, temperatureSource, 'Bearer not.a.token')).error).toBe('Invalid run token');

        expect(await db.select().from(runsTable)).toEqual([]);
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 0 });
    });

    const deploy = (url: string, source: string, authorization = 'Bearer key') => fetch(`${url}/v1/contracts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ source }),
    });

    const forecastContract = 'contract com.example.Outlook(city: string): string {\n  const weather: com.example.Weather\n  return "${weather.temperature(city: city).value} degrees"\n}';

    test('a call to another node\'s contract pays for the tokens it executed and for the paid call it makes', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        // A micro-USD a token, which the provider learns at startup. Its session reports a new URL, which unlists it.
        await db.update(nodesTable).set({ priceMicroUsdPerMillionTokens: 1_000_000 }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        const providerUrl = await startNode(seeded.provider, { provider: true });
        await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        // Enough for the contract's tokens and the paid call it makes, which the default, a single call's limit, isn't.
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl, contractCostLimitMicroUsd: 50_000 });

        expect((await deploy(providerUrl, forecastContract)).status).toBe(201);
        await vi.waitFor(async () => {
            const { resources } = await (await fetch(`${callerUrl}/v1/resources`)).json() as { resources: StellariumResource[] };
            expect(resources.map(resource => resource.name)).toContain('Outlook');
        });

        const result = await run(callerUrl, 'request R {\n  const outlook: com.example.Outlook\n  return outlook.run(city: "Oslo")\n}');

        expect(result.returnValue).toEqual({ value: '12 degrees', error: null });
        await vi.waitFor(async () => expect((await db.select().from(runsTable))[0]).toMatchObject({ kind: 'contract', status: 'captured', clientId: null }));
        const [contractRun] = await db.select().from(runsTable);
        const tokens = contractRun!.tokens!;
        expect(tokens).toBeGreaterThan(0);
        await vi.waitFor(async () => expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ heldMicroUsd: 0 }));
        // Weather (10,000) from the contract run's hold, and a micro-USD a token.
        expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 100_000 - 10_000 - tokens });
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 8_000 + tokens - Math.floor(tokens * 0.2) });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('a contract keeps state for the organization the operator says is paying', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true });
        await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        const callerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });

        expect((await deploy(providerUrl, 'contract com.example.Visits: object {\n  var state(caller.org) visits: int32 = 0\n  visits = visits + 1\n  return { visits: visits, org: caller.org }\n}')).status).toBe(201);
        await vi.waitFor(async () => {
            const { resources } = await (await fetch(`${callerUrl}/v1/resources`)).json() as { resources: StellariumResource[] };
            expect(resources.map(resource => resource.name)).toContain('Visits');
        });
        const visit = 'request R {\n  const visits: com.example.Visits\n  return visits.run().value\n}';

        expect((await run(callerUrl, visit)).returnValue).toEqual({ visits: 1, org: PAYER_ORGANIZATION });
        expect((await run(callerUrl, visit)).returnValue).toEqual({ visits: 2, org: PAYER_ORGANIZATION });
        // The provider's own organization has its own copy.
        expect((await run(providerUrl, visit)).returnValue).toEqual({ visits: 1, org: PROVIDER_ORGANIZATION });
    });

    test('another organization\'s API client pays the deploy fee', async () => {
        const seeded = await seedOrganizations(db, 100_000);
        organizations = seeded.organizations;
        const providerUrl = await startNode(seeded.provider, { provider: true, contractDeployFeeMicroUsd: 2_000 });
        await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
        const token = await runToken(PAYER_ORGANIZATION, seeded.provider.publicKey);

        const response = await deploy(providerUrl, forecastContract, `Bearer ${token}`);

        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ feeMicroUsd: 2_000 });
        await vi.waitFor(async () => expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 98_000, heldMicroUsd: 0 }));
        expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ payableMicroUsd: 1_600 });
        expect(await ledgerProblems(db)).toEqual([]);
    });

    test('a provider that isn\'t enrolled fails to start', async () => {
        await expect(startNode(generateNodeKeys(), { provider: true })).rejects.toThrow('Node is not enrolled in an organization');
    });

    describe('sh.stellarium.money.Account', () => {
        const COURIER = 'org_courier';
        const OUTSIDER = 'org_outsider';
        const JOB = [
            'contract com.example.Job(to: string, amount: int64): int64 {',
            '  var state paid: int64 = 0',
            '  const account: sh.stellarium.money.Account',
            '  const payment = account.pay(to: to, amount: amount, from: "org_payer", key: null)',
            '  paid = paid + amount',
            '  return account.balance().value',
            '}',
        ].join('\n');

        /** The provider's node hosts a Job contract registered with the operator, which the payer funded with $10 for the courier. */
        async function fundedJob() {
            const seeded = await seedOrganizations(db, 50_000_000);
            organizations = seeded.organizations;
            await db.insert(topUpsTable).values({ organizationId: PAYER_ORGANIZATION, amountMicroUsd: 50_000_000, status: 'succeeded' });
            for (const id of [COURIER, OUTSIDER]) {
                await organizations.create(id, { id });
                await organizations.setPayoutsEnabled(id, true);
            }
            await organizations.setNodeMoneyLimits(seeded.provider.publicKey, { maxContractBalanceMicroUsd: 100_000_000 });
            await organizations.setNodeMoneyLimits(seeded.payer.publicKey, { maxApiKeyRunValueMicroUsd: 10_000_000, monthlyApiKeyValueCapMicroUsd: 10_000_000 });
            const providerUrl = await startNode(seeded.provider);
            const deployed = await deploy(providerUrl, JOB);
            expect(deployed.status).toBe(201);
            const { version } = await deployed.json() as { version: string };
            const job = { nodePublicKey: seeded.provider.publicKey, name: 'com.example.Job', version };
            // The node registers the contract after deploying it, owned by its organization.
            await vi.waitFor(async () => expect(await service.money.publicContract(job)).toMatchObject({
                source: JOB, ownerOrganizationId: PROVIDER_ORGANIZATION, payable: false, dependencies: [], requestscriptVersion: expect.stringMatching(/^1\./),
            }));
            // RequestScript 1.7.0 can't declare a contract payable, so the test makes it one.
            await db.update(contractVersionsTable).set({ payable: true }).where(eq(contractVersionsTable.name, 'com.example.Job'));
            const funding = crypto.randomUUID();
            await service.runs.open(seeded.payer.publicKey, { runId: funding });
            await service.money.stage(seeded.payer.publicKey, { runId: funding, callIndex: 0, function: 'attach', parameters: { to: job, amount: 10_000_000, attachmentId: crypto.randomUUID(), payees: [COURIER] } });
            await service.runs.capture(seeded.payer.publicKey, { runId: funding, tokens: 0 });
            return { providerUrl, job };
        }

        const balance = async (job: { nodePublicKey: string, name: string, version: string }) => (await service.money.publicContract(job))!.balanceMicroUsd;

        test('a contract pays a payee from its balance, and reads the balance with the payment staged', async () => {
            const { providerUrl, job } = await fundedJob();
            const result = await run(providerUrl, 'request Pay {\n  const job: com.example.Job\n  return job.run(to: "org_courier", amount: 3000000).value\n}');
            expect(result.returnValue).toBe(7_000_000);
            // The contract's free run settles after the response.
            await vi.waitFor(async () => expect(await organizations.get(COURIER)).toMatchObject({ payableMicroUsd: 3_000_000 - 600_000 }));
            expect(await balance(job)).toBe(7_000_000);
            expect(await ledgerProblems(db)).toEqual([]);
        });

        test('a contract\'s state is saved only once the operator applies its money', async () => {
            const { providerUrl } = await fundedJob();
            const state = async () => (await (await fetch(`${providerUrl}/v1/contracts/com.example.Job/state`, { headers: { Authorization: 'Bearer key' } })).json() as { variables: { name: string, value: unknown }[] }).variables;
            const result = await run(providerUrl, 'request Pay {\n  const job: com.example.Job\n  return job.run(to: "org_courier", amount: 3000000).value\n}');
            expect(result.returnValue).toBe(7_000_000);
            // The contract finished, but its write waits for the operator.
            expect(await state()).toEqual([]);
            await vi.waitFor(async () => expect(await state()).toMatchObject([{ name: 'paid', value: 3_000_000 }]));

            // A second call reads the saved state, and builds on it.
            expect((await run(providerUrl, 'request Pay {\n  const job: com.example.Job\n  return job.run(to: "org_courier", amount: 1000000).value\n}')).returnValue).toBe(6_000_000);
            await vi.waitFor(async () => expect(await state()).toMatchObject([{ name: 'paid', value: 4_000_000 }]));
        });

        test('a refused Account call fails the contract even when its script ignores the error, and nothing moves', async () => {
            const { providerUrl, job } = await fundedJob();
            const result = await run(providerUrl, 'request Pay {\n  const job: com.example.Job\n  return job.run(to: "org_outsider", amount: 1000000)\n}');
            expect(result.returnValue).toMatchObject({ value: null, error: { message: expect.stringContaining("isn't one of the funding's payees") } });
            await vi.waitFor(async () => {
                const [opened] = await db.select().from(runsTable).where(eq(runsTable.nodePublicKey, job.nodePublicKey));
                // The request script owns the free run, and succeeded with the contract's error as its result. The
                // contract staged nothing before its call was refused, so its run's tree applies no money.
                expect(opened).toMatchObject({ kind: 'free', outcome: 'succeeded', treeOutcome: 'applied' });
            });
            expect(await balance(job)).toBe(10_000_000);
            expect(await organizations.get(OUTSIDER)).toMatchObject({ payableMicroUsd: 0 });
        });

        test('a contract an API client deploys is registered as its organization\'s', async () => {
            const seeded = await seedOrganizations(db, 1_000_000);
            organizations = seeded.organizations;
            const providerUrl = await startNode(seeded.provider);
            // Starting reports a new base URL, which unlists the node, so it's listed afterwards.
            await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
            const token = await runToken(PAYER_ORGANIZATION, seeded.provider.publicKey);
            const source = 'contract com.example.Tenant(a: int32): int32 {\n  return a\n}';
            expect((await deploy(providerUrl, source, `Bearer ${token}`)).status).toBe(201);
            await vi.waitFor(async () => expect(await service.money.publicContract({ nodePublicKey: seeded.provider.publicKey, name: 'com.example.Tenant', version: '1' }))
                .toMatchObject({ ownerOrganizationId: PAYER_ORGANIZATION, hostOrganizationId: PROVIDER_ORGANIZATION }));
        });

        test('a request script has no balance', async () => {
            const { providerUrl } = await fundedJob();
            const result = await run(providerUrl, 'request Read {\n  const account: sh.stellarium.money.Account\n  return account.balance()\n}');
            expect(result.returnValue).toMatchObject({ value: null, error: { message: expect.stringContaining('only a contract has a balance') } });
        });
    });

    describe('payable contracts (RequestScript 1.8)', () => {
        const COURIER = 'org_courier';
        const JOB = [
            'payable contract com.example.Job(action: string, jobId: string): string {',
            '  const account: sh.stellarium.money.Account',
            '  if (action == "fund") {',
            '    if (payment.amount == 0) {',
            '      fail "fund needs money attached"',
            '    }',
            '    account.earmark(key: "job-1")',
            '    return "funded ${payment.amount} by ${payment.from} for ${payment.payees[0]}"',
            '  }',
            '  const due = account.fundingOf(org: "org_payer", key: jobId).value',
            '  account.pay(to: "org_courier", amount: due, from: "org_payer", key: jobId)',
            '  return "released ${due}"',
            '}',
        ].join('\n');

        /** The provider's node hosts Job, and the payer's node, which learned it, buys with $50 topped up today. */
        async function market() {
            const seeded = await seedOrganizations(db, 50_000_000);
            organizations = seeded.organizations;
            await db.insert(topUpsTable).values({ organizationId: PAYER_ORGANIZATION, amountMicroUsd: 50_000_000, status: 'succeeded' });
            await organizations.create(COURIER, { id: COURIER });
            await organizations.setPayoutsEnabled(COURIER, true);
            await organizations.setNodeMoneyLimits(seeded.provider.publicKey, { maxContractBalanceMicroUsd: 1_000_000_000 });
            await organizations.setNodeMoneyLimits(seeded.payer.publicKey, { maxApiKeyRunValueMicroUsd: 50_000_000, monthlyApiKeyValueCapMicroUsd: 50_000_000 });
            const providerUrl = await startNode(seeded.provider);
            await db.update(nodesTable).set({ listed: true }).where(eq(nodesTable.publicKey, seeded.provider.publicKey));
            expect((await deploy(providerUrl, JOB)).status).toBe(201);
            expect((await deploy(providerUrl, 'contract com.example.Plain(action: string): string {\n  return action\n}')).status).toBe(201);
            expect((await deploy(providerUrl, 'payable contract com.example.Who: object {\n  return { sender: sender, now: now }\n}')).status).toBe(201);
            expect((await deploy(providerUrl, 'contract com.example.Wrapper: object {\n  const who: com.example.Who@1\n  return who.run().value\n}')).status).toBe(201);
            const job = { nodePublicKey: seeded.provider.publicKey, name: 'com.example.Job', version: '1' };
            // A payable contract is registered before its deploy answers.
            expect(await service.money.publicContract(job)).toMatchObject({ payable: true, source: JOB });
            const payerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });
            return { providerUrl, payerUrl, job };
        }

        const fund = 'request Hire {\n  const job: com.example.Job@1\n  return job.run{amount: 20000000, payees: ["org_courier"]}(action: "fund", jobId: "").value\n}';
        const balance = async (job: { nodePublicKey: string, name: string, version: string }) => (await service.money.publicContract(job))!.balanceMicroUsd;

        test('a buyer funds a job on another node, and its host pays the courier what was earmarked', async () => {
            const { providerUrl, payerUrl, job } = await market();
            expect((await run(payerUrl, fund)).returnValue).toBe('funded 20000000 by org_payer for org_courier');
            await vi.waitFor(async () => expect(await balance(job)).toBe(20_000_000));
            expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 30_000_000, heldMicroUsd: 0 });

            const release = 'request Release {\n  const job: com.example.Job@1\n  return job.run(action: "release", jobId: "job-1").value\n}';
            expect((await run(providerUrl, release)).returnValue).toBe('released 20000000');
            // 20% platform fee in these tests, rounded up.
            await vi.waitFor(async () => expect(await organizations.get(COURIER)).toMatchObject({ payableMicroUsd: 16_000_000 }));
            expect(await balance(job)).toBe(0);
            expect(await ledgerProblems(db)).toEqual([]);
        });

        test('a payable contract reads who called it, vouched for by the operator, and the tree\'s time', async () => {
            const { providerUrl, payerUrl, job } = await market();
            const provider = job.nodePublicKey;
            const payerNode = (await organizations.listNodes(PAYER_ORGANIZATION))[0]!.publicKey;

            // A request script on another node: its run's organization, and no contract.
            const fromScript = (await run(payerUrl, 'request R {\n  const who: com.example.Who@1\n  return who.run().value\n}')).returnValue;
            expect(fromScript.sender).toEqual({ org: PAYER_ORGANIZATION, node: payerNode, contract: null });
            // A contract on the same node: its registered owner, the provider's organization for an API-key deploy.
            const fromContract = (await run(providerUrl, 'request R {\n  const wrapper: com.example.Wrapper@1\n  return wrapper.run().value\n}')).returnValue;
            expect(fromContract.sender).toEqual({ org: PROVIDER_ORGANIZATION, node: provider, contract: 'com.example.Wrapper@1' });
            // The provider's own API-key script calls it directly.
            const local = (await run(providerUrl, 'request R {\n  const who: com.example.Who@1\n  return who.run().value\n}')).returnValue;
            expect(local.sender).toEqual({ org: PROVIDER_ORGANIZATION, node: provider, contract: null });

            // The script moved no money, so the call is its own tree: the contract run the operator stamped.
            const roots = await db.select().from(runsTable).where(and(eq(runsTable.nodePublicKey, provider), eq(runsTable.kind, 'contract'), isNull(runsTable.rootRunId)));
            expect(roots).toHaveLength(1);
            expect(fromScript.now).toBe(roots[0]!.stampedAt!.getTime());
        });

        /** Funds and releases a job, and waits for both trees' receipts. Returns the release tree's root. */
        /**
         * Funds and releases a job. With `pause`, the operator stops verifying before the release, whose tree then waits
         * with its money unmoved. Returns the release tree's root.
         */
        async function fundAndRelease(pause = false) {
            const setup = await market();
            expect((await run(setup.payerUrl, fund)).returnValue).toBe('funded 20000000 by org_payer for org_courier');
            await vi.waitFor(async () => expect(await service.money.publicContract(setup.job)).toMatchObject({ balanceMicroUsd: 20_000_000 }));
            if (pause) clearInterval(verifier);
            const release = 'request Release {\n  const job: com.example.Job@1\n  return job.run(action: "release", jobId: "job-1").value\n}';
            expect((await run(setup.providerUrl, release)).returnValue).toBe('released 20000000');
            // The release tree's receipt is in, with Job's pay staged.
            await vi.waitFor(async () => {
                const [pay] = await db.select().from(moneyChangesTable).where(eq(moneyChangesTable.function, 'pay'));
                expect(pay).toBeDefined();
                expect(await db.select().from(runReceiptsTable).where(eq(runReceiptsTable.rootRunId, pay!.rootRunId))).not.toEqual([]);
                const [root] = await db.select().from(runsTable).where(eq(runsTable.id, pay!.rootRunId));
                expect(root!.treeOutcome).toBe(pause ? 'verifying' : 'applied');
            });
            const [pay] = await db.select().from(moneyChangesTable).where(eq(moneyChangesTable.function, 'pay'));
            const [root] = await db.select().from(runsTable).where(eq(runsTable.id, pay!.rootRunId));
            return { ...setup, root: root!, pay: pay! };
        }

        test('trees whose receipts replay are verified, and their payments released', async () => {
            const { root } = await fundAndRelease();
            // Verified before the money moved, so the courier's payment was never held.
            await vi.waitFor(async () => expect((await db.select().from(runsTable).where(eq(runsTable.id, root.id)))[0]!.verification).toBe('verified'));
            expect(await organizations.get(COURIER)).toMatchObject({ payableMicroUsd: 16_000_000 });
            expect(await service.money.heldForVerification(COURIER)).toBe(0);
            expect(await db.select().from(runsTable).where(eq(runsTable.verification, 'pending'))).toEqual([]);
        });

        test('a host that staged a payment its contract didn\'t ask for is caught, reversed, and banned once two staff approve', async () => {
            const { root, pay, providerUrl } = await fundAndRelease(true);
            // The host staged 20,000,000 to the courier; its receipt says the contract asked for that. Say it asked for less.
            const parameters = pay.parameters as { parameters: Record<string, unknown> };
            await db.update(moneyChangesTable).set({ parameters: { ...parameters, parameters: { ...parameters.parameters, amount: 1 } } }).where(eq(moneyChangesTable.id, pay.id));
            await service.verification.verifyTrees();
            const [verified] = await db.select().from(runsTable).where(eq(runsTable.id, root.id));
            expect(verified).toMatchObject({ verification: 'failed', treeOutcome: 'dropped' });

            // Caught before its money moved: the courier was never paid, and closing Job returned the buyer's funding.
            expect(await organizations.get(COURIER)).toMatchObject({ payableMicroUsd: 0 });
            expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 50_000_000, heldMicroUsd: 0 });
            expect(await ledgerProblems(db)).toEqual([]);
            const [fraudCase] = await service.governance.fraudCases();
            expect(fraudCase).toMatchObject({ organizationId: PROVIDER_ORGANIZATION, kind: 'proof', reversedMicroUsd: 0 });
            // Its nodes are suspended, and its contracts closed.
            expect((await organizations.listNodes(PROVIDER_ORGANIZATION)).every(node => node.suspendedAt !== null)).toBe(true);
            expect((await service.money.publicContract({ nodePublicKey: root.nodePublicKey, name: 'com.example.Job', version: '1' }))!.refundAllAt).not.toBeNull();
            // A suspended node can't move money.
            expect((await run(providerUrl, 'request R {\n  const job: com.example.Job@1\n  return job.run(action: "release", jobId: "job-1")\n}')).returnValue.error).not.toBeNull();

            // The operator proposed a ban, which takes two staff members.
            const [ban] = await service.governance.actions('proposed');
            expect(ban).toMatchObject({ kind: 'ban', organizationId: PROVIDER_ORGANIZATION, proposedBy: 'operator' });
            expect(await service.governance.approve(ban!.id, 'alice')).toMatchObject({ status: 'proposed' });
            await expect(service.governance.approve(ban!.id, 'alice')).rejects.toMatchObject({ statusCode: 409 });
            expect(await service.governance.approve(ban!.id, 'bob')).toMatchObject({ status: 'executed' });
            expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ bannedAt: expect.any(Date) });

            // Its owner appeals once, and a staff member overturns the ban.
            await service.governance.appeal(PROVIDER_ORGANIZATION, 'A bug in our node, not fraud', 'user_owner');
            await expect(service.governance.appeal(PROVIDER_ORGANIZATION, 'again', 'user_owner')).rejects.toMatchObject({ statusCode: 409 });
            await service.governance.propose('carol', 'overturn_appeal', { organizationId: PROVIDER_ORGANIZATION }, 'Review found a runtime bug');
            expect(await organizations.get(PROVIDER_ORGANIZATION)).toMatchObject({ bannedAt: null });
            expect((await organizations.listNodes(PROVIDER_ORGANIZATION)).every(node => node.suspendedAt === null)).toBe(true);
            const actions = (await service.audit.forOrganization(PROVIDER_ORGANIZATION)).map(entry => entry.action);
            expect(actions).toEqual(expect.arrayContaining(['fraud_found', 'contracts_closed', 'execute_ban', 'appeal', 'execute_overturn_appeal']));
        });

        test('a replay that disagrees goes to review, and a runtime fault releases the payments', async () => {
            const { root } = await fundAndRelease(true);
            // The receipt claims an output its replay won't produce.
            const receipts = await db.select().from(runReceiptsTable).where(eq(runReceiptsTable.rootRunId, root.id));
            const receipt = receipts[0]!.receipt as { outputs: Record<string, unknown> };
            await db.update(runReceiptsTable).set({ receipt: { ...receipt, outputs: { ...receipt.outputs, returnValue: 'something else' } } }).where(eq(runReceiptsTable.id, receipts[0]!.id));
            await service.verification.verifyTrees();
            expect((await db.select().from(runsTable).where(eq(runsTable.id, root.id)))[0]!.verification).toBe('review');
            const [review] = await service.governance.openReviews();
            expect(review!.reason).toContain('returnValue');
            expect((await organizations.getNode(root.nodePublicKey))!.suspendedAt).not.toBeNull();
            // Its money waits, unmoved, for the review.
            expect(await organizations.get(COURIER)).toMatchObject({ payableMicroUsd: 0 });

            await service.governance.propose('alice', 'decide_review', { reviewId: review!.id, decision: 'runtime_fault' }, 'Our replay bug');
            expect((await db.select().from(runsTable).where(eq(runsTable.id, root.id)))[0]).toMatchObject({ verification: 'verified', treeOutcome: 'applied' });
            expect((await organizations.getNode(root.nodePublicKey))!.suspendedAt).toBeNull();
            expect(await organizations.get(COURIER)).toMatchObject({ payableMicroUsd: 16_000_000 });
        });

        /**
         * The payer's node hosts a payable Forecast, which calls the provider's paid Weather: a remote call the provider
         * answers signed. Returns the Forecast run's tree once its receipt is in.
         */
        async function forecast() {
            const seeded = await seedOrganizations(db, 1_000_000);
            organizations = seeded.organizations;
            const providerUrl = await startNode(seeded.provider, { provider: true });
            const payerUrl = await startNode(seeded.payer, { startingPeer: providerUrl });
            expect((await deploy(payerUrl, 'payable contract com.example.Forecast: int32 {\n  const weather: com.example.Weather\n  return weather.temperature(city: "Oslo").value\n}')).status).toBe(201);
            expect((await run(payerUrl, 'request R {\n  const forecast: com.example.Forecast@1\n  return forecast.run().value\n}')).returnValue).toBe(12);
            let receipt: { id: number, rootRunId: number, receipt: { calls: { attestation?: Record<string, unknown>, response: unknown }[] } } | undefined;
            await vi.waitFor(async () => {
                [receipt] = await db.select().from(runReceiptsTable) as never[];
                expect(receipt).toBeDefined();
            });
            return { providerUrl, payerUrl, receipt: receipt!, payerNode: seeded.payer.publicKey };
        }

        test('a provider signs its answers to a contract run\'s calls, and the operator verifies them', async () => {
            const { receipt } = await forecast();
            const [call] = receipt.receipt.calls;
            expect(call!.attestation).toMatchObject({ callIndex: 0, signature: expect.any(String), publicKey: expect.any(String) });
            await vi.waitFor(async () => expect((await db.select().from(runsTable).where(eq(runsTable.id, receipt.rootRunId)))[0]!.verification).toBe('verified'));
        });

        test('a host that changes a provider\'s answer, or says a call failed that the provider answered, is caught', async () => {
            clearInterval(verifier);
            const { receipt, payerNode } = await forecast();
            const [call] = receipt.receipt.calls;
            const tampered = { ...receipt.receipt, calls: [{ ...call!, response: { value: 30, error: null } }] };
            await db.update(runReceiptsTable).set({ receipt: tampered }).where(eq(runReceiptsTable.id, receipt.id));
            await db.update(runsTable).set({ verification: 'pending' }).where(eq(runsTable.id, receipt.rootRunId));
            await service.verification.verifyTrees();
            expect((await service.governance.fraudCases())[0]).toMatchObject({ nodePublicKey: payerNode, reason: expect.stringContaining("didn't sign") });

            // Saying the call failed doesn't help: the provider remembers answering it.
            const failed = { ...receipt.receipt, calls: [{ ...call!, response: { value: null, error: { message: 'timed out' } }, attestation: { ...call!.attestation, failed: true, signature: undefined } }] };
            await db.update(runReceiptsTable).set({ receipt: failed }).where(eq(runReceiptsTable.id, receipt.id));
            await db.update(runsTable).set({ verification: 'pending' }).where(eq(runsTable.id, receipt.rootRunId));
            await service.verification.verifyTrees();
            expect((await service.governance.fraudCases())[0]).toMatchObject({ reason: expect.stringContaining('the provider answered it') });
        });

        test('fund fails without money attached, and moves nothing', async () => {
            const { payerUrl, job } = await market();
            const result = await run(payerUrl, fund.replace('amount: 20000000', 'amount: 0').replace(').value', ')'));
            expect(result.returnValue).toMatchObject({ value: null, error: { message: expect.stringContaining('fund needs money attached') } });
            expect(await balance(job)).toBe(0);
        });

        test('money attached to a contract that isn\'t payable is refused, and the buyer\'s script fails', async () => {
            const { payerUrl } = await market();
            const callPlain = 'request Hire {\n  const plain: com.example.Plain@1\n  return plain.run{amount: 1000000, payees: ["org_courier"]}(action: "x")\n}';
            const result = await run(payerUrl, callPlain);
            expect(result.error).toBe('Script failed');
            expect(result.details).toContain("isn't payable");
            await vi.waitFor(async () => expect(await organizations.get(PAYER_ORGANIZATION)).toMatchObject({ balanceMicroUsd: 50_000_000, heldMicroUsd: 0 }));
        });

        test('a contract requests a random value, and reads it in a later run once its tree is verified and applied', async () => {
            const { providerUrl } = await market();
            const lottery = [
                'contract com.example.Lottery(action: string): string {',
                '  const random: sh.stellarium.random.Random',
                '  if (action == "draw") {',
                '    random.requestValue(key: "round-1")',
                '    return "requested"',
                '  }',
                '  return random.value(key: "round-1").value',
                '}',
            ].join('\n');
            expect((await deploy(providerUrl, lottery)).status).toBe(201);
            const call = (action: string) => run(providerUrl, `request Play {\n  const lottery: com.example.Lottery@1\n  return lottery.run(action: "${action}").value\n}`);
            expect((await call('draw')).returnValue).toBe('requested');
            const [request] = await vi.waitFor(async () => {
                const rows = await db.select().from(randomRequestsTable);
                expect(rows).toMatchObject([{ key: 'round-1', status: 'requested' }]);
                return rows;
            });
            expect((await call('reveal')).returnValue).toBe(request!.value);
            // The read's receipt replays, and names the value the operator drew.
            await vi.waitFor(async () => expect(await db.select().from(runsTable).where(eq(runsTable.treeOutcome, 'verifying'))).toEqual([]));
            expect(await db.select().from(fraudCasesTable)).toEqual([]);
        });
    });
});

