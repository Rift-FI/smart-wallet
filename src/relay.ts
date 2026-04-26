import "dotenv/config";
import {
  createPublicClient,
  http,
  Address,
  Hex,
  parseUnits,
  getAddress,
  maxUint256,
  parseAbi,
  encodePacked,
  keccak256,
  encodeAbiParameters,
  toBytes,
  toHex,
  concat,
  pad,
} from "viem";
import { entryPoint07Address, EntryPointVersion } from "viem/account-abstraction";
import { toAccount } from "viem/accounts";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { ethers } from "ethers";
import { CHAINS } from "./abstraction";
import {
  isCeloChain,
  isCeloSupportedToken,
  createCeloPaymasterMiddleware,
  getCeloPaymasterAddress,
  buildCeloPaymasterApprovalCall,
} from "./celo-paymaster";

// ─── Constants ──────────────────────────────────────────────────────────

/** Safe4337Module v0.3.0 address (EntryPoint v0.7) */
const SAFE_4337_MODULE_ADDRESS: Address = "0x75cf11467937ce3f2f357CE24ffc3DBF8fD5c226";

/** EIP-712 type hash for SafeOp struct */
const SAFE_OP_TYPEHASH = keccak256(
  toBytes(
    "SafeOp(address safe,uint256 nonce,bytes32 initCode,bytes32 callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes32 paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)"
  )
);

/** EIP-712 domain separator type hash */
const DOMAIN_SEPARATOR_TYPEHASH = keccak256(
  toBytes("EIP712Domain(uint256 chainId,address verifyingContract)")
);

// ─── Internal Helpers ───────────────────────────────────────────────────

/**
 * Create a non-signing owner account for UserOp preparation.
 * The smart account address is deterministic based on owner address alone.
 */
function createDummyOwner(address: Address) {
  return toAccount({
    address,
    async signMessage() {
      // Valid-format dummy sig for gas estimation (r=1, s=1, v=27)
      return ("0x" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "1b") as Hex;
    },
    async signTransaction() {
      return "0x" as Hex;
    },
    async signTypedData() {
      return "0x" as Hex;
    },
  });
}

/**
 * Compute the Safe operation hash (EIP-712 structured hash).
 * This is what the owner signs via personal_sign.
 * Must match Safe4337Module._getOperationHash() on-chain.
 */
function computeSafeOperationHash(
  userOp: {
    sender: Address;
    nonce: bigint;
    factory?: Address;
    factoryData?: Hex;
    callData: Hex;
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    paymaster?: Address;
    paymasterVerificationGasLimit?: bigint;
    paymasterPostOpGasLimit?: bigint;
    paymasterData?: Hex;
  },
  chainId: number
): Hex {
  // Derive initCode (v0.7: factory + factoryData, or empty)
  const initCode: Hex = userOp.factory
    ? concat([userOp.factory, userOp.factoryData || "0x"])
    : "0x";

  // Derive paymasterAndData (v0.7: paymaster + verificationGasLimit + postOpGasLimit + data)
  let paymasterAndData: Hex = "0x";
  if (userOp.paymaster) {
    paymasterAndData = concat([
      userOp.paymaster,
      pad(toHex(userOp.paymasterVerificationGasLimit || 0n), { size: 16 }),
      pad(toHex(userOp.paymasterPostOpGasLimit || 0n), { size: 16 }),
      userOp.paymasterData || "0x",
    ]) as Hex;
  }

  // Encode SafeOp struct
  const safeOpData = encodeAbiParameters(
    [
      { type: "bytes32" }, // SAFE_OP_TYPEHASH
      { type: "address" }, // safe
      { type: "uint256" }, // nonce
      { type: "bytes32" }, // keccak256(initCode)
      { type: "bytes32" }, // keccak256(callData)
      { type: "uint128" }, // verificationGasLimit
      { type: "uint128" }, // callGasLimit
      { type: "uint256" }, // preVerificationGas
      { type: "uint128" }, // maxPriorityFeePerGas
      { type: "uint128" }, // maxFeePerGas
      { type: "bytes32" }, // keccak256(paymasterAndData)
      { type: "uint48" },  // validAfter
      { type: "uint48" },  // validUntil
      { type: "address" }, // entryPoint
    ],
    [
      SAFE_OP_TYPEHASH,
      userOp.sender,
      userOp.nonce,
      keccak256(initCode),
      keccak256(userOp.callData),
      userOp.verificationGasLimit,
      userOp.callGasLimit,
      userOp.preVerificationGas,
      userOp.maxPriorityFeePerGas,
      userOp.maxFeePerGas,
      keccak256(paymasterAndData),
      0, // validAfter (matches signature prefix)
      0, // validUntil (matches signature prefix)
      entryPoint07Address,
    ]
  );

  // Domain separator
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), SAFE_4337_MODULE_ADDRESS]
    )
  );

  // EIP-712 hash
  return keccak256(
    encodePacked(
      ["bytes1", "bytes1", "bytes32", "bytes32"],
      ["0x19", "0x01", domainSeparator, keccak256(safeOpData)]
    )
  );
}

/**
 * Encode the client's personal_sign signature into Safe UserOp format.
 * Adjusts v by +4 for Safe's eth_sign verification path,
 * then prepends validAfter + validUntil timestamps.
 */
function encodeSafeUserOpSignature(clientSignature: Hex): Hex {
  const sigBytes = clientSignature.slice(2); // remove 0x
  const r = sigBytes.slice(0, 64);
  const s = sigBytes.slice(64, 128);
  const v = parseInt(sigBytes.slice(128, 130), 16);

  // Safe expects v + 4 for eth_sign flow (27→31, 28→32)
  const adjustedV = (v + 4).toString(16).padStart(2, "0");
  const adjustedSig = `0x${r}${s}${adjustedV}` as Hex;

  // Encode: uint48(validAfter=0) + uint48(validUntil=0) + adjustedSignature
  return encodePacked(
    ["uint48", "uint48", "bytes"],
    [0, 0, adjustedSig]
  );
}

/**
 * Serialize a prepared UserOp for JSON transport (BigInt → hex strings).
 */
function serializeUserOp(userOp: any, sender: Address) {
  return {
    sender,
    nonce: toHex(userOp.nonce),
    callData: userOp.callData,
    callGasLimit: toHex(userOp.callGasLimit),
    verificationGasLimit: toHex(userOp.verificationGasLimit),
    preVerificationGas: toHex(userOp.preVerificationGas),
    maxFeePerGas: toHex(userOp.maxFeePerGas),
    maxPriorityFeePerGas: toHex(userOp.maxPriorityFeePerGas),
    signature: userOp.signature,
    ...(userOp.factory ? { factory: userOp.factory } : {}),
    ...(userOp.factoryData ? { factoryData: userOp.factoryData } : {}),
    ...(userOp.paymaster ? { paymaster: userOp.paymaster } : {}),
    ...(userOp.paymasterData ? { paymasterData: userOp.paymasterData } : {}),
    ...(userOp.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: toHex(userOp.paymasterVerificationGasLimit) }
      : {}),
    ...(userOp.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: toHex(userOp.paymasterPostOpGasLimit) }
      : {}),
  };
}

/**
 * Deserialize a UserOp from JSON transport (hex strings → BigInt).
 */
function deserializeUserOp(userOp: any) {
  return {
    sender: userOp.sender as Address,
    nonce: BigInt(userOp.nonce),
    callData: userOp.callData as Hex,
    callGasLimit: BigInt(userOp.callGasLimit),
    verificationGasLimit: BigInt(userOp.verificationGasLimit),
    preVerificationGas: BigInt(userOp.preVerificationGas),
    maxFeePerGas: BigInt(userOp.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(userOp.maxPriorityFeePerGas),
    ...(userOp.factory ? { factory: userOp.factory as Address } : {}),
    ...(userOp.factoryData ? { factoryData: userOp.factoryData as Hex } : {}),
    ...(userOp.paymaster ? { paymaster: userOp.paymaster as Address } : {}),
    ...(userOp.paymasterData ? { paymasterData: userOp.paymasterData as Hex } : {}),
    ...(userOp.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: BigInt(userOp.paymasterVerificationGasLimit) }
      : {}),
    ...(userOp.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: BigInt(userOp.paymasterPostOpGasLimit) }
      : {}),
  };
}

// ─── Core: Prepare UserOp ───────────────────────────────────────────────

export interface PrepareResult {
  smartAccountAddress: Address;
  userOperation: Record<string, any>;
  hashToSign: Hex;
  chainId: number;
}

/**
 * Core function: create smart account client and prepare a UserOp.
 * Returns the prepared (unsigned) UserOp and the Safe operation hash
 * that the client must sign via personal_sign.
 */
async function prepareUserOp(
  smartAccount: any,
  chain: any,
  chainId: number,
  rpcUrl: string,
  bundlerUrl: string,
  paymasterRPC: string,
  calls: any[],
  paymasterToken?: string
): Promise<PrepareResult> {
  let smartAccountClient;

  if (isCeloChain(chainId) && paymasterToken) {
    const celoPaymaster = createCeloPaymasterMiddleware(paymasterToken as Address);
    const pimlicoClient = createPimlicoClient({
      chain,
      transport: http(paymasterRPC),
      entryPoint: { address: entryPoint07Address, version: "0.7" as EntryPointVersion },
    });
    console.log(`📡 [v2] Using Pimlico bundler + Celo custom paymaster`);

    smartAccountClient = createSmartAccountClient({
      account: smartAccount,
      chain,
      bundlerTransport: http(bundlerUrl),
      paymaster: celoPaymaster,
      userOperation: {
        estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
      },
    });
  } else {
    const pimlicoClient = createPimlicoClient({
      chain,
      transport: http(paymasterRPC),
      entryPoint: { address: entryPoint07Address, version: "0.7" as EntryPointVersion },
    });

    smartAccountClient = createSmartAccountClient({
      account: smartAccount,
      chain,
      bundlerTransport: http(bundlerUrl),
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
      },
    });
  }

  // Prepare the UserOp (gas estimation + paymaster data)
  console.log(`🔧 [v2] Preparing UserOperation (${calls.length} calls)...`);
  const preparedUserOp: any = await (smartAccountClient as any).prepareUserOperation({
    calls,
    ...(paymasterToken && !isCeloChain(chainId)
      ? { paymasterContext: { token: paymasterToken as Address } }
      : {}),
  });

  // Compute the Safe operation hash (what the client signs)
  const hashToSign = computeSafeOperationHash(
    {
      sender: smartAccount.address,
      nonce: preparedUserOp.nonce,
      factory: preparedUserOp.factory,
      factoryData: preparedUserOp.factoryData,
      callData: preparedUserOp.callData,
      callGasLimit: preparedUserOp.callGasLimit,
      verificationGasLimit: preparedUserOp.verificationGasLimit,
      preVerificationGas: preparedUserOp.preVerificationGas,
      maxFeePerGas: preparedUserOp.maxFeePerGas,
      maxPriorityFeePerGas: preparedUserOp.maxPriorityFeePerGas,
      paymaster: preparedUserOp.paymaster,
      paymasterVerificationGasLimit: preparedUserOp.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: preparedUserOp.paymasterPostOpGasLimit,
      paymasterData: preparedUserOp.paymasterData,
    },
    chainId
  );

  console.log(`✅ [v2] UserOp prepared. Hash to sign: ${hashToSign}`);

  return {
    smartAccountAddress: smartAccount.address,
    userOperation: serializeUserOp(preparedUserOp, smartAccount.address),
    hashToSign,
    chainId,
  };
}

// ─── Public API: Prepare Transfer ───────────────────────────────────────

/**
 * Prepare a token transfer UserOp for client-side signing.
 * No private key required — only the owner's address.
 */
export async function prepareTransfer(params: {
  ownerAddress: string;
  chainId: number;
  rpcUrl: string;
  tokenAddress: string;
  recipient: string;
  amount: number;
  bundlerUrl: string;
  paymasterRPC: string;
}): Promise<PrepareResult> {
  const { ownerAddress, chainId, rpcUrl, tokenAddress, recipient, amount, bundlerUrl, paymasterRPC } = params;

  const chain = CHAINS[chainId as keyof typeof CHAINS];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);

  const publicClient = createPublicClient({ transport: http(rpcUrl), chain });
  const dummyOwner = createDummyOwner(ownerAddress as Address);

  const smartAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [dummyOwner as any],
    version: "1.4.1",
  });

  console.log(`🏦 [v2] Smart account: ${smartAccount.address} (owner: ${ownerAddress})`);

  // Get token decimals and check balance
  const tokenContract = new ethers.Contract(
    tokenAddress,
    ["function decimals() view returns (uint8)"],
    new ethers.providers.JsonRpcProvider(rpcUrl)
  );
  const decimals = await tokenContract.decimals();
  const amountInWei = parseUnits(amount.toString(), decimals);

  const balance = await publicClient.readContract({
    abi: parseAbi(["function balanceOf(address) returns (uint256)"]),
    address: tokenAddress as Address,
    functionName: "balanceOf",
    args: [smartAccount.address],
  });

  if (balance < amountInWei) {
    throw new Error(
      `Insufficient balance. Required: ${ethers.utils.formatUnits(amountInWei.toString(), decimals)}, Available: ${ethers.utils.formatUnits(String(balance), decimals)}`
    );
  }

  // Build calls
  const calls = await buildTransferCalls(chainId, chain, tokenAddress as Address, recipient as Address, amountInWei, paymasterRPC);

  return await prepareUserOp(smartAccount, chain, chainId, rpcUrl, bundlerUrl, paymasterRPC, calls, tokenAddress);
}

// ─── Public API: Prepare Transaction ────────────────────────────────────

/**
 * Prepare a universal transaction UserOp for client-side signing.
 * No private key required — only the owner's address.
 */
export async function prepareTransaction(params: {
  ownerAddress: string;
  chainId: number;
  rpcUrl: string;
  calls: Array<{
    to: string;
    value?: string;
    data?: string;
    abi?: any[];
    functionName?: string;
    args?: any[];
  }>;
  bundlerUrl: string;
  paymasterRPC: string;
  paymasterToken?: string;
}): Promise<PrepareResult> {
  const { ownerAddress, chainId, rpcUrl, calls, bundlerUrl, paymasterRPC, paymasterToken } = params;

  const chain = CHAINS[chainId as keyof typeof CHAINS];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);

  const publicClient = createPublicClient({ transport: http(rpcUrl), chain });
  const dummyOwner = createDummyOwner(ownerAddress as Address);

  const smartAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [dummyOwner as any],
    version: "1.4.1",
  });

  console.log(`🏦 [v2] Smart account: ${smartAccount.address} (owner: ${ownerAddress})`);

  // Build transaction calls
  const transactionCalls: any[] = calls.map((call) => {
    if (call.abi && call.functionName && call.args) {
      return {
        to: getAddress(call.to),
        value: call.value ? BigInt(call.value) : 0n,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
      };
    } else if (call.data) {
      return {
        to: getAddress(call.to),
        value: call.value ? BigInt(call.value) : 0n,
        data: call.data as `0x${string}`,
      };
    } else {
      return {
        to: getAddress(call.to),
        value: call.value ? BigInt(call.value) : 0n,
      };
    }
  });

  // Add paymaster approval if needed
  if (isCeloChain(chainId) && paymasterToken) {
    if (!isCeloSupportedToken(paymasterToken)) {
      throw new Error(`Token ${paymasterToken} not supported by Celo paymaster`);
    }
    transactionCalls.unshift(buildCeloPaymasterApprovalCall(paymasterToken as Address));
  } else if (paymasterToken) {
    const pimlicoClient = createPimlicoClient({
      chain,
      transport: http(paymasterRPC),
      entryPoint: { address: entryPoint07Address, version: "0.7" as EntryPointVersion },
    });

    const quotes = await pimlicoClient.getTokenQuotes({ chain, tokens: [paymasterToken as Address] });
    if (!quotes?.length) throw new Error(`Token ${paymasterToken} not supported by paymaster`);

    const paymaster = quotes[0]?.paymaster;
    if (!paymaster) throw new Error(`No paymaster for ${paymasterToken}`);

    transactionCalls.unshift({
      to: getAddress(paymasterToken),
      value: 0n,
      abi: parseAbi(["function approve(address,uint256)"]) as any,
      functionName: "approve",
      args: [paymaster, maxUint256],
    });
  }

  return await prepareUserOp(smartAccount, chain, chainId, rpcUrl, bundlerUrl, paymasterRPC, transactionCalls, paymasterToken);
}

// ─── Public API: Submit Signed UserOp ───────────────────────────────────

/**
 * Submit a client-signed UserOperation to the bundler.
 * The client provides their personal_sign signature of the hashToSign.
 */
export async function submitSignedUserOp(params: {
  chainId: number;
  userOperation: any;
  signature: Hex;
  bundlerUrl: string;
}): Promise<{ userOperationHash: string }> {
  const { chainId, userOperation, signature, bundlerUrl } = params;

  const chain = CHAINS[chainId as keyof typeof CHAINS];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);

  // Encode signature in Safe format (adjust v, prepend timestamps)
  const safeSignature = encodeSafeUserOpSignature(signature);

  // Determine bundler URL
  const actualBundlerUrl = bundlerUrl;

  // Deserialize UserOp and set the real signature
  const userOp: any = deserializeUserOp(userOperation);
  userOp.signature = safeSignature;

  console.log(`📤 [v2] Submitting signed UserOp to bundler: ${actualBundlerUrl}`);

  // Send via eth_sendUserOperation JSON-RPC
  const response = await fetch(actualBundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendUserOperation",
      params: [
        formatUserOpForRpc(userOp),
        entryPoint07Address,
      ],
      id: 1,
    }),
  });

  const result = await response.json() as any;

  if (result.error) {
    throw new Error(`Bundler error: ${result.error.message || JSON.stringify(result.error)}`);
  }

  const userOperationHash = result.result;
  console.log(`✅ [v2] UserOp submitted. Hash: ${userOperationHash}`);

  return { userOperationHash };
}

/**
 * Format a deserialized UserOp for the eth_sendUserOperation JSON-RPC call.
 * All values must be hex strings.
 */
function formatUserOpForRpc(userOp: any) {
  return {
    sender: userOp.sender,
    nonce: toHex(userOp.nonce),
    callData: userOp.callData,
    callGasLimit: toHex(userOp.callGasLimit),
    verificationGasLimit: toHex(userOp.verificationGasLimit),
    preVerificationGas: toHex(userOp.preVerificationGas),
    maxFeePerGas: toHex(userOp.maxFeePerGas),
    maxPriorityFeePerGas: toHex(userOp.maxPriorityFeePerGas),
    signature: userOp.signature,
    // v0.7 fields (non-packed)
    factory: userOp.factory || undefined,
    factoryData: userOp.factoryData || undefined,
    paymaster: userOp.paymaster || undefined,
    paymasterVerificationGasLimit: userOp.paymasterVerificationGasLimit
      ? toHex(userOp.paymasterVerificationGasLimit)
      : undefined,
    paymasterPostOpGasLimit: userOp.paymasterPostOpGasLimit
      ? toHex(userOp.paymasterPostOpGasLimit)
      : undefined,
    paymasterData: userOp.paymasterData || undefined,
  };
}

// ─── Helper: Build Transfer Calls ───────────────────────────────────────

async function buildTransferCalls(
  chainId: number,
  chain: any,
  tokenAddress: Address,
  recipient: Address,
  amountInWei: bigint,
  paymasterRPC: string
): Promise<any[]> {
  if (isCeloChain(chainId)) {
    if (!isCeloSupportedToken(tokenAddress)) {
      throw new Error(`Token ${tokenAddress} not supported by Celo paymaster. Supported: USDC, USDT`);
    }
    const paymasterAddress = getCeloPaymasterAddress();
    return [
      {
        to: getAddress(tokenAddress),
        abi: parseAbi(["function approve(address,uint256)"]),
        functionName: "approve",
        args: [paymasterAddress, maxUint256],
      },
      {
        to: getAddress(tokenAddress),
        abi: parseAbi(["function transfer(address,uint256)"]),
        functionName: "transfer",
        args: [getAddress(recipient), amountInWei],
      },
    ];
  }

  // Pimlico path
  const pimlicoClient = createPimlicoClient({
    chain,
    transport: http(paymasterRPC),
    entryPoint: { address: entryPoint07Address, version: "0.7" as EntryPointVersion },
  });

  const quotes = await pimlicoClient.getTokenQuotes({ chain, tokens: [tokenAddress] });
  if (!quotes?.length) throw new Error(`Token ${tokenAddress} not supported by paymaster`);

  const paymaster = quotes[0]?.paymaster;
  if (!paymaster) throw new Error(`No paymaster for ${tokenAddress}`);

  return [
    {
      to: getAddress(tokenAddress),
      abi: parseAbi(["function approve(address,uint256)"]),
      functionName: "approve",
      args: [paymaster, maxUint256],
    },
    {
      to: getAddress(tokenAddress),
      abi: parseAbi(["function transfer(address,uint256)"]),
      functionName: "transfer",
      args: [getAddress(recipient), amountInWei],
    },
  ];
}
