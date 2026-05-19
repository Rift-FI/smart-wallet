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

export function getMarkupConfig(): MarkupConfig {
  const rawBps = process.env.MARKUP_BPS;
  const rawTreasury = process.env.RIFT_MARKUP_TREASURY_ADDRESS;

  const bps = rawBps !== undefined ? Number(rawBps) : DEFAULT_MARKUP_BPS;
  if (!Number.isFinite(bps) || bps < 0) {
    console.warn(
      `[markup] Invalid MARKUP_BPS="${rawBps}"; markup disabled until corrected.`
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
