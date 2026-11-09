/**
 * Passkey wallet integration tests on an anvil fork of Base (spec §5).
 *
 *   ~/.foundry/bin/anvil --fork-url https://mainnet.base.org --port 8546
 *   ANVIL_RPC_URL=http://127.0.0.1:8546 npm test
 *
 * Real WebAuthn assertions from a software P-256 passkey, executed through
 * EntryPoint.handleOps (RELAY_MODE=direct). Skips when anvil is down.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BASE_USDC,
  BASE_WETH,
  erc20Balance,
  forkClients,
  randomAddress,
  setUsdcBalance,
  useForkEnv,
} from "../testing/fork";
import { createVirtualPasskey, passkeyCoords, type VirtualPasskey } from "../testing/virtualPasskey";
import { SAFE_WEBAUTHN_SHARED_SIGNER } from "./constants";
import { PasskeyError } from "./errors";
import { buildLegacySafe, computeProxyAddress } from "./account";
import {
  getOwners,
  passkeyNativeAddress,
  passkeyProxyAddress,
  prepareMessage,
  prepareOperation,
  submitMessage,
  submitOperation,
} from "./service";
import { migrateSafe } from "./migration";
import { prepareUserOp, submitUserOp } from "./relay";
import { buildGasPlan } from "./gas";

// Probed once in src/testing/globalSetup.ts (FORK_AVAILABLE=1 when anvil answers).
const up = process.env.FORK_AVAILABLE === "1";
const CHAIN = 8453;
const ERC20 = parseAbi([
  "function transfer(address,uint256)",
  "function approve(address,uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

function nativeRef(pk: VirtualPasskey, address: Address, extras: VirtualPasskey[] = []) {
  return {
    kind: "passkey_native",
    address,
    firstPasskey: { ...passkeyCoords(pk), credentialId: pk.credentialId },
    extraPasskeys: extras.map(passkeyCoords),
  };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PasskeyError);
    expect((e as PasskeyError).code).toBe(code);
    return e as PasskeyError;
  }
  throw new Error(`expected ${code}`);
}

describe.skipIf(!up)("passkey Safe on a Base fork", () => {
  const { publicClient, testClient } = forkClients();
  const A = createVirtualPasskey();
  const B = createVirtualPasskey();
  let safe: Address;
  let proxyB: Address;

  beforeAll(async () => {
    useForkEnv();
    process.env.RIFT_MARKUP_TREASURY_ADDRESS = "0x000000000000000000000000000000000000dEaD";
    process.env.MARKUP_BPS = "50";
    process.env.MARKUP_FLAT_FEE_TOKEN_UNITS = "100000";
    safe = (await passkeyNativeAddress(passkeyCoords(A))).address;
    await testClient.setBalance({ address: safe, value: parseEther("1") });
  });

  it("deploys a native passkey Safe and sends ETH in one passkey-signed UserOp", async () => {
    const recipient = randomAddress();
    const prep = await prepareOperation({
      chainId: CHAIN,
      account: nativeRef(A, safe),
      calls: [{ to: recipient, value: "12345" }],
      gas: { mode: "sponsored" },
      purpose: "send_native",
    });
    expect(prep.deployed).toBe(false);
    expect(prep.userOp.factory).toBeDefined();

    const res = await submitOperation({
      ticketId: prep.ticketId,
      signer: { address: SAFE_WEBAUTHN_SHARED_SIGNER, kind: "shared" },
      authProof: A.signHash(prep.hashToSign),
    });
    expect(res.success).toBe(true);
    expect(await publicClient.getBalance({ address: recipient })).toBe(12345n);
    const owners = await getOwners(CHAIN, safe);
    expect(owners.deployed).toBe(true);
    expect(owners.owners).toEqual([SAFE_WEBAUTHN_SHARED_SIGNER]);
  });

  it("rejects a wrong-key / wrong-challenge signature without burning the ticket", async () => {
    const prep = await prepareOperation({
      chainId: CHAIN,
      account: nativeRef(A, safe),
      calls: [{ to: randomAddress(), value: "1" }],
    });
    const intruder = createVirtualPasskey();
    await expectCode(
      submitOperation({ ticketId: prep.ticketId, signer: { address: SAFE_WEBAUTHN_SHARED_SIGNER, kind: "shared" }, authProof: intruder.signHash(prep.hashToSign) }),
      "INVALID_PASSKEY_SIGNATURE"
    );
    await expectCode(
      submitOperation({ ticketId: prep.ticketId, signer: { kind: "shared" }, authProof: A.signHash(prep.hashToSign, { challengeOverride: ("0x" + "11".repeat(32)) as Hex }) }),
      "INVALID_PASSKEY_SIGNATURE"
    );
    await expectCode(
      submitOperation({ ticketId: prep.ticketId, signer: { kind: "shared" }, authProof: { kind: "oidc", id_token: "x" } }),
      "PASSKEY_REQUIRED"
    );
    const ok = await submitOperation({ ticketId: prep.ticketId, signer: { kind: "shared" }, authProof: A.signHash(prep.hashToSign) });
    expect(ok.success).toBe(true);
    await expectCode(
      submitOperation({ ticketId: prep.ticketId, signer: { kind: "shared" }, authProof: A.signHash(prep.hashToSign) }),
      "TICKET_NOT_FOUND"
    );
  });

  it("transfers USDC with Rift + project markup calls in the same UserOp", async () => {
    await setUsdcBalance(testClient, safe, 50_000_000n);
    const recipient = randomAddress();
    const projectTreasury = randomAddress();
    const riftTreasury = getAddress(process.env.RIFT_MARKUP_TREASURY_ADDRESS!);
    const riftBefore = await erc20Balance(publicClient, BASE_USDC, riftTreasury);

    const prep = await prepareOperation({
      chainId: CHAIN,
      account: nativeRef(A, safe),
      calls: [{ to: BASE_USDC, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [recipient, 10_000_000n] }) }],
      gas: { mode: "token", token: BASE_USDC, projectMarkupBps: 100, projectTreasuryAddress: projectTreasury },
      purpose: "transfer",
    });
    const res = await submitOperation({ ticketId: prep.ticketId, signer: { kind: "shared" }, authProof: A.signHash(prep.hashToSign) });
    expect(res.success).toBe(true);
    expect(await erc20Balance(publicClient, BASE_USDC, recipient)).toBe(10_000_000n);
    expect(await erc20Balance(publicClient, BASE_USDC, projectTreasury)).toBe(100_000n); // 1%
    expect((await erc20Balance(publicClient, BASE_USDC, riftTreasury)) - riftBefore).toBe(50_000n); // 0.5%
    expect(await erc20Balance(publicClient, BASE_USDC, safe)).toBe(50_000_000n - 10_150_000n);
  });

  it("executes an arbitrary call batch (approve + swap-like call)", async () => {
    const spender = randomAddress();
    const wethBefore = await erc20Balance(publicClient, BASE_WETH, safe);
    const prep = await prepareOperation({
      chainId: CHAIN,
      account: nativeRef(A, safe),
      calls: [
        { to: BASE_USDC, abi: ERC20 as any, functionName: "approve", args: [spender, 777n] },
        { to: BASE_WETH, value: "1000000000000", data: encodeFunctionData({ abi: parseAbi(["function deposit() payable"]), functionName: "deposit" }) },
      ],
      gas: { mode: "sponsored" },
    });
    const res = await submitOperation({ ticketId: prep.ticketId, signer: { kind: "shared" }, authProof: A.signHash(prep.hashToSign) });
    expect(res.success).toBe(true);
    expect(await publicClient.readContract({ address: BASE_USDC, abi: ERC20, functionName: "allowance", args: [safe, spender] })).toBe(777n);
    expect((await erc20Balance(publicClient, BASE_WETH, safe)) - wethBefore).toBe(1_000_000_000_000n);
  });

  it("adds a second passkey, then signs with it as a proxy owner", async () => {
    proxyB = (await passkeyProxyAddress(passkeyCoords(B))).proxyAddress;
    const add = await prepareOperation({
      chainId: CHAIN,
      account: nativeRef(A, safe),
      intent: { type: "add_passkey", passkey: passkeyCoords(B) },
      purpose: "add_passkey",
    });
    const res = await submitOperation({ ticketId: add.ticketId, signer: { kind: "shared" }, authProof: A.signHash(add.hashToSign) });
    expect(res.success).toBe(true);
    expect((await getOwners(CHAIN, safe)).owners).toEqual([proxyB, SAFE_WEBAUTHN_SHARED_SIGNER]);

    const recipient = randomAddress();
    const send = await prepareOperation({ chainId: CHAIN, account: nativeRef(A, safe, [B]), calls: [{ to: recipient, value: "42" }] });
    const sent = await submitOperation({ ticketId: send.ticketId, signer: { address: proxyB, kind: "proxy" }, authProof: B.signHash(send.hashToSign) });
    expect(sent.success).toBe(true);
    expect(await publicClient.getBalance({ address: recipient })).toBe(42n);
  });

  it("ERC-1271: personal_sign and typed data on the deployed Safe (shared + proxy signer)", async () => {
    const msg = await prepareMessage({ chainId: CHAIN, account: nativeRef(A, safe), kind: "personal_sign", message: "hello rift" });
    const out = await submitMessage({ ticketId: msg.ticketId, signer: { kind: "shared" }, authProof: A.signHash(msg.hashToSign) });
    expect(out.erc6492).toBe(false);
    expect(await publicClient.verifyMessage({ address: safe, message: "hello rift", signature: out.signature })).toBe(true);

    const typedData = {
      domain: { name: "Rift", version: "1", chainId: CHAIN, verifyingContract: BASE_USDC },
      types: { Mail: [{ name: "contents", type: "string" }] },
      primaryType: "Mail" as const,
      message: { contents: "gm" },
    };
    const td = await prepareMessage({ chainId: CHAIN, account: nativeRef(A, safe), kind: "typed_data", typedData });
    const tdOut = await submitMessage({ ticketId: td.ticketId, signer: { address: proxyB, kind: "proxy" }, authProof: B.signHash(td.hashToSign) });
    expect(await publicClient.verifyTypedData({ address: safe, ...typedData, signature: tdOut.signature })).toBe(true);
  });

  it("removes a passkey; its signatures are then refused", async () => {
    const rm = await prepareOperation({
      chainId: CHAIN,
      account: nativeRef(A, safe, [B]),
      intent: { type: "remove_passkey", passkey: passkeyCoords(B) },
      purpose: "remove_passkey",
    });
    const res = await submitOperation({ ticketId: rm.ticketId, signer: { kind: "shared" }, authProof: A.signHash(rm.hashToSign) });
    expect(res.success).toBe(true);
    expect((await getOwners(CHAIN, safe)).owners).toEqual([SAFE_WEBAUTHN_SHARED_SIGNER]);

    const send = await prepareOperation({ chainId: CHAIN, account: nativeRef(A, safe), calls: [{ to: randomAddress(), value: "1" }] });
    await expectCode(
      submitOperation({ ticketId: send.ticketId, signer: { address: proxyB, kind: "proxy" }, authProof: B.signHash(send.hashToSign) }),
      "SIGNER_NOT_OWNER"
    );
    // The last owner can't be removed.
    await expectCode(
      prepareOperation({ chainId: CHAIN, account: nativeRef(A, safe), intent: { type: "remove_passkey", owner: SAFE_WEBAUTHN_SHARED_SIGNER } }),
      "LAST_OWNER"
    );
  });

  it("ERC-6492: personal_sign and typed data from an undeployed Safe", async () => {
    const C = createVirtualPasskey();
    const addr = (await passkeyNativeAddress(passkeyCoords(C))).address;
    expect(await publicClient.getCode({ address: addr })).toBeUndefined();

    const msg = await prepareMessage({ chainId: CHAIN, account: nativeRef(C, addr), kind: "personal_sign", message: { raw: "0xdeadbeef" } });
    expect(msg.deployed).toBe(false);
    const out = await submitMessage({ ticketId: msg.ticketId, signer: { kind: "shared" }, authProof: C.signHash(msg.hashToSign) });
    expect(out.erc6492).toBe(true);
    expect(out.signature.endsWith("6492649264926492649264926492649264926492649264926492649264926492")).toBe(true);
    expect(await publicClient.verifyMessage({ address: addr, message: { raw: "0xdeadbeef" }, signature: out.signature })).toBe(true);

    const typedData = {
      domain: { name: "Rift", version: "1", chainId: CHAIN },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping" as const,
      message: { n: 7n },
    };
    const td = await prepareMessage({ chainId: CHAIN, account: nativeRef(C, addr), kind: "typed_data", typedData: { ...typedData, message: { n: "7" } } });
    const tdOut = await submitMessage({ ticketId: td.ticketId, signer: { kind: "shared" }, authProof: C.signHash(td.hashToSign) });
    expect(await publicClient.verifyTypedData({ address: addr, ...typedData, signature: tdOut.signature })).toBe(true);
    // Still counterfactual.
    expect(await publicClient.getCode({ address: addr })).toBeUndefined();
  });

  it("native deploy op adds every extra passkey (1a)", async () => {
    const F = createVirtualPasskey();
    const G = createVirtualPasskey();
    const addr = (await passkeyNativeAddress(passkeyCoords(F))).address;
    await testClient.setBalance({ address: addr, value: parseEther("1") });
    const prep = await prepareOperation({ chainId: CHAIN, account: nativeRef(F, addr, [G]), calls: [{ to: randomAddress(), value: "1" }] });
    const res = await submitOperation({ ticketId: prep.ticketId, signer: { kind: "shared" }, authProof: F.signHash(prep.hashToSign) });
    expect(res.success).toBe(true);
    const proxyG = await computeProxyAddress(publicClient, G);
    expect((await getOwners(CHAIN, addr)).owners).toEqual([proxyG, SAFE_WEBAUTHN_SHARED_SIGNER]);
  });
});

describe.skipIf(!up)("EOA Safe → passkey migration on a Base fork", () => {
  const { publicClient, testClient } = forkClients();
  beforeAll(() => useForkEnv());

  async function legacySafe() {
    const key = generatePrivateKey();
    const eoa = privateKeyToAccount(key);
    const safe = await buildLegacySafe(publicClient, eoa);
    await testClient.setBalance({ address: safe.address, value: parseEther("1") });
    return { key, eoa, safe };
  }

  /** Sign + submit a plain op with the EOA (pre-migration usage / "old key" attempts). */
  async function eoaSend(safe: Awaited<ReturnType<typeof buildLegacySafe>>, to: Address) {
    const gas = { mode: "native" as const, markup: {} };
    const plan = await buildGasPlan({ gas, chainId: CHAIN, client: publicClient, safe: safe.address, userCalls: [{ to, value: 1n, data: "0x" }], quoteToken: async () => null });
    const op = await prepareUserOp({ chainId: CHAIN, client: publicClient, account: safe, gas, plan });
    op.signature = await safe.signUserOperation({ ...(op as any), chainId: CHAIN });
    return submitUserOp({ chainId: CHAIN, client: publicClient, userOp: op });
  }

  it("migrates a deployed EOA Safe: owners swapped, address unchanged, old key rejected", async () => {
    const { key, eoa, safe } = await legacySafe();
    expect((await eoaSend(safe, randomAddress())).success).toBe(true); // deploy as legacy
    const D = createVirtualPasskey();
    const E = createVirtualPasskey();

    const res = await migrateSafe({
      chainId: CHAIN,
      client: publicClient,
      safeAddress: safe.address,
      legacyOwner: eoa.address,
      eoaPrivateKey: key,
      passkeys: [D, E],
    });
    expect(res.status).toBe("migrated");
    const proxyD = await computeProxyAddress(publicClient, D);
    const proxyE = await computeProxyAddress(publicClient, E);
    expect(res.owners).toEqual([proxyE, proxyD]);

    // Same address, now signed by a passkey proxy.
    const ref = { kind: "migrated", address: safe.address, legacyOwner: eoa.address };
    const recipient = randomAddress();
    const prep = await prepareOperation({ chainId: CHAIN, account: ref, calls: [{ to: recipient, value: "99" }] });
    expect(prep.sender).toBe(safe.address);
    const sent = await submitOperation({ ticketId: prep.ticketId, signer: { address: proxyD, kind: "proxy" }, authProof: D.signHash(prep.hashToSign) });
    expect(sent.success).toBe(true);
    expect(await publicClient.getBalance({ address: recipient })).toBe(99n);

    // The old EOA key is no longer an owner: EntryPoint refuses (AA24).
    await expectCode(eoaSend(safe, randomAddress()), "SUBMIT_FAILED");
    // Re-running migration is a no-op.
    const again = await migrateSafe({ chainId: CHAIN, client: publicClient, safeAddress: safe.address, legacyOwner: eoa.address, eoaPrivateKey: key, passkeys: [D] });
    expect(again.status).toBe("already_migrated");
  });

  it("migrates an undeployed EOA Safe (initCode + owner swap in one op)", async () => {
    const { key, eoa, safe } = await legacySafe();
    const D = createVirtualPasskey();
    const res = await migrateSafe({ chainId: CHAIN, client: publicClient, safeAddress: safe.address, legacyOwner: eoa.address, eoaPrivateKey: key, passkeys: [D] });
    expect(res.status).toBe("migrated");
    expect(res.owners).toEqual([await computeProxyAddress(publicClient, D)]);
  });

  it("refuses to sign anything but the migration calldata", async () => {
    const { key, eoa, safe } = await legacySafe();
    const D = createVirtualPasskey();
    const attacker = randomAddress();
    const base = { chainId: CHAIN, client: publicClient, safeAddress: safe.address, legacyOwner: eoa.address, eoaPrivateKey: key, passkeys: [D] };

    // Smuggle an extra transfer into the batch.
    await expectCode(
      migrateSafe({
        ...base,
        tamper: (op) => ({
          ...op,
          callData: encodeFunctionData({
                abi: parseAbi(["function executeUserOpWithErrorString(address,uint256,bytes,uint8)"]),
                functionName: "executeUserOpWithErrorString",
                args: [attacker, parseEther("0.5"), "0x", 0],
              }) as Hex,
        }),
      }),
      "MIGRATION_CALLDATA_REJECTED"
    );
    // Wrong key for the account.
    await expectCode(migrateSafe({ ...base, eoaPrivateKey: generatePrivateKey() }), "EOA_MISMATCH");
    // Nothing happened on chain.
    expect(await publicClient.getBalance({ address: attacker })).toBe(0n);
    expect(await publicClient.getCode({ address: safe.address })).toBeUndefined();
  });

  it("reports MIGRATION_NEEDS_GAS when nothing can pay", async () => {
    const key = generatePrivateKey();
    const eoa = privateKeyToAccount(key);
    const safe = await buildLegacySafe(publicClient, eoa);
    await expectCode(
      migrateSafe({ chainId: CHAIN, client: publicClient, safeAddress: safe.address, legacyOwner: eoa.address, eoaPrivateKey: key, passkeys: [createVirtualPasskey()] }),
      "MIGRATION_NEEDS_GAS"
    );
  });

  it("prepare on a not-yet-migrated chain says MIGRATION_REQUIRED", async () => {
    const { eoa, safe } = await legacySafe();
    await expectCode(
      prepareOperation({ chainId: CHAIN, account: { kind: "migrated", address: safe.address, legacyOwner: eoa.address }, calls: [{ to: randomAddress(), value: "1" }] }),
      "MIGRATION_REQUIRED"
    );
  });
});
