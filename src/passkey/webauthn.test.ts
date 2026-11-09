/**
 * Encoder unit tests. The key property: given the SAME WebAuthn assertion,
 * buildPasskeySignature (server path, no getFn) produces byte-identical
 * output to permissionless's own Safe signing via the shared signer.
 */

import { describe, expect, it } from "vitest";
import { encodePacked, keccak256, toHex, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createVirtualPasskey } from "../testing/virtualPasskey";
import {
  P256_N,
  buildPasskeySignature,
  decodeBase64,
  derToRS,
  encodeSafeContractSignature,
  encodeUserOpSignature,
  extractChallenge,
  extractClientDataFields,
  parseAuthProof,
  verifyP256Assertion,
} from "./webauthn";
import { SAFE_WEBAUTHN_SHARED_SIGNER } from "./constants";
import { PasskeyError } from "./errors";
import { computeSafeOpData, computeSafeOpHash, type UserOp } from "./userOp";

const HASH = keccak256(toHex("rift passkey test")) as Hex;

function sampleUserOp(): UserOp {
  return {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 7n,
    factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    factoryData: "0xdeadbeef",
    callData: "0x7bb37428",
    callGasLimit: 100_000n,
    verificationGasLimit: 500_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymaster: "0x0000000000000039cd5e8aE05257CE51C473ddd1",
    paymasterVerificationGasLimit: 40_000n,
    paymasterPostOpGasLimit: 20_000n,
    paymasterData: "0x1234",
    signature: "0x",
  };
}

/** Capture the exact assertion a getFn call produced, as a wire authProof. */
function recordingPasskey() {
  const pk = createVirtualPasskey();
  let last: any = null;
  const getFn = async (opts: any) => {
    const cred = await pk.getFn(opts);
    last = cred;
    return cred;
  };
  const proof = () => ({
    kind: "passkey",
    cred_id_b64: "AA==",
    client_data_json_b64: Buffer.from(last.response.clientDataJSON).toString("base64"),
    authenticator_data_b64: Buffer.from(last.response.authenticatorData).toString("base64"),
    signature_b64: Buffer.from(last.response.signature).toString("base64"),
  });
  return { pk, getFn, proof };
}

describe("buildPasskeySignature vs permissionless (shared signer)", () => {
  it("UserOp signature is byte-identical", async () => {
    const { pk, getFn, proof } = recordingPasskey();
    const { toWebAuthnAccount } = await import("viem/account-abstraction");
    const owner = toWebAuthnAccount({ credential: { id: pk.credentialId, publicKey: pk.publicKey }, getFn: getFn as any, rpId: pk.rpId });
    const op = sampleUserOp();

    // No RPC is made: address is given and chainId is passed explicitly.
    const safe = await toSafeSmartAccount({
      client: createPublicClient({ chain: base, transport: http("http://127.0.0.1:1") }),
      owners: [owner],
      version: "1.4.1",
      entryPoint: { address: entryPoint07Address, version: "0.7" },
      address: op.sender,
    });
    const theirs = await safe.signUserOperation({ ...(op as any), chainId: 8453 });

    const hash = computeSafeOpHash(op, 8453);
    const ours = buildPasskeySignature({ authProof: proof(), hashToSign: hash, signer: SAFE_WEBAUTHN_SHARED_SIGNER });
    // Same bytes (permissionless embeds the checksummed address, hence hex case).
    expect(encodeUserOpSignature(ours.contractSignature).toLowerCase()).toBe(theirs.toLowerCase());
  });

  it("safeOp operationData hashes to the SafeOp hash", () => {
    const op = sampleUserOp();
    expect(keccak256(computeSafeOpData(op, 8453))).toBe(computeSafeOpHash(op, 8453));
    expect(computeSafeOpHash(op, 8453)).not.toBe(computeSafeOpHash(op, 1));
  });
});

describe("assertion parsing", () => {
  it("extracts challenge and clientDataFields", () => {
    const pk = createVirtualPasskey();
    const parsed = parseAuthProof(pk.signHash(HASH));
    expect(extractChallenge(parsed.clientDataJSON)).toBe(HASH);
    expect(extractClientDataFields(parsed.clientDataJSON)).toBe('"origin":"https://app.riftfi.com","crossOrigin":false');
  });

  it("verifies off-chain with the right key only", () => {
    const pk = createVirtualPasskey();
    const other = createVirtualPasskey();
    const sig = buildPasskeySignature({ authProof: pk.signHash(HASH), hashToSign: HASH, signer: SAFE_WEBAUTHN_SHARED_SIGNER });
    const args = { authenticatorData: sig.parsed.authenticatorData, clientDataJSON: sig.parsed.clientDataJSON, r: sig.r, s: sig.s };
    expect(verifyP256Assertion({ x: pk.x, y: pk.y, ...args })).toBe(true);
    expect(verifyP256Assertion({ x: other.x, y: other.y, ...args })).toBe(false);
  });

  it("rejects oidc / missing proofs with PASSKEY_REQUIRED", () => {
    for (const bad of [undefined, null, { kind: "oidc", id_token: "x" }]) {
      try {
        parseAuthProof(bad);
        throw new Error("should throw");
      } catch (e) {
        expect((e as PasskeyError).code).toBe("PASSKEY_REQUIRED");
      }
    }
  });

  it("rejects a challenge that is not hashToSign", () => {
    const pk = createVirtualPasskey();
    const proof = pk.signHash(HASH, { challengeOverride: keccak256("0x01") });
    expect(() => buildPasskeySignature({ authProof: proof, hashToSign: HASH, signer: SAFE_WEBAUTHN_SHARED_SIGNER })).toThrow(/challenge/);
  });

  it("rejects assertions without the UV flag", () => {
    const pk = createVirtualPasskey();
    const proof = pk.signHash(HASH, { flags: 0x01 });
    expect(() => buildPasskeySignature({ authProof: proof, hashToSign: HASH, signer: SAFE_WEBAUTHN_SHARED_SIGNER })).toThrow(/user-verified/);
  });

  it("rejects webauthn.create client data", () => {
    const pk = createVirtualPasskey();
    const proof = pk.signHash(HASH);
    const cd = Buffer.from(proof.client_data_json_b64!, "base64").toString().replace("webauthn.get", "webauthn.create");
    proof.client_data_json_b64 = Buffer.from(cd).toString("base64");
    expect(() => buildPasskeySignature({ authProof: proof, hashToSign: HASH, signer: SAFE_WEBAUTHN_SHARED_SIGNER })).toThrow(PasskeyError);
  });

  it("accepts base64url as well as standard base64", () => {
    expect(Array.from(decodeBase64("-_8", "x"))).toEqual([0xfb, 0xff]);
    expect(Array.from(decodeBase64("+/8=", "x"))).toEqual([0xfb, 0xff]);
    expect(() => decodeBase64("not base64!", "x")).toThrow(PasskeyError);
  });
});

describe("derToRS", () => {
  const der = (r: bigint, s: bigint) => {
    const int = (v: bigint) => {
      let h = v.toString(16);
      if (h.length % 2) h = "0" + h;
      if (parseInt(h.slice(0, 2), 16) >= 0x80) h = "00" + h;
      return "02" + (h.length / 2).toString(16).padStart(2, "0") + h;
    };
    const body = int(r) + int(s);
    return Buffer.from("30" + (body.length / 2).toString(16).padStart(2, "0") + body, "hex");
  };

  it("parses and normalises high-s to low-s", () => {
    expect(derToRS(der(5n, 7n))).toEqual({ r: 5n, s: 7n });
    const high = P256_N - 3n;
    expect(derToRS(der(9n, high))).toEqual({ r: 9n, s: 3n });
    // leading 0x00 padding on a high-bit r
    const r = 0x80n << 248n;
    expect(derToRS(der(r, 1n)).r).toBe(r);
  });

  it("rejects malformed DER", () => {
    expect(() => derToRS(Buffer.from("3006020101020101ff", "hex"))).toThrow(PasskeyError);
    expect(() => derToRS(Buffer.from("31060201010201 01".replace(" ", ""), "hex"))).toThrow(PasskeyError);
    expect(() => derToRS(der(0n, 1n))).toThrow(PasskeyError);
  });
});

describe("contract signature layout", () => {
  it("is r=signer, s=65, v=0, then length-prefixed data", () => {
    const sig = encodeSafeContractSignature("0x00000000000000000000000000000000000000aa", "0xabcd");
    expect(sig).toBe(
      "0x" +
        "aa".padStart(64, "0") +
        "41".padStart(64, "0") +
        "00" +
        "2".padStart(64, "0") +
        "abcd"
    );
    expect(encodeUserOpSignature(sig)).toBe(encodePacked(["uint48", "uint48", "bytes"], [0, 0, sig]));
  });
});
