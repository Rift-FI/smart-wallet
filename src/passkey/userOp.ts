/**
 * UserOperation helpers shared by prepare / submit / migrate.
 *
 * Safe accounts don't sign the raw ERC-4337 userOpHash: Safe4337Module
 * verifies an EIP-712 SafeOp hash (domain = module, chainId). That is the
 * hashToSign returned by every prepare, and the WebAuthn challenge.
 */

import {
  concat,
  concatHex,
  encodeFunctionData,
  getAddress,
  hashDomain,
  hashStruct,
  hashTypedData,
  isAddress,
  isHex,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { SAFE_4337_MODULE_ADDRESS } from "./constants";
import { PasskeyError } from "./errors";
import type { RawCall } from "./account";

export const EIP712_SAFE_OPERATION_TYPE_V07 = {
  SafeOp: [
    { type: "address", name: "safe" },
    { type: "uint256", name: "nonce" },
    { type: "bytes", name: "initCode" },
    { type: "bytes", name: "callData" },
    { type: "uint128", name: "verificationGasLimit" },
    { type: "uint128", name: "callGasLimit" },
    { type: "uint256", name: "preVerificationGas" },
    { type: "uint128", name: "maxPriorityFeePerGas" },
    { type: "uint128", name: "maxFeePerGas" },
    { type: "bytes", name: "paymasterAndData" },
    { type: "uint48", name: "validAfter" },
    { type: "uint48", name: "validUntil" },
    { type: "address", name: "entryPoint" },
  ],
} as const;

/** Unpacked v0.7 UserOperation as viem/permissionless produce it. */
export interface UserOp {
  sender: Address;
  nonce: bigint;
  factory?: Address | undefined;
  factoryData?: Hex | undefined;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address | undefined;
  paymasterVerificationGasLimit?: bigint | undefined;
  paymasterPostOpGasLimit?: bigint | undefined;
  paymasterData?: Hex | undefined;
  signature: Hex;
}

export function packPaymasterAndData(op: Partial<UserOp>): Hex {
  if (!op.paymaster) return "0x";
  return concat([
    op.paymaster,
    pad(toHex(op.paymasterVerificationGasLimit ?? 0n), { size: 16 }),
    pad(toHex(op.paymasterPostOpGasLimit ?? 0n), { size: 16 }),
    op.paymasterData ?? "0x",
  ]);
}

export function packInitCode(op: Partial<UserOp>): Hex {
  if (op.factory && op.factoryData) return concatHex([op.factory, op.factoryData]);
  return "0x";
}

function safeOpMessage(op: UserOp, validAfter: number, validUntil: number) {
  return {
    safe: op.sender,
    nonce: op.nonce,
    initCode: packInitCode(op),
    callData: op.callData,
    verificationGasLimit: op.verificationGasLimit,
    callGasLimit: op.callGasLimit,
    preVerificationGas: op.preVerificationGas,
    maxPriorityFeePerGas: op.maxPriorityFeePerGas,
    maxFeePerGas: op.maxFeePerGas,
    paymasterAndData: packPaymasterAndData(op),
    validAfter,
    validUntil,
    entryPoint: entryPoint07Address,
  };
}

/** SafeOp EIP-712 hash — exactly what permissionless's signUserOperation hashes. */
export function computeSafeOpHash(op: UserOp, chainId: number, validAfter = 0, validUntil = 0): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: SAFE_4337_MODULE_ADDRESS },
    types: EIP712_SAFE_OPERATION_TYPE_V07,
    primaryType: "SafeOp",
    message: safeOpMessage(op, validAfter, validUntil),
  });
}

/**
 * operationData = 0x1901 || domainSeparator || structHash — the `data`
 * argument Safe4337Module passes to Safe.checkSignatures. keccak256 of it
 * equals computeSafeOpHash.
 */
export function computeSafeOpData(op: UserOp, chainId: number, validAfter = 0, validUntil = 0): Hex {
  const domainSeparator = hashDomain({
    domain: { chainId, verifyingContract: SAFE_4337_MODULE_ADDRESS },
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  const structHash = hashStruct({
    data: safeOpMessage(op, validAfter, validUntil),
    primaryType: "SafeOp",
    types: EIP712_SAFE_OPERATION_TYPE_V07,
  });
  return concat(["0x1901", domainSeparator, structHash]);
}

// ─── JSON (de)serialisation ──────────────────────────────────────────

const BIGINT_FIELDS = [
  "nonce",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
] as const;

const USEROP_FIELDS = [
  "sender",
  "nonce",
  "factory",
  "factoryData",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterData",
  "signature",
] as const;

/** Pick the v0.7 fields and hex-encode bigints (viem's prepared op carries extras like `account`). */
export function serialiseUserOp(op: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of USEROP_FIELDS) {
    const v = op[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "bigint" ? toHex(v) : String(v);
  }
  return out;
}

export function reviveUserOp(json: Record<string, string>): UserOp {
  const out: Record<string, unknown> = { ...json };
  for (const k of BIGINT_FIELDS) {
    if (typeof json[k] === "string") out[k] = BigInt(json[k] as string);
  }
  if (!out.signature) out.signature = "0x";
  return out as unknown as UserOp;
}

// ─── Call normalisation ──────────────────────────────────────────────

/**
 * Accepts `{ to, value?, data? }` (value as decimal / hex string or number)
 * or `{ to, value?, abi, functionName, args }`.
 */
export function normaliseCalls(raw: unknown): RawCall[] {
  if (!Array.isArray(raw)) throw new PasskeyError("VALIDATION_ERROR", "calls must be an array");
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") throw new PasskeyError("VALIDATION_ERROR", `calls[${i}] must be an object`);
    const call = c as Record<string, unknown>;
    if (typeof call.to !== "string" || !isAddress(call.to, { strict: false })) {
      throw new PasskeyError("VALIDATION_ERROR", `calls[${i}].to must be an address`);
    }
    let value = 0n;
    if (call.value !== undefined && call.value !== null && call.value !== "") {
      try {
        value = BigInt(call.value as string | number | bigint);
      } catch {
        throw new PasskeyError("VALIDATION_ERROR", `calls[${i}].value must be an integer`);
      }
      if (value < 0n) throw new PasskeyError("VALIDATION_ERROR", `calls[${i}].value must be >= 0`);
    }
    let data: Hex = "0x";
    if (Array.isArray(call.abi) && typeof call.functionName === "string") {
      try {
        data = encodeFunctionData({
          abi: call.abi as any,
          functionName: call.functionName,
          args: (call.args as unknown[]) ?? [],
        } as any);
      } catch (e: any) {
        throw new PasskeyError("VALIDATION_ERROR", `calls[${i}] could not be ABI-encoded: ${e?.shortMessage ?? e?.message}`);
      }
    } else if (call.data !== undefined && call.data !== null && call.data !== "") {
      if (typeof call.data !== "string" || !isHex(call.data)) {
        throw new PasskeyError("VALIDATION_ERROR", `calls[${i}].data must be 0x-hex`);
      }
      data = call.data as Hex;
    }
    return { to: getAddress(call.to), value, data };
  });
}
