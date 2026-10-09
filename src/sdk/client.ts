import { erc20Abi, bytesToHex, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { ViemChainAccess } from "../payment/chain.js";
import type {
    RequestAuthorization,
    ProtocolSigner,
    Signed,
    RunResult,
    ExecutionRecord,
    Address,
} from "../protocol/types.js";
import { proveRunAccess } from "../protocol/access.js";
import { hashRequest, hashValue, wireJson } from "../protocol/canonical.js";
import {
    types,
    typedHash,
    verifySigned,
    resourceId,
} from "../protocol/typed-data.js";
import {
    claimSchema,
    dispatchAcknowledgementSchema,
} from "../protocol/schema.js";
import {
    validateClaim,
    validateDispatchAcknowledgement,
    nowSeconds,
    sameAddress,
} from "../payment/validation.js";
export interface RequestApproval {
    source: string;
    budgetUsdc: bigint;
    executionAuthority: Address;
    expiresAt: bigint;
    nonce: bigint;
}
export class StellariumClient {
    constructor(
        readonly chain: ViemChainAccess,
        readonly signer: ProtocolSigner,
        private readonly fetcher: typeof fetch = fetch,
        readonly autoAccept = true,
    ) {}
    async quote(resourceKey: string, functionName: string) {
        const revision = await this.chain.getRevision(resourceId(resourceKey));
        if (
            !revision ||
            revision.retiredAt !== 0n ||
            !(await verifySigned(
                "MonetizationManifest",
                revision.manifest,
                revision.manifest.message.paymentIdentity,
                this.chain.registryDomain,
            ))
        )
            throw new Error("No current verified payment manifest");
        const quote = revision.manifest.message.functions.find(
            (fn) => fn.name === functionName,
        );
        if (!quote) throw new Error("Unknown quoted function");
        return { quote, manifest: revision.manifest };
    }
    async availableBalance(): Promise<bigint> {
        return this.chain.read("vault", "available", [
            this.signer.address,
        ]) as Promise<bigint>;
    }
    async deposit(amount: bigint): Promise<Hex> {
        if (amount <= 0n) throw new Error("Deposit must be positive");
        await this.chain.assertChain();
        const allowance = await this.chain.publicClient.readContract({
            address: this.chain.usdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [this.signer.address, this.chain.config.contracts.vault],
        });
        if (allowance < amount) {
            const hash = await this.chain.walletClient.writeContract({
                address: this.chain.usdc,
                abi: erc20Abi,
                functionName: "approve",
                args: [this.chain.config.contracts.vault, amount],
                account: this.chain.account,
                chain: this.chain.config.chainId === 8453 ? base : baseSepolia,
            });
            const receipt =
                await this.chain.publicClient.waitForTransactionReceipt({
                    hash,
                });
            if (receipt.status !== "success")
                throw new Error("USDC approval failed");
        }
        return this.chain.write("vault", "deposit", [amount]);
    }
    async withdraw(amount: bigint): Promise<Hex> {
        return this.chain.write("vault", "withdraw", [amount]);
    }
    async authorize(
        input: RequestApproval,
    ): Promise<Signed<RequestAuthorization>> {
        if (input.budgetUsdc <= 0n || input.expiresAt <= nowSeconds())
            throw new Error("Invalid request budget or expiry");
        const caller =
            typeof this.chain.account === "string"
                ? this.chain.account
                : this.chain.account.address;
        if (!sameAddress(caller, this.signer.address))
            throw new Error("Wallet account and caller signer must match");
        const message: RequestAuthorization = {
            protocolVersion: 1,
            requestId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
            caller: this.signer.address,
            budgetUsdc: input.budgetUsdc,
            requestHash: hashRequest(input.source),
            executionAuthority: input.executionAuthority,
            issuedAt: nowSeconds(),
            expiresAt: input.expiresAt,
            nonce: input.nonce,
        };
        return this.signer.sign(
            "RequestAuthorization",
            this.chain.domain,
            message,
        );
    }
    async openRequest(
        authorization: Signed<RequestAuthorization>,
    ): Promise<Hex> {
        if (
            !sameAddress(authorization.message.caller, this.signer.address) ||
            !(await verifySigned(
                "RequestAuthorization",
                authorization,
                this.signer.address,
                this.chain.domain,
            ))
        )
            throw new Error("Invalid caller authorization");
        return this.chain.write("vault", "openRequestBudget", [
            authorization.message,
            authorization.signature,
        ]);
    }
    async closeRequest(requestId: Hex): Promise<Hex> {
        return this.chain.write("vault", "closeRequest", [requestId]);
    }
    async run(
        endpoint: string,
        source: string,
        authorization?: Signed<RequestAuthorization>,
    ): Promise<RunResult> {
        if (
            authorization &&
            authorization.message.requestHash !== hashRequest(source)
        )
            throw new Error("Source does not match request authorization");
        let body: import("../protocol/types.js").RunBody = {
            version: 1,
            kind: "request",
            source,
            payment: authorization ? { authorization } : undefined,
        };
        if (authorization)
            body = await proveRunAccess(
                body,
                this.signer,
                this.chain.domain,
                endpoint,
            );
        const response = await this.fetcher(
            `${endpoint.replace(/\/$/, "")}/v1/run`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: wireJson(body),
            },
        );
        const data = (await response.json()) as RunResult & { error?: string };
        const executions = (data.executions ?? []).map((record) => ({
            ...record,
            claim: claimSchema.parse(record.claim),
            dispatchAcknowledgement: record.dispatchAcknowledgement
                ? dispatchAcknowledgementSchema.parse(
                      record.dispatchAcknowledgement,
                  )
                : undefined,
        }));
        for (const record of executions) {
            if (
                !authorization ||
                typedHash(
                    "RequestAuthorization",
                    record.claim.authorization,
                ) !== typedHash("RequestAuthorization", authorization)
            )
                throw new Error("Unexpected request receipt");
            await validateClaim(this.chain, record.claim, undefined, false);
            await validateDispatchAcknowledgement(this.chain, record);
            if (
                record.claim.receipt.message.responseHash !==
                hashValue(record.returnValue)
            )
                throw new Error("Invocation result does not match its receipt");
            if (this.autoAccept) {
                try {
                    await this.accept(record, record.returnValue);
                } catch (error) {
                    record.acceptanceDeliveryError =
                        error instanceof Error
                            ? error.message
                            : "Acceptance delivery failed";
                }
            }
        }
        if (!response.ok)
            throw Object.assign(new Error(data.error ?? "Request failed"), {
                executions,
            });
        return {
            returnValue: data.returnValue,
            executions,
            evidenceId: data.evidenceId,
        };
    }
    async accept(
        record: ExecutionRecord,
        invocationResult: unknown,
    ): Promise<void> {
        const claim = record.claim;
        if (
            !sameAddress(
                claim.authorization.message.caller,
                this.signer.address,
            ) ||
            claim.receipt.message.responseHash !== hashValue(invocationResult)
        )
            throw new Error("Receipt does not match caller or result");
        await validateClaim(this.chain, claim, undefined, false);
        const acceptance = await this.signer.sign(
            "Acceptance",
            this.chain.domain,
            {
                protocolVersion: 1,
                receiptHash: typedHash("ExecutionReceipt", claim.receipt),
                issuedAt: nowSeconds(),
            },
        );
        claim.acceptance = acceptance;
        const response = await this.fetcher(
            `${record.providerEndpoint.replace(/\/$/, "")}/v1/payments/acceptances`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: wireJson({
                    receiptId: claim.receipt.message.receiptId,
                    acceptance,
                }),
            },
        );
        if (!response.ok) throw new Error("Acceptance delivery failed");
    }
    async claimStatus(receiptId: Hex): Promise<unknown> {
        return this.chain.read("settlement", "claims", [receiptId]);
    }
    async finalize(receiptId: Hex): Promise<Hex> {
        return this.chain.write("settlement", "finalize", [receiptId]);
    }
    async challenge(receiptId: Hex): Promise<Hex> {
        const fee = (await this.chain.read(
            "court",
            "arbitrationFee",
        )) as bigint;
        await this.approveCourt(fee);
        return this.chain.write("settlement", "challenge", [receiptId]);
    }
    async depositArbitrationFee(receiptId: Hex): Promise<Hex> {
        const dispute = (await this.chain.read("court", "disputes", [
            receiptId,
        ])) as readonly unknown[];
        await this.approveCourt(dispute[2] as bigint);
        return this.chain.write("court", "depositFee", [receiptId]);
    }
    private async approveCourt(amount: bigint): Promise<void> {
        const hash = await this.chain.walletClient.writeContract({
            address: this.chain.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: [this.chain.config.contracts.court, amount],
            account: this.chain.account,
            chain: this.chain.config.chainId === 8453 ? base : baseSepolia,
        });
        if (
            (await this.chain.publicClient.waitForTransactionReceipt({ hash }))
                .status !== "success"
        )
            throw new Error("Arbitration approval failed");
    }
    async commitEvidence(receiptId: Hex, commitment: Hex): Promise<Hex> {
        return this.chain.write("court", "commitEvidence", [
            receiptId,
            commitment,
        ]);
    }
    async arbitrationRound(receiptId: Hex, round: number): Promise<unknown> {
        return this.chain.read("court", "getRound", [receiptId, round]);
    }
    async appeal(receiptId: Hex): Promise<Hex> {
        return this.chain.write("court", "appeal", [receiptId]);
    }
    async decide(receiptId: Hex): Promise<Hex> {
        return this.chain.write("court", "decide", [receiptId]);
    }
    async finalizeDispute(receiptId: Hex): Promise<Hex> {
        return this.chain.write("court", "finalize", [receiptId]);
    }
}
/** A supplied wallet client may use an injected or WalletConnect EIP-1193 transport. */
export function walletSigner(
    chain: ViemChainAccess,
    address: Address,
): ProtocolSigner {
    return {
        address,
        async sign(primaryType, domain, message) {
            if (!(primaryType in types))
                throw new Error("Unsupported signature type");
            const selected =
                primaryType === "MonetizationManifest"
                    ? {
                          MonetizationManifest: types.MonetizationManifest,
                          FunctionQuote: types.FunctionQuote,
                      }
                    : {
                          [primaryType]:
                              types[primaryType as keyof typeof types],
                      };
            const signature = await chain.walletClient.signTypedData({
                account: address,
                domain,
                types: selected,
                primaryType,
                message: message as unknown as Record<string, unknown>,
            });
            return { domain, message, signature };
        },
    };
}
