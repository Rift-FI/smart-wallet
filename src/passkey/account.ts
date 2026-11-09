/**
 * AccountRef → permissionless Safe account, plus owner-list helpers.
 *
 * AccountRef (spec §2f):
 *   { kind: "passkey_native", address, firstPasskey: {x,y,credentialId}, extraPasskeys: [{x,y}] }
 *   { kind: "migrated", address, legacyOwner }   (legacyOwner = EOA, for initCode only)
 *
 * Coordinates are accepted as 0x-hex (32 bytes) or decimal strings.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  isAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { entryPoint07Address, toWebAuthnAccount } from "viem/account-abstraction";
import { toAccount } from "viem/accounts";
import { toSafeSmartAccount } from "permissionless/accounts";
import {
  SAFE_OWNER_ABI,
  SAFE_VERSION,
  SAFE_WEBAUTHN_SHARED_SIGNER,
  SAFE_WEBAUTHN_SIGNER_FACTORY,
  SENTINEL_OWNERS,
  SIGNER_FACTORY_ABI,
  VERIFIERS,
  getPasskeyCapabilities,
} from "./constants";
import { PasskeyError } from "./errors";

export interface PasskeyCoords {
  x: bigint;
  y: bigint;
}

export interface NativeAccountRef {
  kind: "passkey_native";
  address: Address;
  firstPasskey: PasskeyCoords & { credentialId: string };
  extraPasskeys: PasskeyCoords[];
}

export interface MigratedAccountRef {
  kind: "migrated";
  address: Address;
  legacyOwner: Address;
}

export type AccountRef = NativeAccountRef | MigratedAccountRef;

export type SafeAccount = Awaited<ReturnType<typeof toSafeSmartAccount>>;

const MAX_UINT256 = (1n << 256n) - 1n;

export function parseCoord(value: unknown, field: string): bigint {
  let out: bigint;
  try {
    if (typeof value === "bigint") out = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) out = BigInt(value);
    else if (typeof value === "string" && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(value)) out = BigInt(value);
    else throw new Error();
  } catch {
    throw new PasskeyError("VALIDATION_ERROR", `${field} must be a 0x-hex or decimal uint256`);
  }
  if (out <= 0n || out > MAX_UINT256) {
    throw new PasskeyError("VALIDATION_ERROR", `${field} is out of range`);
  }
  return out;
}

export function parseCoords(raw: unknown, field: string): PasskeyCoords {
  if (!raw || typeof raw !== "object") {
    throw new PasskeyError("VALIDATION_ERROR", `${field} must be { x, y }`);
  }
  const r = raw as { x?: unknown; y?: unknown };
  return { x: parseCoord(r.x, `${field}.x`), y: parseCoord(r.y, `${field}.y`) };
}

export function coordHex(v: bigint): Hex {
  return toHex(v, { size: 32 });
}

export function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new PasskeyError("VALIDATION_ERROR", `${field} must be an address`);
  }
  return getAddress(value);
}

export function parseAccountRef(raw: unknown): AccountRef {
  if (!raw || typeof raw !== "object") {
    throw new PasskeyError("VALIDATION_ERROR", "account (AccountRef) is required");
  }
  const r = raw as Record<string, unknown>;
  const address = parseAddress(r.address, "account.address");
  if (r.kind === "passkey_native") {
    const first = parseCoords(r.firstPasskey, "account.firstPasskey");
    const fp = r.firstPasskey as { credentialId?: unknown };
    const credentialId = typeof fp.credentialId === "string" && fp.credentialId ? fp.credentialId : "passkey";
    const extrasRaw = r.extraPasskeys ?? [];
    if (!Array.isArray(extrasRaw)) {
      throw new PasskeyError("VALIDATION_ERROR", "account.extraPasskeys must be an array");
    }
    const extraPasskeys = extrasRaw.map((p, i) => parseCoords(p, `account.extraPasskeys[${i}]`));
    return { kind: "passkey_native", address, firstPasskey: { ...first, credentialId }, extraPasskeys };
  }
  if (r.kind === "migrated") {
    return { kind: "migrated", address, legacyOwner: parseAddress(r.legacyOwner, "account.legacyOwner") };
  }
  throw new PasskeyError("VALIDATION_ERROR", 'account.kind must be "passkey_native" or "migrated"');
}

/** JSON-safe form (bigints → hex) for storing an AccountRef in a ticket. */
export function serialiseAccountRef(ref: AccountRef): Record<string, unknown> {
  if (ref.kind === "migrated") return { ...ref };
  return {
    kind: ref.kind,
    address: ref.address,
    firstPasskey: {
      x: coordHex(ref.firstPasskey.x),
      y: coordHex(ref.firstPasskey.y),
      credentialId: ref.firstPasskey.credentialId,
    },
    extraPasskeys: ref.extraPasskeys.map((p) => ({ x: coordHex(p.x), y: coordHex(p.y) })),
  };
}

function uncompressedPublicKey(p: PasskeyCoords): Hex {
  return encodePacked(["bytes1", "uint256", "uint256"], ["0x04", p.x, p.y]);
}

/**
 * The webauthn stub signature permissionless uses for gas estimation,
 * re-targeted at an arbitrary signer (proxy owners on migrated Safes).
 */
function webAuthnStubSignature(signer: Address): Hex {
  const data = encodeAbiParameters(
    [
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
      { name: "signature", type: "uint256[2]" },
    ],
    [
      "0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000",
      '"origin":"http://somelargdomainheresothatwehaveenoughbytes.com","crossOrigin":false',
      [
        44941127272049826721201904734628716258498742255959991581049806490182030242267n,
        9910254599581058084911561569808925251374718953855182016200087235935345969636n,
      ],
    ]
  );
  const dataHex = data.slice(2);
  const sig =
    `0x${signer.slice(2).toLowerCase().padStart(64, "0")}` +
    `${(65).toString(16).padStart(64, "0")}00` +
    `${(dataHex.length / 2).toString(16).padStart(64, "0")}${dataHex}`;
  return encodePacked(["uint48", "uint48", "bytes"], [0, 0, sig as Hex]);
}

const SAFE_DEFAULTS = {
  version: SAFE_VERSION,
  entryPoint: { address: entryPoint07Address, version: "0.7" as const },
  saltNonce: 0n,
};

/**
 * Passkey-native Safe (§1a): owner = shared signer configured with the
 * first passkey, verifiers = VERIFIERS (precompile + FCL fallback).
 * The webauthn owner has no getFn — it is never asked to sign here.
 */
export async function buildNativeSafe(
  client: PublicClient,
  firstPasskey: PasskeyCoords & { credentialId?: string },
  address?: Address
): Promise<SafeAccount> {
  const owner = toWebAuthnAccount({
    credential: {
      id: firstPasskey.credentialId || "passkey",
      publicKey: uncompressedPublicKey(firstPasskey),
    },
    getFn: async () => {
      throw new Error("server-side webauthn owner cannot sign");
    },
  });
  return toSafeSmartAccount({
    client,
    owners: [owner],
    ...SAFE_DEFAULTS,
    // permissionless passes this to SharedSigner.configure({x, y, verifiers}).
    safeP256VerifierAddress: toHex(VERIFIERS, { size: 22 }) as unknown as Address,
    ...(address ? { address } : {}),
  });
}

/** Address-only EOA owner (the legacy owner, used for initCode / address). */
export function addressOnlyOwner(address: Address) {
  return toAccount({
    address,
    async signMessage() {
      throw new Error("address-only owner cannot sign");
    },
    async signTransaction() {
      throw new Error("address-only owner cannot sign");
    },
    async signTypedData() {
      throw new Error("address-only owner cannot sign");
    },
  });
}

/** Legacy EOA-owned Safe (pre-migration address derivation). */
export async function buildLegacySafe(
  client: PublicClient,
  owner: Parameters<typeof toSafeSmartAccount>[0]["owners"][number]
): Promise<SafeAccount> {
  return toSafeSmartAccount({ client, owners: [owner], ...SAFE_DEFAULTS });
}

const nativeAddressCache = new Map<string, Address>();

/** Counterfactual native Safe address for a first passkey (same on every chain). */
export async function computeNativeAddress(client: PublicClient, p: PasskeyCoords): Promise<Address> {
  const key = `${p.x.toString(16)}:${p.y.toString(16)}`;
  const cached = nativeAddressCache.get(key);
  if (cached) return cached;
  const safe = await buildNativeSafe(client, p);
  nativeAddressCache.set(key, safe.address);
  return safe.address;
}

const proxyCache = new Map<string, Address>();

/** SafeWebAuthnSignerProxy address = factory.getSigner(x, y, VERIFIERS). */
export async function computeProxyAddress(client: PublicClient, p: PasskeyCoords): Promise<Address> {
  const key = `${p.x.toString(16)}:${p.y.toString(16)}`;
  const cached = proxyCache.get(key);
  if (cached) return cached;
  const addr = (await client.readContract({
    address: SAFE_WEBAUTHN_SIGNER_FACTORY,
    abi: SIGNER_FACTORY_ABI,
    functionName: "getSigner",
    args: [p.x, p.y, VERIFIERS],
  })) as Address;
  const out = getAddress(addr);
  proxyCache.set(key, out);
  return out;
}

export interface OwnerState {
  deployed: boolean;
  owners: Address[];
  threshold: number;
}

export async function readOwnerState(client: PublicClient, safe: Address): Promise<OwnerState> {
  const code = await client.getCode({ address: safe });
  if (!code || code === "0x") return { deployed: false, owners: [], threshold: 0 };
  const [owners, threshold] = await Promise.all([
    client.readContract({ address: safe, abi: SAFE_OWNER_ABI, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: SAFE_OWNER_ABI, functionName: "getThreshold" }),
  ]);
  return {
    deployed: true,
    owners: (owners as readonly Address[]).map((o) => getAddress(o)),
    threshold: Number(threshold),
  };
}

export function assertCapability(chainId: number, need: "sharedSigner" | "signerFactory"): void {
  const caps = getPasskeyCapabilities(chainId);
  if (!caps[need]) {
    const contract = need === "sharedSigner" ? "SafeWebAuthnSharedSigner" : "SafeWebAuthnSignerFactory";
    throw new PasskeyError(
      "PASSKEY_UNSUPPORTED_ON_CHAIN",
      `${contract} is not deployed on chain ${chainId}; see scripts/deploy-passkey-contracts.md`,
      { chainId, missing: contract }
    );
  }
}

/**
 * Resolve an AccountRef to a usable Safe account on `chainId`, checking
 * the address and (for migrated accounts) that the chain is migrated.
 */
export async function resolveAccount(
  client: PublicClient,
  chainId: number,
  ref: AccountRef
): Promise<{ safe: SafeAccount; state: OwnerState }> {
  if (ref.kind === "passkey_native") {
    assertCapability(chainId, "sharedSigner");
    const computed = await computeNativeAddress(client, ref.firstPasskey);
    if (computed.toLowerCase() !== ref.address.toLowerCase()) {
      throw new PasskeyError(
        "ACCOUNT_MISMATCH",
        `account.address ${ref.address} is not the native Safe of firstPasskey (${computed})`
      );
    }
    const safe = await buildNativeSafe(client, ref.firstPasskey);
    const state = await readOwnerState(client, safe.address);
    return { safe, state };
  }

  assertCapability(chainId, "signerFactory");
  const legacy = await buildLegacySafe(client, addressOnlyOwner(ref.legacyOwner));
  if (legacy.address.toLowerCase() !== ref.address.toLowerCase()) {
    throw new PasskeyError(
      "ACCOUNT_MISMATCH",
      `account.address ${ref.address} is not the Safe of legacyOwner (${legacy.address})`
    );
  }
  const state = await readOwnerState(client, legacy.address);
  if (!state.deployed || state.owners.some((o) => o.toLowerCase() === ref.legacyOwner.toLowerCase())) {
    throw new PasskeyError(
      "MIGRATION_REQUIRED",
      `Safe ${ref.address} is not migrated to passkeys on chain ${chainId}`,
      { chainId }
    );
  }
  const stubSigner = state.owners[0] ?? zeroAddress;
  // Gas estimation must see a WebAuthn-shaped signature from a real proxy
  // owner, not the EOA's ECDSA stub.
  const safe = { ...legacy, getStubSignature: async () => webAuthnStubSignature(stubSigner) } as SafeAccount;
  return { safe, state };
}

// ─── Owner-management calls (§1b) ────────────────────────────────────

export interface RawCall {
  to: Address;
  value: bigint;
  data: Hex;
}

export function buildCreateSignerCall(p: PasskeyCoords): RawCall {
  return {
    to: SAFE_WEBAUTHN_SIGNER_FACTORY,
    value: 0n,
    data: encodeFunctionData({
      abi: SIGNER_FACTORY_ABI,
      functionName: "createSigner",
      args: [p.x, p.y, VERIFIERS],
    }),
  };
}

export function buildAddOwnerCall(safe: Address, owner: Address): RawCall {
  return {
    to: safe,
    value: 0n,
    data: encodeFunctionData({
      abi: SAFE_OWNER_ABI,
      functionName: "addOwnerWithThreshold",
      args: [owner, 1n],
    }),
  };
}

export function buildAddPasskeyCalls(safe: Address, p: PasskeyCoords, proxy: Address): RawCall[] {
  return [buildCreateSignerCall(p), buildAddOwnerCall(safe, proxy)];
}

/** prev of owners[0] is SENTINEL, else owners[i-1]. */
export function computePrevOwner(owners: readonly Address[], owner: Address): Address {
  const i = owners.findIndex((o) => o.toLowerCase() === owner.toLowerCase());
  if (i < 0) throw new PasskeyError("NOT_AN_OWNER", `${owner} is not an owner of this Safe`);
  return i === 0 ? SENTINEL_OWNERS : getAddress(owners[i - 1] as Address);
}

/** Safe's addOwner inserts at the head of the linked list. */
export function ownersAfterAdding(owners: readonly Address[], added: readonly Address[]): Address[] {
  let list = [...owners];
  for (const a of added) {
    if (list.some((o) => o.toLowerCase() === a.toLowerCase())) continue;
    list = [getAddress(a), ...list];
  }
  return list;
}

export function buildRemoveOwnerCall(safe: Address, owners: readonly Address[], owner: Address): RawCall {
  if (owners.length <= 1) {
    throw new PasskeyError("LAST_OWNER", "refusing to remove the last owner of the Safe");
  }
  const prev = computePrevOwner(owners, owner);
  return {
    to: safe,
    value: 0n,
    data: encodeFunctionData({
      abi: SAFE_OWNER_ABI,
      functionName: "removeOwner",
      args: [prev, getAddress(owner), 1n],
    }),
  };
}

export function isSharedSigner(address: string): boolean {
  return address.toLowerCase() === SAFE_WEBAUTHN_SHARED_SIGNER.toLowerCase();
}

/**
 * Account to use for read-only fee estimates. Accepts an AccountRef
 * (preferred) or a legacy `ownerAddress`. A migrated ref on a chain that
 * isn't migrated yet estimates against the legacy Safe.
 */
export async function estimationAccount(
  client: PublicClient,
  chainId: number,
  opts: { account?: unknown; ownerAddress?: string | undefined }
): Promise<SafeAccount> {
  if (opts.account !== undefined && opts.account !== null) {
    const ref = parseAccountRef(opts.account);
    try {
      return (await resolveAccount(client, chainId, ref)).safe;
    } catch (e) {
      if (ref.kind === "migrated" && e instanceof PasskeyError && e.code === "MIGRATION_REQUIRED") {
        return buildLegacySafe(client, addressOnlyOwner(ref.legacyOwner));
      }
      throw e;
    }
  }
  return buildLegacySafe(client, addressOnlyOwner(parseAddress(opts.ownerAddress, "ownerAddress")));
}
