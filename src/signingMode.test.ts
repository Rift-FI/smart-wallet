/**
 * Tests for the signing-mode env reader + stub enclave signer.
 *
 * The tests focus on the BEHAVIORS that matter for safe deployment:
 *   - Default is 'local' (deploy with no env change → today's behaviour)
 *   - 'enclave' mode is opt-in (deploy with SIGNING_MODE=enclave)
 *   - Mode reads happen at call time, not module-load time, so test
 *     overrides take effect
 *   - The enclave signer currently returns null → caller falls back
 *     to local. This is the property that makes SIGNING_MODE=enclave
 *     a no-op safe-to-deploy until the vsock client lands.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getSigningMode, isEnclaveMode, signWithEnclave } from "./signingMode";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.SIGNING_MODE;
});

afterAll(() => {
  process.env = originalEnv;
});

describe("getSigningMode", () => {
  it("defaults to 'local' when SIGNING_MODE is unset", () => {
    expect(getSigningMode()).toBe("local");
  });

  it("defaults to 'local' when SIGNING_MODE is empty string", () => {
    process.env.SIGNING_MODE = "";
    expect(getSigningMode()).toBe("local");
  });

  it("returns 'local' explicitly", () => {
    process.env.SIGNING_MODE = "local";
    expect(getSigningMode()).toBe("local");
  });

  it("returns 'enclave' for SIGNING_MODE=enclave", () => {
    process.env.SIGNING_MODE = "enclave";
    expect(getSigningMode()).toBe("enclave");
  });

  it("is case-insensitive", () => {
    process.env.SIGNING_MODE = "Enclave";
    expect(getSigningMode()).toBe("enclave");
  });

  it("trims whitespace around the value", () => {
    process.env.SIGNING_MODE = "  enclave  ";
    expect(getSigningMode()).toBe("enclave");
  });

  it("falls back to 'local' on unknown values (safe default)", () => {
    process.env.SIGNING_MODE = "nitro";
    expect(getSigningMode()).toBe("local");
    process.env.SIGNING_MODE = "garbage";
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

describe("signWithEnclave (stub)", () => {
  const baseParams = {
    userOpHashHex: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
    wrappedDekB64: "Zm9vYmFy",
    ciphertextHex: "abcdef",
    ivHex: "0123456789abcdef0123456789abcdef",
    kmsKeyArn: "arn:aws:kms:us-east-1:957814222213:key/test",
  };

  it("returns null when not in enclave mode (caller signs locally)", async () => {
    const result = await signWithEnclave(baseParams);
    expect(result).toBeNull();
  });

  it("returns null even in enclave mode (because vsock client is stubbed)", async () => {
    process.env.SIGNING_MODE = "enclave";
    const result = await signWithEnclave(baseParams);
    // The stub still returns null. Caller MUST fall back to local
    // signing in this state. When the vsock client lands, this test
    // will be updated to assert the real signature shape.
    expect(result).toBeNull();
  });
});
