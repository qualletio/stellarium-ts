import Fastify, { type FastifyInstance } from "fastify";
import type { NodeDatabase as Database } from "../db/database.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import routes from "../routes.js";
import { createService, type Service } from "../service.js";
import { STARTUP_PAGE_SIZE, StartupService } from "../startup.js";
import { DIALECTS, testConfig, weatherResource, openTestDatabase } from "./helpers.js";

const STARTING_PEER = "http://starting.example";
const SELF = "http://self.example";

describe.each(DIALECTS)("StartupService (%s)", (dialect) => {
    const peerCount = STARTUP_PAGE_SIZE * 2 + 5;
    const resourceCount = STARTUP_PAGE_SIZE + 1;

    let databases: Database[];
    let startingNode: FastifyInstance;
    let service: Service;
    let startup: StartupService;
    let requestedUrls: string[];

    beforeEach(async () => {
        const startingDb = await openTestDatabase(dialect);
        const startingService = createService(startingDb, [weatherResource(STARTING_PEER)], testConfig({ baseUrl: STARTING_PEER }));
        for (let i = 0; i < peerCount; i++) {
            const baseUrl = `http://peer${i}.example`;
            await startingService.peerRepository.create({ baseUrl, name: baseUrl, publicKey: `key-${i}` });
        }
        for (let i = 0; i < resourceCount - 1; i++) {
            await startingService.resourceRepository.learn({ id: 0, baseUrl: "http://peer0.example", metadata: {}, path: "com.peer", name: `Learned${i}`, functions: [] });
        }

        startingNode = Fastify();
        await startingNode.register(routes, { prefix: "/v1", service: startingService });
        await startingNode.ready();

        // Route the starting peer's traffic to the in-process node, recording each request.
        requestedUrls = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = new URL(String(input));
            requestedUrls.push(url.pathname + url.search);
            const response = await startingNode.inject({ method: "GET", url: url.pathname + url.search });
            return new Response(response.body, { status: response.statusCode, headers: { "Content-Type": "application/json" } });
        });

        const db = await openTestDatabase(dialect);
        databases = [startingDb, db];
        const config = testConfig({ baseUrl: SELF });
        service = createService(db, [], config);
        startup = new StartupService(startingNode.log, service, STARTING_PEER, SELF, config.publicKey, config.privateKey);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await startingNode.close();
        await Promise.all(databases.map(db => db.close()));
    });

    test("populatePeers walks every page and stores the starting peer", async () => {
        await startup.populatePeers();

        const peers = await service.peerRepository.getPeerList();
        expect(peers).toHaveLength(peerCount + 1);
        expect(peers.map(p => p.baseUrl)).toContain(STARTING_PEER);
        expect(requestedUrls.filter(url => url.startsWith("/v1/peers"))).toEqual([
            `/v1/peers?offset=0&limit=${STARTUP_PAGE_SIZE}`,
            `/v1/peers?offset=${STARTUP_PAGE_SIZE}&limit=${STARTUP_PAGE_SIZE}`,
            `/v1/peers?offset=${STARTUP_PAGE_SIZE * 2}&limit=${STARTUP_PAGE_SIZE}`,
        ]);
    });

    test("populatePeers completes a list a previous run left partial", async () => {
        await service.peerRepository.create({ baseUrl: "http://peer0.example", name: "http://peer0.example", publicKey: "key-0" });

        await startup.populatePeers();

        expect(await service.peerRepository.getPeerList()).toHaveLength(peerCount + 1);
    });

    test("populateResources walks every page", async () => {
        await startup.populateResources();

        expect(await service.resourceRepository.getExternalResources()).toHaveLength(resourceCount);
        expect(requestedUrls.filter(url => url.startsWith("/v1/resources"))).toHaveLength(2);
    });

    test("rejects a next offset that doesn't move forward", async () => {
        vi.mocked(fetch).mockResolvedValue(Response.json({ resources: [], nextOffset: 0 }));

        await expect(startup.populateResources()).rejects.toThrow("Invalid response from peer");
    });
});
