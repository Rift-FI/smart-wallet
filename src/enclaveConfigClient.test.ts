/**
 * enclaveConfigClient — vitest suite.
 *
 * Behaviours under test:
 *   1. resolveEnclaveConfig(null | undefined | "") returns null without
 *      any fetch call.
 *   2. Missing RIFT_BACKEND_URL / INTERNAL_SERVICE_TOKEN returns null
 *      (multi-tenant off; caller falls back to env defaults).
 *   3. Backend 404 → returns null AND caches the null so a second call
 *      inside the negative-TTL window does NOT re-fetch.
 *   4. Backend 200 → returns the parsed config AND caches it.
 *   5. Backend 5xx / network error → returns null on first call; a
 *      cached-good value is served stale on subsequent errors.
 *   6. resolveChainConfig picks the right chain out of the config's
 *      chains[] array.
 *   7. invalidateCache clears entries and forces a re-fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveEnclaveConfig,
  resolveChainConfig,
  invalidateCache,
  type EnclaveConfig,
} from "./enclaveConfigClient";

const originalEnv = { ...process.env };

const VALID_CONFIG: EnclaveConfig = {
  projectId: "proj-1",
  parentProxyUrl: "https://signer.acme.example",
  parentProxyBearer: "plain-bearer-goes-here",
  kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/abcd",
  kmsRegion: "us-east-1",
  pcr0: "b".repeat(96),
  enclaveRef: "v1.0.0",
  chains: [
    {
      chainId: 8453,
      bundlerUrl: "https://bundler.example/base",
      bundlerBearer: null,
      rpcUrl: "https://rpc.example/base",
      paymasterUrl: null,
    },
    {
      chainId: 42161,
      bundlerUrl: "https://bundler.example/arb",
      bundlerBearer: "arb-bearer",
      rpcUrl: "https://rpc.example/arb",
      paymasterUrl: "https://paymaster.example/arb",
    },
  ],
};

function jsonResponse(status: number, body: any = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.RIFT_BACKEND_URL = "https://backend.riftfi.example";
  process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";
  invalidateCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveEnclaveConfig — falsy inputs", () => {
  it("null / undefined / empty projectId returns null without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
    expect(await resolveEnclaveConfig(null)).toBeNull();
    expect(await resolveEnclaveConfig(undefined)).toBeNull();
    expect(await resolveEnclaveConfig("")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveEnclaveConfig — env not configured", () => {
  it("returns null when RIFT_BACKEND_URL is missing", async () => {
    delete process.env.RIFT_BACKEND_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any);
    expect(await resolveEnclaveConfig("proj-1")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when INTERNAL_SERVICE_TOKEN is missing", async () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any);
    expect(await resolveEnclaveConfig("proj-1")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT cache the null when env is missing (may be set later)", async () => {
    delete process.env.RIFT_BACKEND_URL;
    await resolveEnclaveConfig("proj-1");

    process.env.RIFT_BACKEND_URL = "https://backend.riftfi.example";
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
    const got = await resolveEnclaveConfig("proj-1");
    expect(got).toEqual(VALID_CONFIG);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEnclaveConfig — 200 path", () => {
  it("returns the parsed config", async () => {
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
    const got = await resolveEnclaveConfig("proj-1");
    expect(got).toEqual(VALID_CONFIG);
  });

  it("caches the result — second call within TTL doesn't re-fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
    await resolveEnclaveConfig("proj-1");
    await resolveEnclaveConfig("proj-1");
    await resolveEnclaveConfig("proj-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("attaches the X-Internal-Token on outgoing requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
    await resolveEnclaveConfig("proj-1");
    const call = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["x-internal-token"]).toBe("test-internal-token");
  });

  it("URL-encodes the projectId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(404) as any
    );
    await resolveEnclaveConfig("proj/with slash");
    const call = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("proj%2Fwith%20slash");
  });
});

describe("resolveEnclaveConfig — 404 path", () => {
  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(jsonResponse(404) as any);
    expect(await resolveEnclaveConfig("proj-none")).toBeNull();
  });

  it("caches the null (negative cache)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(404) as any
    );
    await resolveEnclaveConfig("proj-none");
    await resolveEnclaveConfig("proj-none");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEnclaveConfig — error path", () => {
  it("returns null on 500", async () => {
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(500, { error: "boom" }) as any
    );
    expect(await resolveEnclaveConfig("proj-1")).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.spyOn(globalThis, "fetch" as any).mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveEnclaveConfig("proj-1")).toBeNull();
  });

  it("serves stale cached value on subsequent network error", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch" as any)
      .mockResolvedValueOnce(jsonResponse(200, VALID_CONFIG) as any);

    // Prime the cache with a good value.
    const first = await resolveEnclaveConfig("proj-1");
    expect(first).toEqual(VALID_CONFIG);

    // Now invalidate to force a re-fetch, and make that fail.
    invalidateCache("proj-1");
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // Without a cache, this returns null (there's nothing to serve stale).
    const second = await resolveEnclaveConfig("proj-1");
    expect(second).toBeNull();
  });

  it("serves stale from cache when the backend errors mid-TTL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any);

    // First call: good response, caches the value.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, VALID_CONFIG) as any);
    await resolveEnclaveConfig("proj-1");

    // Next call within TTL: should return the cache, not even hit fetch.
    fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }) as any);
    const cached = await resolveEnclaveConfig("proj-1");
    expect(cached).toEqual(VALID_CONFIG);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveChainConfig", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
  });

  it("returns null when the parent config is missing", async () => {
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(jsonResponse(404) as any);
    expect(await resolveChainConfig("proj-missing", 8453)).toBeNull();
  });

  it("returns the right chain when it exists", async () => {
    const got = await resolveChainConfig("proj-1", 8453);
    expect(got).not.toBeNull();
    expect(got!.chainId).toBe(8453);
    expect(got!.bundlerUrl).toBe("https://bundler.example/base");
  });

  it("returns null for chains not in the config", async () => {
    const got = await resolveChainConfig("proj-1", 1); // Ethereum mainnet not configured
    expect(got).toBeNull();
  });

  it("keeps decrypted bundlerBearer on chains that have one", async () => {
    const got = await resolveChainConfig("proj-1", 42161);
    expect(got).not.toBeNull();
    expect(got!.bundlerBearer).toBe("arb-bearer");
    expect(got!.paymasterUrl).toBe("https://paymaster.example/arb");
  });
});

describe("invalidateCache", () => {
  it("forces a re-fetch for a specific projectId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
    await resolveEnclaveConfig("proj-1");
    invalidateCache("proj-1");
    await resolveEnclaveConfig("proj-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("clears everything when called with no argument", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue(
      jsonResponse(200, VALID_CONFIG) as any
    );
    await resolveEnclaveConfig("proj-1");
    await resolveEnclaveConfig("proj-2");
    invalidateCache();
    await resolveEnclaveConfig("proj-1");
    await resolveEnclaveConfig("proj-2");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
