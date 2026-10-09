import {
    hashTypedData,
    keccak256,
    encodeAbiParameters,
    stringToHex,
    recoverTypedDataAddress,
    type Hex,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Domain, ProtocolSigner, Signed } from "./types.js";
const fields = (spec: string) =>
    spec.split(" ").map((field) => {
        const [name, type] = field.split(":");
        return { name, type };
    });
export const types = {
    DispatchAcknowledgement: fields(
        "protocolVersion:uint32 invocationId:bytes32 providerPaymentIdentity:address receiptSigner:address receivedAt:uint64 chainBlockNumber:uint256 chainBlockHash:bytes32",
    ),
    RequestAuthorization: fields(
        "protocolVersion:uint32 requestId:bytes32 caller:address budgetUsdc:uint256 requestHash:bytes32 executionAuthority:address issuedAt:uint64 expiresAt:uint64 nonce:uint256",
    ),
    InvocationGrant: fields(
        "protocolVersion:uint32 requestId:bytes32 authorizationHash:bytes32 invocationNonce:bytes32 providerPaymentIdentity:address resourceId:bytes32 manifestRevision:uint256 functionNameHash:bytes32 parametersHash:bytes32 quoteId:bytes32 grossPriceUsdc:uint256 issuedAt:uint64 expiresAt:uint64",
    ),
    ExecutionReceipt: fields(
        "protocolVersion:uint32 receiptId:bytes32 requestId:bytes32 authorizationHash:bytes32 invocationId:bytes32 invocationGrantHash:bytes32 manifestRevision:uint256 providerPaymentIdentity:address paymentRecipient:address receiptSigner:address resourceId:bytes32 functionNameHash:bytes32 parametersHash:bytes32 responseHash:bytes32 quoteId:bytes32 grossPriceUsdc:uint256 relay:address relayFeeUsdc:uint256 executedAt:uint64 issuedAt:uint64",
    ),
    FunctionQuote: fields("name:string grossPriceUsdc:uint256 quoteId:bytes32"),
    MonetizationManifest: fields(
        "protocolVersion:uint32 resourceId:bytes32 manifestRevision:uint256 paymentIdentity:address paymentRecipient:address receiptSigner:address evidenceEncryptionPublicKey:string usdc:address quoteRegistryId:bytes32 functions:FunctionQuote[] issuedAt:uint64",
    ),
    RelayAdvertisement: fields(
        "protocolVersion:uint32 relay:address endpoint:string receiptVersion:uint32 relayFeeUsdc:uint256 available:bool issuedAt:uint64 expiresAt:uint64 nonce:uint256",
    ),
    RunAccess: fields(
        "protocolVersion:uint32 payloadHash:bytes32 endpointHash:bytes32 issuedAt:uint64 expiresAt:uint64 nonce:bytes32",
    ),
    EvidenceRelease: fields(
        "protocolVersion:uint32 receiptId:bytes32 evidenceId:bytes32 arbitrator:address round:uint8 issuedAt:uint64 expiresAt:uint64 nonce:bytes32",
    ),
    EvidenceDelivery: fields(
        "protocolVersion:uint32 receiptId:bytes32 arbitrator:address round:uint8 encryptedHash:bytes32 issuedAt:uint64 expiresAt:uint64 nonce:bytes32",
    ),
    Acceptance: fields(
        "protocolVersion:uint32 receiptHash:bytes32 issuedAt:uint64",
    ),
} as const;
function selectedTypes(primaryType: string) {
    if (!(primaryType in types)) throw new Error("Unsupported signature type");
    return primaryType === "MonetizationManifest"
        ? {
              MonetizationManifest: types.MonetizationManifest,
              FunctionQuote: types.FunctionQuote,
          }
        : { [primaryType]: types[primaryType as keyof typeof types] };
}
export function typedHash<T>(
    primaryType: string,
    signed: Pick<Signed<T>, "domain" | "message">,
): Hex {
    return hashTypedData({
        domain: signed.domain,
        types: selectedTypes(primaryType),
        primaryType,
        message: signed.message as Record<string, unknown>,
    });
}
export async function verifySigned<T>(
    primaryType: string,
    signed: Signed<T>,
    expected: Address,
    domain: Domain,
): Promise<boolean> {
    if (JSON.stringify(signed.domain) !== JSON.stringify(domain)) {
        if (
            signed.domain.name !== domain.name ||
            signed.domain.version !== domain.version ||
            signed.domain.chainId !== domain.chainId ||
            signed.domain.verifyingContract.toLowerCase() !==
                domain.verifyingContract.toLowerCase()
        )
            return false;
    }
    try {
        const address = await recoverTypedDataAddress({
            domain: signed.domain,
            types: selectedTypes(primaryType),
            primaryType,
            message: signed.message as Record<string, unknown>,
            signature: signed.signature,
        });
        return address.toLowerCase() === expected.toLowerCase();
    } catch {
        return false;
    }
}
export function createPrivateKeySigner(privateKey: Hex): ProtocolSigner {
    const account = privateKeyToAccount(privateKey);
    return {
        address: account.address,
        async sign(primaryType, domain, message) {
            const signature = await account.signTypedData({
                domain,
                types: selectedTypes(primaryType),
                primaryType,
                message: message as unknown as Record<string, unknown>,
            });
            return { domain, message, signature };
        },
    };
}
export const hashName = (name: string): Hex => keccak256(stringToHex(name));
export const resourceId = (key: string): Hex => hashName(key);
export function receiptId(
    domain: Domain,
    requestId: Hex,
    invocationId: Hex,
): Hex {
    return keccak256(
        encodeAbiParameters(
            [
                { type: "uint256" },
                { type: "address" },
                { type: "bytes32" },
                { type: "bytes32" },
            ],
            [
                BigInt(domain.chainId),
                domain.verifyingContract,
                requestId,
                invocationId,
            ],
        ),
    );
}
