/**
 * Ticket cache tests.
 *
 * Pure logic — no network, no clock manipulation beyond vi.useFakeTimers
 * for the TTL test. The cache must:
 *   1. Round-trip arbitrary objects through stash → consume.
 *   2. Generate unique ticket IDs even when stashing identical values.
 *   3. Be SINGLE-USE — consume drops the entry whether it succeeds or not.
 *   4. Return null after TTL expires.
 *   5. Lazy-evict expired entries on the next access.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { stashTicket, consumeTicket, ticketTtlMs } from "./ticketCache";

afterEach(() => {
  vi.useRealTimers();
});

describe("stashTicket / consumeTicket", () => {
  it("round-trips an object value", () => {
    const value = { foo: "bar", nested: { a: 1 } };
    const { ticketId, expiresAt } = stashTicket(value);
    expect(ticketId).toMatch(/^tk_[0-9a-f]{32}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const got = consumeTicket<typeof value>(ticketId);
    expect(got).toEqual(value);
  });

  it("generates unique IDs for identical values", () => {
    const v = { same: true };
    const a = stashTicket(v).ticketId;
    const b = stashTicket(v).ticketId;
    expect(a).not.toBe(b);
  });

  it("is single-use — second consume returns null", () => {
    const { ticketId } = stashTicket({ x: 1 });
    expect(consumeTicket(ticketId)).not.toBeNull();
    expect(consumeTicket(ticketId)).toBeNull();
  });

  it("returns null for an unknown ticket id", () => {
    expect(consumeTicket("tk_does_not_exist")).toBeNull();
  });

  it("returns null after the TTL elapses", () => {
    vi.useFakeTimers();
    const { ticketId } = stashTicket({ stale: true });

    // Just before expiry: still valid.
    vi.advanceTimersByTime(ticketTtlMs() - 1);
    // Re-stash a dummy so consumeTicket re-runs the eviction sweep; the
    // value here is just to keep the cache non-empty.
    stashTicket({ keep: "alive" });

    // Now past TTL — original ticket must be gone.
    vi.advanceTimersByTime(2);
    expect(consumeTicket(ticketId)).toBeNull();
  });
});

describe("expiresAt", () => {
  it("is roughly now + TTL_MS", () => {
    const before = Date.now();
    const { expiresAt } = stashTicket({ z: 1 });
    const after = Date.now();
    expect(expiresAt).toBeGreaterThanOrEqual(before + ticketTtlMs());
    expect(expiresAt).toBeLessThanOrEqual(after + ticketTtlMs());
  });
});
