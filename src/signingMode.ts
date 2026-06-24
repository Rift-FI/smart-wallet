/**
 * Per-process signing-mode selector.
 *
 * Phase 1.0 plumbing. The smart-wallet has historically signed every
 * UserOperation in-process by passing a viem `privateKeyToAccount(pk)`
 * directly to `toSafeSmartAccount`. The plaintext key lives in this
 * Node process's memory for the duration of the request.
 *
 * Phase 1 introduces a second mode: signing happens INSIDE a Nitro
 * Enclave. The smart-wallet builds the UserOp + hash in-process (no
 * key material involved), then asks the enclave to sign the hash
 * over a vsock socket. The plaintext key only ever exists in the
 * enclave's encrypted RAM.
 *
 * Selecting the mode is a single env var:
 *   SIGNING_MODE=local      → today's behaviour (default)
 *   SIGNING_MODE=enclave    → routes signature requests to the enclave
 *
 * Backwards compatibility: SIGNING_MODE=enclave is a SUPERSET of local
 * behaviour during the rollout. If the enclave is unreachable or the
 * vsock client throws, the signer transparently falls back to local
 * signing so signing can't be hard-broken by a misconfigured enclave.
 * This shim disappears once we've proven enclave signing in production
 * for ~30 days.
 *
 * Currently the enclave routing is STUBBED — see `signWithEnclave`
 * below. The TODO marker is where the vsock client plugs in.
 */

import type { Hex } from "viem";

export type SigningMode = "local" | "enclave";

/**
 * Read the mode live from env, so test setup that flips env vars in
 * beforeEach actually takes effect without re-importing.
 */
export function getSigningMode(): SigningMode {
  const raw = (process.env.SIGNING_MODE || "").trim().toLowerCase();
  if (raw === "enclave") return "enclave";
  return "local";
}

/** Quick lookup that doesn't allocate a string. */
export function isEnclaveMode(): boolean {
  return getSigningMode() === "enclave";
}

/**
 * Log the signing-mode decision at process boot. Useful in CloudWatch
 * to confirm a deployed instance is in the mode you expected.
 */
export function logSigningModeOnStartup(): void {
  const mode = getSigningMode();
  console.log(`[signingMode] this instance is running in '${mode}' mode`);
  if (mode === "enclave") {
    console.log("[signingMode] enclave path is currently stubbed → falls through to local signing");
    console.log("[signingMode] when vsock client is wired (next commit), Safe UserOp hashes route to the Nitro enclave");
  }
}

/**
 * Stub for the enclave signing call.
 *
 * Returns `null` when the enclave path isn't implemented (or fails).
 * Callers see `null` and fall back to local signing, preserving today's
 * behaviour in `enclave` mode until the real vsock client lands.
 *
 * TODO(rift-1.1): replace this body with:
 *   1. open vsock connection (or HTTP-over-vsock-proxy) to enclave on
 *      port 5005
 *   2. send length-prefixed JSON SignRequest:
 *        { user_op_hash_hex, wrapped_dek_b64, ciphertext_hex, iv_hex,
 *          kms_key_arn }
 *   3. read SignResponse, return Ok.signature_hex
 *   4. on any error: log + return null (caller falls back to local)
 *
 * The enclave's protocol is defined in the rift-signer-enclave repo
 * (src/protocol.rs).
 */
export async function signWithEnclave(_params: {
  userOpHashHex: Hex;
  wrappedDekB64: string;
  ciphertextHex: string;
  ivHex: string;
  kmsKeyArn: string;
}): Promise<Hex | null> {
  if (!isEnclaveMode()) return null;
  // TODO(rift-1.1): wire vsock client.
  return null;
}
