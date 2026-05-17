/**
 * Estimate a cross-chain bridge: real Across quote + paymaster gas in the
 * token being bridged. Read-only counterpart to /api/bridge.
 *
 * Why this exists: the backend's /bridge/quote previously did
 * `outputAmount = inputAmount * 0.999` (just our 0.1% fee) and never
 * called Across. The actual execution at /api/bridge did call Across,
 * giving the user a different number than the preview. This endpoint
 * lets the backend show what `/api/bridge` will actually produce —
 * Across LP+relayer fees included — plus the paymaster gas the user
 * will pay on top.
 *
 * Mirrors estimateTransfer.ts: stub signer (no private key needed),
 * Tether-safe approves via buildPaymasterApproveCalls, heuristic gas
 * fallback when prepareUserOperation reverts (common for first-deploy
 * UserOps on Ethereum mainnet).
 */

import "dotenv/config";
import { ethers } from "ethers";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  createPublicClient,
  http,
  Address,
  parseUnits,
  parseAbi,
} from "viem";
import { entryPoint07Address, EntryPointVersion } from "viem/account-abstraction";
import { toAccount } from "viem/accounts";
import { CHAINS } from "./abstraction";
import { getAcrossQuote, buildBridgeCalls, type BridgeQuoteResponse } from "./bridge";
import { buildPaymasterApproveCalls } from "./paymasterApprove";

export interface EstimateBridgeArgs {
  sourceChainId: number;
  destChainId: number;
  tokenAddress: string;
  amount: number;
  ownerAddress: string;
  /** Recipient on the destination chain. Defaults to smart-wallet address. */
  recipient?: string;
  rpcUrl: string;
  bundlerUrl: string;
  paymasterRPC: string;
}

export interface EstimateBridgeData {
  sourceChainId: number;
  destChainId: number;
  smartAccount: string;
  /** Token bridged (lowercased). */
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Input the user is sending, human-readable. */
  inputAmount: string;
  /** What Across will deliver on the destination chain, human-readable.
   *  Already net of LP + relayer fee. */
  outputAmount: string;
  /** inputAmount − outputAmount — Across's protocol-level fee. */
  bridgeFee: string;
  /** Paymaster gas, in the same token, human-readable. */
  gasFeeInToken: string;
  /** inputAmount + gasFeeInToken — what the smart wallet must hold. */
  totalNeeded: string;
  /** Current smart-account balance, human-readable. */
  tokenBalance: string;
  /** Whether tokenBalance >= totalNeeded. */
  sufficient: boolean;
  /** totalNeeded − tokenBalance when not sufficient, else "0". */
  deficit: string;
  /** Across SpokePool address on the source chain. */
  spokePool: string;
  /** ETA in seconds (best-effort, Across rarely returns this — approximate). */
  estimatedFillSeconds: number;
  /** Pimlico paymaster the smart account approves. */
  paymaster: string;
  /** Raw native-currency gas cost (wei) — debug only. */
  rawGasNativeWei: string;
  /** True when the precise simulation failed and gas is heuristic. */
  degraded?: boolean;
  degradedReason?: string;
}

export interface EstimateBridgeResult {
  success: boolean;
  error?: string;
  data?: EstimateBridgeData;
}

function stubSignerFromAddress(address: string) {
  return toAccount({
    address: address as Address,
    async signMessage() {
      throw new Error("estimateBridge: stub signer cannot sign");
    },
    async signTransaction() {
      throw new Error("estimateBridge: stub signer cannot sign");
    },
    async signTypedData() {
      throw new Error("estimateBridge: stub signer cannot sign");
    },
  });
}

export async function estimateBridge(
  args: EstimateBridgeArgs
): Promise<EstimateBridgeResult> {
  try {
    const sourceChain = CHAINS[args.sourceChainId as keyof typeof CHAINS];
    if (!sourceChain) {
      return {
        success: false,
        error: `Unsupported source chain: ${args.sourceChainId}`,
      };
    }
    const destChainSupported =
      CHAINS[args.destChainId as keyof typeof CHAINS] != null;
    if (!destChainSupported) {
      return {
        success: false,
        error: `Unsupported destination chain: ${args.destChainId}`,
      };
    }

    const publicClient = createPublicClient({
      transport: http(args.rpcUrl),
      chain: sourceChain,
    });

    const pimlicoClient = createPimlicoClient({
      chain: sourceChain,
      transport: http(args.paymasterRPC),
      entryPoint: {
        address: entryPoint07Address,
        version: "0.7" as EntryPointVersion,
      },
    });

    // Derive smart account address from owner (read-only path).
    const stubSigner = stubSignerFromAddress(args.ownerAddress);
    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [stubSigner],
      version: "1.4.1",
    });

    const decimalsRaw = await publicClient.readContract({
      abi: parseAbi(["function decimals() view returns (uint8)"]),
      address: args.tokenAddress as Address,
      functionName: "decimals",
    });
    const decimals = Number(decimalsRaw);
    const symbolRaw = await publicClient
      .readContract({
        abi: parseAbi(["function symbol() view returns (string)"]),
        address: args.tokenAddress as Address,
        functionName: "symbol",
      })
      .catch(() => "TOKEN");
    const tokenSymbol = String(symbolRaw);

    const amountInWei = parseUnits(args.amount.toString(), decimals);

    const tokenBalanceRaw = await publicClient.readContract({
      abi: parseAbi(["function balanceOf(address) returns (uint256)"]),
      address: args.tokenAddress as Address,
      functionName: "balanceOf",
      args: [smartAccount.address],
    });
    const tokenBalance = BigInt(String(tokenBalanceRaw));

    // ── Real Across quote ────────────────────────────────────────
    const recipient = (args.recipient || smartAccount.address) as Address;
    let acrossQuote: BridgeQuoteResponse;
    try {
      acrossQuote = await getAcrossQuote(
        args.sourceChainId,
        args.destChainId,
        args.tokenAddress,
        amountInWei.toString(),
        recipient
      );
    } catch (e: any) {
      return {
        success: false,
        error: `Across quote failed: ${e?.message || "unknown"}`,
      };
    }

    const outputAmountWei = BigInt(acrossQuote.outputAmount);
    const bridgeFeeWei = amountInWei - outputAmountWei;

    // ── Pimlico paymaster context ────────────────────────────────
    const quotes = await pimlicoClient.getTokenQuotes({
      chain: sourceChain,
      tokens: [args.tokenAddress as Address],
    });
    if (!quotes || quotes.length === 0 || !quotes[0]?.paymaster) {
      return {
        success: false,
        error: `Token ${args.tokenAddress} not supported by Pimlico paymaster on chain ${args.sourceChainId}`,
      };
    }
    const paymasterAddress = quotes[0].paymaster;

    const smartAccountClient = createSmartAccountClient({
      account: smartAccount,
      chain: sourceChain,
      bundlerTransport: http(args.bundlerUrl),
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () =>
          (await pimlicoClient.getUserOperationGasPrice()).fast,
      },
    });

    // Build the SAME calls /api/bridge will execute: paymaster approve
    // (Tether-safe), Across spoke-pool approve + depositV3.
    const paymasterApproveCalls = await buildPaymasterApproveCalls(
      publicClient as any,
      args.tokenAddress as Address,
      smartAccount.address,
      paymasterAddress as Address
    );
    const bridgeCalls = buildBridgeCalls(
      acrossQuote,
      smartAccount.address,
      recipient,
      args.tokenAddress,
      amountInWei,
      args.destChainId
    );
    const calls = [...paymasterApproveCalls, ...bridgeCalls];

    // ── Try precise gas, fall back to heuristic on revert ────────
    let gasCostNativeWei: bigint;
    let gasFeeInTokenWei: bigint;
    let degraded = false;
    let degradedReason: string | undefined;

    try {
      const userOp: any = await smartAccountClient.prepareUserOperation({
        calls,
        paymasterContext: { token: args.tokenAddress as Address },
      });

      const totalGas =
        BigInt(userOp.preVerificationGas ?? 0) +
        BigInt(userOp.verificationGasLimit ?? 0) +
        BigInt(userOp.callGasLimit ?? 0) +
        BigInt(userOp.paymasterVerificationGasLimit ?? 0) +
        BigInt(userOp.paymasterPostOpGasLimit ?? 0);
      gasCostNativeWei = totalGas * BigInt(userOp.maxFeePerGas ?? 0);
      if (gasCostNativeWei === 0n) {
        throw new Error("prepareUserOperation returned zero gas limits");
      }
    } catch (simErr: any) {
      degraded = true;
      degradedReason = simErr?.message?.split("\n")[0] || "Simulation failed";
      console.warn(
        `[estimateBridge] prepareUserOperation failed, using heuristic — ${degradedReason}`
      );
      const code = await publicClient.getBytecode({
        address: smartAccount.address,
      });
      const isDeployed = !!code && code !== "0x";
      // Bridge UserOps are heavier than transfers (extra SpokePool call).
      // Pad accordingly.
      const heuristicGasLimit = isDeployed ? 500_000n : 1_100_000n;
      const gasPrice = await pimlicoClient.getUserOperationGasPrice();
      gasCostNativeWei = heuristicGasLimit * BigInt(gasPrice.fast.maxFeePerGas);
    }

    const exchangeRate = BigInt(quotes[0].exchangeRate);
    gasFeeInTokenWei = (gasCostNativeWei * exchangeRate) / 10n ** 18n;

    const totalNeededWei = amountInWei + gasFeeInTokenWei;
    const sufficient = tokenBalance >= totalNeededWei;
    const deficit = sufficient ? 0n : totalNeededWei - tokenBalance;

    return {
      success: true,
      data: {
        sourceChainId: args.sourceChainId,
        destChainId: args.destChainId,
        smartAccount: smartAccount.address,
        token: args.tokenAddress.toLowerCase(),
        tokenSymbol,
        tokenDecimals: decimals,
        inputAmount: ethers.utils.formatUnits(amountInWei.toString(), decimals),
        outputAmount: ethers.utils.formatUnits(
          outputAmountWei.toString(),
          decimals
        ),
        bridgeFee: ethers.utils.formatUnits(bridgeFeeWei.toString(), decimals),
        gasFeeInToken: ethers.utils.formatUnits(
          gasFeeInTokenWei.toString(),
          decimals
        ),
        totalNeeded: ethers.utils.formatUnits(
          totalNeededWei.toString(),
          decimals
        ),
        tokenBalance: ethers.utils.formatUnits(
          tokenBalance.toString(),
          decimals
        ),
        sufficient,
        deficit: ethers.utils.formatUnits(deficit.toString(), decimals),
        spokePool: acrossQuote.spokePoolAddress,
        estimatedFillSeconds: Math.max(
          0,
          Number(acrossQuote.fillDeadline) - Number(acrossQuote.timestamp)
        ),
        paymaster: paymasterAddress,
        rawGasNativeWei: gasCostNativeWei.toString(),
        ...(degraded
          ? {
              degraded: true as const,
              ...(degradedReason ? { degradedReason } : {}),
            }
          : {}),
      },
    };
  } catch (error: any) {
    console.error("estimateBridge error:", {
      message: error?.message,
      cause: error?.cause,
    });
    return {
      success: false,
      error: error?.message || "Unknown error during bridge estimation",
    };
  }
}
