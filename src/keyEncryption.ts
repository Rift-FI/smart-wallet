/**
 * Envelope-aware decryption of the EOA private key.
 *
 * Mirrors the backend's `utils/keyEncryption.ts` exactly — same format,
 * same prefix, same legacy fallback. The two repos use the same scheme
 * so blobs written by backend.encryptKey() decrypt cleanly here.
 *
 * Formats:
 *   Legacy (still readable, pre-envelope rows in the DB):
 *     "<iv_hex>:<ciphertext_hex>" — AES-256-CBC, key = sha256(ENCRYPTION_KEY)
 *
 *   Envelope (new format, produced by backend.encryptKey()):
 *     "enc:v1:<wrapped_dek_b64>:<iv_hex>:<ciphertext_hex>"
 *     wrapped_dek_b64 is KMS-encrypted; we Decrypt via KMS to get the
 *     plaintext DEK, then AES-decrypt the payload with that DEK.
 */

import crypto, { createHash } from "node:crypto";
import { unwrapDataKey } from "./kms";

const ENVELOPE_PREFIX = "enc:v1:";

export async function decryptKey(blob: string): Promise<string> {
  // v2 (password-bound) and v3 (device-bound) envelopes are NEVER
  // decryptable here — they need the user's password or a Nitro
  // enclave with pinned PCR0 respectively. If we get one it means the
  // caller (route handler / middleware) didn't correctly route it to
  // envelope-mode signing. Throw an unambiguous error so the failure
  // reads "v2/v3 must not decrypt in-process" instead of the confusing
  // "Legacy AES blob…" fallthrough.
  if (blob.startsWith("enc:v2:")) {
    throw new Error(
      "v2 (password-bound) envelope cannot be decrypted in-process — the route must forward the blob to the enclave with the user's password"
    );
  }
  if (blob.startsWith("enc:v3:")) {
    throw new Error(
      "v3 (device-bound) envelope cannot be decrypted in-process — the route must forward the blob to the enclave with the user's authProof (SIGNING_MODE must be 'enclave')"
    );
  }

  if (!blob.startsWith(ENVELOPE_PREFIX)) {
    return legacyDecrypt(blob);
  }

  const rest = blob.slice(ENVELOPE_PREFIX.length);
  const firstColon = rest.indexOf(":");
  const secondColon = rest.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    throw new Error("Malformed envelope blob: expected enc:v1:<dek>:<iv>:<ciphertext>");
  }
  const wrappedB64 = rest.slice(0, firstColon);
  const ivHex = rest.slice(firstColon + 1, secondColon);
  const ciphertextHex = rest.slice(secondColon + 1);

  const wrapped = Buffer.from(wrappedB64, "base64");
  const dek = await unwrapDataKey(wrapped);
  try {
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", dek, iv);
    let plaintext = decipher.update(ciphertextHex, "hex", "utf-8");
    plaintext += decipher.final("utf-8");
    return plaintext;
  } finally {
    dek.fill(0);
  }
}

function legacyDecrypt(blob: string): string {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "Legacy AES blob received but ENCRYPTION_KEY env var is not set. " +
        "Cannot decrypt without it. Set ENCRYPTION_KEY on the smart-wallet service " +
        "(same value as the backend) or migrate the blob to envelope format first."
    );
  }
  const key = createHash("sha256").update(String(secret)).digest();
  const parts = blob.split(":");
  if (parts.length !== 2) throw new Error("Malformed legacy AES blob");
  const iv = Buffer.from(parts[0], "hex");
  const ciphertext = parts[1];
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
  let plaintext = decipher.update(ciphertext, "hex", "utf-8");
  plaintext += decipher.final("utf-8");
  return plaintext;
}
