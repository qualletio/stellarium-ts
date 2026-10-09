import fs from "node:fs";
import {
    createPublicClient,
    createWalletClient,
    http,
    encodeFunctionData,
    keccak256,
    stringToHex,
    isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
const args = process.argv.slice(2);
const configPath = args.includes("--config")
    ? args[args.indexOf("--config") + 1]
    : "docs/deployment.example.json";
const broadcast = args.includes("--broadcast");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const names = [
    "StellariumBalanceVault",
    "ResourceRegistry",
    "Settlement",
    "FeeOracle",
    "RelayRegistry",
    "ReputationRegistry",
    "ArbitrationCourt",
    "ProtocolTreasury",
    "RandomnessAdapter",
    "Governor",
    "TimelockController",
    "StewardMultisig",
];
const artifacts = Object.fromEntries(
    [...names, "DeploymentFactory"].map((name) => [
        name,
        JSON.parse(fs.readFileSync(`build/contracts/${name}.json`, "utf8")),
    ]),
);
if (config.chainId !== 84532)
    throw new Error(
        "This unaudited deployment script is restricted to Base Sepolia",
    );
for (const key of [
    "usdc",
    "chainlinkEthUsdFeed",
    "baseGasOracle",
    "vrfCoordinator",
])
    if (!isAddress(config[key])) throw new Error(`Invalid ${key}`);
if (
    config.stewards.length !== 5 ||
    new Set(config.stewards.map((a) => a.toLowerCase())).size !== 5 ||
    config.stewards.some((a) => !isAddress(a))
)
    throw new Error("Exactly five distinct EOA stewards are required");
if (
    config.initialSeeds.length < 3 ||
    new Set(config.initialSeeds.map((a) => a.toLowerCase())).size !==
        config.initialSeeds.length ||
    config.initialSeeds.some((a) => !isAddress(a))
)
    throw new Error("Distinct bootstrap seeds are required");
const output = args.includes("--out")
    ? args[args.indexOf("--out") + 1]
    : "build/deployment-plan.json";
const plan = {
    ...config,
    status: "dry-run",
    compiler: "0.8.30",
    threshold: 3,
    ordinaryDelaySeconds: 172800,
    upgradeDelaySeconds: 604800,
    contracts: names.map((name) => ({
        name,
        implementationCreationCodeHash: keccak256(artifacts[name].bytecode),
        deployedSizeBytes: (artifacts[name].deployedBytecode.length - 2) / 2,
    })),
};
if (!broadcast) {
    fs.writeFileSync(output, JSON.stringify(plan, null, 2));
    console.log(
        `Deployment plan written to ${output}; no RPC request or transaction was made.`,
    );
    process.exit(0);
}
if (!process.env.DEPLOYER_PRIVATE_KEY || !process.env.BASE_SEPOLIA_RPC_URL)
    throw new Error(
        "Set DEPLOYER_PRIVATE_KEY and BASE_SEPOLIA_RPC_URL before explicit --broadcast",
    );
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const client = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL),
});
const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL),
});
if ((await client.getChainId()) !== 84532)
    throw new Error("RPC is not Base Sepolia");
for (const address of [
    config.usdc,
    config.chainlinkEthUsdFeed,
    config.baseGasOracle,
    config.vrfCoordinator,
])
    if (!(await client.getCode({ address })))
        throw new Error(`Missing external contract ${address}`);
for (const address of config.stewards)
    if (await client.getCode({ address }))
        throw new Error("Stewards must be EOAs");
const deployed = {};
async function deploy(name) {
    const hash = await wallet.deployContract({
        abi: artifacts[name].abi,
        bytecode: artifacts[name].bytecode,
    });
    const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 2,
    });
    if (receipt.status !== "success" || !receipt.contractAddress)
        throw new Error(`Failed deploying ${name}`);
    deployed[name] = receipt.contractAddress;
    return receipt.contractAddress;
}
for (const name of names) await deploy(name);
const factory = await deploy("DeploymentFactory");
const salts = names.map((name) =>
    keccak256(stringToHex(`${config.deploymentId}:${name}`)),
);
const proxies = {};
for (let i = 0; i < names.length; i++)
    proxies[names[i]] = await client.readContract({
        address: factory,
        abi: artifacts.DeploymentFactory.abi,
        functionName: "predict",
        args: [deployed[names[i]], salts[i]],
    });
const p = proxies;
const gov = p.TimelockController;
const params = config.parameters;
const initializeArgs = {
    StellariumBalanceVault: [
        gov,
        config.usdc,
        p.Settlement,
        p.ArbitrationCourt,
        p.StewardMultisig,
    ],
    ResourceRegistry: [
        gov,
        config.usdc,
        p.ReputationRegistry,
        p.ArbitrationCourt,
    ],
    Settlement: [
        gov,
        p.StellariumBalanceVault,
        p.ResourceRegistry,
        p.RelayRegistry,
        p.ReputationRegistry,
        p.FeeOracle,
        p.ProtocolTreasury,
        p.ArbitrationCourt,
        p.StewardMultisig,
    ],
    FeeOracle: [
        gov,
        config.chainlinkEthUsdFeed,
        config.baseGasOracle,
        BigInt(params.feeOverheadGas),
        BigInt(params.transactionOverheadBytes),
        BigInt(params.maximumGasPriceWei),
    ],
    RelayRegistry: [
        gov,
        config.usdc,
        p.ReputationRegistry,
        p.ArbitrationCourt,
        BigInt(params.minimumRelayStakeUsdc),
    ],
    ReputationRegistry: [
        gov,
        config.initialSeeds,
        params.reputationCoefficients.map(BigInt),
    ],
    ArbitrationCourt: [
        gov,
        config.usdc,
        p.ReputationRegistry,
        p.ProtocolTreasury,
        p.Settlement,
        p.RandomnessAdapter,
        BigInt(params.minimumArbitratorStakeUsdc),
        BigInt(params.arbitrationFeeUsdc),
    ],
    ProtocolTreasury: [
        gov,
        p.StellariumBalanceVault,
        config.usdc,
        p.Settlement,
        p.ArbitrationCourt,
    ],
    RandomnessAdapter: [
        gov,
        config.vrfCoordinator,
        p.ArbitrationCourt,
        config.vrfKeyHash,
        BigInt(config.vrfSubscriptionId),
        params.vrfConfirmations,
        params.vrfCallbackGasLimit,
    ],
    Governor: [
        gov,
        p.ReputationRegistry,
        gov,
        p.StewardMultisig,
        BigInt(params.votingDelaySeconds),
        BigInt(params.votingPeriodSeconds),
        BigInt(params.quorumBps),
    ],
    TimelockController: [p.StewardMultisig],
    StewardMultisig: [
        gov,
        config.stewards,
        p.StellariumBalanceVault,
        p.Settlement,
    ],
};
const initializers = names.map((name) =>
    encodeFunctionData({
        abi: artifacts[name].abi,
        functionName: "initialize",
        args: initializeArgs[name],
    }),
);
const hash = await wallet.writeContract({
    address: factory,
    abi: artifacts.DeploymentFactory.abi,
    functionName: "deploy",
    args: [names.map((name) => deployed[name]), salts, initializers],
});
const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
});
if (receipt.status !== "success")
    throw new Error("Atomic proxy initialization failed");
const reporterCalls = [p.Settlement, p.ArbitrationCourt].map((address) => ({
    target: p.ReputationRegistry,
    value: "0",
    data: encodeFunctionData({
        abi: artifacts.ReputationRegistry.abi,
        functionName: "setReporter",
        args: [address, true],
    }),
}));
const runtimeCodeHashes = {};
for (const name of names)
    runtimeCodeHashes[name] = keccak256(
        await client.getCode({ address: deployed[name] }),
    );
const result = {
    runtimeCodeHashes,
    ...plan,
    status: "deployed",
    proxyInitializationTransaction: hash,
    implementations: deployed,
    proxies,
    requiredSetup: {
        reporterCalls,
        minimumDelaySeconds: 172800,
        vrfConsumer: p.RandomnessAdapter,
        prefundOperationsReserve: true,
    },
    chainConfiguration: {
        chainId: 84532,
        usdc: config.usdc,
        contracts: {
            vault: p.StellariumBalanceVault,
            registry: p.ResourceRegistry,
            settlement: p.Settlement,
            feeOracle: p.FeeOracle,
            relayRegistry: p.RelayRegistry,
            reputation: p.ReputationRegistry,
            court: p.ArbitrationCourt,
            treasury: p.ProtocolTreasury,
            randomness: p.RandomnessAdapter,
            governor: p.Governor,
            timelock: p.TimelockController,
            launchMultisig: p.StewardMultisig,
        },
    },
};
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(
    `Deployment recorded in ${output}. Schedule the included reporter setup through the launch multisig and timelock, fund the reserve, and authorize the VRF consumer before use.`,
);
