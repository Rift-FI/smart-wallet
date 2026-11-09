/**
 * UserOp relay: build (prepare) and submit.
 *
 * Production: Pimlico bundler per chain, paymaster per gas plan
 * (Pimlico verifying / ERC-20 paymaster, Rift's Celo Erc20Paymaster, or
 * none when the Safe pays native gas).
 *
 * Test only (NODE_ENV=test AND RELAY_MODE=direct): no bundler. The op is
 * filled with fixed gas limits and submitted via EntryPoint.handleOps from
 * a funded account (RELAY_DIRECT_PRIVATE_KEY, default anvil account #0).
 */

import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  createBundlerClient,
  entryPoint07Abi,
  entryPoint07Address,
  formatUserOperationRequest,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, getChainConfig, getRpcUrl } from "../chainConfig";
import { createCeloPaymasterMiddleware } from "../celo-paymaster";
import { PasskeyError } from "./errors";
import type { SafeAccount } from "./account";
import type { GasPlan, GasSpec } from "./gas";
import type { UserOp } from "./userOp";

const ENTRY_POINT = { address: entryPoint07Address, version: "0.7" as const };

/** anvil's default account #0 — only ever used when NODE_ENV=test. */
const ANVIL_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function isDirectRelay(): boolean {
  return process.env.NODE_ENV === "test" && process.env.RELAY_MODE === "direct";
}

function bundlerConfig(chainId: number): { bundlerUrl: string; paymasterRPC: string } {
  const cfg = getChainConfig(chainId);
  if (!cfg || !cfg.bundlerUrl) {
    throw new PasskeyError(
      "CONFIGURATION_ERROR",
      `Missing bundler config for chain ${chainId} (${cfg?.envPrefix ?? "?"}_BUNDLER_URL)`
    );
  }
  return { bundlerUrl: cfg.bundlerUrl, paymasterRPC: cfg.paymasterRPC };
}

function pimlicoFor(chainId: number) {
  const { bundlerUrl, paymasterRPC } = bundlerConfig(chainId);
  return createPimlicoClient({
    chain: getChain(chainId),
    transport: http(paymasterRPC || bundlerUrl),
    entryPoint: ENTRY_POINT,
  });
}

/** ERC-20 paymaster address that covers `token` on `chainId` (null when unavailable). */
export async function quoteTokenPaymaster(chainId: number, token: Address): Promise<Address | null> {
  if (isDirectRelay()) return null;
  const quotes = await pimlicoFor(chainId).getTokenQuotes({ chain: getChain(chainId), tokens: [token] });
  const paymaster = quotes?.[0]?.paymaster;
  if (!paymaster) {
    throw new PasskeyError("VALIDATION_ERROR", `Token ${token} not supported by ERC-20 paymaster`);
  }
  return paymaster;
}

/** Max native cost the Safe must prefund when no paymaster pays. */
export function requiredPrefund(op: UserOp): bigint {
  const gas =
    op.verificationGasLimit +
    op.callGasLimit +
    op.preVerificationGas +
    (op.paymasterVerificationGasLimit ?? 0n) +
    (op.paymasterPostOpGasLimit ?? 0n);
  return gas * op.maxFeePerGas;
}

export async function prepareUserOp(params: {
  chainId: number;
  client: PublicClient;
  account: SafeAccount;
  gas: GasSpec;
  plan: GasPlan;
}): Promise<UserOp> {
  const { chainId, client, account, gas, plan } = params;
  const calls = plan.calls.map((c) => ({ to: c.to, value: c.value, data: c.data }));

  if (isDirectRelay()) {
    const code = await client.getCode({ address: account.address });
    const deployed = !!code && code !== "0x";
    const [nonce, callData, fees] = await Promise.all([
      account.getNonce(),
      account.encodeCalls(calls),
      client.estimateFeesPerGas(),
    ]);
    const op: UserOp = {
      sender: account.address,
      nonce,
      callData,
      callGasLimit: 2_000_000n,
      verificationGasLimit: 2_000_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas: fees.maxFeePerGas * 2n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signature: "0x",
    };
    if (!deployed) {
      const f = await account.getFactoryArgs();
      if (f.factory && f.factoryData) {
        op.factory = f.factory;
        op.factoryData = f.factoryData;
      }
    }
    return op;
  }

  const { bundlerUrl } = bundlerConfig(chainId);
  const pimlico = pimlicoFor(chainId);
  let paymaster: any;
  if (plan.celoPaymaster && gas.mode === "token") {
    paymaster = createCeloPaymasterMiddleware(gas.token);
  } else if (gas.mode === "sponsored" || plan.paymasterContext) {
    if (!getChainConfig(chainId)?.paymasterRPC) {
      throw new PasskeyError("CONFIGURATION_ERROR", `Missing paymaster config for chain ${chainId}`);
    }
    paymaster = pimlico;
  }

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: getChain(chainId),
    bundlerTransport: http(bundlerUrl),
    ...(paymaster ? { paymaster } : {}),
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  });
  const prepared = await (smartAccountClient as any).prepareUserOperation({
    calls,
    ...(plan.paymasterContext ? { paymasterContext: plan.paymasterContext } : {}),
  });
  return { ...prepared, signature: "0x" } as UserOp;
}

export interface SubmitResult {
  userOpHash: Hex;
  transactionHash: Hex | null;
  success: boolean;
  status: "confirmed" | "failed" | "pending";
}

export async function submitUserOp(params: {
  chainId: number;
  client: PublicClient;
  userOp: UserOp;
  rpcUrl?: string;
}): Promise<SubmitResult> {
  const { chainId, client, userOp } = params;
  const userOpHash = getUserOperationHash({
    userOperation: userOp as any,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: "0.7",
    chainId,
  });

  if (isDirectRelay()) {
    const relayer = privateKeyToAccount(
      (process.env.RELAY_DIRECT_PRIVATE_KEY || ANVIL_DEFAULT_KEY) as Hex
    );
    const wallet = createWalletClient({
      account: relayer,
      chain: getChain(chainId),
      transport: http(getRpcUrl(chainId, params.rpcUrl)),
    });
    let txHash: Hex;
    try {
      txHash = await wallet.writeContract({
        address: entryPoint07Address,
        abi: entryPoint07Abi,
        functionName: "handleOps",
        args: [[toPackedUserOperation(userOp as any)], relayer.address],
      });
    } catch (e: any) {
      throw new PasskeyError("SUBMIT_FAILED", e?.shortMessage || e?.message || "handleOps failed");
    }
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    const events = parseEventLogs({ abi: entryPoint07Abi, logs: receipt.logs, eventName: "UserOperationEvent" });
    const ev = events.find((e) => (e.args as any).userOpHash === userOpHash);
    const success = receipt.status === "success" && !!ev && (ev.args as any).success === true;
    return { userOpHash, transactionHash: txHash, success, status: success ? "confirmed" : "failed" };
  }

  const { bundlerUrl } = bundlerConfig(chainId);
  const bundler = createBundlerClient({ chain: getChain(chainId), transport: http(bundlerUrl) });
  let sentHash: Hex;
  try {
    sentHash = (await bundler.request({
      method: "eth_sendUserOperation",
      params: [formatUserOperationRequest(userOp as any), entryPoint07Address],
    } as any)) as Hex;
  } catch (e: any) {
    throw new PasskeyError("SUBMIT_FAILED", e?.details || e?.shortMessage || e?.message || "bundler rejected the UserOp");
  }
  try {
    const receipt = await bundler.waitForUserOperationReceipt({ hash: sentHash, timeout: 60_000 });
    return {
      userOpHash: sentHash,
      transactionHash: receipt.receipt.transactionHash,
      success: receipt.success,
      status: receipt.success ? "confirmed" : "failed",
    };
  } catch {
    // Receipt timeout isn't fatal — the op may still land; caller can poll.
    return { userOpHash: sentHash, transactionHash: null, success: true, status: "pending" };
  }
}
