/**
 * Per-process signing-mode selector + parent-proxy HTTP client.
 *
 * Phase 1 — the smart-wallet runs on the EC2 host (NOT inside the
 * enclave) and delegates the actual signing primitive to the enclave
 * via the parent-proxy. The parent-proxy listens on
 * http://127.0.0.1:7777 (set via PARENT_PROXY_URL).
 *
 * Flow when SIGNING_MODE=enclave:
 *   1. Smart-wallet builds the UserOp + computes the Safe-specific hash
 *      (no key material involved — pure encoding).
 *   2. Smart-wallet POSTs to parent-proxy: {user_op_hash_hex, envelope,
 *      kms_key_arn}.
 *   3. Parent-proxy forwards over vsock to the enclave.
 *   4. Enclave KMS-attests, RSA-OAEP unwraps the DEK, AES-decrypts the
 *      envelope, secp256k1 signs, returns the 65-byte signature.
 *   5. Parent-proxy returns the signature over HTTP.
 *
 * Backwards-compat: if SIGNING_MODE=local (default) or the
 * parent-proxy is unreachable, signWithEnclave returns null and the
 * caller falls back to signing with the plaintext key in-process —
 * same behaviour as today.
 */

import type { Hex } from "viem";

export type SigningMode = "local" | "enclave";

const PARENT_PROXY_URL =
  process.env.PARENT_PROXY_URL || "http://127.0.0.1:7777";

// Live env read so tests can override SIGNING_MODE per case.
export function getSigningMode(): SigningMode {
  const raw = (process.env.SIGNING_MODE || "").trim().toLowerCase();
  return raw === "enclave" ? "enclave" : "local";
}

export function isEnclaveMode(): boolean {
  return getSigningMode() === "enclave";
}

export function logSigningModeOnStartup(): void {
  const mode = getSigningMode();
  console.log(`[signingMode] this instance is running in '${mode}' mode`);
  if (mode === "enclave") {
    console.log(`[signingMode] enclave signing via parent-proxy at ${PARENT_PROXY_URL}`);
  }
}

/**
 * Pre-parsed envelope blob suitable for sending to the enclave.
 * Backend stores blobs as `enc:v1:<wrapped_dek_b64>:<iv_hex>:<ciphertext_hex>`.
 */
export interface EnvelopeParts {
  wrappedDekB64: string;
  ivHex: string;
  ciphertextHex: string;
}

/**
 * Parse the backend's envelope format into its three components.
 * Returns null when the input isn't an envelope blob (legacy AES
 * format starts with `<iv_hex>:<ciphertext_hex>` and has no prefix).
 */
export function parseEnvelope(blob: string): EnvelopeParts | null {
  const prefix = "enc:v1:";
  if (!blob.startsWith(prefix)) return null;
  const rest = blob.slice(prefix.length);
  const firstColon = rest.indexOf(":");
  const secondColon = rest.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) return null;
  return {
    wrappedDekB64: rest.slice(0, firstColon),
    ivHex: rest.slice(firstColon + 1, secondColon),
    ciphertextHex: rest.slice(secondColon + 1),
  };
}

/**
 * Sign a Safe UserOp hash by routing through the parent-proxy → enclave.
 *
 * Returns the 65-byte Ethereum-canonical signature as 0x-prefixed hex,
 * or `null` when:
 *   - SIGNING_MODE is not "enclave" (caller signs locally)
 *   - the envelope blob isn't in `enc:v1:` format (no DEK to unwrap)
 *   - the parent-proxy is unreachable / returns an error (graceful
 *     fallback to local signing during the rollout window)
 *
 * The HTTP call has a 30-second timeout; the enclave's RSA key
 * generation is the slowest step (~50-200ms on Graviton) but the
 * generous timeout keeps us robust against the occasional cold-start.
 */
export async function signWithEnclave(params: {
  userOpHashHex: Hex;
  envelopeBlob: string;
  kmsKeyArn: string;
}): Promise<Hex | null> {
  if (!isEnclaveMode()) return null;
  const parts = parseEnvelope(params.envelopeBlob);
  if (!parts) {
    console.warn(
      "[signingMode] envelope blob is not in enc:v1: format — falling back to local signing"
    );
    return null;
  }

  const body = {
    user_op_hash_hex: params.userOpHashHex,
    wrapped_dek_b64: parts.wrappedDekB64,
    iv_hex: parts.ivHex,
    ciphertext_hex: parts.ciphertextHex,
    kms_key_arn: params.kmsKeyArn,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    // Build headers. When PARENT_PROXY_AUTH_TOKEN is set in env, send
    // the matching Bearer token — the parent-proxy on the EC2 will
    // 401 anything else, so this is the gate that keeps random
    // internet from hitting the public /sign endpoint.
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const proxyToken = process.env.PARENT_PROXY_AUTH_TOKEN;
    if (proxyToken) {
      headers["authorization"] = `Bearer ${proxyToken}`;
    }

    const response = await fetch(`${PARENT_PROXY_URL}/sign`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "<no body>");
      console.error(
        `[signingMode] parent-proxy returned ${response.status}: ${text}`
      );
      return null;
    }
    const json = (await response.json()) as { signature_hex?: string };
    if (!json.signature_hex) {
      console.error("[signingMode] parent-proxy response had no signature_hex");
      return null;
    }
    return json.signature_hex as Hex;
  } catch (err: any) {
    console.error(`[signingMode] parent-proxy call failed: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
