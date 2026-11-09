/**
 * Migration calldata allowlist + owner linked-list helpers (pure).
 */

import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import {
  MULTI_SEND_CALL_ONLY,
  assertMigrationCallsAllowed,
  assertMigrationUserOpAllowed,
  buildMigrationCalls,
  decodeSafeCallData,
  type MigrationExpectation,
} from "./migration";
import {
  buildAddOwnerCall,
  buildCreateSignerCall,
  buildRemoveOwnerCall,
  computePrevOwner,
  ownersAfterAdding,
  parseAccountRef,
  parseCoord,
  type RawCall,
} from "./account";
import { SAFE_OWNER_ABI, SAFE_WEBAUTHN_SIGNER_FACTORY, SENTINEL_OWNERS, SIGNER_FACTORY_ABI } from "./constants";
import { PasskeyError } from "./errors";
import type { UserOp } from "./userOp";

const SAFE: Address = "0x5B75c3E0Ea03585dead3d9F0f414b2901f77d759";
const EOA: Address = "0x1111111111111111111111111111111111111111";
const P1: Address = "0x2222222222222222222222222222222222222222";
const P2: Address = "0x3333333333333333333333333333333333333333";
const ATTACKER: Address = "0x4444444444444444444444444444444444444444";

const expectation = (currentOwners: Address[] = [EOA]): MigrationExpectation => ({
  safe: SAFE,
  eoa: EOA,
  passkeys: [
    { x: 11n, y: 12n, proxy: P1 },
    { x: 21n, y: 22n, proxy: P2 },
  ],
  currentOwners,
});

function rejects(fn: () => void, pattern?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PasskeyError);
    expect((e as PasskeyError).code).toBe("MIGRATION_CALLDATA_REJECTED");
    if (pattern) expect((e as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected rejection");
}

const EXEC = parseAbi(["function executeUserOpWithErrorString(address,uint256,bytes,uint8)"]);
const MULTISEND = parseAbi(["function multiSend(bytes)"]);

function encodeMultiSendCalls(calls: RawCall[], op = 0): Hex {
  const packed = calls
    .map((c) => {
      const data = c.data.slice(2);
      return (
        op.toString(16).padStart(2, "0") +
        c.to.slice(2) +
        c.value.toString(16).padStart(64, "0") +
        (data.length / 2).toString(16).padStart(64, "0") +
        data
      );
    })
    .join("");
  return encodeFunctionData({
    abi: EXEC,
    functionName: "executeUserOpWithErrorString",
    args: [MULTI_SEND_CALL_ONLY, 0n, encodeFunctionData({ abi: MULTISEND, functionName: "multiSend", args: [`0x${packed}`] }), 1],
  });
}

const fakeOp = (callData: Hex, extra: Partial<UserOp> = {}): UserOp => ({
  sender: SAFE, nonce: 0n, callData, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n,
  maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: "0x", ...extra,
});

describe("buildMigrationCalls", () => {
  it("is createSigner×n, addOwner×n, removeOwner(prev, EOA, 1) with the right prev", () => {
    const calls = buildMigrationCalls(expectation());
    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual(buildCreateSignerCall({ x: 11n, y: 12n }));
    expect(calls[2]).toEqual(buildAddOwnerCall(SAFE, P1));
    // after adds the list is [P2, P1, EOA] → prev(EOA) = P1
    expect(calls[4]).toEqual(buildRemoveOwnerCall(SAFE, [P2, P1, EOA], EOA));
    assertMigrationCallsAllowed(calls, expectation());
  });

  it("skips addOwner for a proxy that is already an owner", () => {
    const e = expectation([P1, EOA]);
    const calls = buildMigrationCalls(e);
    expect(calls).toHaveLength(4);
    assertMigrationCallsAllowed(calls, e);
  });
});

describe("assertMigrationCallsAllowed (the EOA signs nothing else)", () => {
  const good = () => buildMigrationCalls(expectation());

  it("rejects an extra token transfer", () => {
    const transfer = {
      to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
      value: 0n,
      data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [ATTACKER, 1n] }),
    };
    const calls = good();
    calls.splice(1, 0, transfer);
    rejects(() => assertMigrationCallsAllowed(calls, expectation()), /targets/);
  });

  it("rejects adding an attacker owner", () => {
    const calls = good();
    calls[2] = buildAddOwnerCall(SAFE, ATTACKER);
    rejects(() => assertMigrationCallsAllowed(calls, expectation()), /unknown owner/);
  });

  it("rejects a threshold change", () => {
    const calls = good();
    calls[2] = { to: SAFE, value: 0n, data: encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "addOwnerWithThreshold", args: [P1, 2n] }) };
    rejects(() => assertMigrationCallsAllowed(calls, expectation()), /threshold/);
  });

  it("rejects removing someone other than the EOA, or a wrong prevOwner", () => {
    const calls = good();
    calls[4] = { to: SAFE, value: 0n, data: encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "removeOwner", args: [P2, P1, 1n] }) };
    rejects(() => assertMigrationCallsAllowed(calls, expectation()), /not the legacy EOA/);
    calls[4] = { to: SAFE, value: 0n, data: encodeFunctionData({ abi: SAFE_OWNER_ABI, functionName: "removeOwner", args: [SENTINEL_OWNERS, EOA, 1n] }) };
    rejects(() => assertMigrationCallsAllowed(calls, expectation()), /prevOwner/);
  });

  it("rejects value, unknown keys, wrong verifiers, missing or early removeOwner", () => {
    const withValue = good();
    withValue[0] = { ...withValue[0]!, value: 1n };
    rejects(() => assertMigrationCallsAllowed(withValue, expectation()), /value/);

    const unknownKey = good();
    unknownKey[0] = buildCreateSignerCall({ x: 99n, y: 99n });
    rejects(() => assertMigrationCallsAllowed(unknownKey, expectation()), /unknown key/);

    const badVerifiers = good();
    badVerifiers[0] = { to: SAFE_WEBAUTHN_SIGNER_FACTORY, value: 0n, data: encodeFunctionData({ abi: SIGNER_FACTORY_ABI, functionName: "createSigner", args: [11n, 12n, 1n] }) };
    rejects(() => assertMigrationCallsAllowed(badVerifiers, expectation()), /verifiers/);

    rejects(() => assertMigrationCallsAllowed(good().slice(0, 4), expectation()), /missing removeOwner/);
    const early = good();
    early.push(buildCreateSignerCall({ x: 11n, y: 12n }));
    rejects(() => assertMigrationCallsAllowed(early, expectation()), /after removeOwner/);
  });

  it("rejects when a passkey would not end up an owner", () => {
    const calls = good().filter((_, i) => i !== 3); // drop addOwner(P2)
    rejects(() => assertMigrationCallsAllowed(calls, expectation()), /would not be an owner/);
  });

  it("rejects other Safe functions (e.g. enableModule / setFallbackHandler)", () => {
    const calls = good();
    calls[0] = { to: SAFE, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function enableModule(address)"]), functionName: "enableModule", args: [ATTACKER] }) };
    rejects(() => assertMigrationCallsAllowed(calls, expectation()), /not an allowed Safe function/);
  });
});

describe("decodeSafeCallData / assertMigrationUserOpAllowed", () => {
  it("round-trips a MultiSendCallOnly batch", () => {
    const calls = buildMigrationCalls(expectation());
    expect(decodeSafeCallData(encodeMultiSendCalls(calls))).toEqual(calls);
  });

  it("rejects a delegatecall entry, a non-multisend delegatecall, and a raw call", () => {
    const calls = buildMigrationCalls(expectation());
    rejects(() => decodeSafeCallData(encodeMultiSendCalls(calls, 1)), /not a CALL/);
    const delegate = encodeFunctionData({ abi: EXEC, functionName: "executeUserOpWithErrorString", args: [ATTACKER, 0n, "0x", 1] });
    rejects(() => decodeSafeCallData(delegate), /delegatecall/);
    rejects(() => decodeSafeCallData("0xdeadbeef"), /executeUserOpWithErrorString/);
  });

  it("checks sender and initCode", () => {
    const e = { ...expectation(), deployed: true, expectedInitCode: "0x" as Hex };
    const callData = encodeMultiSendCalls(buildMigrationCalls(expectation()));
    assertMigrationUserOpAllowed(fakeOp(callData), e);
    rejects(() => assertMigrationUserOpAllowed(fakeOp(callData, { sender: ATTACKER }), e), /sender/);
    rejects(() => assertMigrationUserOpAllowed(fakeOp(callData, { factory: ATTACKER, factoryData: "0x01" }), e), /initCode/);
    const undeployed = { ...e, deployed: false, expectedInitCode: (ATTACKER + "02") as Hex };
    rejects(() => assertMigrationUserOpAllowed(fakeOp(callData, { factory: ATTACKER, factoryData: "0x01" }), undeployed), /initCode/);
  });
});

describe("owner list helpers", () => {
  it("computePrevOwner uses SENTINEL for the head", () => {
    expect(computePrevOwner([P1, P2, EOA], P1)).toBe(SENTINEL_OWNERS);
    expect(computePrevOwner([P1, P2, EOA], EOA)).toBe(P2);
    expect(() => computePrevOwner([P1], ATTACKER)).toThrow(/not an owner/);
  });

  it("ownersAfterAdding prepends and skips duplicates", () => {
    expect(ownersAfterAdding([EOA], [P1, P2])).toEqual([P2, P1, EOA]);
    expect(ownersAfterAdding([P1, EOA], [P1, P2])).toEqual([P2, P1, EOA]);
  });

  it("buildRemoveOwnerCall refuses the last owner", () => {
    try {
      buildRemoveOwnerCall(SAFE, [P1], P1);
      throw new Error("should throw");
    } catch (e) {
      expect((e as PasskeyError).code).toBe("LAST_OWNER");
    }
  });
});

describe("AccountRef parsing", () => {
  it("accepts hex and decimal coordinates", () => {
    expect(parseCoord("0x0a", "x")).toBe(10n);
    expect(parseCoord("10", "x")).toBe(10n);
    expect(() => parseCoord("0x", "x")).toThrow(PasskeyError);
    expect(() => parseCoord("-1", "x")).toThrow(PasskeyError);
    expect(() => parseCoord("0", "x")).toThrow(PasskeyError);
  });

  it("parses both kinds and rejects others", () => {
    const native = parseAccountRef({ kind: "passkey_native", address: SAFE.toLowerCase(), firstPasskey: { x: "1", y: "2", credentialId: "c" } });
    expect(native).toMatchObject({ kind: "passkey_native", address: SAFE, extraPasskeys: [] });
    expect(parseAccountRef({ kind: "migrated", address: SAFE, legacyOwner: EOA })).toEqual({ kind: "migrated", address: SAFE, legacyOwner: EOA });
    expect(() => parseAccountRef({ kind: "eoa", address: SAFE })).toThrow(PasskeyError);
    expect(() => parseAccountRef({ kind: "migrated", address: SAFE })).toThrow(PasskeyError);
  });
});
