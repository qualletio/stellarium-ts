import { z } from "zod";
const uint = z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(BigInt)
    .refine((n) => n < 2n ** 256n);
const time = uint.refine((n) => n < 2n ** 64n);
const address = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((v) => v as `0x${string}`);
const hash = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((v) => v as `0x${string}`);
const signature = z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .transform((v) => v as `0x${string}`);
export const domainSchema = z.strictObject({
    name: z.literal("Stellarium"),
    version: z.literal("1"),
    chainId: z.union([z.literal(8453), z.literal(84532)]),
    verifyingContract: address,
});
const signed = <T extends z.ZodType>(message: T) =>
    z.strictObject({ domain: domainSchema, message, signature });
const authorization = z.strictObject({
    protocolVersion: z.literal(1),
    requestId: hash,
    caller: address,
    budgetUsdc: uint,
    requestHash: hash,
    executionAuthority: address,
    issuedAt: time,
    expiresAt: time,
    nonce: uint,
});
const grant = z.strictObject({
    protocolVersion: z.literal(1),
    requestId: hash,
    authorizationHash: hash,
    invocationNonce: hash,
    providerPaymentIdentity: address,
    resourceId: hash,
    manifestRevision: uint,
    functionNameHash: hash,
    parametersHash: hash,
    quoteId: hash,
    grossPriceUsdc: uint,
    issuedAt: time,
    expiresAt: time,
});
const receipt = z.strictObject({
    protocolVersion: z.literal(1),
    receiptId: hash,
    requestId: hash,
    authorizationHash: hash,
    invocationId: hash,
    invocationGrantHash: hash,
    manifestRevision: uint,
    providerPaymentIdentity: address,
    paymentRecipient: address,
    receiptSigner: address,
    resourceId: hash,
    functionNameHash: hash,
    parametersHash: hash,
    responseHash: hash,
    quoteId: hash,
    grossPriceUsdc: uint,
    relay: address,
    relayFeeUsdc: uint,
    executedAt: time,
    issuedAt: time,
});
const acceptance = z.strictObject({
    protocolVersion: z.literal(1),
    receiptHash: hash,
    issuedAt: time,
});
export const dispatchAcknowledgementSchema = signed(
    z.strictObject({
        protocolVersion: z.literal(1),
        invocationId: hash,
        providerPaymentIdentity: address,
        receiptSigner: address,
        receivedAt: time,
        chainBlockNumber: uint,
        chainBlockHash: hash,
    }),
);
export const authorizationSchema = signed(authorization);
export const grantSchema = signed(grant);
export const receiptSchema = signed(receipt);
export const acceptanceSchema = signed(acceptance);
export const manifestSchema = signed(
    z.strictObject({
        protocolVersion: z.literal(1),
        resourceId: hash,
        manifestRevision: uint,
        paymentIdentity: address,
        paymentRecipient: address,
        receiptSigner: address,
        evidenceEncryptionPublicKey: z.string().min(1).max(4096),
        usdc: address,
        quoteRegistryId: hash,
        functions: z
            .array(
                z.strictObject({
                    name: z.string().min(1).max(128),
                    grossPriceUsdc: uint,
                    quoteId: hash,
                }),
            )
            .min(1)
            .max(128),
        issuedAt: time,
    }),
);
export const advertisementSchema = signed(
    z.strictObject({
        protocolVersion: z.literal(1),
        relay: address,
        endpoint: z.url(),
        receiptVersion: z.literal(1),
        relayFeeUsdc: uint,
        available: z.boolean(),
        issuedAt: time,
        expiresAt: time,
        nonce: uint,
    }),
);
export const runAccessSchema = signed(
    z.strictObject({
        protocolVersion: z.literal(1),
        payloadHash: hash,
        endpointHash: hash,
        issuedAt: time,
        expiresAt: time,
        nonce: hash,
    }),
);
const parameter = z.strictObject({
    name: z.string().min(1).max(128),
    value: z.json(),
});
export const runSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        version: z.literal(1),
        kind: z.literal("request"),
        source: z.string().min(1).max(1_000_000),
        accessProof: runAccessSchema.optional(),
        payment: z
            .strictObject({ authorization: authorizationSchema })
            .optional(),
    }),
    z.strictObject({
        version: z.literal(1),
        kind: z.literal("invocation"),
        resourceId: hash,
        resourceKey: z.string().min(1).max(512),
        functionName: z.string().min(1).max(128),
        parameters: z.array(parameter).max(128),
        accessProof: runAccessSchema.optional(),
        payment: z
            .strictObject({
                authorization: authorizationSchema,
                grant: grantSchema,
            })
            .optional(),
    }),
]);
export const claimSchema = z.strictObject({
    authorization: authorizationSchema,
    grant: grantSchema,
    receipt: receiptSchema,
    acceptance: acceptanceSchema.optional(),
});
export const evidenceReleaseSchema = signed(
    z.strictObject({
        protocolVersion: z.literal(1),
        receiptId: hash,
        evidenceId: hash,
        arbitrator: address,
        round: z.number().int().min(0).max(2),
        issuedAt: time,
        expiresAt: time,
        nonce: hash,
    }),
);
export const evidenceDeliverySchema = signed(
    z.strictObject({
        protocolVersion: z.literal(1),
        receiptId: hash,
        arbitrator: address,
        round: z.number().int().min(0).max(2),
        encryptedHash: hash,
        issuedAt: time,
        expiresAt: time,
        nonce: hash,
    }),
);
export const encryptedEvidenceSchema = z.strictObject({
    version: z.literal(1),
    ephemeralPublicKey: z.string().max(256),
    salt: z.string().max(128),
    iv: z.string().max(64),
    ciphertext: z.string().max(1_000_000),
    tag: z.string().max(64),
});
