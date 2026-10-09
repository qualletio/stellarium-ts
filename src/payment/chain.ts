import {
    type PublicClient,
    type WalletClient,
    type Account,
    type Address,
    type Abi,
    type Hex,
    TransactionReceiptNotFoundError,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { abis } from "./abis.js";
import type {
    ChainAccess,
    Domain,
    ManifestRevision,
    Claim,
    MonetizationManifest,
    Signed,
    RequestBudget,
} from "../protocol/types.js";
import { manifestSchema } from "../protocol/schema.js";
import { typedHash } from "../protocol/typed-data.js";
import { TransactionNotBroadcastError } from "./validation.js";
import { wireJson } from "../protocol/canonical.js";
export interface ContractAddresses {
    vault: Address;
    registry: Address;
    settlement: Address;
    feeOracle: Address;
    relayRegistry: Address;
    reputation: Address;
    court: Address;
    treasury: Address;
    randomness: Address;
    governor: Address;
    timelock: Address;
    launchMultisig: Address;
}
export interface ChainConfiguration {
    chainId: 8453 | 84532;
    usdc: Address;
    contracts: ContractAddresses;
}
export class ViemChainAccess implements ChainAccess {
    readonly domain: Domain;
    readonly registryDomain: Domain;
    readonly relayDomain: Domain;
    readonly usdc: Address;
    constructor(
        readonly config: ChainConfiguration,
        readonly publicClient: PublicClient,
        readonly walletClient: WalletClient,
        readonly account: Account | Address,
    ) {
        this.domain = {
            name: "Stellarium",
            version: "1",
            chainId: config.chainId,
            verifyingContract: config.contracts.settlement,
        };
        this.registryDomain = {
            ...this.domain,
            verifyingContract: config.contracts.registry,
        };
        this.relayDomain = {
            ...this.domain,
            verifyingContract: config.contracts.relayRegistry,
        };
        this.usdc = config.usdc;
    }
    async read(
        contract: keyof ContractAddresses,
        functionName: string,
        args: unknown[] = [],
    ): Promise<unknown> {
        await this.assertChain();
        return this.publicClient.readContract({
            address: this.config.contracts[contract],
            abi: this.abi(contract),
            functionName,
            args,
        });
    }
    abi(contract: keyof ContractAddresses): Abi {
        const names: Record<keyof ContractAddresses, string> = {
            vault: "StellariumBalanceVault",
            registry: "ResourceRegistry",
            settlement: "Settlement",
            feeOracle: "FeeOracle",
            relayRegistry: "RelayRegistry",
            reputation: "ReputationRegistry",
            court: "ArbitrationCourt",
            treasury: "ProtocolTreasury",
            randomness: "RandomnessAdapter",
            governor: "Governor",
            timelock: "TimelockController",
            launchMultisig: "StewardMultisig",
        };
        return abis[names[contract]];
    }
    async assertChain(): Promise<void> {
        if ((await this.publicClient.getChainId()) !== this.config.chainId)
            throw new Error("RPC chain does not match payment configuration");
    }
    async write(
        contract: keyof ContractAddresses,
        functionName: string,
        args: unknown[] = [],
    ): Promise<Hex> {
        const chain = this.config.chainId === 8453 ? base : baseSepolia;
        try {
            await this.assertChain();
            await this.publicClient.simulateContract({
                address: this.config.contracts[contract],
                abi: this.abi(contract),
                functionName,
                args,
                account: this.account,
            });
        } catch (error) {
            throw new TransactionNotBroadcastError(
                error instanceof Error ? error.message : "Preflight failed",
                { cause: error },
            );
        }
        return this.walletClient.writeContract({
            address: this.config.contracts[contract],
            abi: this.abi(contract),
            functionName,
            args,
            account: this.account,
            chain,
        });
    }
    async getChainReference() {
        await this.assertChain();
        const block = await this.publicClient.getBlock({ blockTag: "latest" });
        if (block.number === null || !block.hash)
            throw new Error("Missing chain reference");
        return { blockNumber: block.number, blockHash: block.hash };
    }
    async getArbitrationPanel(receiptId: Hex) {
        const [caller, provider, , round, phase] = (await this.read(
            "court",
            "disputes",
            [receiptId],
        )) as [Address, Address, bigint, number, number];
        if (phase !== 2) return undefined;
        const data = (await this.read("court", "getRound", [
            receiptId,
            round,
        ])) as { panel: Address[]; evidenceUntil: bigint };
        const arbitrators = [];
        for (const address of data.panel) {
            const [, encryptionPublicKey] = (await this.read(
                "court",
                "arbitrators",
                [address],
            )) as [bigint, string];
            arbitrators.push({ address, encryptionPublicKey });
        }
        return {
            caller,
            provider,
            round,
            evidenceUntil: data.evidenceUntil,
            arbitrators,
        };
    }
    async getBudget(requestId: Hex): Promise<RequestBudget | undefined> {
        const [caller, authorizationHash, remainingUsdc, expiresAt, open] =
            (await this.read("vault", "budgets", [requestId])) as [
                Address,
                Hex,
                bigint,
                bigint,
                boolean,
            ];
        if (caller === "0x0000000000000000000000000000000000000000")
            return undefined;
        return { caller, authorizationHash, remainingUsdc, expiresAt, open };
    }
    async getRevision(
        resourceId: Hex,
        revision?: bigint,
    ): Promise<ManifestRevision | undefined> {
        const number =
            revision ??
            ((await this.read("registry", "currentRevision", [
                resourceId,
            ])) as bigint);
        if (number === 0n) return undefined;
        const [, , , manifestHash, activatedAt, retiredAt] = (await this.read(
            "registry",
            "revisions",
            [resourceId, number],
        )) as [Address, Address, Address, Hex, bigint, bigint];
        if (activatedAt === 0n) return undefined;
        const data = (await this.read("registry", "getManifest", [
            resourceId,
            number,
        ])) as string;
        const manifest = manifestSchema.parse(JSON.parse(data));
        if (
            manifest.message.resourceId !== resourceId ||
            manifest.message.manifestRevision !== number ||
            typedHash("MonetizationManifest", manifest) !== manifestHash
        )
            throw new Error(
                "Published manifest data does not match its registry commitment",
            );
        return { manifest, activatedAt, retiredAt };
    }
    async publishManifest(
        manifest: Signed<MonetizationManifest>,
    ): Promise<void> {
        const hash = await this.write("registry", "publishManifest", [
            manifest.message,
            manifest.signature,
            wireJson(manifest),
        ]);
        const receipt = await this.publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 2,
        });
        if (receipt.status !== "success")
            throw new Error("Manifest registration failed");
    }
    async isEligibleRelay(relay: Address): Promise<boolean> {
        return this.read("relayRegistry", "eligible", [
            relay,
        ]) as Promise<boolean>;
    }
    async relayScore(relay: Address): Promise<bigint> {
        return this.read("reputation", "score", [relay, 2]) as Promise<bigint>;
    }
    async submitClaims(claims: Claim[]): Promise<Hex> {
        const values = claims.map((claim) => ({
            authorization: claim.authorization.message,
            callerSignature: claim.authorization.signature,
            grant: claim.grant.message,
            authoritySignature: claim.grant.signature,
            receipt: claim.receipt.message,
            providerSignature: claim.receipt.signature,
            acceptance: claim.acceptance?.message ?? {
                protocolVersion: 0,
                receiptHash: `0x${"0".repeat(64)}`,
                issuedAt: 0n,
            },
            acceptanceSignature: claim.acceptance?.signature ?? "0x",
        }));
        return this.write("settlement", "submitBatch", [values]);
    }
    async getClaimState(receiptId: Hex) {
        const value = (await this.read("settlement", "claims", [
            receiptId,
        ])) as readonly unknown[];
        return (
            ["unclaimed", "pending", "disputed", "paid", "refunded"] as const
        )[Number(value[9])];
    }
    async transactionStatus(
        hash: Hex,
    ): Promise<"pending" | "confirmed" | "failed"> {
        try {
            const receipt = await this.publicClient.getTransactionReceipt({
                hash,
            });
            if (receipt.status === "reverted") return "failed";
            const finalized = await this.publicClient.getBlock({
                blockTag: "finalized",
            });
            return receipt.blockNumber <= finalized.number!
                ? "confirmed"
                : "pending";
        } catch (error) {
            if (error instanceof TransactionReceiptNotFoundError)
                return "pending";
            throw error;
        }
    }
}
