import type {
    ChainAccess,
    Signed,
    RequestAuthorization,
    InvocationGrant,
    Claim,
    ManifestRevision,
    Address,
} from "../protocol/types.js";
import {
    typedHash,
    verifySigned,
    receiptId,
    hashName,
} from "../protocol/typed-data.js";
export class TransactionNotBroadcastError extends Error {}
export class ProtocolError extends Error {
    constructor(
        message: string,
        readonly statusCode = 400,
    ) {
        super(message);
    }
}
export const sameAddress = (a: Address, b: Address): boolean =>
    a.toLowerCase() === b.toLowerCase();
export const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));
export function activeAt(revision: ManifestRevision, at: bigint): boolean {
    return (
        at >= revision.activatedAt &&
        (revision.retiredAt === 0n || at < revision.retiredAt)
    );
}
export async function validateAuthorization(
    chain: ChainAccess,
    signed: Signed<RequestAuthorization>,
    now = nowSeconds(),
    requireOpen = true,
): Promise<void> {
    const auth = signed.message;
    if (
        auth.protocolVersion !== 1 ||
        auth.issuedAt > now ||
        (requireOpen && auth.expiresAt <= now) ||
        auth.expiresAt <= auth.issuedAt
    )
        throw new ProtocolError(
            "Expired or invalid request authorization",
            403,
        );
    if (
        !(await verifySigned(
            "RequestAuthorization",
            signed,
            auth.caller,
            chain.domain,
        ))
    )
        throw new ProtocolError("Invalid caller signature", 403);
    const budget = await chain.getBudget(auth.requestId);
    if (
        !budget ||
        (requireOpen && !budget.open) ||
        budget.expiresAt !== auth.expiresAt ||
        !sameAddress(budget.caller, auth.caller) ||
        budget.authorizationHash !== typedHash("RequestAuthorization", signed)
    )
        throw new ProtocolError(
            "Authorization does not match an open budget",
            403,
        );
}
export async function validateGrant(
    chain: ChainAccess,
    authorization: Signed<RequestAuthorization>,
    signed: Signed<InvocationGrant>,
    now = nowSeconds(),
    execution = true,
    requireOpen = true,
): Promise<ManifestRevision> {
    await validateAuthorization(chain, authorization, now, requireOpen);
    const auth = authorization.message;
    const grant = signed.message;
    if (
        !(await verifySigned(
            "InvocationGrant",
            signed,
            auth.executionAuthority,
            chain.domain,
        ))
    )
        throw new ProtocolError("Invalid invocation authority", 403);
    if (
        grant.protocolVersion !== 1 ||
        grant.requestId !== auth.requestId ||
        grant.authorizationHash !==
            typedHash("RequestAuthorization", authorization) ||
        grant.issuedAt < auth.issuedAt ||
        grant.issuedAt > now ||
        grant.expiresAt > auth.expiresAt ||
        grant.expiresAt < grant.issuedAt ||
        (execution && grant.expiresAt < now)
    )
        throw new ProtocolError("Invalid invocation grant", 403);
    const revision = await chain.getRevision(
        grant.resourceId,
        grant.manifestRevision,
    );
    if (
        !revision ||
        !activeAt(revision, grant.issuedAt) ||
        (execution && !activeAt(revision, now))
    )
        throw new ProtocolError("Inactive quote revision", 409);
    const manifest = revision.manifest.message;
    if (
        !(await verifySigned(
            "MonetizationManifest",
            revision.manifest,
            manifest.paymentIdentity,
            chain.registryDomain,
        ))
    )
        throw new ProtocolError("Invalid manifest signature", 403);
    const quote = manifest.functions.find((q) => q.quoteId === grant.quoteId);
    if (
        !quote ||
        hashName(quote.name) !== grant.functionNameHash ||
        manifest.resourceId !== grant.resourceId ||
        manifest.manifestRevision !== grant.manifestRevision ||
        !sameAddress(manifest.paymentIdentity, grant.providerPaymentIdentity) ||
        quote.grossPriceUsdc !== grant.grossPriceUsdc
    )
        throw new ProtocolError("Quote terms mismatch", 403);
    const budget = await chain.getBudget(auth.requestId);
    if (!budget || (requireOpen && budget.remainingUsdc < grant.grossPriceUsdc))
        throw new ProtocolError("Insufficient request budget", 402);
    return revision;
}
export async function validateClaim(
    chain: ChainAccess,
    claim: Claim,
    now = nowSeconds(),
    requireOpen = true,
): Promise<void> {
    const revision = await validateGrant(
        chain,
        claim.authorization,
        claim.grant,
        now,
        false,
        requireOpen,
    );
    const r = claim.receipt.message;
    const g = claim.grant.message;
    const auth = claim.authorization.message;
    const invocationId = typedHash("InvocationGrant", claim.grant);
    if (
        r.protocolVersion !== 1 ||
        r.requestId !== auth.requestId ||
        r.authorizationHash !== g.authorizationHash ||
        r.invocationId !== invocationId ||
        r.invocationGrantHash !== invocationId ||
        r.receiptId !== receiptId(chain.domain, r.requestId, invocationId)
    )
        throw new ProtocolError("Receipt identity mismatch");
    for (const field of [
        "resourceId",
        "manifestRevision",
        "functionNameHash",
        "parametersHash",
        "quoteId",
        "grossPriceUsdc",
    ] as const)
        if (r[field] !== g[field])
            throw new ProtocolError("Receipt grant mismatch");
    const manifest = revision.manifest.message;
    if (
        !sameAddress(r.providerPaymentIdentity, manifest.paymentIdentity) ||
        !sameAddress(r.receiptSigner, manifest.receiptSigner) ||
        !sameAddress(r.paymentRecipient, manifest.paymentRecipient)
    )
        throw new ProtocolError("Historical receipt keys mismatch");
    if (
        r.executedAt < g.issuedAt ||
        r.executedAt > g.expiresAt ||
        r.executedAt > now ||
        r.issuedAt < r.executedAt ||
        r.issuedAt > now ||
        (requireOpen && now - r.executedAt > 1800n) ||
        !activeAt(revision, r.executedAt)
    )
        throw new ProtocolError("Invalid receipt timing");
    if (
        r.relayFeeUsdc > r.grossPriceUsdc ||
        (requireOpen && !(await chain.isEligibleRelay(r.relay)))
    )
        throw new ProtocolError("Invalid relay fee or registration");
    if (
        !(await verifySigned(
            "ExecutionReceipt",
            claim.receipt,
            r.receiptSigner,
            chain.domain,
        ))
    )
        throw new ProtocolError("Invalid provider signature");
    if (
        claim.acceptance &&
        (claim.acceptance.message.receiptHash !==
            typedHash("ExecutionReceipt", claim.receipt) ||
            claim.acceptance.message.issuedAt < r.executedAt ||
            claim.acceptance.message.issuedAt > now ||
            !(await verifySigned(
                "Acceptance",
                claim.acceptance,
                auth.caller,
                chain.domain,
            )))
    )
        throw new ProtocolError("Invalid caller acceptance");
}

export async function validateDispatchAcknowledgement(
    chain: ChainAccess,
    record: import("../protocol/types.js").ExecutionRecord,
): Promise<void> {
    const ack = record.dispatchAcknowledgement;
    if (!ack) return; // Older durable receipts may have no corroborating dispatch record.
    const m = ack.message,
        r = record.claim.receipt.message;
    if (
        m.invocationId !== r.invocationId ||
        !sameAddress(m.providerPaymentIdentity, r.providerPaymentIdentity) ||
        !sameAddress(m.receiptSigner, r.receiptSigner) ||
        m.receivedAt < record.claim.grant.message.issuedAt ||
        m.receivedAt > r.executedAt ||
        !(await verifySigned(
            "DispatchAcknowledgement",
            ack,
            r.receiptSigner,
            chain.domain,
        ))
    )
        throw new ProtocolError("Invalid dispatch acknowledgement", 502);
}
