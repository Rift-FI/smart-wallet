/**
 * Signer factory — local key vs. enclave-backed.
 *
 * Three modes:
 *   1. SIGNING_MODE=local (default): same as `privateKeyToAccount(pk)` today.
 *   2. SIGNING_MODE=enclave + ownerAddress + envelope + KMS ARN:
 *      **no-key path.** Returns a viem Account whose `address` is the
 *      passed-in EOA, and whose `signMessage` / `sign` route to the
 *      Nitro enclave via the parent-proxy. The plaintext private key
 *      NEVER enters this Node process — exactly the Phase 1 goal.
 *   3. SIGNING_MODE=enclave + privateKey (no address): legacy fallback
 *      from earlier in Phase 1 rollout. Plaintext briefly lives in
 *      memory for the address derivation but signing still routes to
 *      the enclave. Kept so a misconfigured request doesn't 500.
 *
 * Mode 2 is what the smart-wallet should be doing in steady state.
 * Backend already passes `ownerAddress` in the body — when the route
 * threads it into `signerOptions`, we get the no-key path automatically.
 */

import {
  type Account,
  type Hex,
  type LocalAccount,
  type SignableMessage,
  hashMessage,
  hashTypedData,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { isEnclaveMode, signWithEnclave } from "./signingMode";

export interface SignerOptions {
  /** Hex-encoded EOA private key, with or without 0x prefix.
   *  Optional in enclave mode when `ownerAddress` is supplied — that's
   *  the no-key path. Required otherwise. */
  privateKey?: string;
  /** The KMS envelope blob the backend posted. Required for enclave mode. */
  envelopeBlob?: string;
  /** Mode-appropriate KMS CMK ARN. Required for enclave mode. */
  kmsKeyArn?: string;
  /** EOA owner address (hex 0x-prefixed). When supplied alongside
   *  envelope + KMS ARN in enclave mode, signs via no-key path so the
   *  plaintext never enters this process. */
  ownerAddress?: string;
}

function ensure0xPrefix(s: string): Hex {
  return (s.startsWith("0x") ? s : `0x${s}`) as Hex;
}

/**
 * Extract a 32-byte hex hash from anything viem might pass to
 * signMessage. Safe / permissionless typically pass `{raw: ...}` with
 * the prehash; we honour that. For a string message we EIP-191 hash it.
 */
function hashFromMessage(message: SignableMessage): Hex {
  if (typeof message === "object" && "raw" in message) {
    const raw = message.raw;
    if (typeof raw === "string") return raw as Hex;
    return ("0x" +
      Array.from(raw)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex;
  }
  return hashMessage(message);
}

/**
 * Build a viem Account. See module docstring for the three modes.
 *
 * - Local mode: returns `privateKeyToAccount(pk)`.
 * - Enclave + ownerAddress: NO-KEY path. Custom toAccount with
 *   enclave-backed signMessage / sign. **plaintext never touches this
 *   process's memory** (assuming the resolveOwnerKey middleware also
 *   skipped decryption in enclave mode, which it does).
 * - Enclave + privateKey (no address): hybrid. Address derived locally
 *   from the key, signing still routes to the enclave. Plaintext is
 *   in memory briefly during construction.
 */
export async function makeSigner(opts: SignerOptions): Promise<Account> {
  // ─── Local mode ─────────────────────────────────────────────────
  if (!isEnclaveMode()) {
    if (!opts.privateKey) {
      throw new Error("makeSigner: local mode requires `privateKey`");
    }
    return privateKeyToAccount(ensure0xPrefix(opts.privateKey));
  }

  // ─── Enclave mode ───────────────────────────────────────────────
  if (!opts.envelopeBlob || !opts.kmsKeyArn) {
    // Misconfigured. If we have a private key, fall back to local —
    // matches today's "graceful fallback" property in case the EC2
    // is mis-deployed.
    console.warn(
      "[signerFactory] enclave mode requested but envelope/kmsKeyArn missing — falling back to local"
    );
    if (!opts.privateKey) {
      throw new Error(
        "makeSigner: enclave mode needs envelope+kmsKeyArn, or privateKey for fallback"
      );
    }
    return privateKeyToAccount(ensure0xPrefix(opts.privateKey));
  }

  const envelopeBlob = opts.envelopeBlob;
  const kmsKeyArn = opts.kmsKeyArn;

  // The shared enclave-sign closure used by both signMessage AND the
  // low-level sign primitive (which Safe's signing path eventually hits).
  const enclaveSign = async (hashHex: Hex): Promise<Hex> => {
    const sig = await signWithEnclave({
      userOpHashHex: hashHex,
      envelopeBlob,
      kmsKeyArn,
    });
    if (sig === null) {
      throw new Error(
        "enclave sign returned null — parent-proxy unreachable or KMS attestation rejected"
      );
    }
    return sig;
  };

  // ─── No-key path: only the address, signing via enclave ─────────
  if (opts.ownerAddress) {
    return toAccount({
      address: ensure0xPrefix(opts.ownerAddress),
      async signMessage({ message }) {
        return enclaveSign(hashFromMessage(message));
      },
      async signTransaction() {
        throw new Error(
          "signerFactory: signTransaction not supported in enclave no-key mode (Safe path uses signMessage)"
        );
      },
      async signTypedData(parameters) {
        // Hash the typed data + sign via enclave. Same code path as a
        // prehash signMessage from the enclave's perspective.
        const hash = hashTypedData(parameters as any);
        return enclaveSign(hash);
      },
    });
  }

  // ─── Hybrid fallback: privateKey present (used for address only),
  // signing routes to enclave. Plaintext briefly in memory. ────────
  if (!opts.privateKey) {
    throw new Error(
      "makeSigner: enclave mode needs ownerAddress (no-key path) or privateKey (hybrid)"
    );
  }
  const pk = ensure0xPrefix(opts.privateKey);
  const localAccount = privateKeyToAccount(pk);
  const account: LocalAccount = {
    ...localAccount,
    type: "local",
    source: "custom",
    async signMessage({ message }) {
      return enclaveSign(hashFromMessage(message));
    },
    async signTypedData(typedData) {
      const hash = hashTypedData(typedData as any);
      return enclaveSign(hash);
    },
    async signTransaction(transaction, options) {
      return localAccount.signTransaction(transaction, options);
    },
    async sign(parameters) {
      return enclaveSign(parameters.hash as Hex);
    },
  };
  return account;
}
