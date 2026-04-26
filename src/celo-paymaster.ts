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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── Config ─────────────────────────────────────────────────────────────

/** Deployed Celo Erc20Paymaster contract address (set after deployment) */
const CELO_PAYMASTER_ADDRESS = (process.env.CELO_PAYMASTER_ADDRESS || "") as Address;

/** Private key for the paymaster's off-chain signer (must match verifyingSigner on contract) */
const CELO_PAYMASTER_SIGNER_KEY = (process.env.CELO_PAYMASTER_SIGNER_KEY || "") as `0x${string}`;

/** Celo chain ID */
export const CELO_CHAIN_ID = 42220;

/** Supported tokens on Celo */
export const CELO_TOKENS: Record<string, { address: Address; decimals: number; symbol: string }> = {
  USDC: {
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    decimals: 6,
    symbol: "USDC",
  },
  USDT: {
    address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    decimals: 6,
    symbol: "USDT",
  },
};

/** All supported token addresses (lowercase) for quick lookup */
const SUPPORTED_TOKEN_ADDRESSES = new Set(
  Object.values(CELO_TOKENS).map((t) => t.address.toLowerCase())
);

/** Cached CELO price — refreshed via fetchCeloPrice() */
let celoPriceUsd = Number(process.env.CELO_PRICE_USD) || 0.5;

/** Last time the price was fetched (ms) */
let lastPriceFetchMs = 0;

/** How often to refresh the price (5 minutes) */
const PRICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Price markup in basis points (10000 = 100%, matches contract default of 11000 = 110%) */
const PRICE_MARKUP = Number(process.env.CELO_PRICE_MARKUP) || 11000;

// ─── Helpers ────────────────────────────────────────────────────────────

export function isCeloChain(chainId: number): boolean {
  return chainId === CELO_CHAIN_ID;
}

/** Returns the bundler URL for Celo (Pimlico — Pimlico bundles Celo even though it doesn't sponsor tokens there). */
export function getCeloBundlerUrl(): string {
  const url = process.env.CELO_BUNDLER_URL;
  if (!url) throw new Error("CELO_BUNDLER_URL env var not set.");
  return url;
}

export function isCeloSupportedToken(tokenAddress: string): boolean {
  return SUPPORTED_TOKEN_ADDRESSES.has(tokenAddress.toLowerCase());
}

/**
 * Fetch the current CELO price in USD from Coingecko's free API.
 * Caches the result for PRICE_REFRESH_INTERVAL_MS.
 *
 * Coingecko's free public endpoint requires no API key for low volume.
 */
export async function fetchCeloPrice(): Promise<number> {
  const now = Date.now();
  if (now - lastPriceFetchMs < PRICE_REFRESH_INTERVAL_MS && celoPriceUsd > 0) {
    return celoPriceUsd;
  }

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=celo&vs_currencies=usd"
    );

    if (!res.ok) {
      console.warn(`Coingecko price fetch failed (${res.status}), using cached price: $${celoPriceUsd}`);
      return celoPriceUsd;
    }

    const data = (await res.json()) as { celo?: { usd?: number } };
    const price = Number(data?.celo?.usd);
    if (price > 0) {
      celoPriceUsd = price;
      lastPriceFetchMs = now;
      console.log(`Celo paymaster CELO price updated from Coingecko: $${price}`);
    }
  } catch (err) {
    console.warn("Coingecko price fetch error, using cached price:", celoPriceUsd, err);
  }

  return celoPriceUsd;
}

export function setCeloPrice(priceUsd: number): void {
  celoPriceUsd = priceUsd;
  lastPriceFetchMs = Date.now();
  console.log(`Celo paymaster CELO price manually set: $${priceUsd}`);
}

export function getCeloPrice(): number {
  return celoPriceUsd;
}

/**
 * Get the paymaster contract address the smart account must approve.
 */
export function getCeloPaymasterAddress(): Address {
  if (!CELO_PAYMASTER_ADDRESS) {
    throw new Error("CELO_PAYMASTER_ADDRESS env var not set. Deploy the Celo paymaster contract first.");
  }
  return CELO_PAYMASTER_ADDRESS;
}

/**
 * Calculate how many token units equal a given gas cost in native wei.
 * Mirrors the on-chain getTokenCostForGas() logic.
 *
 * tokenCost = gasCostInWei * pricePerNative * markup / (1e18 * 10000)
 * where pricePerNative = celoPriceUsd * 10^decimals  (e.g. CELO=$0.5, USDC 6 dec → 500_000)
 */
export function estimateTokenCost(gasCostWei: bigint, tokenDecimals: number): bigint {
  const pricePerNative = BigInt(Math.round(celoPriceUsd * 10 ** tokenDecimals));
  return (gasCostWei * pricePerNative * BigInt(PRICE_MARKUP)) / (BigInt(1e18) * 10000n);
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
 * with (chainId, paymaster, token, validUntil, validAfter, pricePerNative).
 * Must match Erc20Paymaster.getHash() on-chain.
 */
function computePaymasterHash(
  userOp: UserOperationFields,
  token: Address,
  validUntil: number,
  validAfter: number,
  pricePerNative: bigint
): Hex {
  const initCode: Hex =
    userOp.factory && userOp.factoryData
      ? concat([userOp.factory, userOp.factoryData])
      : "0x";

  const accountGasLimits: Hex = concat([
    pad(toHex(userOp.verificationGasLimit), { size: 16 }),
    pad(toHex(userOp.callGasLimit), { size: 16 }),
  ]) as Hex;

  const gasFees: Hex = concat([
    pad(toHex(userOp.maxPriorityFeePerGas), { size: 16 }),
    pad(toHex(userOp.maxFeePerGas), { size: 16 }),
  ]) as Hex;

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, uint256, address, address, uint48, uint48, uint256"
    ),
    [
      userOp.sender,
      userOp.nonce,
      keccak256(initCode),
      keccak256(userOp.callData),
      accountGasLimits as `0x${string}`,
      userOp.preVerificationGas,
      gasFees as `0x${string}`,
      BigInt(CELO_CHAIN_ID),
      CELO_PAYMASTER_ADDRESS,
      token,
      validUntil,
      validAfter,
      pricePerNative,
    ]
  );

  return keccak256(encoded);
}

// ─── Paymaster middleware for permissionless ─────────────────────────────

/**
 * Create a paymaster middleware object compatible with permissionless's
 * createSmartAccountClient({ paymaster: ... }).
 *
 * @param tokenAddress  The ERC-20 token used to pay gas (USDC or USDT on Celo).
 */
export function createCeloPaymasterMiddleware(tokenAddress: Address) {
  if (!CELO_PAYMASTER_SIGNER_KEY) {
    throw new Error("CELO_PAYMASTER_SIGNER_KEY env var not set.");
  }
  if (!CELO_PAYMASTER_ADDRESS) {
    throw new Error("CELO_PAYMASTER_ADDRESS env var not set.");
  }

  const signerAccount = privateKeyToAccount(CELO_PAYMASTER_SIGNER_KEY);

  const getValidity = () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      validAfter: now - 60,
      validUntil: now + 10 * 60,
    };
  };

  const encodePaymasterData = (
    token: Address,
    validUntil: number,
    validAfter: number,
    pricePerNative: bigint,
    signature: Hex
  ): Hex => {
    return concat([
      token,                                         // 20 bytes
      pad(toHex(validUntil), { size: 6 }),           // 6 bytes
      pad(toHex(validAfter), { size: 6 }),           // 6 bytes
      pad(toHex(pricePerNative), { size: 32 }),      // 32 bytes
      signature,                                     // 65 bytes  → total 129 bytes
    ]) as Hex;
  };

  /**
   * Compute pricePerNative for the chosen gas token from the cached CELO/USD.
   * pricePerNative = how many smallest token units equal 1 native unit (1e18 wei).
   * For a 6-decimal token: pricePerNative = round(celoPriceUsd * 1e6).
   */
  const computePricePerNative = (token: Address): bigint => {
    const cfg = Object.values(CELO_TOKENS).find(
      (t) => t.address.toLowerCase() === token.toLowerCase()
    );
    if (!cfg) throw new Error(`Token ${token} not in CELO_TOKENS map`);
    return BigInt(Math.round(getCeloPrice() * 10 ** cfg.decimals));
  };

  const VERIFICATION_GAS_LIMIT = 150_000n;
  const POST_OP_GAS_LIMIT = 100_000n;

  return {
    getPaymasterStubData: async (_params: any) => {
      await fetchCeloPrice();
      const { validUntil, validAfter } = getValidity();
      const pricePerNative = computePricePerNative(tokenAddress);
      const stubSignature = ("0x" +
        "00".repeat(31) + "01" +
        "00".repeat(31) + "01" +
        "1b"
      ) as Hex;

      return {
        paymaster: CELO_PAYMASTER_ADDRESS,
        paymasterData: encodePaymasterData(tokenAddress, validUntil, validAfter, pricePerNative, stubSignature),
        paymasterVerificationGasLimit: VERIFICATION_GAS_LIMIT,
        paymasterPostOpGasLimit: POST_OP_GAS_LIMIT,
      };
    },

    getPaymasterData: async (params: any) => {
      await fetchCeloPrice();
      const { validUntil, validAfter } = getValidity();
      const pricePerNative = computePricePerNative(tokenAddress);

      console.log(`🔑 Signing Celo paymaster data: sender=${params.sender}, pricePerNative=${pricePerNative}`);

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
        validAfter,
        pricePerNative
      );

      const signature = await signerAccount.signMessage({
        message: { raw: hash },
      });

      return {
        paymaster: CELO_PAYMASTER_ADDRESS,
        paymasterData: encodePaymasterData(tokenAddress, validUntil, validAfter, pricePerNative, signature),
        paymasterVerificationGasLimit: VERIFICATION_GAS_LIMIT,
        paymasterPostOpGasLimit: POST_OP_GAS_LIMIT,
      };
    },
  };
}

/**
 * Build the approval call that must be prepended to the UserOp's calls
 * so the paymaster can pull tokens in postOp.
 */
export function buildCeloPaymasterApprovalCall(tokenAddress: Address) {
  return {
    to: getAddress(tokenAddress),
    value: BigInt(0),
    abi: parseAbi(["function approve(address,uint256)"]) as any,
    functionName: "approve",
    args: [getCeloPaymasterAddress(), maxUint256],
  };
}
