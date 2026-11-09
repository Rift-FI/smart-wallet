/**
 * EOA-owned Safe → passkey-owned Safe migration (spec §1c).
 *
 * The legacy EOA key is used for exactly ONE thing: signing this UserOp
 *
 *   [ factory.createSigner(x,y,VERIFIERS)  for every passkey,
 *     safe.addOwnerWithThreshold(proxy_i, 1) for every passkey,
 *     safe.removeOwner(prev_of_EOA, EOA, 1) ]
 *
 * (+ initCode when the Safe is undeployed on that chain). Before the EOA
 * signs, the op's callData is decoded and checked against that shape by
 * assertMigrationUserOpAllowed — anything else is refused. The key is
 * never logged and never stored.
 */

import {
  decodeFunctionData,
  getAddress,
  hexToBigInt,
  isHex,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SAFE_OWNER_ABI,
  SAFE_WEBAUTHN_SIGNER_FACTORY,
  SIGNER_FACTORY_ABI,
  VERIFIERS,
} from "./constants";
import { PasskeyError } from "./errors";
import {
  assertCapability,
  buildAddOwnerCall,
  buildCreateSignerCall,
  buildLegacySafe,
  computePrevOwner,
  computeProxyAddress,
  ownersAfterAdding,
  readOwnerState,
  type PasskeyCoords,
  type RawCall,
} from "./account";
import { buildGasPlan, type GasSpec } from "./gas";
import { isDirectRelay, prepareUserOp, requiredPrefund, submitUserOp, type SubmitResult } from "./relay";
import { packInitCode, type UserOp } from "./userOp";
import { encodeFunctionData } from "viem";

export const MULTI_SEND_CALL_ONLY: Address = getAddress("0x9641d764fc13c8B624c04430C7356C1C7C8102e2");

const EXECUTE_USER_OP_ABI = [
  {
    type: "function",
    name: "executeUserOpWithErrorString",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

const MULTI_SEND_ABI = [
  {
    type: "function",
    name: "multiSend",
    stateMutability: "payable",
    inputs: [{ name: "transactions", type: "bytes" }],
    outputs: [],
  },
] as const;

export interface MigrationPasskey extends PasskeyCoords {
  proxy: Address;
}

export interface MigrationExpectation {
  safe: Address;
  eoa: Address;
  passkeys: MigrationPasskey[];
  /** Owners before the op runs ([eoa] for an undeployed Safe). */
  currentOwners: Address[];
}

/** Build the §1c call list. Skips addOwner for proxies that are already owners. */
export function buildMigrationCalls(e: MigrationExpectation): RawCall[] {
  const calls: RawCall[] = [];
  const added: Address[] = [];
  for (const p of e.passkeys) calls.push(buildCreateSignerCall(p));
  for (const p of e.passkeys) {
    const already = [...e.currentOwners, ...added].some((o) => o.toLowerCase() === p.proxy.toLowerCase());
    if (already) continue;
    calls.push(buildAddOwnerCall(e.safe, p.proxy));
    added.push(p.proxy);
  }
  const after = ownersAfterAdding(e.currentOwners, added);
  const prev = computePrevOwner(after, e.eoa);
  calls.push({
    to: e.safe,
    value: 0n,
    data: encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "removeOwner", args: [prev, e.eoa, 1n] }),
  });
  return calls;
}

function reject(why: string): never {
  throw new PasskeyError("MIGRATION_CALLDATA_REJECTED", `migration calldata rejected: ${why}`);
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The allowlist. Every call must be one of:
 *   factory.createSigner(x, y, VERIFIERS)      x,y ∈ passkeys
 *   safe.addOwnerWithThreshold(proxy, 1)        proxy ∈ passkeys' proxies
 *   safe.removeOwner(prev, EOA, 1)              exactly once, last, prev correct
 * with value 0, and every passkey proxy must be an owner afterwards.
 */
export function assertMigrationCallsAllowed(calls: RawCall[], e: MigrationExpectation): void {
  if (calls.length < 2) reject("too few calls");
  let owners = [...e.currentOwners];
  let removed = false;

  calls.forEach((c, i) => {
    if (removed) reject(`call ${i} comes after removeOwner`);
    if (c.value !== 0n) reject(`call ${i} transfers value`);

    if (eq(c.to, SAFE_WEBAUTHN_SIGNER_FACTORY)) {
      let d;
      try {
        d = decodeFunctionData({ abi: SIGNER_FACTORY_ABI, data: c.data });
      } catch {
        reject(`call ${i} is not a known factory function`);
      }
      if (d.functionName !== "createSigner") reject(`call ${i} is not createSigner`);
      const [x, y, verifiers] = d.args as readonly [bigint, bigint, bigint];
      if (verifiers !== VERIFIERS) reject(`call ${i} uses unexpected verifiers`);
      if (!e.passkeys.some((p) => p.x === x && p.y === y)) reject(`call ${i} creates a signer for an unknown key`);
      return;
    }

    if (eq(c.to, e.safe)) {
      let d;
      try {
        d = decodeFunctionData({ abi: SAFE_OWNER_ABI, data: c.data });
      } catch {
        reject(`call ${i} is not an allowed Safe function`);
      }
      if (d.functionName === "addOwnerWithThreshold") {
        const [owner, threshold] = d.args as readonly [Address, bigint];
        if (threshold !== 1n) reject(`call ${i} changes the threshold`);
        if (!e.passkeys.some((p) => eq(p.proxy, owner))) reject(`call ${i} adds an unknown owner ${owner}`);
        if (owners.some((o) => eq(o, owner))) reject(`call ${i} adds an existing owner`);
        owners = [getAddress(owner), ...owners];
        return;
      }
      if (d.functionName === "removeOwner") {
        const [prev, owner, threshold] = d.args as readonly [Address, Address, bigint];
        if (!eq(owner, e.eoa)) reject(`call ${i} removes ${owner}, not the legacy EOA`);
        if (threshold !== 1n) reject(`call ${i} changes the threshold`);
        if (!eq(prev, computePrevOwner(owners, e.eoa))) reject(`call ${i} has a wrong prevOwner`);
        owners = owners.filter((o) => !eq(o, e.eoa));
        removed = true;
        return;
      }
      reject(`call ${i} calls Safe.${d.functionName}`);
    }

    reject(`call ${i} targets ${c.to}`);
  });

  if (!removed) reject("missing removeOwner(EOA)");
  for (const p of e.passkeys) {
    if (!owners.some((o) => eq(o, p.proxy))) reject(`passkey proxy ${p.proxy} would not be an owner`);
  }
}

/** Strictly decode Safe4337Module callData into calls (CALL only, no delegatecall except MultiSendCallOnly). */
export function decodeSafeCallData(callData: Hex): RawCall[] {
  let d;
  try {
    d = decodeFunctionData({ abi: EXECUTE_USER_OP_ABI, data: callData });
  } catch {
    reject("callData is not executeUserOpWithErrorString");
  }
  const [to, value, data, operation] = d.args as readonly [Address, bigint, Hex, number];
  if (operation === 0) return [{ to: getAddress(to), value, data }];
  if (operation !== 1 || !eq(to, MULTI_SEND_CALL_ONLY) || value !== 0n) reject("unexpected delegatecall");

  let ms;
  try {
    ms = decodeFunctionData({ abi: MULTI_SEND_ABI, data });
  } catch {
    reject("delegatecall is not multiSend");
  }
  const packed = ms.args[0] as Hex;
  const out: RawCall[] = [];
  const len = size(packed);
  let pos = 0;
  while (pos < len) {
    if (pos + 85 > len) reject("truncated multiSend payload");
    const op = Number(hexToBigInt(slice(packed, pos, pos + 1)));
    if (op !== 0) reject("multiSend entry is not a CALL");
    const target = getAddress(slice(packed, pos + 1, pos + 21));
    const val = hexToBigInt(slice(packed, pos + 21, pos + 53));
    const dataLen = Number(hexToBigInt(slice(packed, pos + 53, pos + 85)));
    if (pos + 85 + dataLen > len) reject("truncated multiSend entry");
    const callData = dataLen === 0 ? "0x" : slice(packed, pos + 85, pos + 85 + dataLen);
    out.push({ to: target, value: val, data: callData });
    pos += 85 + dataLen;
  }
  return out;
}

/** Final gate before the EOA signs: sender, initCode and decoded calls. */
export function assertMigrationUserOpAllowed(
  op: UserOp,
  e: MigrationExpectation & { deployed: boolean; expectedInitCode: Hex }
): void {
  if (!eq(op.sender, e.safe)) reject("sender is not the legacy Safe");
  const initCode = packInitCode(op);
  if (e.deployed) {
    if (initCode !== "0x") reject("initCode on a deployed Safe");
  } else if (initCode.toLowerCase() !== e.expectedInitCode.toLowerCase()) {
    reject("initCode is not the legacy Safe's factory data");
  }
  assertMigrationCallsAllowed(decodeSafeCallData(op.callData), e);
}

export interface MigrateParams {
  chainId: number;
  client: PublicClient;
  rpcUrl?: string;
  safeAddress: Address;
  legacyOwner: Address;
  eoaPrivateKey: string;
  passkeys: PasskeyCoords[];
  /** Test hook: mutate the op before the allowlist check (proves it rejects). */
  tamper?: (op: UserOp) => UserOp;
}

export interface MigrateResult {
  status: "migrated" | "already_migrated" | "failed" | "pending";
  chainId: number;
  owners: Address[];
  userOpHash?: Hex;
  transactionHash?: Hex | null;
  success: boolean;
}

export async function migrateSafe(p: MigrateParams): Promise<MigrateResult> {
  assertCapability(p.chainId, "signerFactory");
  if (p.passkeys.length === 0) throw new PasskeyError("VALIDATION_ERROR", "passkeys must not be empty");
  if (typeof p.eoaPrivateKey !== "string" || !isHex(p.eoaPrivateKey) || p.eoaPrivateKey.length !== 66) {
    throw new PasskeyError("VALIDATION_ERROR", "eoaPrivateKey must be a 32-byte 0x-hex key");
  }

  const eoa = privateKeyToAccount(p.eoaPrivateKey as Hex);
  if (!eq(eoa.address, p.legacyOwner)) {
    throw new PasskeyError("EOA_MISMATCH", "eoaPrivateKey does not derive to account.legacyOwner");
  }
  const safe = await buildLegacySafe(p.client, eoa);
  if (!eq(safe.address, p.safeAddress)) {
    throw new PasskeyError("ACCOUNT_MISMATCH", `legacy owner's Safe is ${safe.address}, not ${p.safeAddress}`);
  }

  const passkeys: MigrationPasskey[] = [];
  for (const k of p.passkeys) passkeys.push({ ...k, proxy: await computeProxyAddress(p.client, k) });

  const state = await readOwnerState(p.client, safe.address);
  if (state.deployed && !state.owners.some((o) => eq(o, eoa.address))) {
    return { status: "already_migrated", chainId: p.chainId, owners: state.owners, success: true };
  }
  const currentOwners = state.deployed ? state.owners : [eoa.address];
  const expectation: MigrationExpectation = { safe: safe.address, eoa: eoa.address, passkeys, currentOwners };
  const calls = buildMigrationCalls(expectation);
  assertMigrationCallsAllowed(calls, expectation);

  // Gas: sponsored where available, else the Safe's own native balance.
  const prepareWith = async (gas: GasSpec) =>
    prepareUserOp({
      chainId: p.chainId,
      client: p.client,
      account: safe,
      gas,
      plan: await buildGasPlan({
        gas, chainId: p.chainId, client: p.client, safe: safe.address, userCalls: calls,
        quoteToken: async () => null,
      }),
    });

  let op: UserOp | null = null;
  let sponsored = false;
  if (!isDirectRelay()) {
    try {
      op = await prepareWith({ mode: "sponsored", markup: {} });
      sponsored = true;
    } catch (e: any) {
      console.warn(`[migrate] chain ${p.chainId}: sponsorship unavailable (${e?.shortMessage ?? e?.message}); trying native gas`);
    }
  }
  if (!op) {
    try {
      op = await prepareWith({ mode: "native", markup: {} });
    } catch (e: any) {
      throw new PasskeyError("MIGRATION_NEEDS_GAS", `could not prepare migration without a paymaster: ${e?.shortMessage ?? e?.message}`, { chainId: p.chainId });
    }
  }
  if (!sponsored) {
    const balance = await p.client.getBalance({ address: safe.address });
    const needed = requiredPrefund(op);
    if (balance < needed) {
      throw new PasskeyError("MIGRATION_NEEDS_GAS", `Safe needs ${needed} wei of native gas on chain ${p.chainId} (has ${balance})`, {
        chainId: p.chainId, needed: needed.toString(), balance: balance.toString(),
      });
    }
  }

  if (p.tamper) op = p.tamper(op);
  const factoryArgs = state.deployed ? null : await safe.getFactoryArgs();
  assertMigrationUserOpAllowed(op, {
    ...expectation,
    deployed: state.deployed,
    expectedInitCode: factoryArgs?.factory && factoryArgs.factoryData ? packInitCode(factoryArgs as any) : "0x",
  });

  const signature = await safe.signUserOperation({ ...(op as any), chainId: p.chainId });
  const result: SubmitResult = await submitUserOp({
    chainId: p.chainId,
    client: p.client,
    userOp: { ...op, signature },
    ...(p.rpcUrl ? { rpcUrl: p.rpcUrl } : {}),
  });
  const after = result.status === "pending" ? state.owners : (await readOwnerState(p.client, safe.address)).owners;
  return {
    status: result.status === "confirmed" ? "migrated" : result.status,
    chainId: p.chainId,
    owners: after,
    userOpHash: result.userOpHash,
    transactionHash: result.transactionHash,
    success: result.success,
  };
}
