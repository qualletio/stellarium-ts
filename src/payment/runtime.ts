import { randomBytes } from "node:crypto";
import type { Resource } from "requestscript";
import type {
    ChainAccess,
    ProtocolSigner,
    Signed,
    RequestAuthorization,
    InvocationGrant,
    ExecutionRecord,
    RunInvocation,
    RunResult,
    ExecutionReceipt,
    Hex,
} from "../protocol/types.js";
import {
    resourceId,
    typedHash,
    hashName,
    receiptId,
} from "../protocol/typed-data.js";
import { hashParameters, hashValue } from "../protocol/canonical.js";
import {
    validateAuthorization,
    validateGrant,
    validateClaim,
    sameAddress,
    nowSeconds,
    ProtocolError,
} from "./validation.js";
import type { ExecutionStore } from "./store.js";
import type { EvidenceStore } from "../evidence/encryption.js";
import type { RelayDiscovery } from "../relay/discovery.js";
import type { MonetizationConfig } from "./manifests.js";
import { hostToWire } from "../resource/values.js";
export interface PaymentSession {
    authorization: Signed<RequestAuthorization>;
    source: string;
    remainingEstimate: bigint;
    executions: ExecutionRecord[];
    trace: {
        invocationId: Hex;
        resourceId: Hex;
        dispatchedAt: string;
        completedAt?: string;
    }[];
}
export interface PaymentRuntimeOptions {
    chain: ChainAccess;
    executionSigner?: ProtocolSigner;
    providers: Map<string, MonetizationConfig>;
    providerEndpoint: string;
    store: ExecutionStore;
    evidence: EvidenceStore;
    relays: RelayDiscovery;
}
export class PaymentRuntime {
    readonly chain: ChainAccess;
    constructor(readonly options: PaymentRuntimeOptions) {
        this.chain = options.chain;
    }
    async session(
        authorization: Signed<RequestAuthorization>,
        source: string,
    ): Promise<PaymentSession> {
        await validateAuthorization(this.chain, authorization);
        if (
            !this.options.executionSigner ||
            !sameAddress(
                this.options.executionSigner.address,
                authorization.message.executionAuthority,
            )
        )
            throw new ProtocolError(
                "This node is not the execution authority",
                403,
            );
        const budget = await this.chain.getBudget(
            authorization.message.requestId,
        );
        return {
            authorization,
            source,
            remainingEstimate: budget!.remainingUsdc,
            executions: [],
            trace: [],
        };
    }
    async issueGrant(
        session: PaymentSession,
        resource: Resource,
        functionName: string,
        parameters: { name: string; value: unknown }[],
    ): Promise<Signed<InvocationGrant> | undefined> {
        const id = resourceId(`${resource.path}.${resource.name}`);
        const revision = await this.chain.getRevision(id);
        if (!revision) return undefined;
        const quote = revision.manifest.message.functions.find(
            (fn) => fn.name === functionName,
        );
        if (!quote || quote.grossPriceUsdc === 0n) return undefined;
        if (session.remainingEstimate < quote.grossPriceUsdc)
            throw new ProtocolError("Request budget exhausted", 402);
        const grant: InvocationGrant = {
            protocolVersion: 1,
            requestId: session.authorization.message.requestId,
            authorizationHash: typedHash(
                "RequestAuthorization",
                session.authorization,
            ),
            invocationNonce: `0x${randomBytes(32).toString("hex")}`,
            providerPaymentIdentity: revision.manifest.message.paymentIdentity,
            resourceId: id,
            manifestRevision: revision.manifest.message.manifestRevision,
            functionNameHash: hashName(functionName),
            parametersHash: hashParameters(parameters),
            quoteId: quote.quoteId,
            grossPriceUsdc: quote.grossPriceUsdc,
            issuedAt: nowSeconds(),
            expiresAt: session.authorization.message.expiresAt,
        };
        return this.options.executionSigner!.sign(
            "InvocationGrant",
            this.chain.domain,
            grant,
        );
    }
    async execute(
        invocation: RunInvocation,
        resource: Resource,
        execute: () => Promise<unknown>,
        session?: PaymentSession,
    ): Promise<RunResult> {
        const id = resourceId(`${resource.path}.${resource.name}`);
        if (invocation.resourceId !== id)
            throw new ProtocolError("Resource identifier mismatch");
        const current = await this.chain.getRevision(id);
        const quote = current?.manifest.message.functions.find(
            (fn) => fn.name === invocation.functionName,
        );
        if (!invocation.payment) {
            if (quote && quote.grossPriceUsdc > 0n)
                throw new ProtocolError(
                    "Paid invocation requires authorization and a grant",
                    402,
                );
            return { returnValue: hostToWire(await execute()), executions: [] };
        }
        const { authorization, grant } = invocation.payment;
        const invocationId = typedHash("InvocationGrant", grant);
        const recorded = await this.options.store.get(invocationId);
        if (recorded) {
            // Authenticate even retries, without requiring a still-active quote or open budget.
            const { verifySigned } = await import("../protocol/typed-data.js");
            if (
                !(await verifySigned(
                    "RequestAuthorization",
                    authorization,
                    authorization.message.caller,
                    this.chain.domain,
                )) ||
                !(await verifySigned(
                    "InvocationGrant",
                    grant,
                    authorization.message.executionAuthority,
                    this.chain.domain,
                )) ||
                grant.message.authorizationHash !==
                    typedHash("RequestAuthorization", authorization) ||
                grant.message.parametersHash !==
                    hashParameters(invocation.parameters) ||
                grant.message.resourceId !== id ||
                grant.message.functionNameHash !==
                    hashName(invocation.functionName)
            )
                throw new ProtocolError("Invalid retry identity", 403);
            if (recorded.result) return recorded.result;
            throw new ProtocolError(`Invocation is ${recorded.status}`, 409);
        }
        const revision = await validateGrant(this.chain, authorization, grant);
        const g = grant.message;
        if (
            g.resourceId !== id ||
            g.functionNameHash !== hashName(invocation.functionName) ||
            g.parametersHash !== hashParameters(invocation.parameters)
        )
            throw new ProtocolError(
                "Invocation differs from its signed grant",
                403,
            );
        const config = this.options.providers.get(
            `${resource.path}.${resource.name}`,
        );
        if (
            !config ||
            !sameAddress(
                config.receiptSigner.address,
                revision.manifest.message.receiptSigner,
            )
        )
            throw new ProtocolError("Receipt signer unavailable", 503);
        const relay = await this.options.relays.select(g.grossPriceUsdc);
        if (!(await this.options.store.begin(invocationId)))
            throw new ProtocolError("Invocation already started", 409);
        const trace = {
            invocationId,
            resourceId: id,
            dispatchedAt: nowSeconds().toString(),
        };

        try {
            const reference = await this.chain.getChainReference();
            const dispatchAcknowledgement = await config.receiptSigner.sign(
                "DispatchAcknowledgement",
                this.chain.domain,
                {
                    protocolVersion: 1,
                    invocationId,
                    providerPaymentIdentity: g.providerPaymentIdentity,
                    receiptSigner: config.receiptSigner.address,
                    receivedAt: nowSeconds(),
                    chainBlockNumber: reference.blockNumber,
                    chainBlockHash: reference.blockHash,
                },
            );
            const returnValue = hostToWire(await execute());
            const completedAt = nowSeconds();
            const fresh = await validateGrant(
                this.chain,
                authorization,
                grant,
                completedAt,
            );
            const manifest = fresh.manifest.message;
            const receipt: ExecutionReceipt = {
                protocolVersion: 1,
                receiptId: receiptId(
                    this.chain.domain,
                    g.requestId,
                    invocationId,
                ),
                requestId: g.requestId,
                authorizationHash: g.authorizationHash,
                invocationId,
                invocationGrantHash: invocationId,
                manifestRevision: g.manifestRevision,
                providerPaymentIdentity: manifest.paymentIdentity,
                paymentRecipient: manifest.paymentRecipient,
                receiptSigner: manifest.receiptSigner,
                resourceId: id,
                functionNameHash: g.functionNameHash,
                parametersHash: g.parametersHash,
                responseHash: hashValue(returnValue),
                quoteId: g.quoteId,
                grossPriceUsdc: g.grossPriceUsdc,
                relay: relay.message.relay,
                relayFeeUsdc: relay.message.relayFeeUsdc,
                executedAt: completedAt,
                issuedAt: completedAt,
            };
            const signedReceipt = await config.receiptSigner.sign(
                "ExecutionReceipt",
                this.chain.domain,
                receipt,
            );
            const claim = { authorization, grant, receipt: signedReceipt };
            await validateClaim(this.chain, claim, completedAt);
            const evidenceId = await this.options.evidence.put({
                source: session?.source,
                dispatchAcknowledgement,
                invocation,
                returnValue,
                claim,
                trace: { ...trace, completedAt: completedAt.toString() },
                manifest: revision.manifest,
            });
            const result = {
                returnValue,
                executions: [
                    {
                        claim,
                        dispatchAcknowledgement,
                        evidenceId,
                        providerEndpoint: this.options.providerEndpoint,
                        returnValue,
                    },
                ],
            };
            await this.options.store.complete(
                invocationId,
                result,
                false,
                relay.message.endpoint,
            );
            return result;
        } catch (error) {
            await this.options.store.fail(invocationId);
            throw error;
        }
    }
}
