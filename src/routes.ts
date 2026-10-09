import type { FastifyPluginAsync } from "fastify";
import { interpretParsed, parseScript } from "requestscript";
import { z } from "zod";
import type { Service } from "./service.js";
import {
    savePublication,
    resourcePublication,
    peerPublication,
} from "./peer/publications.js";
import {
    advertisementSchema,
    claimSchema,
    runSchema,
    acceptanceSchema,
    evidenceReleaseSchema,
    evidenceDeliverySchema,
    encryptedEvidenceSchema,
} from "./protocol/schema.js";
import { wireJson, hashRequest, hashValue } from "./protocol/canonical.js";
import { verifyRunAccess } from "./protocol/access.js";
import { typedHash, verifySigned } from "./protocol/typed-data.js";
import {
    CombinationResourceInvoker,
    assertTopLevelInvocation,
} from "./resource/invoker.js";
import {
    validateClaim,
    nowSeconds,
    sameAddress,
    ProtocolError,
} from "./payment/validation.js";
import type { PaymentSession } from "./payment/runtime.js";
interface RouteOptions {
    service: Service;
}
const peerSchema = z.strictObject({
    baseUrl: z.url(),
    name: z.string().min(1),
    publicKey: z.string().min(1),
    signature: z.string().min(1),
    expiry: z.iso.datetime(),
});
const routes: FastifyPluginAsync<RouteOptions> = async (
    fastify,
    { service },
) => {
    fastify.setErrorHandler((error, request, reply) => {
        if (error instanceof z.ZodError)
            return reply.status(400).send({
                error: "Invalid request body",
                issues: error.issues.map((issue) => ({
                    path: issue.path,
                    message: issue.message,
                })),
            });
        if (error instanceof ProtocolError)
            return reply
                .status(error.statusCode)
                .send({ error: error.message });
        request.log.error(error);
        return reply.status(500).send({ error: "Internal server error" });
    });
    fastify.get("/", async () => ({ hello: "world" }));
    fastify.get("/peers", async () => ({
        peers: await service.peerRepository.getPeerList(),
        self:
            process.env.SIGNING_PUBLIC_KEY && process.env.SIGNING_PRIVATE_KEY
                ? peerPublication(
                      service.baseUrl,
                      process.env.SIGNING_PUBLIC_KEY,
                      process.env.SIGNING_PRIVATE_KEY,
                  )
                : undefined,
    }));
    fastify.put("/peers", async (request) => {
        const peer = peerSchema.parse(request.body);
        if (
            !(await service.peerRepository.createIfNotExists(
                peer,
                peer.signature,
                peer.expiry,
            ))
        )
            throw new ProtocolError("Invalid peer signature or expiry");
        return { success: true };
    });
    fastify.get("/resources", async () => {
        const resources = await service.resourceRepository.getAllResources();
        return JSON.parse(
            wireJson({
                resources: resources.map((resource) => ({
                    path: resource.path,
                    name: resource.name,
                    functions: resource.functions.map((fn) => ({
                        name: fn.name,
                        returnType: fn.returnType,
                        parameters: fn.parameters,
                    })),
                    baseUrl: resource.baseUrl,
                    monetization: resource.monetization,
                })),
            }),
        );
    });
    fastify.get("/publications", async () => {
        if (!process.env.SIGNING_PUBLIC_KEY || !process.env.SIGNING_PRIVATE_KEY)
            throw new ProtocolError("Peer signing keys unavailable", 503);
        return resourcePublication(
            service,
            process.env.SIGNING_PUBLIC_KEY,
            process.env.SIGNING_PRIVATE_KEY,
        );
    });
    fastify.put("/all-resources", async (request) => {
        await savePublication(service, request.body);
        return { success: true };
    });
    fastify.get("/relays", async () =>
        JSON.parse(wireJson({ relays: (await service.relays?.list()) ?? [] })),
    );
    fastify.put("/relays", async (request) => {
        if (!service.relays)
            throw new ProtocolError("Payment support unavailable", 503);
        await service.relays.save(advertisementSchema.parse(request.body));
        return { success: true };
    });
    fastify.post("/relay/claims", async (request, reply) => {
        if (!service.relay) throw new ProtocolError("Relay mode disabled", 404);
        await service.relay.accept(claimSchema.parse(request.body));
        return reply.status(202).send({ accepted: true });
    });
    fastify.get("/relay/claims/:id", async (request) => {
        const id = (request.params as { id: string }).id;
        const row = await service.db.get(
            "SELECT state,transaction_hash AS transactionHash,last_error AS error FROM relay_queue WHERE id=?",
            id,
        );
        if (!row) throw new ProtocolError("Claim not found", 404);
        return row;
    });
    fastify.post("/payments/acceptances", async (request) => {
        if (!service.payment)
            throw new ProtocolError("Payment support unavailable", 503);
        const body = z
            .strictObject({
                receiptId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
                acceptance: acceptanceSchema,
            })
            .parse(request.body);
        const row = await service.db.get(
            "SELECT id,result_json FROM invocation WHERE status='completed' AND json_extract(result_json,'$.executions[0].claim.receipt.message.receiptId')=?",
            body.receiptId,
        );
        if (!row) throw new ProtocolError("Receipt not found", 404);
        const result = await service.payment.options.store.get(row.id);
        const claim = {
            ...result!.result!.executions[0].claim,
            acceptance: body.acceptance,
        };
        await validateClaim(service.payment.chain, claim, undefined, false);
        const execution = result!.result!.executions[0];
        execution.claim = claim;
        await service.payment.options.store.complete(row.id, result!.result!);
        await service.db.run(
            "UPDATE outbox SET claim_json=?,delivered=0 WHERE id=?",
            wireJson(claim),
            body.receiptId,
        );
        return { accepted: true };
    });
    fastify.post("/evidence/deliver", async (request) => {
        if (!service.payment)
            throw new ProtocolError("Payment support unavailable", 503);
        const { envelope, proof } = z
            .strictObject({
                envelope: encryptedEvidenceSchema,
                proof: evidenceDeliverySchema,
            })
            .parse(request.body);
        const m = proof.message;
        const now = nowSeconds();
        const panel = await service.payment.chain.getArbitrationPanel(
            m.receiptId,
        );
        if (
            !panel ||
            m.round !== panel.round ||
            m.issuedAt > now ||
            m.expiresAt < now ||
            m.expiresAt > panel.evidenceUntil ||
            !panel.arbitrators.some((a) =>
                sameAddress(a.address, m.arbitrator),
            ) ||
            m.encryptedHash !== hashValue(envelope)
        )
            throw new ProtocolError("Invalid evidence delivery");
        const chain = service.payment.chain;
        if (
            !(await verifySigned(
                "EvidenceDelivery",
                proof,
                panel.caller,
                chain.domain,
            )) &&
            !(await verifySigned(
                "EvidenceDelivery",
                proof,
                panel.provider,
                chain.domain,
            ))
        )
            throw new ProtocolError("Invalid evidence party signature", 403);
        await service.db.run(
            "INSERT OR IGNORE INTO evidence(id,encrypted_json,created_at) VALUES(?,?,?)",
            m.encryptedHash,
            JSON.stringify(envelope),
            Date.now(),
        );
        return { evidenceId: m.encryptedHash };
    });
    fastify.post("/evidence/:id/release", async (request) => {
        if (!service.payment)
            throw new ProtocolError("Payment support unavailable", 503);
        const proof = evidenceReleaseSchema.parse(request.body);
        const m = proof.message;
        const id = (request.params as { id: string }).id;
        const now = nowSeconds();
        const panel = await service.payment.chain.getArbitrationPanel(
            m.receiptId,
        );
        if (
            !panel ||
            id !== m.evidenceId ||
            m.round !== panel.round ||
            m.issuedAt > now ||
            m.expiresAt < now ||
            m.expiresAt > panel.evidenceUntil
        )
            throw new ProtocolError("Invalid evidence release");
        const arbitrator = panel.arbitrators.find((a) =>
            sameAddress(a.address, m.arbitrator),
        );
        if (!arbitrator)
            throw new ProtocolError("Arbitrator not selected", 403);
        if (
            !(await verifySigned(
                "EvidenceRelease",
                proof,
                panel.caller,
                service.payment.chain.domain,
            )) &&
            !(await verifySigned(
                "EvidenceRelease",
                proof,
                panel.provider,
                service.payment.chain.domain,
            ))
        )
            throw new ProtocolError("Invalid evidence party signature", 403);
        const row = await service.db.get(
            "SELECT id FROM invocation WHERE json_extract(result_json,'$.executions[0].evidenceId')=? AND json_extract(result_json,'$.executions[0].claim.receipt.message.receiptId')=?",
            id,
            m.receiptId,
        );
        const requestEvidence = await service.db.get(
            "SELECT id FROM request_execution WHERE json_extract(result_json,'$.evidenceId')=? AND EXISTS(SELECT 1 FROM json_each(request_execution.result_json,'$.executions') WHERE json_extract(value,'$.claim.receipt.message.receiptId')=?)",
            id,
            m.receiptId,
        );
        if (!row && !requestEvidence)
            throw new ProtocolError(
                "Evidence does not belong to this dispute",
                404,
            );
        return service.payment.options.evidence.release(
            m.evidenceId,
            arbitrator.encryptionPublicKey,
        );
    });
    fastify.get("/evidence/:id", async (request) => {
        const id = (request.params as { id: `0x${string}` }).id;
        const envelope = await service.payment?.options.evidence.get(id);
        if (!envelope) throw new ProtocolError("Evidence not found", 404);
        return envelope;
    });
    fastify.post("/run", async (request, reply) => {
        assertTopLevelInvocation();
        const body = runSchema.parse(request.body);
        if (body.payment) {
            if (!service.payment)
                throw new ProtocolError("Payment support unavailable", 503);
            const expected =
                body.kind === "request"
                    ? body.payment.authorization.message.caller
                    : body.payment.authorization.message.executionAuthority;
            let nonce;
            try {
                nonce = await verifyRunAccess(
                    body,
                    expected,
                    service.payment.chain.domain,
                    service.baseUrl,
                );
            } catch {
                throw new ProtocolError("Invalid request access proof", 403);
            }
            const inserted = await service.db.run(
                "INSERT OR IGNORE INTO access_nonce(id,expires_at) VALUES(?,?)",
                nonce,
                Number(body.accessProof!.message.expiresAt),
            );
            if (inserted.changes !== 1)
                throw new ProtocolError(
                    "Request access proof already used; sign a fresh proof to retry",
                    409,
                );
            await service.db.run(
                "DELETE FROM access_nonce WHERE expires_at<?",
                Number(nowSeconds()),
            );
        }
        if (body.kind === "invocation") {
            const resource = await service.resourceRepository.getResource(
                body.resourceKey,
            );
            if (!resource || resource.metadata.baseUrl)
                throw new ProtocolError("Resource is not hosted here", 404);
            const result = await service.resourceInvoker.dispatch(
                body,
                resource,
            );
            return JSON.parse(wireJson(result));
        }
        let script;
        try {
            script = parseScript(body.source);
        } catch {
            throw new ProtocolError("Invalid RequestScript");
        }
        if (script.declaration.kind !== "request")
            throw new ProtocolError("Invalid script declaration");
        let session: PaymentSession | undefined;
        let requestId: `0x${string}` | undefined;
        if (body.payment) {
            if (!service.payment)
                throw new ProtocolError("Payment support unavailable", 503);
            const auth = body.payment.authorization;
            if (
                auth.message.requestHash !== hashRequest(body.source) ||
                !(await verifySigned(
                    "RequestAuthorization",
                    auth,
                    auth.message.caller,
                    service.payment.chain.domain,
                ))
            )
                throw new ProtocolError(
                    "Request differs from caller authorization",
                    403,
                );
            requestId = typedHash("RequestAuthorization", auth);
            const recorded = await service.payment.options.store.get(
                requestId,
                true,
            );
            if (recorded?.result) return JSON.parse(wireJson(recorded.result));
            if (recorded)
                throw new ProtocolError(
                    `Request execution is ${recorded.status}`,
                    409,
                );
            session = await service.payment.session(auth, body.source);
            if (!(await service.payment.options.store.begin(requestId, true)))
                throw new ProtocolError("Request already started", 409);
        }
        try {
            const result = await interpretParsed(script, {
                resourceResolver: service.resourceResolver,
                resourceInvoker: new CombinationResourceInvoker(
                    service.payment,
                    session,
                ),
            });
            const response: import("./protocol/types.js").RunResult = {
                returnValue: result.returnValue ?? null,
                executions: session?.executions ?? [],
            };
            if (requestId && session)
                response.evidenceId =
                    await service.payment!.options.evidence.put({
                        source: body.source,
                        authorization: session.authorization,
                        executions: session.executions,
                        trace: session.trace,
                    });
            if (requestId)
                await service.payment!.options.store.complete(
                    requestId,
                    response,
                    true,
                );
            return JSON.parse(wireJson(response));
        } catch (error) {
            if (requestId)
                await service.payment!.options.store.fail(requestId, true);
            if (error instanceof ProtocolError)
                return reply.status(error.statusCode).send(
                    JSON.parse(
                        wireJson({
                            error: error.message,
                            executions: session?.executions ?? [],
                        }),
                    ),
                );
            request.log.error(error);
            return reply.status(422).send(
                JSON.parse(
                    wireJson({
                        error: "Request execution failed",
                        executions: session?.executions ?? [],
                    }),
                ),
            );
        }
    });
};
export default routes;
