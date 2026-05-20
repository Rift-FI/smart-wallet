/**
 * Global service-fee markup on every transfer relayed through the
 * smart-wallet API. The markup is a percentage of the user's transfer
 * amount, charged in the SAME token, paid as an additional ERC-20
 * transfer call in the SAME UserOperation that performs the user's
 * transfer.
 *
 * Settings (env, both required for markup to apply):
 *
 *   MARKUP_BPS                  – basis points (1 bp = 0.01%). Default 50 (0.5%).
 *                                  Set to "0" to disable markup entirely.
 *   RIFT_MARKUP_TREASURY_ADDRESS – EVM address that receives the markup.
 *                                  Same address used on every chain.
 *
 * If either is missing/zero, markup is silently disabled — the relay
 * behaves exactly as it did before this module existed. This keeps
 * the rollout safe: deploy the code, then flip the env to enable.
 *
 * No per-project override, no whitelisted bypass: applies to every
 * caller of the smart-wallet API, by product decision.
 */

import { Address, getAddress, parseAbi } from "viem";

const DEFAULT_MARKUP_BPS = 50; // 0.5%

/**
 * Resolved markup config. `enabled: false` means callers should skip
 * appending the markup transfer entirely.
 */
export interface MarkupConfig {
  enabled: boolean;
  bps: number;
  treasury: Address | null;
}

/**
 * @param overrideBps  When provided (caller passed a per-key bps from
 *   the backend's MARKUP_BPS_OVERRIDES), use it instead of the env
 *   default. 0 is a valid value — it means "no send markup for this
 *   key" — so we check for undefined, not falsiness.
 */
export function getMarkupConfig(overrideBps?: number): MarkupConfig {
  const rawTreasury = process.env.RIFT_MARKUP_TREASURY_ADDRESS;

  const bps =
    overrideBps !== undefined && Number.isFinite(overrideBps) && overrideBps >= 0
      ? overrideBps
      : process.env.MARKUP_BPS !== undefined
        ? Number(process.env.MARKUP_BPS)
        : DEFAULT_MARKUP_BPS;
  if (!Number.isFinite(bps) || bps < 0) {
    console.warn(
      `[markup] Invalid markup bps (override=${overrideBps}, env="${process.env.MARKUP_BPS}"); markup disabled until corrected.`
    );
    return { enabled: false, bps: 0, treasury: null };
  }
  if (bps === 0) {
    return { enabled: false, bps: 0, treasury: null };
  }

  if (!rawTreasury || !/^0x[a-fA-F0-9]{40}$/.test(rawTreasury)) {
    console.warn(
      "[markup] RIFT_MARKUP_TREASURY_ADDRESS is missing or invalid; markup disabled."
    );
    return { enabled: false, bps: 0, treasury: null };
  }

  return {
    enabled: true,
    bps,
    treasury: getAddress(rawTreasury) as Address,
  };
}

/**
 * Compute the markup amount (in raw token units) for a given transfer.
 * Floors the integer division — we always charge less than the precise
 * 0.5% rather than rounding up and risking the user being short.
 *
 * Returns 0n if the resulting markup would be 0 — caller should skip
 * appending the transfer call (transferring 0 reverts on USDT mainnet
 * and is wasteful gas on every token).
 */
export function computeMarkupAmount(
  transferAmountWei: bigint,
  bps: number
): bigint {
  if (bps <= 0) return 0n;
  return (transferAmountWei * BigInt(bps)) / 10_000n;
}

/**
 * Build the ERC-20 `transfer(treasury, markupAmount)` call that should
 * be appended to a UserOp's calls array. Returns `null` if markup is
 * disabled, treasury missing, or amount rounds to zero — callers
 * should detect null and skip appending.
 */
export function buildMarkupTransferCall(opts: {
  tokenAddress: Address;
  transferAmountWei: bigint;
  config: MarkupConfig;
}): {
  to: Address;
  abi: any;
  functionName: "transfer";
  args: [Address, bigint];
} | null {
  if (!opts.config.enabled || !opts.config.treasury) return null;
  const markup = computeMarkupAmount(opts.transferAmountWei, opts.config.bps);
  if (markup === 0n) return null;
  return {
    to: opts.tokenAddress,
    abi: parseAbi(["function transfer(address,uint256)"]),
    functionName: "transfer",
    args: [opts.config.treasury, markup],
  };
}

// ─── Flat-fee markup (used by bridge + universal txns) ───────────────
//
// For non-transfer flows (bridge, swap, arbitrary contract calls)
// there's no clear "transfer amount" to multiply 0.5% against. We
// instead charge a flat fee in the paymaster token (USDC / USDT,
// both 6 decimals) per UserOp.
//
// Configured via env:
//   MARKUP_FLAT_FEE_TOKEN_UNITS — raw token units. Default 100_000
//     (= $0.10 in any 6-decimal stable). Set to 0 to disable.
//
// Reuses the same RIFT_MARKUP_TREASURY_ADDRESS as the percentage
// markup — single destination, simpler accounting.

const DEFAULT_FLAT_FEE_TOKEN_UNITS = 100_000n; // $0.10 in USDC/USDT (6 decimals)

export interface FlatMarkupConfig {
  enabled: boolean;
  amountWei: bigint;
  treasury: Address | null;
}

export function getFlatMarkupConfig(): FlatMarkupConfig {
  const rawAmount = process.env.MARKUP_FLAT_FEE_TOKEN_UNITS;
  const rawTreasury = process.env.RIFT_MARKUP_TREASURY_ADDRESS;

  let amountWei: bigint;
  if (rawAmount === undefined) {
    amountWei = DEFAULT_FLAT_FEE_TOKEN_UNITS;
  } else {
    try {
      amountWei = BigInt(rawAmount);
    } catch {
      console.warn(
        `[markup] Invalid MARKUP_FLAT_FEE_TOKEN_UNITS="${rawAmount}"; flat markup disabled.`
      );
      return { enabled: false, amountWei: 0n, treasury: null };
    }
  }
  if (amountWei <= 0n) {
    return { enabled: false, amountWei: 0n, treasury: null };
  }
  if (!rawTreasury || !/^0x[a-fA-F0-9]{40}$/.test(rawTreasury)) {
    console.warn(
      "[markup] RIFT_MARKUP_TREASURY_ADDRESS missing or invalid; flat markup disabled."
    );
    return { enabled: false, amountWei: 0n, treasury: null };
  }
  return {
    enabled: true,
    amountWei,
    treasury: getAddress(rawTreasury) as Address,
  };
}

/**
 * Build a flat-fee transfer call for non-transfer flows (bridge,
 * universal txns). Returns null when disabled.
 *
 * The token used is whichever paymaster token the UserOp pays gas in —
 * caller passes `tokenAddress`. We trust the caller's token because
 * the flat fee env value is denominated in 6-decimal stable units
 * (matching USDC/USDT on every chain we support).
 */
export function buildFlatMarkupTransferCall(opts: {
  tokenAddress: Address;
  config: FlatMarkupConfig;
}): {
  to: Address;
  abi: any;
  functionName: "transfer";
  args: [Address, bigint];
} | null {
  if (!opts.config.enabled || !opts.config.treasury) return null;
  return {
    to: opts.tokenAddress,
    abi: parseAbi(["function transfer(address,uint256)"]),
    functionName: "transfer",
    args: [opts.config.treasury, opts.config.amountWei],
  };
}
