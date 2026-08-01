/**
 * In-memory ticket cache for two-phase UserOperation signing.
 *
 * Why this exists:
 *   v3 envelopes are device-bound. Every signature requires an authProof
 *   (WebAuthn assertion or OIDC id_token) whose challenge/nonce MUST equal
 *   the user_op_hash being signed. The hash isn't known until the smart-
 *   wallet has built the user op (gas estimates, paymaster data, nonce).
 *   So the client can't sign upfront.
 *
 * Two-phase flow:
 *   1. Client POSTs to /api/transaction/preview → smart-wallet builds the
 *      user op, returns { user_op_hash_hex, ticket_id }, stashes the
 *      prepared op here.
 *   2. Client signs user_op_hash_hex with their passkey / OIDC.
 *   3. Client POSTs to /api/transaction/submit-prepared with
 *      { ticket_id, authProof }. Smart-wallet retrieves the prepared op,
 *      signs via parent-proxy /sign with authProof, submits to bundler.
 *
 * Single-process in-memory Map is fine: smart-wallet is currently a
 * single Node instance (Caprover container, no HA). For multi-instance
 * deploys we'd swap this for Redis with the same interface.
 *
 * TTL: 60s — long enough for a user to tap Touch ID, short enough that
 * stale tickets (with stale gas prices) can't be replayed.
 */

import { randomBytes } from "crypto";

interface TicketEntry<T> {
  value: T;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry<unknown>>();

const TTL_MS = 60_000;

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

export function ticketTtlMs(): number {
  return TTL_MS;
}
