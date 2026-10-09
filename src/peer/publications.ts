import { z } from "zod";
import type { Service } from "../service.js";
import type { ResourceWithBaseUrl } from "../resource/repository.js";
import { manifestSchema } from "../protocol/schema.js";
import { resourceId, typedHash, verifySigned } from "../protocol/typed-data.js";
import { ProtocolError } from "../payment/validation.js";
import { signData, verifyData } from "../crypto/utils.js";
import { wireJson } from "../protocol/canonical.js";
export const publicationSchema = z.strictObject({
    publicKey: z.string().min(1),
    signature: z.string().min(1),
    resources: z
        .array(
            z.strictObject({
                path: z.string().min(1),
                name: z.string().min(1),
                baseUrl: z.url(),
                functions: z.array(
                    z.strictObject({
                        name: z.string().min(1),
                        returnType: z.string().min(1),
                        parameters: z.array(
                            z.strictObject({
                                name: z.string(),
                                type: z.string(),
                            }),
                        ),
                    }),
                ),
                monetization: z.unknown().optional(),
            }),
        )
        .max(1000),
});
export async function savePublication(
    service: Service,
    input: unknown,
): Promise<void> {
    const body = publicationSchema.parse(input);
    const peer = await service.peerRepository.getPeerByPublicKey(
        body.publicKey,
    );
    if (!peer) throw new ProtocolError("Peer not found");
    try {
        if (
            !verifyData(
                { resources: body.resources },
                peer.publicKey,
                body.signature,
            )
        )
            throw new Error();
    } catch {
        throw new ProtocolError("Invalid resource signature");
    }
    for (const resource of body.resources) {
        if (resource.baseUrl !== peer.baseUrl)
            throw new ProtocolError(
                "Resource endpoint differs from its publisher",
            );
        if (resource.monetization) {
            if (!service.payment)
                throw new ProtocolError("Payment verification unavailable");
            const manifest = manifestSchema.parse(resource.monetization);
            const current = await service.payment.chain.getRevision(
                resourceId(`${resource.path}.${resource.name}`),
            );
            if (
                !current ||
                typedHash("MonetizationManifest", manifest) !==
                    typedHash("MonetizationManifest", current.manifest) ||
                !(await verifySigned(
                    "MonetizationManifest",
                    manifest,
                    manifest.message.paymentIdentity,
                    service.payment.chain.registryDomain,
                ))
            )
                throw new ProtocolError("Invalid Resource payment manifest");
        }
    }
    if (
        !(await service.resourceRepository.saveAll(
            body.resources as unknown as ResourceWithBaseUrl[],
            peer,
            body.signature,
        ))
    )
        throw new ProtocolError("Invalid resource signature");
}
export async function resourcePublication(
    service: Service,
    publicKey: string,
    privateKey: string,
) {
    const resources = JSON.parse(
        wireJson(
            (await service.resourceRepository.getInternalResources()).map(
                (resource) => ({
                    path: resource.path,
                    name: resource.name,
                    baseUrl: resource.baseUrl,
                    functions: resource.functions.map((fn) => ({
                        name: fn.name,
                        returnType: fn.returnType,
                        parameters: fn.parameters,
                    })),
                    monetization: resource.monetization,
                }),
            ),
        ),
    );
    return {
        publicKey,
        resources,
        signature: signData({ resources }, privateKey),
    };
}
export function peerPublication(
    baseUrl: string,
    publicKey: string,
    privateKey: string,
) {
    const peer = {
        baseUrl,
        name: baseUrl,
        publicKey,
        expiry: new Date(Date.now() + 600_000).toISOString(),
    };
    return { ...peer, signature: signData(peer, privateKey) };
}
