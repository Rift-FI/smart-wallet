/**
 * Test-only software P-256 "virtual passkey". Produces real WebAuthn
 * assertions (authenticatorData, clientDataJSON, DER signature) exactly
 * like a platform authenticator would, so tests exercise the same bytes
 * the on-chain verifier sees.
 *
 * Never imported by production code.
 */

import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "crypto";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import type { AuthProofWire } from "../passkey/webauthn";

export interface VirtualPasskey {
  credentialId: string;
  x: bigint;
  y: bigint;
  /** 0x04 || x || y */
  publicKey: Hex;
  rpId: string;
  origin: string;
  /** WebAuthn get() for viem's toWebAuthnAccount. */
  getFn: (options?: any) => Promise<any>;
  /** Produce the wire authProof for a 32-byte hash. */
  signHash: (hash: Hex, opts?: { flags?: number; challengeOverride?: Hex }) => AuthProofWire;
  /** viem WebAuthn account (for comparing against permissionless's own signing). */
  account: () => ReturnType<typeof toWebAuthnAccount>;
}

export function createVirtualPasskey(opts: { rpId?: string; origin?: string } = {}): VirtualPasskey {
  const rpId = opts.rpId ?? "app.riftfi.com";
  const origin = opts.origin ?? "https://app.riftfi.com";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const xBytes = Buffer.from(jwk.x, "base64url");
  const yBytes = Buffer.from(jwk.y, "base64url");
  const x = BigInt("0x" + xBytes.toString("hex"));
  const y = BigInt("0x" + yBytes.toString("hex"));
  const credentialId = randomBytes(16).toString("base64url");
  let counter = 0;

  const assert = (challenge: Uint8Array, flags = 0x05) => {
    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.from(challenge).toString("base64url"),
      origin,
      crossOrigin: false,
    });
    counter += 1;
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const authenticatorData = Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([flags]),
      counterBytes,
    ]);
    const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
    const signature = cryptoSign(
      "sha256",
      Buffer.concat([authenticatorData, clientDataHash]),
      privateKey as KeyObject
    );
    return { clientDataJSON: Buffer.from(clientDataJSON, "utf8"), authenticatorData, signature };
  };

  const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

  const getFn = async (options?: any) => {
    const raw = options?.publicKey?.challenge;
    const challenge = typeof raw === "string" ? hexToBytes(raw as Hex) : new Uint8Array(raw);
    const a = assert(challenge);
    return {
      id: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: toArrayBuffer(a.clientDataJSON),
        authenticatorData: toArrayBuffer(a.authenticatorData),
        signature: toArrayBuffer(a.signature),
      },
    };
  };

  const publicKeyHex = bytesToHex(new Uint8Array([0x04, ...xBytes, ...yBytes]));

  return {
    credentialId,
    x,
    y,
    publicKey: publicKeyHex,
    rpId,
    origin,
    getFn,
    signHash: (hash, o = {}) => {
      const a = assert(hexToBytes(o.challengeOverride ?? hash), o.flags ?? 0x05);
      return {
        kind: "passkey",
        cred_id_b64: Buffer.from(credentialId, "base64url").toString("base64"),
        client_data_json_b64: a.clientDataJSON.toString("base64"),
        authenticator_data_b64: a.authenticatorData.toString("base64"),
        signature_b64: a.signature.toString("base64"),
      };
    },
    account: () =>
      toWebAuthnAccount({
        credential: { id: credentialId, publicKey: publicKeyHex },
        getFn: getFn as any,
        rpId,
      }),
  };
}

/** Convenience: hex form of a passkey's public coordinates, as the API takes them. */
export function passkeyCoords(p: VirtualPasskey): { x: Hex; y: Hex } {
  return {
    x: `0x${p.x.toString(16).padStart(64, "0")}` as Hex,
    y: `0x${p.y.toString(16).padStart(64, "0")}` as Hex,
  };
}
