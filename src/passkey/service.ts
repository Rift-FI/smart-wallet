/**
 * Passkey wallet primitives behind the /api/v3 + /api/passkey routes
 * (spec §2f). Every fund-moving or signing operation is two-phase:
 *
 *   prepare → { ticketId, hashToSign, ... }   (unsigned op stored in the ticket)
 *   client passkey-signs hashToSign
 *   submit { ticketId, signer, authProof } → encoded per §1d / §1e, verified,
 *   then submitted (UserOps) or returned (messages).
 */

import {
  getAddress,
  hashMessage,
  hashTypedData,
  serializeErc6492Signature,
  type Address,
  type Hex,
  type PublicClient,
  type SignableMessage,
  type TypedDataDefinition,
} from "viem";
import { getPublicClient, isSupportedChain, SUPPORTED_CHAINS_LIST } from "../chainConfig";
import { consumeTicket, peekTicket, stashTicket } from "../ticketCache";
import {
  ERC1271_MAGIC_VALUE,
  SAFE_OWNER_ABI,
  SAFE_WEBAUTHN_SHARED_SIGNER,
  SAFE_WEBAUTHN_SIGNER_FACTORY,
} from "./constants";
import { PasskeyError } from "./errors";
import {
  assertCapability,
  buildAddPasskeyCalls,
  buildRemoveOwnerCall,
  computeNativeAddress,
  computeProxyAddress,
  isSharedSigner,
  parseAccountRef,
  parseAddress,
  parseCoords,
  readOwnerState,
  resolveAccount,
  serialiseAccountRef,
  type AccountRef,
  type OwnerState,
  type PasskeyCoords,
  type RawCall,
} from "./account";
import { buildGasPlan, parseGasSpec, type GasSpec } from "./gas";
import { prepareUserOp, quoteTokenPaymaster, submitUserOp, type SubmitResult } from "./relay";
import { computeSafeOpData, computeSafeOpHash, normaliseCalls, reviveUserOp, serialiseUserOp } from "./userOp";
import { buildPasskeySignature, encodeUserOpSignature, verifyP256Assertion } from "./webauthn";

export function assertChain(chainId: unknown): number {
  if (!isSupportedChain(chainId)) {
    throw new PasskeyError("UNSUPPORTED_CHAIN", `chainId must be one of ${SUPPORTED_CHAINS_LIST}`);
  }
  return chainId;
}

export interface SignerRef {
  address: Address;
  kind: "shared" | "proxy";
}

export function parseSignerRef(raw: unknown): SignerRef {
  if (!raw || typeof raw !== "object") {
    throw new PasskeyError("VALIDATION_ERROR", 'signer { address, kind: "shared"|"proxy" } is required');
  }
  const r = raw as { address?: unknown; kind?: unknown };
  if (r.kind === "shared") {
    const address = r.address === undefined ? SAFE_WEBAUTHN_SHARED_SIGNER : parseAddress(r.address, "signer.address");
    if (!isSharedSigner(address)) throw new PasskeyError("VALIDATION_ERROR", "signer.kind=shared requires the shared signer address");
    return { address, kind: "shared" };
  }
  if (r.kind === "proxy") {
    const address = parseAddress(r.address, "signer.address");
    if (isSharedSigner(address)) throw new PasskeyError("VALIDATION_ERROR", "signer.kind=proxy cannot be the shared signer");
    return { address, kind: "proxy" };
  }
  throw new PasskeyError("VALIDATION_ERROR", 'signer.kind must be "shared" or "proxy"');
}

/**
 * `signer` may be omitted for a passkey-native Safe (→ shared signer, its
 * first passkey) so older submit callers keep working. Migrated Safes
 * always need the proxy address.
 */
export function resolveSigner(raw: unknown, ref: AccountRef): SignerRef {
  if (raw === undefined || raw === null) {
    if (ref.kind === "passkey_native") return { address: SAFE_WEBAUTHN_SHARED_SIGNER, kind: "shared" };
    throw new PasskeyError("VALIDATION_ERROR", 'signer { address, kind: "proxy" } is required for a migrated Safe');
  }
  return parseSignerRef(raw);
}

// ─── Addresses / owners ──────────────────────────────────────────────

/** Chain used for chain-agnostic computations (address, proxy). */
function computeChainId(): number {
  const raw = Number(process.env.PASSKEY_COMPUTE_CHAIN_ID);
  return isSupportedChain(raw) ? raw : 8453;
}

export async function passkeyNativeAddress(raw: unknown): Promise<{ address: Address }> {
  const coords = parseCoords(raw, "credential");
  return { address: await computeNativeAddress(getPublicClient(computeChainId()), coords) };
}

export async function passkeyProxyAddress(raw: unknown): Promise<{ proxyAddress: Address }> {
  const coords = parseCoords(raw, "signer");
  const chainId = computeChainId();
  assertCapability(chainId, "signerFactory");
  return { proxyAddress: await computeProxyAddress(getPublicClient(chainId), coords) };
}

export async function getOwners(chainIdRaw: unknown, safeRaw: unknown, rpcUrl?: string): Promise<OwnerState> {
  const chainId = assertChain(chainIdRaw);
  const safe = parseAddress(safeRaw, "safe");
  return readOwnerState(getPublicClient(chainId, rpcUrl), safe);
}

// ─── Intents (convenience call builders) ─────────────────────────────

export type Intent =
  | { type: "add_passkey"; passkey: PasskeyCoords }
  | { type: "remove_passkey"; owner?: Address; passkey?: PasskeyCoords };

export function parseIntent(raw: unknown): Intent | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "add_passkey") return { type: "add_passkey", passkey: parseCoords(r.passkey, "intent.passkey") };
  if (r.type === "remove_passkey") {
    if (r.owner !== undefined) return { type: "remove_passkey", owner: parseAddress(r.owner, "intent.owner") };
    return { type: "remove_passkey", passkey: parseCoords(r.passkey, "intent.passkey") };
  }
  throw new PasskeyError("VALIDATION_ERROR", 'intent.type must be "add_passkey" or "remove_passkey"');
}

async function intentCalls(
  client: PublicClient,
  chainId: number,
  safe: Address,
  state: OwnerState,
  intent: Intent
): Promise<RawCall[]> {
  if (!state.deployed) {
    throw new PasskeyError("VALIDATION_ERROR", "owner changes need a deployed Safe; undeployed chains pick passkeys up at deploy/migration");
  }
  assertCapability(chainId, "signerFactory");
  if (intent.type === "add_passkey") {
    const proxy = await computeProxyAddress(client, intent.passkey);
    if (state.owners.some((o) => o.toLowerCase() === proxy.toLowerCase())) {
      throw new PasskeyError("VALIDATION_ERROR", `passkey proxy ${proxy} is already an owner`);
    }
    return buildAddPasskeyCalls(safe, intent.passkey, proxy);
  }
  const owner = intent.owner ?? (await computeProxyAddress(client, intent.passkey as PasskeyCoords));
  return [buildRemoveOwnerCall(safe, state.owners, owner)];
}

// ─── UserOp prepare / submit ─────────────────────────────────────────

interface UserOpTicket {
  type: "userop";
  chainId: number;
  rpcUrl?: string;
  account: Record<string, unknown>;
  userOp: Record<string, string>;
  hashToSign: Hex;
  deployed: boolean;
  purpose: string;
}

export interface PrepareInput {
  chainId: unknown;
  account: unknown;
  calls?: unknown;
  gas?: unknown;
  purpose?: unknown;
  intent?: unknown;
  rpcUrl?: string;
}

export interface PrepareOutput {
  ticketId: string;
  hashToSign: Hex;
  userOp: Record<string, string>;
  expiresAt: number;
  chainId: number;
  sender: Address;
  deployed: boolean;
  purpose: string;
  /** Native Safe deploy on a chain without the signer factory: extra passkeys not added. */
  skippedExtraPasskeys?: boolean;
}

export async function prepareOperation(input: PrepareInput): Promise<PrepareOutput> {
  const chainId = assertChain(input.chainId);
  const ref = parseAccountRef(input.account);
  const gas: GasSpec = parseGasSpec(input.gas);
  const purpose = typeof input.purpose === "string" && input.purpose ? input.purpose : "transaction";
  const intent = parseIntent(input.intent);
  const client = getPublicClient(chainId, input.rpcUrl);

  const { safe, state } = await resolveAccount(client, chainId, ref);

  let userCalls = input.calls === undefined && intent ? [] : normaliseCalls(input.calls);
  if (intent) userCalls = [...userCalls, ...(await intentCalls(client, chainId, safe.address, state, intent))];
  if (userCalls.length === 0) throw new PasskeyError("VALIDATION_ERROR", "calls must be a non-empty array");
  if (userCalls.some((c) => c.to.toLowerCase() === SAFE_WEBAUTHN_SIGNER_FACTORY.toLowerCase())) {
    assertCapability(chainId, "signerFactory");
  }

  // §1a: the deploy op of a native Safe also adds every other active passkey.
  let skippedExtraPasskeys = false;
  if (ref.kind === "passkey_native" && !state.deployed && ref.extraPasskeys.length > 0) {
    try {
      assertCapability(chainId, "signerFactory");
      const extra: RawCall[] = [];
      for (const p of ref.extraPasskeys) {
        extra.push(...buildAddPasskeyCalls(safe.address, p, await computeProxyAddress(client, p)));
      }
      userCalls = [...extra, ...userCalls];
    } catch (e) {
      if (!(e instanceof PasskeyError) || e.code !== "PASSKEY_UNSUPPORTED_ON_CHAIN") throw e;
      skippedExtraPasskeys = true;
    }
  }

  const plan = await buildGasPlan({
    gas,
    chainId,
    client,
    safe: safe.address,
    userCalls,
    quoteToken: (token) => quoteTokenPaymaster(chainId, token),
  });

  let op;
  try {
    op = await prepareUserOp({ chainId, client, account: safe, gas, plan });
  } catch (e: any) {
    if (e instanceof PasskeyError) throw e;
    throw new PasskeyError("PREPARE_FAILED", e?.details || e?.shortMessage || e?.message || "prepare failed");
  }

  const hashToSign = computeSafeOpHash(op, chainId);
  const userOp = serialiseUserOp(op as any);
  const ticket: UserOpTicket = {
    type: "userop",
    chainId,
    ...(input.rpcUrl ? { rpcUrl: input.rpcUrl } : {}),
    account: serialiseAccountRef(ref),
    userOp,
    hashToSign,
    deployed: state.deployed,
    purpose,
  };
  const { ticketId, expiresAt } = stashTicket(ticket);
  console.log(`[v3/prepare] chain=${chainId} sender=${safe.address} purpose=${purpose} calls=${plan.calls.length} ticket=${ticketId}`);
  return {
    ticketId,
    hashToSign,
    userOp,
    expiresAt,
    chainId,
    sender: safe.address,
    deployed: state.deployed,
    purpose,
    ...(skippedExtraPasskeys ? { skippedExtraPasskeys } : {}),
  };
}

/**
 * Shared signer checks: who may sign, and an off-chain P-256 check when we
 * know the key (native first passkey via the shared signer).
 */
function checkSigner(ref: AccountRef, signer: SignerRef, deployed: boolean, owners: Address[]): void {
  if (signer.kind === "shared") {
    if (ref.kind !== "passkey_native") {
      throw new PasskeyError("SIGNER_NOT_OWNER", "migrated Safes are signed by passkey proxies, not the shared signer");
    }
  } else if (!deployed) {
    throw new PasskeyError("SIGNER_NOT_OWNER", "an undeployed Safe can only be signed by its first passkey (shared signer)");
  }
  if (deployed && !owners.some((o) => o.toLowerCase() === signer.address.toLowerCase())) {
    throw new PasskeyError("SIGNER_NOT_OWNER", `${signer.address} is not an owner of this Safe on this chain`);
  }
}

function checkNativeAssertion(ref: AccountRef, signer: SignerRef, sig: ReturnType<typeof buildPasskeySignature>): void {
  if (ref.kind !== "passkey_native" || signer.kind !== "shared") return;
  const ok = verifyP256Assertion({
    x: ref.firstPasskey.x,
    y: ref.firstPasskey.y,
    authenticatorData: sig.parsed.authenticatorData,
    clientDataJSON: sig.parsed.clientDataJSON,
    r: sig.r,
    s: sig.s,
  });
  if (!ok) throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "passkey signature does not verify against the first passkey");
}

export interface SubmitInput {
  ticketId: unknown;
  signer: unknown;
  authProof: unknown;
}

export async function submitOperation(input: SubmitInput): Promise<SubmitResult & { chainId: number }> {
  if (typeof input.ticketId !== "string") throw new PasskeyError("VALIDATION_ERROR", "ticketId is required");
  const ticket = peekTicket<UserOpTicket>(input.ticketId);
  if (!ticket || ticket.type !== "userop") {
    throw new PasskeyError("TICKET_NOT_FOUND", "ticket not found, expired or already used — prepare again");
  }
  const ref = parseAccountRef(ticket.account);
  const signer = resolveSigner(input.signer, ref);
  const sig = buildPasskeySignature({ authProof: input.authProof, hashToSign: ticket.hashToSign, signer: signer.address });

  const client = getPublicClient(ticket.chainId, ticket.rpcUrl);
  const state = await readOwnerState(client, ref.address);
  checkSigner(ref, signer, state.deployed, state.owners);
  checkNativeAssertion(ref, signer, sig);

  const op = reviveUserOp(ticket.userOp);
  // On-chain-equivalent check: exactly what Safe4337Module asks the Safe.
  if (state.deployed) {
    try {
      await client.readContract({
        address: ref.address,
        abi: SAFE_OWNER_ABI,
        functionName: "checkSignatures",
        args: [ticket.hashToSign, computeSafeOpData(op, ticket.chainId), sig.contractSignature],
      });
    } catch {
      throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "Safe.checkSignatures rejected the passkey signature");
    }
  }

  if (!consumeTicket(input.ticketId)) {
    throw new PasskeyError("TICKET_NOT_FOUND", "ticket already used");
  }
  op.signature = encodeUserOpSignature(sig.contractSignature);
  const result = await submitUserOp({
    chainId: ticket.chainId,
    client,
    userOp: op,
    ...(ticket.rpcUrl ? { rpcUrl: ticket.rpcUrl } : {}),
  });
  console.log(`[v3/submit] chain=${ticket.chainId} sender=${ref.address} purpose=${ticket.purpose} userOp=${result.userOpHash} status=${result.status}`);
  return { ...result, chainId: ticket.chainId };
}

// ─── Messages (ERC-1271 / ERC-6492, §1e) ─────────────────────────────

interface MessageTicket {
  type: "message";
  chainId: number;
  rpcUrl?: string;
  account: Record<string, unknown>;
  innerHash: Hex;
  hashToSign: Hex;
}

/** Safe 1.4.1 SafeMessage(bytes message) hash over an EIP-191 / EIP-712 digest. */
export function computeSafeMessageHash(innerHash: Hex, safe: Address, chainId: number): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: { SafeMessage: [{ name: "message", type: "bytes" }] },
    primaryType: "SafeMessage",
    message: { message: innerHash },
  });
}

/** personal_sign: viem SignableMessage semantics (string = UTF-8, { raw } = bytes). */
export function innerMessageHash(kind: unknown, message: unknown, typedData: unknown): Hex {
  if (kind === "personal_sign") {
    if (typeof message === "string") return hashMessage(message);
    if (message && typeof message === "object" && typeof (message as any).raw === "string") {
      return hashMessage(message as SignableMessage);
    }
    throw new PasskeyError("VALIDATION_ERROR", "message must be a string or { raw: 0x… }");
  }
  if (kind === "typed_data") {
    const td = (typeof typedData === "string" ? JSON.parse(typedData) : typedData) as TypedDataDefinition;
    if (!td || typeof td !== "object" || !td.types || !td.primaryType) {
      throw new PasskeyError("VALIDATION_ERROR", "typedData must be an EIP-712 { domain, types, primaryType, message }");
    }
    const types = { ...(td.types as Record<string, unknown>) };
    delete types.EIP712Domain;
    try {
      return hashTypedData({ ...td, types } as TypedDataDefinition);
    } catch (e: any) {
      throw new PasskeyError("VALIDATION_ERROR", `typedData could not be hashed: ${e?.shortMessage ?? e?.message}`);
    }
  }
  throw new PasskeyError("VALIDATION_ERROR", 'kind must be "personal_sign" or "typed_data"');
}

export async function prepareMessage(input: {
  chainId: unknown;
  account: unknown;
  kind: unknown;
  message?: unknown;
  typedData?: unknown;
  rpcUrl?: string;
}): Promise<{ ticketId: string; hashToSign: Hex; expiresAt: number; chainId: number; deployed: boolean }> {
  const chainId = assertChain(input.chainId);
  const ref = parseAccountRef(input.account);
  const innerHash = innerMessageHash(input.kind, input.message, input.typedData);
  const client = getPublicClient(chainId, input.rpcUrl);
  const { safe, state } = await resolveAccount(client, chainId, ref);
  const hashToSign = computeSafeMessageHash(innerHash, safe.address, chainId);
  const ticket: MessageTicket = {
    type: "message",
    chainId,
    ...(input.rpcUrl ? { rpcUrl: input.rpcUrl } : {}),
    account: serialiseAccountRef(ref),
    innerHash,
    hashToSign,
  };
  const { ticketId, expiresAt } = stashTicket(ticket);
  return { ticketId, hashToSign, expiresAt, chainId, deployed: state.deployed };
}

export async function submitMessage(input: SubmitInput): Promise<{
  signature: Hex;
  erc6492: boolean;
  chainId: number;
  address: Address;
  messageHash: Hex;
}> {
  if (typeof input.ticketId !== "string") throw new PasskeyError("VALIDATION_ERROR", "ticketId is required");
  const ticket = peekTicket<MessageTicket>(input.ticketId);
  if (!ticket || ticket.type !== "message") {
    throw new PasskeyError("TICKET_NOT_FOUND", "ticket not found, expired or already used — prepare again");
  }
  const ref = parseAccountRef(ticket.account);
  const signer = resolveSigner(input.signer, ref);
  const sig = buildPasskeySignature({ authProof: input.authProof, hashToSign: ticket.hashToSign, signer: signer.address });
  const client = getPublicClient(ticket.chainId, ticket.rpcUrl);
  const state = await readOwnerState(client, ref.address);
  checkSigner(ref, signer, state.deployed, state.owners);
  checkNativeAssertion(ref, signer, sig);

  let signature: Hex = sig.contractSignature;
  let erc6492 = false;
  if (state.deployed) {
    let magic: Hex | null = null;
    try {
      magic = (await client.readContract({
        address: ref.address,
        abi: SAFE_OWNER_ABI,
        functionName: "isValidSignature",
        args: [ticket.innerHash, signature],
      })) as Hex;
    } catch {
      magic = null;
    }
    if (magic?.toLowerCase() !== ERC1271_MAGIC_VALUE) {
      throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "Safe.isValidSignature rejected the passkey signature");
    }
  } else {
    // Undeployed: only a passkey-native Safe can be counterfactually
    // validated (its initCode configures the first passkey).
    const { safe } = await resolveAccount(client, ticket.chainId, ref);
    const { factory, factoryData } = await safe.getFactoryArgs();
    if (!factory || !factoryData) throw new PasskeyError("CONFIGURATION_ERROR", "missing factory data for ERC-6492");
    signature = serializeErc6492Signature({ address: factory, data: factoryData, signature });
    erc6492 = true;
    const valid = await client.verifyHash({ address: ref.address, hash: ticket.innerHash, signature }).catch(() => false);
    if (!valid) throw new PasskeyError("INVALID_PASSKEY_SIGNATURE", "ERC-6492 signature does not verify");
  }
  consumeTicket(input.ticketId);
  return { signature, erc6492, chainId: ticket.chainId, address: getAddress(ref.address), messageHash: ticket.innerHash };
}
