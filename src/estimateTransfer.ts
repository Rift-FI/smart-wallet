/**
 * Estimate the **gas fee, in the token being sent**, for an ERC-20 transfer
 * via our ERC-4337 smart account + paymaster setup. Mirrors the build path
 * of submitTransaction() in abstraction.ts but stops at
 * `prepareUserOperation` — never signs, never submits.
 *
 * Why this matters: on Ethereum mainnet the paymaster's gas fee in USDC/USDT
 * can be $1–3, so a user sending 100 USDC with exactly 100 USDC in their
 * wallet hits "paymaster rejected: insufficient token allowance/balance"
 * with no actionable error. With this endpoint the dashboard / app can:
 *
 *   1. Show the user "send 100 USDC, gas 0.42 USDC, total 100.42 USDC needed"
 *      before they tap Send.
 *   2. Hard-block submission when balance < totalNeeded.
 *
 * Read-only: takes an ownerAddress, not a private key. The smart account is
 * deterministically derived from the owner so we can prepare a UserOp
 * without ever needing to sign anything. A stub viem Account is passed to
 * permissionless's toSafeSmartAccount() — its signing methods throw if
 * accidentally invoked, but `prepareUserOperation` never invokes them.
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
  getAddress,
  parseAbi,
} from "viem";
import { entryPoint07Address, EntryPointVersion } from "viem/account-abstraction";
import { toAccount } from "viem/accounts";
import { CHAINS } from "./abstraction";
import {
  isCeloChain,
  isCeloSupportedToken,
  createCeloPaymasterMiddleware,
  getCeloPaymasterAddress,
  estimateTokenCost,
} from "./celo-paymaster";
import { buildPaymasterApproveCalls } from "./paymasterApprove";
import { getMarkupConfig, buildMarkupTransferCall } from "./markup";

export interface EstimateTransferArgs {
  chainId: number;
  rpcUrl: string;
  tokenAddress: string;
  amount: number; // human-readable, e.g. 100 for "100 USDC"
  recipient: string;
  ownerAddress: string;
  bundlerUrl: string;
  paymasterRPC: string;
  /** Per-key markup override (bps). Undefined → MARKUP_BPS env default. */
  markupBps?: number;
}

export interface EstimateTransferData {
  chainId: number;
  smartAccount: string;
  token: string;
  tokenDecimals: number;
  /** Amount the user wants to send, human-readable. */
  sendAmount: string;
  /** Estimated paymaster fee in the same token, human-readable. */
  gasFeeInToken: string;
  /** sendAmount + gasFeeInToken, human-readable. */
  totalNeeded: string;
  /** Current token balance of the smart account, human-readable. */
  tokenBalance: string;
  /** Whether tokenBalance >= totalNeeded. */
  sufficient: boolean;
  /** totalNeeded − tokenBalance if not sufficient, else "0". */
  deficit: string;
  /** Paymaster contract address (Pimlico or Celo). */
  paymaster: string;
  /** Raw native-currency gas cost (wei), exposed for debugging. */
  rawGasNativeWei: string;
  /**
   * `true` when prepareUserOperation simulation failed and the fee
   * was computed heuristically (gas price × typical gas limit). The
   * actual on-chain gas may be lower; the heuristic is intentionally
   * generous to keep the user safe.
   */
  degraded?: boolean;
  /** If `degraded`, the reason the precise simulation failed. */
  degradedReason?: string;
  /**
   * Just the paymaster's portion of `gasFeeInToken`. Same token,
   * same units. `gasFeeInToken = paymasterFeeInToken + markupFeeInToken`.
   */
  paymasterFeeInToken: string;
  /** Just the markup portion. 0 when markup is disabled. */
  markupFeeInToken: string;
  /** Markup rate applied. 0 when markup is disabled. */
  markupBps: number;
}

export interface EstimateTransferResult {
  success: boolean;
  error?: string;
  data?: EstimateTransferData;
}

/**
 * Build a viem Account that ONLY exposes the address. Signing methods
 * throw — they're never called by `prepareUserOperation`.
 */
function stubSignerFromAddress(address: string) {
  return toAccount({
    address: address as Address,
    async signMessage() {
      throw new Error("estimateTransfer: stub signer cannot sign");
    },
    async signTransaction() {
      throw new Error("estimateTransfer: stub signer cannot sign");
    },
    async signTypedData() {
      throw new Error("estimateTransfer: stub signer cannot sign");
    },
  });
}

export async function estimateTransfer(
  args: EstimateTransferArgs
): Promise<EstimateTransferResult> {
  try {
    const chain = CHAINS[args.chainId as keyof typeof CHAINS];
    if (!chain) {
      return { success: false, error: `Unsupported chain ID: ${args.chainId}` };
    }

    const publicClient = createPublicClient({
      transport: http(args.rpcUrl),
      chain,
    });

    const pimlicoClient = createPimlicoClient({
      chain,
      transport: http(args.paymasterRPC),
      entryPoint: {
        address: entryPoint07Address,
        version: "0.7" as EntryPointVersion,
      },
    });

    // Address-only owner → SAFE smart account address is deterministic.
    const stubSigner = stubSignerFromAddress(args.ownerAddress);
    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [stubSigner],
      version: "1.4.1",
    });

    // Token decimals + current balance.
    const decimalsRaw = await publicClient.readContract({
      abi: parseAbi(["function decimals() view returns (uint8)"]),
      address: args.tokenAddress as Address,
      functionName: "decimals",
    });
    const decimals = Number(decimalsRaw);
    const amountInWei = parseUnits(args.amount.toString(), decimals);

    const tokenBalanceRaw = await publicClient.readContract({
      abi: parseAbi(["function balanceOf(address) returns (uint256)"]),
      address: args.tokenAddress as Address,
      functionName: "balanceOf",
      args: [smartAccount.address],
    });
    // readContract's inferred return is `never` under exactOptionalPropertyTypes;
    // the underlying value is bigint. Coerce via String() to be defensive.
    const tokenBalance = BigInt(String(tokenBalanceRaw));

    // Build the same calls + paymaster the real transfer would.
    let calls: any[];
    let smartAccountClient: any;
    let paymasterAddress: string;

    if (isCeloChain(args.chainId)) {
      if (!isCeloSupportedToken(args.tokenAddress)) {
        return {
          success: false,
          error: `Token ${args.tokenAddress} not supported by Celo paymaster. Supported: USDC, USDT`,
        };
      }
      const celoPaymaster = createCeloPaymasterMiddleware(
        args.tokenAddress as Address
      );
      paymasterAddress = getCeloPaymasterAddress();

      smartAccountClient = createSmartAccountClient({
        account: smartAccount,
        chain,
        bundlerTransport: http(args.bundlerUrl),
        paymaster: celoPaymaster,
        userOperation: {
          estimateFeesPerGas: async () =>
            (await pimlicoClient.getUserOperationGasPrice()).fast,
        },
      });

      const celoApproveCalls = await buildPaymasterApproveCalls(
        publicClient as any,
        args.tokenAddress as Address,
        smartAccount.address,
        paymasterAddress as Address
      );
      calls = [
        ...celoApproveCalls,
        {
          to: getAddress(args.tokenAddress),
          abi: parseAbi(["function transfer(address,uint256)"]),
          functionName: "transfer",
          args: [getAddress(args.recipient), amountInWei],
        },
        // Mirror submitTransaction: markup transfer is part of the
        // UserOp so paymaster gas estimate accounts for the extra call.
        ...(() => {
          const c = buildMarkupTransferCall({
            tokenAddress: args.tokenAddress as Address,
            transferAmountWei: amountInWei,
            config: getMarkupConfig(args.markupBps),
          });
          return c ? [c] : [];
        })(),
      ];
    } else {
      const quotes = await pimlicoClient.getTokenQuotes({
        chain,
        tokens: [args.tokenAddress as Address],
      });
      if (!quotes || quotes.length === 0 || !quotes[0]?.paymaster) {
        return {
          success: false,
          error: `Token ${args.tokenAddress} not supported by Pimlico ERC-20 paymaster on this chain`,
        };
      }
      paymasterAddress = quotes[0].paymaster;

      smartAccountClient = createSmartAccountClient({
        account: smartAccount,
        chain,
        bundlerTransport: http(args.bundlerUrl),
        paymaster: pimlicoClient,
        userOperation: {
          estimateFeesPerGas: async () =>
            (await pimlicoClient.getUserOperationGasPrice()).fast,
        },
      });

      const pimlicoApproveCalls = await buildPaymasterApproveCalls(
        publicClient as any,
        args.tokenAddress as Address,
        smartAccount.address,
        paymasterAddress as Address
      );
      calls = [
        ...pimlicoApproveCalls,
        {
          to: getAddress(args.tokenAddress),
          abi: parseAbi(["function transfer(address,uint256)"]),
          functionName: "transfer",
          args: [getAddress(args.recipient), amountInWei],
        },
        // Mirror submitTransaction: markup transfer is part of the
        // UserOp so paymaster gas estimate accounts for the extra call.
        ...(() => {
          const c = buildMarkupTransferCall({
            tokenAddress: args.tokenAddress as Address,
            transferAmountWei: amountInWei,
            config: getMarkupConfig(args.markupBps),
          });
          return c ? [c] : [];
        })(),
      ];
    }

    // Build the UserOp without submitting. permissionless calls the bundler
    // to estimate gas and the paymaster to compute paymasterAndData — both
    // are read-only RPC calls.
    //
    // On Ethereum mainnet (and occasionally other chains) the bundler's
    // simulation reverts when the user's balance is near the edge of
    // covering (send amount + paymaster gas), or when the smart account
    // isn't deployed yet and Safe's first-deploy UserOp simulation is
    // flaky. The error surfaces as "approve | transfer returned no data
    // (0x)" or similar — opaque to the caller.
    //
    // Strategy: try the precise path first; if it fails, fall back to a
    // heuristic estimate (gas price × typical gas budget × paymaster
    // exchange rate). The UI gets `degraded: true` so it knows the
    // number is rough.
    let gasCostNativeWei: bigint;
    let gasFeeInTokenWei: bigint;
    let degraded = false;
    let degradedReason: string | undefined;

    try {
      const userOp: any = await smartAccountClient.prepareUserOperation({
        calls,
        ...(isCeloChain(args.chainId)
          ? {}
          : { paymasterContext: { token: args.tokenAddress as Address } }),
      });

      const preVerificationGas = BigInt(userOp.preVerificationGas ?? 0);
      const verificationGasLimit = BigInt(userOp.verificationGasLimit ?? 0);
      const callGasLimit = BigInt(userOp.callGasLimit ?? 0);
      const paymasterVerificationGasLimit = BigInt(
        userOp.paymasterVerificationGasLimit ?? 0
      );
      const paymasterPostOpGasLimit = BigInt(
        userOp.paymasterPostOpGasLimit ?? 0
      );
      const maxFeePerGas = BigInt(userOp.maxFeePerGas ?? 0);

      const totalGas =
        preVerificationGas +
        verificationGasLimit +
        callGasLimit +
        paymasterVerificationGasLimit +
        paymasterPostOpGasLimit;
      gasCostNativeWei = totalGas * maxFeePerGas;

      if (gasCostNativeWei === 0n) {
        // prepareUserOperation didn't throw but returned zero gas
        // limits — happens when the bundler RPC misbehaves. Treat as
        // a simulation failure and fall through to heuristic.
        throw new Error("prepareUserOperation returned zero gas limits");
      }
    } catch (simErr: any) {
      degraded = true;
      degradedReason = simErr?.message?.split("\n")[0] || "Simulation failed";
      console.warn(
        `[estimateTransfer] prepareUserOperation failed, using heuristic — ${degradedReason}`
      );

      // Check whether the smart account is already deployed. A fresh
      // deploy on Ethereum mainnet can use ~600k-1M gas; a subsequent
      // transfer is ~200k-350k. Pad either way for safety.
      const code = await publicClient.getBytecode({
        address: smartAccount.address,
      });
      const isDeployed = !!code && code !== "0x";
      const heuristicGasLimit = isDeployed ? 350_000n : 900_000n;

      const gasPrice = await pimlicoClient.getUserOperationGasPrice();
      const heuristicMaxFeePerGas = BigInt(gasPrice.fast.maxFeePerGas);
      gasCostNativeWei = heuristicGasLimit * heuristicMaxFeePerGas;
    }

    // Convert native-currency gas cost → token units.
    if (isCeloChain(args.chainId)) {
      // celo-paymaster's helper mirrors the on-chain pricing formula.
      gasFeeInTokenWei = estimateTokenCost(gasCostNativeWei, decimals);
    } else {
      // Pimlico's getTokenQuotes returns an exchangeRate scaled by 1e18:
      //   tokens (in token decimals) per 1 native unit (1e18 wei).
      const quote: any = (
        await pimlicoClient.getTokenQuotes({
          chain,
          tokens: [args.tokenAddress as Address],
        })
      )[0];
      const exchangeRate = BigInt(quote.exchangeRate);
      gasFeeInTokenWei = (gasCostNativeWei * exchangeRate) / 10n ** 18n;
    }

    // Markup math. Single source of truth: markup.ts. We compute here
    // EVEN IF buildMarkupTransferCall above returned null (markup
    // disabled / 0-amount), because we want the response shape to be
    // consistent — `markupFeeInToken: "0"` is honest signal.
    const markupConfig = getMarkupConfig(args.markupBps);
    const markupAmountWei = markupConfig.enabled
      ? (amountInWei * BigInt(markupConfig.bps)) / 10_000n
      : 0n;

    // `gasFeeInToken` = paymaster gas + markup. Combined value so old
    // clients (and the existing app UI) keep displaying the correct
    // total deducted. Breakdown fields below for new clients.
    const combinedFeeWei = gasFeeInTokenWei + markupAmountWei;
    const totalNeeded = amountInWei + combinedFeeWei;
    const sufficient = tokenBalance >= totalNeeded;
    const deficit = sufficient ? 0n : totalNeeded - tokenBalance;

    return {
      success: true,
      data: {
        chainId: args.chainId,
        smartAccount: smartAccount.address,
        token: args.tokenAddress,
        tokenDecimals: decimals,
        sendAmount: ethers.utils.formatUnits(amountInWei.toString(), decimals),
        // Combined fee — what the user's wallet actually loses per tx
        // BEYOND the send amount itself (paymaster + markup).
        gasFeeInToken: ethers.utils.formatUnits(
          combinedFeeWei.toString(),
          decimals
        ),
        paymasterFeeInToken: ethers.utils.formatUnits(
          gasFeeInTokenWei.toString(),
          decimals
        ),
        markupFeeInToken: ethers.utils.formatUnits(
          markupAmountWei.toString(),
          decimals
        ),
        markupBps: markupConfig.bps,
        totalNeeded: ethers.utils.formatUnits(totalNeeded.toString(), decimals),
        tokenBalance: ethers.utils.formatUnits(
          tokenBalance.toString(),
          decimals
        ),
        sufficient,
        deficit: ethers.utils.formatUnits(deficit.toString(), decimals),
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
    console.error("estimateTransfer error:", {
      message: error?.message,
      cause: error?.cause,
    });
    return {
      success: false,
      error: error?.message || "Unknown error during fee estimation",
    };
  }
}
