/**
 * On-chain constants for passkey-owned Safes (Safe v1.4.1, EntryPoint
 * v0.7, Safe passkey module v0.2.1). Same addresses on every chain.
 *
 * Spec: PASSKEY-WALLET-SPEC.md §1.
 */

import { getAddress, type Address } from "viem";

export const SAFE_VERSION = "1.4.1" as const;

export const SAFE_4337_MODULE_ADDRESS: Address = getAddress(
  "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226"
);

export const SAFE_WEBAUTHN_SHARED_SIGNER: Address = getAddress(
  "0x94a4F6affBd8975951142c3999aEAB7ecee555c2"
);

export const SAFE_WEBAUTHN_SIGNER_FACTORY: Address = getAddress(
  "0x1d31F259eE307358a26dFb23EB365939E8641195"
);

export const FCL_P256_VERIFIER: Address = getAddress(
  "0xA86e0054C51E4894D88762a017ECc5E5235f5DBA"
);

/** Safe singleton factory used to deploy the passkey contracts (docs only). */
export const SAFE_SINGLETON_FACTORY: Address = getAddress(
  "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7"
);

/**
 * P256.Verifiers (uint176): RIP-7212 precompile 0x100 in the top 16 bits,
 * FCL fallback verifier in the low 160 bits. Used for EVERY passkey signer
 * (shared-signer configuration and SafeWebAuthnSignerProxy creation).
 */
export const VERIFIERS: bigint =
  (0x0100n << 160n) | BigInt(FCL_P256_VERIFIER);

/** Safe owner linked-list sentinel. */
export const SENTINEL_OWNERS: Address = "0x0000000000000000000000000000000000000001";

export const SAFE_OWNER_ABI = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "addOwnerWithThreshold",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "_threshold", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "removeOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "owner", type: "address" },
      { name: "_threshold", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "checkSignatures",
    stateMutability: "view",
    inputs: [
      { name: "dataHash", type: "bytes32" },
      { name: "data", type: "bytes" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "_dataHash", type: "bytes32" },
      { name: "_signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const;

export const SIGNER_FACTORY_ABI = [
  {
    type: "function",
    name: "createSigner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
      { name: "verifiers", type: "uint176" },
    ],
    outputs: [{ name: "signer", type: "address" }],
  },
  {
    type: "function",
    name: "getSigner",
    stateMutability: "view",
    inputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
      { name: "verifiers", type: "uint176" },
    ],
    outputs: [{ name: "signer", type: "address" }],
  },
] as const;

/** ERC-1271 magic value for isValidSignature(bytes32,bytes). */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;

// ─── Per-chain capability table (§1) ─────────────────────────────────
//
// sharedSigner  → SafeWebAuthnSharedSigner deployed (passkey-native Safes
//                 can be created / signed by their first passkey).
// signerFactory → SafeWebAuthnSignerFactory deployed (extra passkeys and
//                 EOA → passkey migration need a SafeWebAuthnSignerProxy).
//
// Every supported chain has the RIP-7212 precompile. Berachain is missing
// the factory today. Lisk (not yet a supported chain) has neither.
// When a contract gets deployed, flip it here or via the env override
// PASSKEY_CAPABILITY_OVERRIDES='{"80094":{"signerFactory":true}}'.

export interface PasskeyCapabilities {
  sharedSigner: boolean;
  signerFactory: boolean;
}

const BASE_CAPABILITIES: Record<number, PasskeyCapabilities> = {
  1: { sharedSigner: true, signerFactory: true },
  8453: { sharedSigner: true, signerFactory: true },
  137: { sharedSigner: true, signerFactory: true },
  42220: { sharedSigner: true, signerFactory: true },
  42161: { sharedSigner: true, signerFactory: true },
  43114: { sharedSigner: true, signerFactory: true },
  56: { sharedSigner: true, signerFactory: true },
  80094: { sharedSigner: true, signerFactory: false },
  1135: { sharedSigner: false, signerFactory: false }, // Lisk
};

function parseOverrides(): Record<number, Partial<PasskeyCapabilities>> {
  const raw = process.env.PASSKEY_CAPABILITY_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<PasskeyCapabilities>>;
    const out: Record<number, Partial<PasskeyCapabilities>> = {};
    for (const [k, v] of Object.entries(parsed)) out[Number(k)] = v;
    return out;
  } catch {
    console.warn("[passkey] PASSKEY_CAPABILITY_OVERRIDES is not valid JSON; ignored.");
    return {};
  }
}

export function getPasskeyCapabilities(chainId: number): PasskeyCapabilities {
  const base = BASE_CAPABILITIES[chainId] ?? { sharedSigner: false, signerFactory: false };
  const override = parseOverrides()[chainId] ?? {};
  return { ...base, ...override };
}

export function getCapabilityTable(): Record<number, PasskeyCapabilities> {
  const out: Record<number, PasskeyCapabilities> = {};
  for (const id of Object.keys(BASE_CAPABILITIES)) {
    out[Number(id)] = getPasskeyCapabilities(Number(id));
  }
  return out;
}
