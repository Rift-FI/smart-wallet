import "dotenv/config";
import {
  Address,
  Hex,
  concat,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  parseAbiParameters,
  getAddress,
  maxUint256,
  parseAbi,
  createPublicClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lisk } from "viem/chains";

// ─── Config ─────────────────────────────────────────────────────────────

/** Deployed LiskPaymaster contract address (set after deployment) */
const LISK_PAYMASTER_ADDRESS = (process.env.LISK_PAYMASTER_ADDRESS || "") as Address;

/** Private key for the paymaster's off-chain signer (must match verifyingSigner on contract) */
const LISK_PAYMASTER_SIGNER_KEY = (process.env.LISK_PAYMASTER_SIGNER_KEY || "") as `0x${string}`;

/** Lisk chain ID */
export const LISK_CHAIN_ID = 1135;

/** Supported tokens on Lisk */
export const LISK_TOKENS: Record<string, { address: Address; decimals: number; symbol: string }> = {
  USDC: {
    address: "0xF242275d3a6527d877f2c927a82D9b057609cc71",
    decimals: 6,
    symbol: "USDC",
  },
  USDT: {
    address: "0x05D032ac25d322df992303dCa074EE7392C117b9",
    decimals: 6,
    symbol: "USDT",
  },
};

/** All supported token addresses (lowercase) for quick lookup */
const SUPPORTED_TOKEN_ADDRESSES = new Set(
  Object.values(LISK_TOKENS).map((t) => t.address.toLowerCase())
);

/** Enso API key for price fetches */
const ENSO_API_KEY = process.env.ENSO_API_KEY || "";

/** WETH address on Lisk (used to fetch ETH price from Enso) */
const LISK_WETH = "0x4200000000000000000000000000000000000006";

/** Cached ETH price — refreshed via fetchEthPrice() */
let ethPriceUsd = Number(process.env.LISK_ETH_PRICE_USD) || 2500;

/** Last time the price was fetched (ms) */
let lastPriceFetchMs = 0;

/** How often to refresh the price (5 minutes) */
const PRICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Price markup in basis points (10000 = 100%, matches contract) */
const PRICE_MARKUP = Number(process.env.LISK_PRICE_MARKUP) || 11000; // 110%

/** Gelato API key for bundler */
const GELATO_API_KEY = process.env.GELATO_API_KEY || "";

// ─── Helpers ────────────────────────────────────────────────────────────

export function isLiskChain(chainId: number): boolean {
  return chainId === LISK_CHAIN_ID;
}

/** Returns the Gelato bundler URL for Lisk */
export function getLiskBundlerUrl(): string {
  return `https://api.gelato.cloud/rpc/${LISK_CHAIN_ID}?apiKey=${GELATO_API_KEY}`;
}

export function isLiskSupportedToken(tokenAddress: string): boolean {
  return SUPPORTED_TOKEN_ADDRESSES.has(tokenAddress.toLowerCase());
}

/**
 * Fetch the current ETH price in USD from the Enso API.
 * Caches the result for PRICE_REFRESH_INTERVAL_MS.
 */
export async function fetchEthPrice(): Promise<number> {
  const now = Date.now();
  if (now - lastPriceFetchMs < PRICE_REFRESH_INTERVAL_MS && ethPriceUsd > 0) {
    return ethPriceUsd;
  }

  if (!ENSO_API_KEY) {
    console.warn("ENSO_API_KEY not set, using cached ETH price:", ethPriceUsd);
    return ethPriceUsd;
  }

  try {
    const res = await fetch(
      `https://api.enso.build/api/v1/prices/${LISK_CHAIN_ID}/${LISK_WETH}`,
      { headers: { Authorization: `Bearer ${ENSO_API_KEY}` } }
    );

    if (!res.ok) {
      console.warn(`Enso price fetch failed (${res.status}), using cached price: $${ethPriceUsd}`);
      return ethPriceUsd;
    }

    const data = (await res.json()) as { price?: number };
    const price = Number(data.price ?? data);
    if (price > 0) {
      ethPriceUsd = price;
      lastPriceFetchMs = now;
      console.log(`Lisk paymaster ETH price updated from Enso: $${price}`);
    }
  } catch (err) {
    console.warn("Enso price fetch error, using cached price:", ethPriceUsd, err);
  }

  return ethPriceUsd;
}

export function setEthPrice(priceUsd: number): void {
  ethPriceUsd = priceUsd;
  lastPriceFetchMs = Date.now();
  console.log(`Lisk paymaster ETH price manually set: $${priceUsd}`);
}

export function getEthPrice(): number {
  return ethPriceUsd;
}

/**
 * Get the paymaster contract address the smart account must approve.
 */
export function getLiskPaymasterAddress(): Address {
  if (!LISK_PAYMASTER_ADDRESS) {
    throw new Error("LISK_PAYMASTER_ADDRESS env var not set. Deploy the LiskPaymaster contract first.");
  }
  return LISK_PAYMASTER_ADDRESS;
}

/**
 * Calculate how many token units equal a given gas cost in native wei.
 * Mirrors the on-chain getTokenCostForGas() logic.
 *
 * tokenCost = gasCostInWei * pricePerEth * markup / (1e18 * 10000)
 * where pricePerEth = ethPriceUsd * 10^decimals  (e.g. 2500 * 1e6 = 2.5e9)
 */
export function estimateTokenCost(gasCostWei: bigint, tokenDecimals: number): bigint {
  const pricePerEth = BigInt(Math.round(ethPriceUsd * 10 ** tokenDecimals));
  return (gasCostWei * pricePerEth * BigInt(PRICE_MARKUP)) / (BigInt(1e18) * 10000n);
}

// ─── UserOp hash (must match contract's getHash) ───────────────────────

interface UserOperationFields {
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
}

/**
 * Pack the UserOp fields the same way EntryPoint v0.7 does, then hash
 * with (chainId, paymaster, token, validUntil, validAfter) — must match
 * LiskPaymaster.getHash() on-chain.
 */
function computePaymasterHash(
  userOp: UserOperationFields,
  token: Address,
  validUntil: number,
  validAfter: number
): Hex {
  // Pack initCode: factory + factoryData (or empty)
  const initCode: Hex =
    userOp.factory && userOp.factoryData
      ? concat([userOp.factory, userOp.factoryData])
      : "0x";

  // Pack accountGasLimits: bytes32 = verificationGasLimit(16) | callGasLimit(16)
  const accountGasLimits: Hex = concat([
    pad(toHex(userOp.verificationGasLimit), { size: 16 }),
    pad(toHex(userOp.callGasLimit), { size: 16 }),
  ]) as Hex;

  // Pack gasFees: bytes32 = maxPriorityFeePerGas(16) | maxFeePerGas(16)
  const gasFees: Hex = concat([
    pad(toHex(userOp.maxPriorityFeePerGas), { size: 16 }),
    pad(toHex(userOp.maxFeePerGas), { size: 16 }),
  ]) as Hex;

  // abi.encode(...) — same param order as the contract's getHash
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, uint256, address, address, uint48, uint48"
    ),
    [
      userOp.sender,
      userOp.nonce,
      keccak256(initCode),
      keccak256(userOp.callData),
      accountGasLimits as `0x${string}`,
      userOp.preVerificationGas,
      gasFees as `0x${string}`,
      BigInt(LISK_CHAIN_ID),
      LISK_PAYMASTER_ADDRESS,
      token,
      validUntil,
      validAfter,
    ]
  );

  return keccak256(encoded);
}

// ─── Paymaster middleware for permissionless ─────────────────────────────

/**
 * Create a paymaster middleware object compatible with permissionless's
 * createSmartAccountClient({ paymaster: ... }).
 *
 * @param tokenAddress  The ERC-20 token used to pay gas (USDC or USDT on Lisk).
 */
export function createLiskPaymasterMiddleware(tokenAddress: Address) {
  if (!LISK_PAYMASTER_SIGNER_KEY) {
    throw new Error("LISK_PAYMASTER_SIGNER_KEY env var not set.");
  }
  if (!LISK_PAYMASTER_ADDRESS) {
    throw new Error("LISK_PAYMASTER_ADDRESS env var not set.");
  }

  const signerAccount = privateKeyToAccount(LISK_PAYMASTER_SIGNER_KEY);

  // Validity window: current time → +10 minutes
  const getValidity = () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      validAfter: now - 60,          // allow 60s clock skew
      validUntil: now + 10 * 60,     // 10 minutes
    };
  };

  /**
   * Encode paymasterData: token(20) + validUntil(6) + validAfter(6) + signature(65)
   */
  const encodePaymasterData = (
    token: Address,
    validUntil: number,
    validAfter: number,
    signature: Hex
  ): Hex => {
    return concat([
      token,                                          // 20 bytes
      pad(toHex(validUntil), { size: 6 }),            // 6 bytes
      pad(toHex(validAfter), { size: 6 }),            // 6 bytes
      signature,                                      // 65 bytes
    ]) as Hex;
  };

  const VERIFICATION_GAS_LIMIT = 150_000n;
  const POST_OP_GAS_LIMIT = 100_000n;

  return {
    /**
     * Called during gas estimation. Returns a stub (dummy signature) so the
     * bundler can estimate gas without a real signature.
     */
    getPaymasterStubData: async (_params: any) => {
      await fetchEthPrice();
      const { validUntil, validAfter } = getValidity();
      // 65-byte dummy signature (won't pass on-chain validation, but same size)
      const stubSignature = ("0x" + "ff".repeat(65)) as Hex;

      return {
        paymaster: LISK_PAYMASTER_ADDRESS,
        paymasterData: encodePaymasterData(tokenAddress, validUntil, validAfter, stubSignature),
        paymasterVerificationGasLimit: VERIFICATION_GAS_LIMIT,
        paymasterPostOpGasLimit: POST_OP_GAS_LIMIT,
      };
    },

    /**
     * Called after gas estimation with the finalized UserOp.
     * Signs the UserOp hash and returns real paymasterData.
     */
    getPaymasterData: async (params: any) => {
      await fetchEthPrice();
      // params is a flat object with UserOp fields + chainId + entryPointAddress
      const { validUntil, validAfter } = getValidity();

      console.log(`🔑 Signing paymaster data for sender: ${params.sender}`);

      // Compute hash matching the on-chain getHash()
      const hash = computePaymasterHash(
        {
          sender: params.sender,
          nonce: BigInt(params.nonce),
          factory: params.factory,
          factoryData: params.factoryData,
          callData: params.callData,
          callGasLimit: BigInt(params.callGasLimit),
          verificationGasLimit: BigInt(params.verificationGasLimit),
          preVerificationGas: BigInt(params.preVerificationGas),
          maxFeePerGas: BigInt(params.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(params.maxPriorityFeePerGas),
        },
        tokenAddress,
        validUntil,
        validAfter
      );

      // Sign with EIP-191 personal sign (matches toEthSignedMessageHash on-chain)
      const signature = await signerAccount.signMessage({
        message: { raw: hash },
      });

      return {
        paymaster: LISK_PAYMASTER_ADDRESS,
        paymasterData: encodePaymasterData(tokenAddress, validUntil, validAfter, signature),
        paymasterVerificationGasLimit: VERIFICATION_GAS_LIMIT,
        paymasterPostOpGasLimit: POST_OP_GAS_LIMIT,
      };
    },
  };
}

/**
 * Estimate gas fees on Lisk using the public RPC (no Pimlico dependency).
 */
export async function getLiskGasFees(rpcUrl: string) {
  const client = createPublicClient({ transport: http(rpcUrl), chain: lisk });
  const gasPrice = await client.getGasPrice();
  // L2 gas is cheap — use simple multiplier
  return {
    maxFeePerGas: (gasPrice * 150n) / 100n,       // 1.5x
    maxPriorityFeePerGas: (gasPrice * 10n) / 100n, // 10% of base
  };
}

/**
 * Build the approval call that must be prepended to the UserOp's calls
 * so the paymaster can pull tokens in postOp.
 */
export function buildLiskPaymasterApprovalCall(tokenAddress: Address) {
  return {
    to: getAddress(tokenAddress),
    value: BigInt(0),
    abi: parseAbi(["function approve(address,uint256)"]) as any,
    functionName: "approve",
    args: [getLiskPaymasterAddress(), maxUint256],
  };
}
