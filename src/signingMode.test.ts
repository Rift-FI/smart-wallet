/**
 * Tests for the signing-mode env reader + parent-proxy HTTP client.
 *
 * Behaviors under test:
 *   1. SIGNING_MODE defaults to 'local'; only 'enclave' opts in.
 *   2. parseEnvelope correctly splits the backend's `enc:v1:` format.
 *   3. signWithEnclave returns null in local mode (caller falls back).
 *   4. signWithEnclave returns null on non-envelope blobs.
 *   5. signWithEnclave returns null when the parent-proxy errors.
 *   6. signWithEnclave returns the signature on a successful round trip.
 *
 * Uses vitest's built-in fetch mock so the tests are hermetic — no
 * actual HTTP traffic, no enclave required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getSigningMode,
  isEnclaveMode,
  parseEnvelope,
  signWithEnclave,
} from "./signingMode";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.SIGNING_MODE;
  delete process.env.PARENT_PROXY_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSigningMode", () => {
  it("defaults to 'local' when SIGNING_MODE is unset", () => {
    expect(getSigningMode()).toBe("local");
  });

  it("returns 'enclave' for SIGNING_MODE=enclave", () => {
    process.env.SIGNING_MODE = "enclave";
    expect(getSigningMode()).toBe("enclave");
  });

  it("is case-insensitive + trims whitespace", () => {
    process.env.SIGNING_MODE = "  Enclave  ";
    expect(getSigningMode()).toBe("enclave");
  });

  it("falls back to 'local' on unknown values (safe default)", () => {
    process.env.SIGNING_MODE = "nitro";
    expect(getSigningMode()).toBe("local");
  });
});

describe("isEnclaveMode", () => {
  it("returns false in default state", () => {
    expect(isEnclaveMode()).toBe(false);
  });

  it("returns true when SIGNING_MODE=enclave", () => {
    process.env.SIGNING_MODE = "enclave";
    expect(isEnclaveMode()).toBe(true);
  });
});

describe("parseEnvelope", () => {
  it("splits a well-formed enc:v1: blob into wrapped_dek, iv, ciphertext", () => {
    const blob = "enc:v1:Zm9vYmFy:0123456789abcdef0123456789abcdef:abcdef1234";
    const parts = parseEnvelope(blob);
    expect(parts).toEqual({
      wrappedDekB64: "Zm9vYmFy",
      ivHex: "0123456789abcdef0123456789abcdef",
      ciphertextHex: "abcdef1234",
    });
  });

  it("returns null for a legacy AES blob (no envelope prefix)", () => {
    // Backend's pre-Phase-0 format: <iv_hex>:<ciphertext_hex>
    const legacy = "7b18a20583b47c049fc8a0b1b81c1e9e:107970b38ea040ee50abf";
    expect(parseEnvelope(legacy)).toBeNull();
  });

  it("returns null for malformed envelope blobs", () => {
    expect(parseEnvelope("enc:v1:")).toBeNull();
    expect(parseEnvelope("enc:v1:Zm9v")).toBeNull(); // only one colon after prefix
    expect(parseEnvelope("")).toBeNull();
  });
});

describe("signWithEnclave", () => {
  const baseParams = {
    userOpHashHex:
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
    envelopeBlob:
      "enc:v1:Zm9vYmFy:0123456789abcdef0123456789abcdef:abcdef1234",
    kmsKeyArn: "arn:aws:kms:us-east-1:957814222213:key/test",
  };

  it("returns null when not in enclave mode (caller signs locally)", async () => {
    const result = await signWithEnclave(baseParams);
    expect(result).toBeNull();
  });

  it("returns null when envelope blob is not in enc:v1: format", async () => {
    process.env.SIGNING_MODE = "enclave";
    const result = await signWithEnclave({
      ...baseParams,
      envelopeBlob: "7b18a20583b47c049fc8a0b1b81c1e9e:107970b38ea040ee50abf", // legacy
    });
    expect(result).toBeNull();
  });

  it("returns null when parent-proxy returns non-2xx", async () => {
    process.env.SIGNING_MODE = "enclave";
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    } as any);
    const result = await signWithEnclave(baseParams);
    expect(result).toBeNull();
  });

  it("returns null when parent-proxy response has no signature_hex", async () => {
    process.env.SIGNING_MODE = "enclave";
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ({ error: "kms attestation rejected" }),
    } as any);
    const result = await signWithEnclave(baseParams);
    expect(result).toBeNull();
  });

  it("returns the signature on a successful round trip", async () => {
    process.env.SIGNING_MODE = "enclave";
    const expected = "0x" + "a".repeat(128) + "1b"; // 65-byte canonical sig
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ({ signature_hex: expected }),
    } as any);

    const result = await signWithEnclave(baseParams);
    expect(result).toBe(expected);
  });

  it("forwards the right body shape to the parent-proxy", async () => {
    process.env.SIGNING_MODE = "enclave";
    process.env.PARENT_PROXY_URL = "http://127.0.0.1:7777";

    const fetchMock = vi
      .spyOn(globalThis, "fetch" as any)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ signature_hex: "0xabcd" }),
      } as any);

    await signWithEnclave(baseParams);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7777/sign");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      user_op_hash_hex: baseParams.userOpHashHex,
      wrapped_dek_b64: "Zm9vYmFy",
      iv_hex: "0123456789abcdef0123456789abcdef",
      ciphertext_hex: "abcdef1234",
      kms_key_arn: baseParams.kmsKeyArn,
    });
  });

  it("returns null when fetch throws (network/timeout)", async () => {
    process.env.SIGNING_MODE = "enclave";
    vi.spyOn(globalThis, "fetch" as any).mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await signWithEnclave(baseParams);
    expect(result).toBeNull();
  });
});
