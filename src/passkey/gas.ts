/**
 * Gas plan for a passkey UserOp (spec §2f "Gas").
 *
 *   { mode: "sponsored", ...markup? }        Pimlico verifying paymaster
 *   { mode: "token", token, ...markup? }     ERC-20 paymaster (Pimlico), or
 *                                            Rift's Erc20Paymaster on Celo
 *
 * Markup fields may sit directly on `gas` or under `gas.markup`:
 *   markupBps, projectMarkupBps, projectTreasuryAddress,
 *   transferTokenAddress, transferBaseAmountWei, flatMarkupTokenAddress
 *
 * Behaviour mirrors the old one-phase routes exactly:
 *   - token mode, single ERC-20 transfer of the gas token (old /api/transfer)
 *     → Rift % markup + project % markup on the transfer amount
 *   - token mode, anything else (old /api/transaction with paymasterToken)
 *     → flat markup in the gas token
 *   - explicit transferBaseAmountWei → % markup on that base (old preview)
 *   - explicit flatMarkupTokenAddress → flat markup in that token
 * Calls are ordered [paymaster approve(s)…, user calls…, markup transfers…].
 */

import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import {
  buildFlatMarkupTransferCall,
  buildMarkupTransferCall,
  buildProjectMarkupTransferCall,
  getFlatMarkupConfig,
  getMarkupConfig,
} from "../markup";
import { buildPaymasterApproveCalls } from "../paymasterApprove";
import { getCeloPaymasterAddress, isCeloChain, isCeloSupportedToken } from "../celo-paymaster";
import { PasskeyError } from "./errors";
import type { RawCall } from "./account";

export interface MarkupSpec {
  markupBps?: number;
  projectMarkupBps?: number;
  projectTreasuryAddress?: string;
  transferTokenAddress?: string;
  transferBaseAmountWei?: string;
  flatMarkupTokenAddress?: string;
}

export type GasSpec =
  | { mode: "sponsored"; markup: MarkupSpec }
  | { mode: "token"; token: Address; markup: MarkupSpec }
  /** Internal: no paymaster, the Safe pays in native gas (migration fallback, direct relay). */
  | { mode: "native"; markup: MarkupSpec };

const MARKUP_KEYS = [
  "markupBps",
  "projectMarkupBps",
  "projectTreasuryAddress",
  "transferTokenAddress",
  "transferBaseAmountWei",
  "flatMarkupTokenAddress",
] as const;

export function parseGasSpec(raw: unknown): GasSpec {
  if (raw === undefined || raw === null) return { mode: "sponsored", markup: {} };
  if (typeof raw !== "object") throw new PasskeyError("VALIDATION_ERROR", "gas must be an object");
  const g = raw as Record<string, unknown>;
  const src = (g.markup && typeof g.markup === "object" ? g.markup : g) as Record<string, unknown>;
  const markup: MarkupSpec = {};
  for (const k of MARKUP_KEYS) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (k === "markupBps" || k === "projectMarkupBps") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new PasskeyError("VALIDATION_ERROR", `gas.${k} must be a non-negative number`);
      }
      markup[k] = v;
    } else {
      markup[k] = String(v);
    }
  }
  if (g.mode === "sponsored" || g.mode === undefined) return { mode: "sponsored", markup };
  if (g.mode === "token") {
    if (typeof g.token !== "string" || !isAddress(g.token, { strict: false })) {
      throw new PasskeyError("VALIDATION_ERROR", "gas.token must be an address for mode=token");
    }
    return { mode: "token", token: getAddress(g.token), markup };
  }
  throw new PasskeyError("VALIDATION_ERROR", 'gas.mode must be "sponsored" or "token"');
}

const TRANSFER_ABI = parseAbi(["function transfer(address,uint256)"]);

/** If `calls` is exactly one ERC-20 transfer on `token`, return its amount. */
export function singleTransferAmount(calls: RawCall[], token: Address): bigint | null {
  if (calls.length !== 1) return null;
  const c = calls[0] as RawCall;
  if (c.to.toLowerCase() !== token.toLowerCase() || c.value !== 0n) return null;
  try {
    const d = decodeFunctionData({ abi: TRANSFER_ABI, data: c.data });
    return d.functionName === "transfer" ? (d.args[1] as bigint) : null;
  } catch {
    return null;
  }
}

function toRaw(c: { to: Address; abi: any; functionName: string; args: readonly unknown[] }): RawCall {
  return {
    to: getAddress(c.to),
    value: 0n,
    data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args as any }),
  };
}

/** Markup transfer calls to append (pure — reads env config only). */
export function buildMarkupCalls(gas: GasSpec, userCalls: RawCall[]): RawCall[] {
  const out: RawCall[] = [];
  const m = gas.markup;

  let percentToken: Address | null = null;
  let percentBase: bigint | null = null;
  if (m.transferBaseAmountWei !== undefined) {
    const token = m.transferTokenAddress ?? (gas.mode === "token" ? gas.token : undefined);
    if (token && isAddress(token, { strict: false })) {
      try {
        percentBase = BigInt(m.transferBaseAmountWei);
        percentToken = getAddress(token);
      } catch {
        throw new PasskeyError("VALIDATION_ERROR", "gas.transferBaseAmountWei must be an integer");
      }
    }
  } else if (gas.mode === "token") {
    const amount = singleTransferAmount(userCalls, gas.token);
    if (amount !== null) {
      percentBase = amount;
      percentToken = gas.token;
    }
  }

  if (percentToken && percentBase !== null && percentBase > 0n) {
    const rift = buildMarkupTransferCall({
      tokenAddress: percentToken,
      transferAmountWei: percentBase,
      config: getMarkupConfig(m.markupBps),
    });
    if (rift) out.push(toRaw(rift));
    const project = buildProjectMarkupTransferCall({
      tokenAddress: percentToken,
      transferAmountWei: percentBase,
      projectBps: m.projectMarkupBps,
      projectTreasury: m.projectTreasuryAddress,
    });
    if (project) out.push(toRaw(project));
  }

  const flatToken =
    m.flatMarkupTokenAddress && isAddress(m.flatMarkupTokenAddress, { strict: false })
      ? getAddress(m.flatMarkupTokenAddress)
      : gas.mode === "token" && percentBase === null
        ? gas.token
        : null;
  if (flatToken) {
    const flat = buildFlatMarkupTransferCall({ tokenAddress: flatToken, config: getFlatMarkupConfig() });
    if (flat) out.push(toRaw(flat));
  }
  return out;
}

export interface GasPlan {
  calls: RawCall[];
  /** Paymaster the token approve targets (token mode only). */
  paymasterAddress?: Address;
  /** paymasterContext for Pimlico ERC-20 mode. */
  paymasterContext?: { token: Address };
  /** True when the Celo custom paymaster middleware must be used. */
  celoPaymaster?: boolean;
}

/**
 * Assemble [approve…, user…, markup…] for a gas spec. `quoteToken` asks the
 * Pimlico paymaster which ERC-20 paymaster covers a token (null = none /
 * unavailable, e.g. the direct test relay — then no approve is added).
 */
export async function buildGasPlan(params: {
  gas: GasSpec;
  chainId: number;
  client: PublicClient;
  safe: Address;
  userCalls: RawCall[];
  quoteToken: (token: Address) => Promise<Address | null>;
}): Promise<GasPlan> {
  const { gas, chainId, client, safe, userCalls } = params;
  const markupCalls = buildMarkupCalls(gas, userCalls);
  if (gas.mode !== "token") {
    return { calls: [...userCalls, ...markupCalls] };
  }

  let paymaster: Address | null;
  let celo = false;
  if (isCeloChain(chainId)) {
    if (!isCeloSupportedToken(gas.token)) {
      throw new PasskeyError(
        "VALIDATION_ERROR",
        `Token ${gas.token} not supported by Celo paymaster. Supported: USDC, USDT`
      );
    }
    paymaster = getAddress(getCeloPaymasterAddress());
    celo = true;
  } else {
    paymaster = await params.quoteToken(gas.token);
  }

  const approve = paymaster
    ? (await buildPaymasterApproveCalls(client as any, gas.token, safe, paymaster)).map(toRaw)
    : [];
  const plan: GasPlan = { calls: [...approve, ...userCalls, ...markupCalls] };
  if (paymaster) plan.paymasterAddress = paymaster;
  if (celo) plan.celoPaymaster = true;
  else if (paymaster) plan.paymasterContext = { token: gas.token };
  return plan;
}
