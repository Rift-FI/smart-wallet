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

export interface EnvelopeV2Parts {
  wrappedDekB64: string;
  saltB64: string;
  nonceHex: string;
  ciphertextHex: string;
  tagHex: string;
}

/**
 * Parse the Phase-3 v2 envelope format:
 *   enc:v2:<wrapped_dek_b64>:<salt_b64>:<nonce_hex>:<ciphertext_hex>:<tag_hex>
 *
 * v2 binds the encryption key to (KMS DEK XOR HKDF(password, salt)), so
 * the enclave needs the user's password to decrypt. The smart-wallet
 * itself never sees the plaintext key in v2 mode — it just forwards.
 */
export function parseEnvelopeV2(blob: string): EnvelopeV2Parts | null {
  const prefix = "enc:v2:";
  if (!blob.startsWith(prefix)) return null;
  const parts = blob.slice(prefix.length).split(":");
  if (parts.length !== 5) return null;
  return {
    wrappedDekB64: parts[0],
    saltB64: parts[1],
    nonceHex: parts[2],
    ciphertextHex: parts[3],
    tagHex: parts[4],
  };
}

export interface EnvelopeV3Parts {
  wrappedDekB64: string;
  nonceHex: string;
  ciphertextHex: string;
  tagHex: string;
}

/**
 * Parse the Phase-3 v3 envelope format:
 *   enc:v3:<wrapped_dek_b64>:<nonce_hex>:<ciphertext_hex>:<tag_hex>
 *
 * v3 envelopes are device-bound: the EOA private key + the enrolled
 * auth methods (Passkey credential IDs / OIDC subjects) are sealed
 * together under AES-GCM with the KMS-released DEK. Every sign needs
 * a fresh `authProof` (OIDC id_token bound to the user op hash, or a
 * WebAuthn assertion challenged with the user op hash). The smart-
 * wallet never sees the plaintext key — same as v2.
 */
export function parseEnvelopeV3(blob: string): EnvelopeV3Parts | null {
  const prefix = "enc:v3:";
  if (!blob.startsWith(prefix)) return null;
  const parts = blob.slice(prefix.length).split(":");
  if (parts.length !== 4) return null;
  const [wrappedDekB64, nonceHex, ciphertextHex, tagHex] = parts;
  if (!wrappedDekB64 || !nonceHex || !ciphertextHex || !tagHex) return null;
  return { wrappedDekB64, nonceHex, ciphertextHex, tagHex };
}

/**
 * Wire shape of a v3 consent proof. Pass-through from the SDK to the
 * enclave. The smart-wallet never inspects the contents — only the
 * enclave can verify a JWT or a WebAuthn assertion.
 */
export type AuthProof =
  | { kind: "oidc"; id_token: string }
  | {
      kind: "passkey";
      cred_id_b64: string;
      client_data_json_b64: string;
      authenticator_data_b64: string;
      signature_b64: string;
    };

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
  /** Required for v2 envelopes (password-bound). Ignored for v1 / v3. */
  password?: string;
  /** Required for v3 envelopes (device-bound). Ignored for v1 / v2. */
  authProof?: AuthProof;
  /**
   * Optional per-request override. When provided, the sign call goes
   * to the integrator's own parent-proxy with their bearer instead of
   * the process-wide env defaults (PARENT_PROXY_URL / PARENT_PROXY_AUTH_TOKEN).
   * Set by the route layer after resolving the caller's projectId
   * against the backend's /internal/projects/:id/enclave-config
   * endpoint. When null / omitted, env defaults apply (current single-
   * tenant Rift-hosted flow).
   */
  route?: { parentProxyUrl: string; parentProxyBearer: string } | null;

  /**
   * Rift-project-id the sign request is scoped to. v3-passkey path
   * only. Combined with `signedConfig` below, tells the enclave
   * which project's per-project WebAuthn accept list to apply.
   * Present without signedConfig → enclave uses hardcoded default
   * (same as omitting both). Ignored on v1/v2/OIDC paths.
   */
  projectId?: string;

  /**
   * v3 / passkey path only. Rift-signed per-project WebAuthn
   * accept-list bundle produced by the backend
   * `projectConfigSigner.signProjectAcceptConfig`, retrieved via
   * `loadProjectSignedAcceptConfig(projectId)`.
   *
   * When present + verifies inside the enclave, the enclave uses
   * THIS project's accepted_origins + accepted_rp_ids instead of
   * the hardcoded Rift-only default. Malformed / stale / wrong-
   * project bundle → enclave silently falls back to hardcoded
   * (never a hard error, so a bad config can't take down signing).
   *
   * Pass BYTE-FOR-BYTE the `signed_config_json` string from the
   * signer/DB loader — do NOT JSON.parse + re-stringify; the
   * enclave hashes these exact bytes for signature verification.
   */
  signedConfig?: {
    signed_config_json: string;
    signature_b64: string;
  };
}): Promise<Hex | null> {
  if (!isEnclaveMode()) return null;

  let body: Record<string, unknown>;
  if (params.envelopeBlob.startsWith("enc:v3:")) {
    if (!params.authProof) {
      console.warn(
        "[signingMode] v3 envelope requires authProof (device-bound). Refusing to call /sign."
      );
      return null;
    }
    if (params.password) {
      console.warn(
        "[signingMode] v3 envelope must not be combined with password — they are mutually exclusive. Refusing."
      );
      return null;
    }
    // Validate the blob parses so we fail locally, not at the proxy.
    if (!parseEnvelopeV3(params.envelopeBlob)) {
      console.warn("[signingMode] malformed enc:v3: blob");
      return null;
    }
    body = {
      user_op_hash_hex: params.userOpHashHex,
      v3_envelope_blob: params.envelopeBlob,
      auth_proof: params.authProof,
      kms_key_arn: params.kmsKeyArn,
    };
    // Attach the signed per-project WebAuthn accept-list bundle if
    // the caller resolved one for this project. Enclave verifies +
    // uses it as the policy for THIS request. Absent bundle → enclave
    // falls back to hardcoded default (Rift's own domains) — same
    // behaviour as before this field existed. See
    // rift-signer-enclave/enclave/src/project_config.rs.
    //
    // Pass BYTE-FOR-BYTE. Enclave hashes signed_config_json as-is;
    // any re-serialisation between here and the enclave would break
    // the signature verification and silently degrade to the default
    // policy.
    if (params.signedConfig) {
      body.signed_config_json = params.signedConfig.signed_config_json;
      body.signed_config_signature_b64 = params.signedConfig.signature_b64;
    }
    if (params.projectId) {
      body.project_id = params.projectId;
    }
  } else if (params.envelopeBlob.startsWith("enc:v2:")) {
    if (!params.password) {
      console.warn(
        "[signingMode] v2 envelope requires a password (non-custodial). Refusing to call /sign."
      );
      return null;
    }
    const v2 = parseEnvelopeV2(params.envelopeBlob);
    if (!v2) {
      console.warn("[signingMode] malformed enc:v2: blob");
      return null;
    }
    body = {
      user_op_hash_hex: params.userOpHashHex,
      wrapped_dek_b64: v2.wrappedDekB64,
      salt_b64: v2.saltB64,
      nonce_hex: v2.nonceHex,
      ciphertext_hex: v2.ciphertextHex,
      tag_hex: v2.tagHex,
      password: params.password,
      kms_key_arn: params.kmsKeyArn,
    };
  } else {
    const parts = parseEnvelope(params.envelopeBlob);
    if (!parts) {
      console.warn(
        "[signingMode] envelope blob is not in enc:v1: or enc:v2: format"
      );
      return null;
    }
    body = {
      user_op_hash_hex: params.userOpHashHex,
      wrapped_dek_b64: parts.wrappedDekB64,
      iv_hex: parts.ivHex,
      ciphertext_hex: parts.ciphertextHex,
      kms_key_arn: params.kmsKeyArn,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    // Route resolution. When a per-request route is provided (multi-
    // tenant integrator flow), send to THAT parent-proxy with THEIR
    // bearer. Otherwise use the process-wide env defaults — the
    // Rift-hosted single-tenant flow.
    const targetUrl = params.route?.parentProxyUrl ?? PARENT_PROXY_URL;
    const targetBearer =
      params.route?.parentProxyBearer ?? process.env.PARENT_PROXY_AUTH_TOKEN;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (targetBearer) {
      headers["authorization"] = `Bearer ${targetBearer}`;
    }

    const response = await fetch(`${targetUrl}/sign`, {
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
