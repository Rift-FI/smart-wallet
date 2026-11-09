/**
 * WebAuthn assertion → Safe contract signature encoding (spec §1d, §2a).
 *
 * The server never holds a passkey and never has a WebAuthn `getFn`. The
 * client signs `hashToSign` (32 raw bytes as the WebAuthn challenge) and
 * sends an `authProof`:
 *
 *   { kind: "passkey", cred_id_b64, client_data_json_b64,
 *     authenticator_data_b64, signature_b64 }          (standard base64, DER sig)
 *
 * From that we build exactly what permissionless's getWebAuthnSignature +
 * concatSignatures produce (node_modules/permissionless/_esm/accounts/safe/
 * signUserOperation.js), with r = the signer address (shared signer for a
 * native-first passkey, SafeWebAuthnSignerProxy otherwise).
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";
import {
  bytesToHex,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hexToBytes,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { PasskeyError } from "./errors";

/** secp256r1 group order. */
export const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Same regex permissionless uses to cut clientDataFields out of clientDataJSON. */
const CLIENT_DATA_REGEX =
  /^\{"type":"webauthn.get","challenge":"[A-Za-z0-9\-_]{43}",(.*)\}$/;

/** authenticatorData flags. The on-chain verifier requires UV. */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export interface AuthProofWire {
  kind: string;
  cred_id_b64?: string;
  client_data_json_b64?: string;
  authenticator_data_b64?: string;
  signature_b64?: string;
}

export interface ParsedAuthProof {
  credentialIdB64: string;
  clientDataJSON: string;
  authenticatorData: Hex;
  signatureDer: Uint8Array;
}

/** Lenient base64 decode: accepts standard and url-safe alphabets, with or without padding. */
export function decodeBase64(value: string, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new PasskeyError("VALIDATION_ERROR", `authProof.${field} is required`);
  }
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised)) {
    throw new PasskeyError("VALIDATION_ERROR", `authProof.${field} is not base64`);
  }
  return new Uint8Array(Buffer.from(normalised, "base64"));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Validate + decode the wire authProof. `kind: "oidc"` (or anything that
 * is not a passkey) is rejected with PASSKEY_REQUIRED.
 */
export function parseAuthProof(proof: unknown): ParsedAuthProof {
  if (!proof || typeof proof !== "object") {
    throw new PasskeyError("PASSKEY_REQUIRED", "authProof (kind: passkey) is required");
  }
  const p = proof as AuthProofWire;
  if (p.kind !== "passkey") {
    throw new PasskeyError(
      "PASSKEY_REQUIRED",
      `authProof.kind must be "passkey" (got ${JSON.stringify(p.kind)})`
    );
  }
  const clientDataBytes = decodeBase64(p.client_data_json_b64 ?? "", "client_data_json_b64");
  const authData = decodeBase64(p.authenticator_data_b64 ?? "", "authenticator_data_b64");
  const sig = decodeBase64(p.signature_b64 ?? "", "signature_b64");
  if (authData.length < 37) {
    throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "authenticatorData is too short");
  }
  return {
    credentialIdB64: typeof p.cred_id_b64 === "string" ? p.cred_id_b64 : "",
    clientDataJSON: Buffer.from(clientDataBytes).toString("utf8"),
    authenticatorData: bytesToHex(authData),
    signatureDer: sig,
  };
}

/** The part of clientDataJSON after `"challenge":"…",` up to (excluding) the final `}`. */
export function extractClientDataFields(clientDataJSON: string): string {
  const match = clientDataJSON.match(CLIENT_DATA_REGEX);
  if (!match || match[1] === undefined) {
    throw new PasskeyError(
      "INVALID_PASSKEY_SIGNATURE",
      "clientDataJSON is not a webauthn.get assertion with a 32-byte challenge"
    );
  }
  return match[1];
}

/** Decode clientDataJSON.challenge (base64url) back to hex. */
export function extractChallenge(clientDataJSON: string): Hex {
  let parsed: { type?: unknown; challenge?: unknown };
  try {
    parsed = JSON.parse(clientDataJSON);
  } catch {
    throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "clientDataJSON is not valid JSON");
  }
  if (parsed.type !== "webauthn.get") {
    throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "clientDataJSON.type must be webauthn.get");
  }
  if (typeof parsed.challenge !== "string") {
    throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "clientDataJSON.challenge missing");
  }
  return bytesToHex(new Uint8Array(Buffer.from(parsed.challenge, "base64url")));
}

export function assertChallengeMatches(clientDataJSON: string, hashToSign: Hex): void {
  const challenge = extractChallenge(clientDataJSON);
  if (challenge.toLowerCase() !== hashToSign.toLowerCase()) {
    throw new PasskeyError(
      "INVALID_PASSKEY_SIGNATURE",
      "passkey challenge does not match hashToSign"
    );
  }
}

export function assertUserVerified(authenticatorData: Hex): void {
  const flags = hexToBytes(authenticatorData)[32] ?? 0;
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) {
    throw new PasskeyError(
      "INVALID_PASSKEY_SIGNATURE",
      "authenticatorData must have user-present and user-verified flags set"
    );
  }
}

/**
 * Parse a DER-encoded ECDSA signature (SEQUENCE { INTEGER r, INTEGER s })
 * into (r, s), normalising s to low-s (matches ox's parseAsn1Signature, so
 * the output is byte-identical to permissionless's own signing).
 */
export function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  const fail = (why: string): never => {
    throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", `malformed DER signature: ${why}`);
  };
  let i = 0;
  if (der[i++] !== 0x30) fail("expected SEQUENCE");
  let seqLen = der[i++] ?? fail("truncated");
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | (der[i++] ?? fail("truncated"));
  }
  if (i + seqLen !== der.length) fail("length mismatch");

  const readInt = (): bigint => {
    if (der[i++] !== 0x02) fail("expected INTEGER");
    const len = der[i++] ?? fail("truncated");
    if (len === 0 || i + len > der.length) fail("bad INTEGER length");
    const bytes = der.slice(i, i + len);
    i += len;
    return BigInt(bytesToHex(bytes));
  };
  const r = readInt();
  let s = readInt();
  if (i !== der.length) fail("trailing bytes");
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) fail("r/s out of range");
  if (s > P256_N / 2n) s = P256_N - s;
  return { r, s };
}

/** abi.encode(bytes authenticatorData, string clientDataFields, uint256[2] [r, s]) */
export function encodeWebAuthnSignatureData(params: {
  authenticatorData: Hex;
  clientDataFields: string;
  r: bigint;
  s: bigint;
}): Hex {
  return encodeAbiParameters(
    [
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
      { name: "signature", type: "uint256[2]" },
    ],
    [params.authenticatorData, params.clientDataFields, [params.r, params.s]]
  );
}

/**
 * Safe contract-signature encoding for ONE signer (threshold 1):
 *   {32B r = signer}{32B s = offset of dynamic part (65)}{1B v = 0}
 *   {32B length}{data}
 */
export function encodeSafeContractSignature(signer: Address, data: Hex): Hex {
  const dataHex = data.slice(2);
  const signerWord = getAddress(signer).slice(2).toLowerCase().padStart(64, "0");
  const offsetWord = (65).toString(16).padStart(64, "0");
  const lengthWord = (dataHex.length / 2).toString(16).padStart(64, "0");
  return `0x${signerWord}${offsetWord}00${lengthWord}${dataHex}` as Hex;
}

/** UserOp signature: encodePacked(uint48 validAfter, uint48 validUntil, contractSignature). */
export function encodeUserOpSignature(
  contractSignature: Hex,
  validAfter = 0,
  validUntil = 0
): Hex {
  return encodePacked(
    ["uint48", "uint48", "bytes"],
    [validAfter, validUntil, contractSignature]
  );
}

/** Off-chain P-256 check over authenticatorData || sha256(clientDataJSON). */
export function verifyP256Assertion(params: {
  x: bigint;
  y: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
  r: bigint;
  s: bigint;
}): boolean {
  try {
    const to32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: to32(params.x).toString("base64url"),
        y: to32(params.y).toString("base64url"),
      },
      format: "jwk",
    });
    const clientDataHash = createHash("sha256").update(params.clientDataJSON, "utf8").digest();
    const message = Buffer.concat([Buffer.from(hexToBytes(params.authenticatorData)), clientDataHash]);
    const sig = Buffer.concat([to32(params.r), to32(params.s)]);
    return cryptoVerify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

export interface PasskeySignature {
  /** abi.encode(authData, clientDataFields, [r, s]) */
  webauthnData: Hex;
  /** Safe contract signature with r = signer */
  contractSignature: Hex;
  r: bigint;
  s: bigint;
  parsed: ParsedAuthProof;
}

/**
 * Full server-side path: authProof → checked → Safe contract signature.
 * Throws PasskeyError on any mismatch (challenge, type, UV flag, DER).
 */
export function buildPasskeySignature(params: {
  authProof: unknown;
  hashToSign: Hex;
  signer: Address;
}): PasskeySignature {
  if (!isHex(params.hashToSign) || params.hashToSign.length !== 66) {
    throw new PasskeyError("VALIDATION_ERROR", "hashToSign must be 32 bytes");
  }
  const parsed = parseAuthProof(params.authProof);
  assertChallengeMatches(parsed.clientDataJSON, params.hashToSign);
  const clientDataFields = extractClientDataFields(parsed.clientDataJSON);
  assertUserVerified(parsed.authenticatorData);
  const { r, s } = derToRS(parsed.signatureDer);
  const webauthnData = encodeWebAuthnSignatureData({
    authenticatorData: parsed.authenticatorData,
    clientDataFields,
    r,
    s,
  });
  return {
    webauthnData,
    contractSignature: encodeSafeContractSignature(params.signer, webauthnData),
    r,
    s,
    parsed,
  };
}
