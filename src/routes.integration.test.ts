/**
 * Route-level tests through the real Express app (createApp) over HTTP.
 * Auth / validation / removed-route tests need no chain; the two-phase
 * flows run against the anvil Base fork with RELAY_MODE=direct and skip
 * when it isn't reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { forkClients, randomAddress, useForkEnv } from "./testing/fork";
import { createVirtualPasskey, passkeyCoords, type VirtualPasskey } from "./testing/virtualPasskey";
import { SAFE_WEBAUTHN_SHARED_SIGNER } from "./passkey/constants";
import { buildLegacySafe } from "./passkey/account";
import { __queueRequestForTests, __setWeb3WalletForTests, getPendingRequests } from "./walletconnect";

const TOKEN = "test-internal-token";
process.env.INTERNAL_SERVICE_TOKEN = TOKEN;

// Probed once in src/testing/globalSetup.ts (FORK_AVAILABLE=1 when anvil answers).
const up = process.env.FORK_AVAILABLE === "1";
let server: Server;
let baseUrl = "";

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const post = (path: string, body: unknown, token?: string | null) => call("POST", path, body, token);

beforeAll(async () => {
  useForkEnv();
  const { createApp } = await import("./app");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

describe("auth (INTERNAL_SERVICE_TOKEN)", () => {
  it("/health needs no token", async () => {
    const r = await call("GET", "/health", undefined, null);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("healthy");
  });

  it("every other route needs the bearer token", async () => {
    expect((await post("/api/v3/owners", {}, null)).status).toBe(401);
    expect((await post("/api/v3/owners", {}, "wrong")).status).toBe(401);
    expect((await call("GET", "/api/walletconnect/requests", undefined, null)).status).toBe(401);
    expect((await post("/api/v2/submit", {}, null)).status).toBe(401);
  });

  it("fails closed when INTERNAL_SERVICE_TOKEN is unset", async () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    try {
      const r = await post("/api/v3/owners", {}, TOKEN);
      expect(r.status).toBe(503);
    } finally {
      process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
    }
  });
});

describe("removed / validated routes", () => {
  it("one-phase key routes are gone (410)", async () => {
    for (const p of ["/api/transfer", "/api/transaction", "/api/bridge"]) {
      const r = await post(p, { ownerPrivateKey: "0x01" });
      expect(r.status).toBe(410);
      expect(r.body.error).toBe("REPLACED_BY_PASSKEY_WALLETS");
    }
    const sign = await post("/api/sign", {});
    expect(sign.status).toBe(410);
    expect(sign.body.error).toBe("EOA_SIGNING_REMOVED");
  });

  it("fails clearly on a chain without the signer factory (Berachain)", async () => {
    const r = await post("/api/v3/migrate", {
      chainId: 80094,
      account: { kind: "migrated", address: randomAddress(), legacyOwner: randomAddress() },
      eoaPrivateKey: generatePrivateKey(),
      passkeys: [{ x: "0x01", y: "0x02" }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("PASSKEY_UNSUPPORTED_ON_CHAIN");
    expect(JSON.stringify(r.body)).not.toMatch(/eoaPrivateKey|0x[0-9a-f]{64}/i);
  });

  it("validates chain and account", async () => {
    expect((await post("/api/v3/prepare", { chainId: 999, account: {}, calls: [] })).body.error).toBe("UNSUPPORTED_CHAIN");
    expect((await post("/api/v3/prepare", { chainId: 8453, account: { kind: "x" }, calls: [] })).body.error).toBe("VALIDATION_ERROR");
    expect((await post("/api/v3/submit", { ticketId: "tk_nope", signer: { kind: "shared" }, authProof: {} })).status).toBe(404);
  });

  it("exposes the per-chain capability table", async () => {
    const r = await call("GET", "/api/passkey/capabilities");
    expect(r.body.chains["8453"]).toEqual({ sharedSigner: true, signerFactory: true });
    expect(r.body.chains["80094"]).toEqual({ sharedSigner: true, signerFactory: false });
  });
});

function nativeRef(pk: VirtualPasskey, address: Address) {
  return { kind: "passkey_native", address, firstPasskey: { ...passkeyCoords(pk), credentialId: pk.credentialId }, extraPasskeys: [] };
}

describe.skipIf(!up)("two-phase flows over HTTP (Base fork, RELAY_MODE=direct)", () => {
  const { publicClient, testClient } = forkClients();
  const A = createVirtualPasskey();
  let safe: Address;

  beforeAll(async () => {
    const r = await post("/api/passkey/address", { credential: passkeyCoords(A) });
    expect(r.status).toBe(200);
    safe = r.body.address;
    expect(r.body.data.address).toBe(safe);
    await testClient.setBalance({ address: safe, value: parseEther("1") });
  });

  it("/api/passkey/signer returns the proxy address", async () => {
    const r = await post("/api/passkey/signer", passkeyCoords(createVirtualPasskey()));
    expect(r.status).toBe(200);
    expect(r.body.proxyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("ERC-6492 message signature while undeployed", async () => {
    const prep = await post("/api/v3/message/prepare", { chainId: 8453, account: nativeRef(A, safe), kind: "personal_sign", message: "gm" });
    expect(prep.status).toBe(200);
    const sub = await post("/api/v3/message/submit", { ticketId: prep.body.ticketId, signer: { kind: "shared" }, authProof: A.signHash(prep.body.hashToSign) });
    expect(sub.status).toBe(200);
    expect(sub.body.erc6492).toBe(true);
    expect(await publicClient.verifyMessage({ address: safe, message: "gm", signature: sub.body.signature })).toBe(true);
  });

  it("prepare → passkey → submit deploys and sends", async () => {
    const recipient = randomAddress();
    const prep = await post("/api/v3/prepare", {
      chainId: 8453, account: nativeRef(A, safe), calls: [{ to: recipient, value: "777" }], gas: { mode: "sponsored" }, purpose: "send",
    });
    expect(prep.status).toBe(200);
    expect(prep.body.hashToSign).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prep.body.userOp.sender).toBe(safe);

    const oidc = await post("/api/v3/submit", { ticketId: prep.body.ticketId, signer: { kind: "shared" }, authProof: { kind: "oidc" } });
    expect(oidc.status).toBe(400);
    expect(oidc.body.error).toBe("PASSKEY_REQUIRED");

    const sub = await post("/api/v3/submit", {
      ticketId: prep.body.ticketId,
      signer: { address: SAFE_WEBAUTHN_SHARED_SIGNER, kind: "shared" },
      authProof: A.signHash(prep.body.hashToSign),
    });
    expect(sub.status).toBe(200);
    expect(sub.body.success).toBe(true);
    expect(sub.body.transactionHash).toMatch(/^0x/);
    expect(await publicClient.getBalance({ address: recipient })).toBe(777n);

    const owners = await post("/api/v3/owners", { chainId: 8453, safe });
    expect(owners.body).toMatchObject({ deployed: true, owners: [SAFE_WEBAUTHN_SHARED_SIGNER] });
  });

  it("legacy /api/transaction/preview + submit-prepared keep their field names", async () => {
    const prep = await post("/api/transaction/preview", { chainId: 8453, account: nativeRef(A, safe), calls: [{ to: randomAddress(), value: "1" }] });
    expect(prep.status).toBe(200);
    expect(prep.body.data.user_op_hash_hex).toBe(prep.body.hashToSign);
    // signer omitted → shared signer for a native Safe
    const sub = await post("/api/transaction/submit-prepared", { ticketId: prep.body.data.ticket_id, authProof: A.signHash(prep.body.data.user_op_hash_hex) });
    expect(sub.status).toBe(200);
    expect(sub.body.data.userOperationHash).toMatch(/^0x/);
  });

  it("ERC-1271 typed data once deployed", async () => {
    const typedData = {
      domain: { name: "Rift", version: "1", chainId: 8453 },
      types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], Hi: [{ name: "v", type: "string" }] },
      primaryType: "Hi",
      message: { v: "there" },
    };
    const prep = await post("/api/v3/message/prepare", { chainId: 8453, account: nativeRef(A, safe), kind: "typed_data", typedData });
    const sub = await post("/api/v3/message/submit", { ticketId: prep.body.ticketId, signer: { kind: "shared" }, authProof: A.signHash(prep.body.hashToSign) });
    expect(sub.body.erc6492).toBe(false);
    const { EIP712Domain: _d, ...types } = typedData.types;
    expect(await publicClient.verifyTypedData({ address: safe, domain: typedData.domain, types, primaryType: "Hi", message: typedData.message, signature: sub.body.signature })).toBe(true);
  });

  it("/api/v3/migrate swaps owners and never echoes the key", async () => {
    const key = generatePrivateKey();
    const eoa = privateKeyToAccount(key);
    const legacy = await buildLegacySafe(publicClient, eoa);
    await testClient.setBalance({ address: legacy.address, value: parseEther("1") });
    const D = createVirtualPasskey();
    const r = await post("/api/v3/migrate", {
      chainId: 8453,
      account: { kind: "migrated", address: legacy.address, legacyOwner: eoa.address },
      eoaPrivateKey: key,
      passkeys: [passkeyCoords(D)],
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("migrated");
    expect(JSON.stringify(r.body)).not.toContain(key.slice(2));
    const proxy = (await post("/api/passkey/signer", passkeyCoords(D))).body.proxyAddress;
    expect((await post("/api/v3/owners", { chainId: 8453, safe: legacy.address })).body.owners).toEqual([proxy]);

    const bad = await post("/api/v3/migrate", {
      chainId: 8453,
      account: { kind: "migrated", address: legacy.address, legacyOwner: eoa.address },
      eoaPrivateKey: generatePrivateKey(),
      passkeys: [passkeyCoords(D)],
    });
    expect(bad.body.error).toBe("EOA_MISMATCH");
  });

  describe("WalletConnect (fake WalletKit)", () => {
    const responses: any[] = [];
    beforeAll(() => {
      __setWeb3WalletForTests({
        respondSessionRequest: async (r: any) => {
          responses.push(r);
        },
      } as any);
    });

    it("personal_sign: preview → passkey → approve returns an ERC-1271 signature to the dApp", async () => {
      const message = "0x" + Buffer.from("Sign in to dApp").toString("hex");
      __queueRequestForTests({ id: 101, topic: "t1", method: "personal_sign", params: [message, safe], peerName: "dApp" }, { account: nativeRef(A, safe), chainId: 8453 });

      const noProof = await post("/api/walletconnect/requests/101/approve", {});
      expect(noProof.body.error).toBe("PASSKEY_REQUIRED");
      expect(getPendingRequests().some((p) => p.id === 101)).toBe(true);

      const prev = await post("/api/walletconnect/requests/101/preview", {});
      expect(prev.status).toBe(200);
      expect(prev.body.requires_auth_proof).toBe(true);
      const ok = await post("/api/walletconnect/requests/101/approve", { authProof: A.signHash(prev.body.hash_to_sign), signer: { kind: "shared" } });
      expect(ok.status).toBe(200);
      const sent = responses.find((r) => r.response.id === 101);
      expect(await publicClient.verifyMessage({ address: safe, message: "Sign in to dApp", signature: sent.response.result as Hex })).toBe(true);
      expect(getPendingRequests().some((p) => p.id === 101)).toBe(false);
    });

    it("eth_sendTransaction: preview → passkey → approve submits and returns the tx hash", async () => {
      const recipient = randomAddress();
      __queueRequestForTests({ id: 102, topic: "t1", method: "eth_sendTransaction", params: [{ to: recipient, value: "0x10" }], peerName: "dApp" }, { account: nativeRef(A, safe), chainId: 8453 });
      const prev = await post("/api/walletconnect/requests/102/preview", {});
      expect(prev.body.hashToSign).toBe(prev.body.hash_to_sign);
      const wrong = await post("/api/walletconnect/requests/102/approve", { authProof: createVirtualPasskey().signHash(prev.body.hash_to_sign), signer: { kind: "shared" } });
      expect(wrong.body.error).toBe("INVALID_PASSKEY_SIGNATURE");
      const ok = await post("/api/walletconnect/requests/102/approve", { authProof: A.signHash(prev.body.hash_to_sign), signer: { kind: "shared" } });
      expect(ok.status).toBe(200);
      expect(ok.body.result).toMatch(/^0x[0-9a-f]{64}$/);
      expect(await publicClient.getBalance({ address: recipient })).toBe(16n);
      expect(responses.find((r) => r.response.id === 102).response.result).toBe(ok.body.result);
    });

    it("non-signing methods approve without a proof", async () => {
      __queueRequestForTests({ id: 103, topic: "t1", method: "eth_chainId", params: [], peerName: "dApp" }, { account: nativeRef(A, safe), chainId: 8453 });
      const ok = await post("/api/walletconnect/requests/103/approve", {});
      expect(ok.body.result).toBe("0x2105");
    });
  });
});
