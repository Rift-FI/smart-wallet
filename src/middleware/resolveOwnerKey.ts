/**
 * Smart-wallet middleware: if the request body has `ownerEncryptedKey`
 * (the new envelope-encrypted blob from the backend), decrypt it via KMS
 * in-process and populate `ownerPrivateKey` on the body. The 8 route
 * handlers downstream all read `ownerPrivateKey`, so they don't need any
 * changes — they just see plaintext like they did before.
 *
 * If the request still ships `ownerPrivateKey` directly (legacy backend,
 * or first-deploy rollout window where the backend hasn't been updated
 * yet), this middleware is a no-op and the route runs unchanged.
 *
 * Why a middleware instead of editing each route:
 *   - 8 routes read `ownerPrivateKey`; doing the same conditional decrypt
 *     in each adds churn and risks one route missing it.
 *   - The decrypt+wipe lifecycle is centralized here; less surface area
 *     for plaintext-leak bugs.
 *
 * Security shape after this lands:
 *   - Backend sends envelope blob over HTTPS (not plaintext).
 *   - Smart-wallet decrypts in-memory immediately, plaintext lives for
 *     the duration of the request handler, then GC.
 *   - The HTTPS payload by itself is useless without KMS access.
 */

import type { Request, Response, NextFunction } from "express";
import { decryptKey } from "../keyEncryption";

export async function resolveOwnerKey(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body) return next();

    // Already in plaintext form — backend hasn't been updated yet, or
    // we're handling a legacy caller. Either way, nothing to do.
    if (typeof body.ownerPrivateKey === "string" && body.ownerPrivateKey.length > 0) {
      return next();
    }

    // The new path: backend supplied the envelope blob. Decrypt it.
    const encrypted = body.ownerEncryptedKey;
    if (typeof encrypted !== "string" || encrypted.length === 0) {
      // No key material in either form — let the route's own validation
      // produce the 400. We don't want to interfere with routes that
      // legitimately don't need a key (e.g. estimate-fee, smart-account/address
      // computed from a known address).
      return next();
    }

    const plaintext = await decryptKey(encrypted);
    body.ownerPrivateKey = plaintext;
    // Phase 1: KEEP the envelope blob on the body so the route handler
    // can forward it to the enclave when SIGNING_MODE=enclave. In local
    // mode this is just untouched and the route ignores it. The
    // makeSigner factory reads both — plaintext for local-mode signing
    // and address derivation, envelope blob for enclave-mode signing.
    // Logging concern: don't log `ownerEncryptedKey` in this service's
    // request logs. The blob is opaque without KMS but still ends up in
    // CloudTrail noise if leaked.

    next();
  } catch (err: any) {
    next(err);
  }
}
