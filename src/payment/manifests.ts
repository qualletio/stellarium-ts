import { randomBytes } from "node:crypto";
import type { Resource } from "requestscript";
import type {
    ChainAccess,
    ProtocolSigner,
    Address,
    Signed,
    MonetizationManifest,
    Hex,
} from "../protocol/types.js";
import { hashValue } from "../protocol/canonical.js";
import { resourceId } from "../protocol/typed-data.js";
import { sameAddress, nowSeconds } from "./validation.js";
export interface MonetizationConfig {
    identitySigner: ProtocolSigner;
    receiptSigner: ProtocolSigner;
    paymentRecipient: Address;
    grossPriceUsdc?: bigint;
    functions?: Record<string, bigint>;
}
const nonce = (): Hex => `0x${randomBytes(32).toString("hex")}`;
export async function reconcileManifest(
    resource: Resource,
    config: MonetizationConfig,
    chain: ChainAccess,
    evidencePublicKey: string,
): Promise<Signed<MonetizationManifest>> {
    const functions = resource.functions
        .map((fn) => ({
            name: fn.name,
            grossPriceUsdc:
                config.functions?.[fn.name] ?? config.grossPriceUsdc ?? 0n,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (functions.some((fn) => fn.grossPriceUsdc < 0n))
        throw new Error("Negative price");
    for (const name of Object.keys(config.functions ?? {}))
        if (!functions.some((fn) => fn.name === name))
            throw new Error(`Unknown priced function: ${name}`);
    const id = resourceId(`${resource.path}.${resource.name}`);
    const current = await chain.getRevision(id);
    const settings = {
        paymentIdentity: config.identitySigner.address.toLowerCase(),
        paymentRecipient: config.paymentRecipient.toLowerCase(),
        receiptSigner: config.receiptSigner.address.toLowerCase(),
        evidenceEncryptionPublicKey: evidencePublicKey,
        usdc: chain.usdc.toLowerCase(),
        functions,
    };
    if (current) {
        const old = current.manifest.message;
        if (!sameAddress(old.paymentIdentity, config.identitySigner.address))
            throw new Error("Registered resource belongs to another identity");
        const oldSettings = {
            paymentIdentity: old.paymentIdentity.toLowerCase(),
            paymentRecipient: old.paymentRecipient.toLowerCase(),
            receiptSigner: old.receiptSigner.toLowerCase(),
            evidenceEncryptionPublicKey: old.evidenceEncryptionPublicKey,
            usdc: old.usdc.toLowerCase(),
            functions: old.functions
                .map(({ name, grossPriceUsdc }) => ({ name, grossPriceUsdc }))
                .sort((a, b) =>
                    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
                ),
        };
        if (hashValue(oldSettings) === hashValue(settings))
            return current.manifest;
    }
    const message: MonetizationManifest = {
        protocolVersion: 1,
        resourceId: id,
        manifestRevision: current
            ? current.manifest.message.manifestRevision + 1n
            : 1n,
        paymentIdentity: config.identitySigner.address,
        paymentRecipient: config.paymentRecipient,
        receiptSigner: config.receiptSigner.address,
        evidenceEncryptionPublicKey: evidencePublicKey,
        usdc: chain.usdc,
        quoteRegistryId: nonce(),
        functions: functions.map((fn) => ({ ...fn, quoteId: nonce() })),
        issuedAt: nowSeconds(),
    };
    const manifest = await config.identitySigner.sign(
        "MonetizationManifest",
        chain.registryDomain,
        message,
    );
    await chain.publishManifest(manifest);
    return manifest;
}
