/**
 * Signer factory — local key vs. enclave-backed.
 *
 * Returns a viem `Account` that `toSafeSmartAccount({ owners: [account] })`
 * can use directly:
 *   - SIGNING_MODE=local (default): same as `privateKeyToAccount(pk)` today.
 *   - SIGNING_MODE=enclave: a custom Account whose `signMessage` routes
 *     the message hash through the parent-proxy → enclave instead of
 *     signing in-process. The plaintext key is never used by the
 *     smart-wallet process in this mode.
 *
 * Refactor seam: every call site that does
 *
 *     const signer = privateKeyToAccount(ownerPrivateKey)
 *
 * becomes
 *
 *     const signer = await makeSigner({
 *       privateKey: ownerPrivateKey,
 *       envelopeBlob: ownerEncryptedKey,    // from req.body (Phase 0.5)
 *       kmsKeyArn: process.env.KMS_KEY_ARN_<mode>,
 *     })
 *
 * Callers in this repo: abstraction.ts (×2), relay.ts (×2),
 * estimateBridge.ts, estimateTransfer.ts. TODO(rift-1.2) refactor them
 * in a follow-up commit — this file ships the abstraction first so the
 * refactor is mechanical, not architectural.
 */

import {
  type Account,
  type Hex,
  type LocalAccount,
  type SignableMessage,
  hashMessage,
  hexToBytes,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isEnclaveMode, signWithEnclave } from "./signingMode";

export interface SignerOptions {
  /** Hex-encoded EOA private key, with or without 0x prefix. */
  privateKey: string;
  /**
   * The KMS envelope blob the backend posted. Required when running
   * in enclave mode — without it we can't ask the enclave to decrypt.
   * If omitted in enclave mode, we throw at construction time so the
   * call site can decide to fall back to local (or surface a clear
   * 400/500).
   */
  envelopeBlob?: string;
  /**
   * Mode-appropriate KMS CMK ARN — forwarded to the enclave so the
   * parent proxy calls KMS Decrypt against the right key.
   */
  kmsKeyArn?: string;
}

/**
 * Build a viem Account. In enclave mode, the returned account's
 * `signMessage` calls the parent-proxy. If the enclave call returns
 * null (rollout fallback / mis-config / network failure), the account
 * silently signs locally with the plaintext key — so a temporary
 * enclave outage doesn't break signing for users.
 *
 * Drop the silent fallback before declaring Phase 1 GA.
 */
export async function makeSigner(opts: SignerOptions): Promise<Account> {
  const pk = (opts.privateKey.startsWith("0x")
    ? opts.privateKey
    : `0x${opts.privateKey}`) as Hex;
  const localAccount = privateKeyToAccount(pk);

  if (!isEnclaveMode()) {
    return localAccount;
  }

  if (!opts.envelopeBlob || !opts.kmsKeyArn) {
    console.warn(
      "[signerFactory] enclave mode requested but envelopeBlob/kmsKeyArn missing — falling back to local"
    );
    return localAccount;
  }

  const envelopeBlob = opts.envelopeBlob;
  const kmsKeyArn = opts.kmsKeyArn;

  // Construct a hybrid account: address + signing methods that route
  // through the enclave for `signMessage` (the one Safe uses) and
  // delegate other signing methods to the local key (rarely used, kept
  // for viem interface completeness).
  const enclaveSign = async (hashOrMessage: SignableMessage): Promise<Hex> => {
    const hashHex = (() => {
      // Safe's signing passes the user-op hash as `raw` 32 bytes.
      if (typeof hashOrMessage === "object" && "raw" in hashOrMessage) {
        const raw = hashOrMessage.raw;
        if (typeof raw === "string") return raw as Hex;
        return ("0x" +
          Array.from(raw)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")) as Hex;
      }
      // Defensive: if someone passes a string, compute its EIP-191 hash
      // — Safe doesn't do this but the Account contract allows it.
      return hashMessage(hashOrMessage as any);
    })();

    const sig = await signWithEnclave({
      userOpHashHex: hashHex,
      envelopeBlob,
      kmsKeyArn,
    });
    if (sig !== null) return sig;
    console.warn(
      "[signerFactory] enclave returned null — falling back to local sign for this op"
    );
    return localAccount.signMessage({ message: hashOrMessage });
  };

  const account: LocalAccount = {
    ...localAccount,
    type: "local",
    source: "custom",
    async signMessage({ message }) {
      return enclaveSign(message);
    },
    async signTypedData(typedData) {
      // viem typed-data signing — for Safe this isn't on the hot path
      // (Safe uses signMessage with the prehash). Keep local for safety.
      return localAccount.signTypedData(typedData);
    },
    async signTransaction(transaction, options) {
      // Raw transaction signing — not used by ERC-4337 / Safe path.
      return localAccount.signTransaction(transaction, options);
    },
    async sign(parameters) {
      // Low-level prehash sign — Safe's signing path eventually lands
      // here. Route to enclave too.
      const hashHex = parameters.hash as Hex;
      const sig = await signWithEnclave({
        userOpHashHex: hashHex,
        envelopeBlob,
        kmsKeyArn,
      });
      if (sig !== null) return sig;
      return localAccount.sign(parameters);
    },
  };

  return account;
}
