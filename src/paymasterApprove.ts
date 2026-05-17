/**
 * Build the approve call(s) the smart account must include so the
 * paymaster can pull its gas fee in tokens.
 *
 * Why this isn't just `approve(paymaster, maxUint256)` every time:
 *
 *   Tether's USDT on Ethereum mainnet (0xdac1...) overrides ERC-20
 *   `approve` with a defense against the classic allowance race:
 *
 *     require(!((_value != 0) && (allowance[msg.sender][_spender] != 0)));
 *
 *   You CANNOT change a non-zero allowance directly to another non-zero
 *   value. You must first set it to zero. Hitting this require with no
 *   error string surfaces to viem as the famously opaque
 *   `The contract function "approve | transfer" returned no data ("0x")`
 *   — because the require revert returns 0 bytes.
 *
 *   So after the FIRST successful offramp, the SC has a non-zero
 *   allowance to the paymaster, and every subsequent offramp's
 *   approve(paymaster, maxUint256) silently reverts in simulation.
 *
 * The fix:
 *
 *   - Read the current allowance once.
 *   - If it already covers `needed`, return [] — no approve call needed,
 *     saves gas + dodges the race entirely.
 *   - If it's zero, return one approve(max) call — fresh approval.
 *   - If it's a small non-zero (Tether race territory), return TWO calls:
 *     approve(0), then approve(max). Tether allows non-zero → 0 and
 *     0 → any. Standard tokens also allow that pattern, so this works
 *     uniformly across all chains/tokens.
 *
 *   Threshold for "already enough": half of maxUint256. After a
 *   max-approve, even after years of paymaster pulls, allowance stays
 *   astronomically large; using max/2 as the threshold means we only
 *   re-approve when somebody has deliberately drained the allowance
 *   (eg by setting it to a small explicit value).
 */

import {
  type Address,
  type PublicClient,
  maxUint256,
  parseAbi,
} from "viem";

/** Threshold below which we consider the allowance "depleted" and re-approve. */
const ALLOWANCE_REFRESH_THRESHOLD = maxUint256 / 2n;

const ALLOWANCE_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const APPROVE_ABI = parseAbi(["function approve(address,uint256)"]);

export interface PaymasterApproveCall {
  to: Address;
  abi: any;
  functionName: "approve";
  args: [Address, bigint];
}

/**
 * Return the approve call(s) (zero or more) that should be prepended
 * to a paymaster-funded UserOp's calls array.
 *
 * @param publicClient  viem public client for the chain
 * @param tokenAddress  ERC-20 the paymaster pulls fees from
 * @param owner         smart account address (the `_owner` in allowance)
 * @param spender       paymaster address (the `_spender` in allowance)
 */
export async function buildPaymasterApproveCalls(
  publicClient: PublicClient,
  tokenAddress: Address,
  owner: Address,
  spender: Address
): Promise<PaymasterApproveCall[]> {
  let current: bigint;
  try {
    const raw = await publicClient.readContract({
      abi: ALLOWANCE_ABI,
      address: tokenAddress,
      functionName: "allowance",
      args: [owner, spender],
    });
    current = BigInt(String(raw));
  } catch {
    // allowance() read failed — be conservative and double-approve.
    current = 1n;
  }

  // Already plenty of allowance — skip entirely.
  if (current >= ALLOWANCE_REFRESH_THRESHOLD) {
    return [];
  }

  // Fresh — single max approve.
  if (current === 0n) {
    return [
      {
        to: tokenAddress,
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [spender, maxUint256],
      },
    ];
  }

  // Non-zero but depleted — Tether-safe double approve.
  return [
    {
      to: tokenAddress,
      abi: APPROVE_ABI,
      functionName: "approve",
      args: [spender, 0n],
    },
    {
      to: tokenAddress,
      abi: APPROVE_ABI,
      functionName: "approve",
      args: [spender, maxUint256],
    },
  ];
}
