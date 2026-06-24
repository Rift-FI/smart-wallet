/**
 * AWS KMS decryption for the envelope-encrypted EOA private key.
 *
 * The smart-wallet service used to require the plaintext private key in
 * every request from the backend — meaning the key crossed HTTPS and
 * lived in this service's request memory before signing. With Phase 0.5,
 * the backend instead sends the envelope blob; this service decrypts the
 * data encryption key (DEK) via KMS in-process, signs, then wipes.
 *
 * Only Decrypt is needed here — the smart-wallet never generates new
 * encryption keys, only unwraps existing ones produced by the backend.
 *
 * Credentials resolve from the default AWS SDK chain: env vars
 * (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY) first. Reuse the same
 * `rift-backend-kms` IAM user the backend uses — its KMS permissions
 * already include Decrypt on both production and sandbox CMKs.
 *
 * KeyId is intentionally NOT pinned in the Decrypt call. KMS infers the
 * CMK from the ciphertext metadata, so the same code path works for
 * either mode without the smart-wallet needing to know which.
 */

import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";

const REGION = process.env.AWS_REGION || "us-east-1";

let cachedClient: KMSClient | null = null;

function client(): KMSClient {
  if (!cachedClient) {
    cachedClient = new KMSClient({ region: REGION, maxAttempts: 3 });
  }
  return cachedClient;
}

export async function unwrapDataKey(wrapped: Buffer): Promise<Buffer> {
  const res = await client().send(
    new DecryptCommand({ CiphertextBlob: wrapped })
  );
  if (!res.Plaintext) {
    throw new Error("KMS Decrypt returned no plaintext");
  }
  return Buffer.from(res.Plaintext);
}

export function isKmsConfigured(): boolean {
  return !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
}
