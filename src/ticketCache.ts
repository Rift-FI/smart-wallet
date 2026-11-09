/**
 * In-memory ticket cache for two-phase passkey signing.
 *
 * Why this exists:
 *   Every UserOp / message is signed by the user's passkey on their
 *   device. The hash to sign (SafeOp / SafeMessage EIP-712 hash) isn't
 *   known until the smart-wallet has built the op (gas, paymaster data,
 *   nonce), so the client can't sign upfront.
 *
 * Two-phase flow:
 *   1. prepare → smart-wallet builds the unsigned op, returns
 *      { ticketId, hashToSign }, stashes the op here.
 *   2. Client signs hashToSign with a passkey (WebAuthn challenge).
 *   3. submit { ticketId, signer, authProof } → smart-wallet encodes the
 *      Safe contract signature, verifies it, submits to the bundler.
 *
 * Single-process in-memory Map is fine: smart-wallet is currently a
 * single Node instance (Caprover container, no HA). For multi-instance
 * deploys we'd swap this for Redis with the same interface.
 *
 * TTL: 120s by default (TICKET_TTL_MS) — long enough for a user to sign
 * a few chains in a row, short enough that stale gas prices / paymaster
 * signatures can't be replayed.
 */

import { randomBytes } from "crypto";

interface TicketEntry<T> {
  value: T;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry<unknown>>();

const TTL_MS = (() => {
  const raw = Number(process.env.TICKET_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

// Lazy cleanup on every lookup is enough — the cache stays small.
// No need for a setInterval that holds the event loop open.
function evictExpired(now: number): void {
  for (const [id, entry] of tickets.entries()) {
    if (entry.expiresAt <= now) tickets.delete(id);
  }
}

export function stashTicket<T>(value: T): { ticketId: string; expiresAt: number } {
  const now = Date.now();
  evictExpired(now);
  const ticketId = `tk_${randomBytes(16).toString("hex")}`;
  const expiresAt = now + TTL_MS;
  tickets.set(ticketId, { value, expiresAt });
  return { ticketId, expiresAt };
}

export function consumeTicket<T>(ticketId: string): T | null {
  const now = Date.now();
  evictExpired(now);
  const entry = tickets.get(ticketId);
  if (!entry) return null;
  // Single-use — delete immediately so a leaked ticket can't be replayed
  // even within its TTL window.
  tickets.delete(ticketId);
  if (entry.expiresAt <= now) return null;
  return entry.value as T;
}

/**
 * Read a ticket WITHOUT consuming it — submit validates the signature
 * first (so a bad proof doesn't burn the ticket), then consumes.
 */
export function peekTicket<T>(ticketId: string): T | null {
  const now = Date.now();
  evictExpired(now);
  const entry = tickets.get(ticketId);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.value as T;
}

export function ticketTtlMs(): number {
  return TTL_MS;
}
