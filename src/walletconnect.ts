import "dotenv/config";
import { Core } from "@walletconnect/core";
import { Web3Wallet, Web3WalletTypes, IWeb3Wallet } from "@walletconnect/web3wallet";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import { isHex, type Hex } from "viem";
import { getPublicClient } from "./chainConfig";
import { parseAccountRef, resolveAccount, serialiseAccountRef } from "./passkey/account";
import { PasskeyError } from "./passkey/errors";
import {
  assertChain,
  prepareMessage,
  prepareOperation,
  submitMessage,
  submitOperation,
} from "./passkey/service";

// WalletConnect runs server-side (WalletKit) so SDK / app clients don't
// have to hold a session. Every signing request is two-phase:
//
//   POST /api/walletconnect/requests/:id/preview → { hashToSign, ticketId }
//     (SafeOp hash for eth_sendTransaction, SafeMessage hash for signatures)
//   client passkey-signs hashToSign
//   POST /api/walletconnect/requests/:id/approve { authProof, signer }
//     → submits the UserOp / returns the ERC-1271 (ERC-6492 if undeployed)
//       signature to the dApp.
//
// No key material is ever stored on a session — only the AccountRef.

interface SessionConfig {
  /** Serialised AccountRef (passkey_native | migrated). */
  account: Record<string, unknown>;
  smartWalletAddress: string;
  chainId: number;
  rpcUrl?: string;
}

// Pending request store
export interface PendingRequest {
  id: number;
  topic: string;
  method: string;
  params: any[];
  peerName: string;
  chainId: number;
  smartWalletAddress: string;
  createdAt: string;
}

const SIGNING_METHODS = new Set([
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
]);

const sessions = new Map<string, SessionConfig>();
const pendingRequests = new Map<number, { pending: PendingRequest; sessionConfig: SessionConfig }>();
// Ticket from preview, consumed by approve. Cleared on approve / reject.
const wcTicketByRequestId = new Map<number, { ticketId: string; kind: "userop" | "message"; expiresAt: number }>();
let web3wallet: IWeb3Wallet | null = null;

// Event callbacks for real-time updates
type EventCallback = (event: { type: string; topic: string; data: any }) => void;
const eventCallbacks: EventCallback[] = [];

export function onWalletConnectEvent(cb: EventCallback) {
  eventCallbacks.push(cb);
}

function emitEvent(event: { type: string; topic: string; data: any }) {
  eventCallbacks.forEach(cb => cb(event));
  console.log(`🔗 WC Event [${event.type}]:`, JSON.stringify(event.data).slice(0, 200));
}

/**
 * Initialize the shared Web3Wallet instance
 */
export async function getWeb3Wallet(): Promise<IWeb3Wallet> {
  if (web3wallet) return web3wallet;

  const projectId = process.env.WALLETCONNECT_PROJECT_ID;
  if (!projectId) {
    throw new Error("WALLETCONNECT_PROJECT_ID env var is required. Get one at https://cloud.walletconnect.com");
  }

  const core = new Core({ projectId });

  web3wallet = await Web3Wallet.init({
    core: core as any,
    metadata: {
      name: "Rift Smart Wallet",
      description: "ERC-4337 Smart Wallet with gas sponsorship",
      url: "https://rift.fi",
      icons: ["https://rift.fi/icon.png"],
    },
  });

  // Handle session proposals (DApp wants to connect)
  web3wallet.on("session_proposal", async (proposal) => {
    console.log(`📥 WC session_proposal received:`, proposal.id);
    emitEvent({ type: "session_proposal", topic: String(proposal.id), data: { id: proposal.id } });
    // Proposals are approved explicitly via the pair endpoint
  });

  // Handle session requests (DApp sends a transaction/sign request).
  // Never auto-signed: queued until the user approves with a passkey.
  web3wallet.on("session_request", async (event) => {
    const { topic, params, id } = event;
    const { request } = params;

    console.log(`📥 WC session_request [${request.method}]`);

    const sessionConfig = sessions.get(topic);
    if (!sessionConfig) {
      console.error(`❌ No session config for topic: ${topic}`);
      await web3wallet!.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          error: getSdkError("UNAUTHORIZED_METHOD"),
        },
      });
      return;
    }

    const activeSessions = web3wallet!.getActiveSessions();
    const session = activeSessions[topic];
    const peerName = session?.peer?.metadata?.name || "Unknown DApp";

    queuePendingRequest(
      {
        id,
        topic,
        method: request.method,
        params: request.params,
        peerName,
        chainId: sessionConfig.chainId,
        smartWalletAddress: sessionConfig.smartWalletAddress,
        createdAt: new Date().toISOString(),
      },
      sessionConfig
    );
  });

  // Handle session deletions
  web3wallet.on("session_delete", (event) => {
    console.log(`🔌 WC session_delete:`, event.topic);
    sessions.delete(event.topic);
    emitEvent({ type: "session_deleted", topic: event.topic, data: {} });
  });

  console.log("✅ WalletConnect Web3Wallet initialized");
  return web3wallet;
}

function queuePendingRequest(pending: PendingRequest, sessionConfig: SessionConfig): void {
  pendingRequests.set(pending.id, { pending, sessionConfig });
  console.log(`⏳ Request ${pending.id} queued for approval: ${pending.method} from ${pending.peerName}`);
  emitEvent({ type: "pending_request", topic: pending.topic, data: pending });
}

/**
 * Pair with a DApp and create a session bound to `account` (an AccountRef).
 */
export async function pairAndApprove(
  uri: string,
  accountRaw: unknown,
  chainIdRaw: unknown,
  rpcUrl?: string
): Promise<{
  topic: string;
  smartWalletAddress: string;
  peerName: string;
  peerUrl: string;
}> {
  const chainId = assertChain(chainIdRaw);
  const ref = parseAccountRef(accountRaw);
  // Validates the address and (for migrated Safes) that this chain is migrated.
  await resolveAccount(getPublicClient(chainId, rpcUrl), chainId, ref);
  const smartWalletAddress = ref.address;

  const wallet = await getWeb3Wallet();
  console.log(`🔗 Pairing with DApp. Smart wallet: ${smartWalletAddress}`);

  // Pair and wait for session proposal
  const proposal = await new Promise<Web3WalletTypes.SessionProposal>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Pairing timeout (30s)")), 30000);

    wallet.once("session_proposal", (p) => {
      clearTimeout(timeout);
      resolve(p);
    });

    wallet.pair({ uri }).catch(reject);
  });

  const chainString = `eip155:${chainId}`;
  const accounts = [`${chainString}:${smartWalletAddress}`];

  const approvedNamespaces = buildApprovedNamespaces({
    proposal: proposal.params,
    supportedNamespaces: {
      eip155: {
        chains: [chainString],
        methods: [
          "eth_sendTransaction",
          "personal_sign",
          "eth_sign",
          "eth_signTypedData",
          "eth_signTypedData_v3",
          "eth_signTypedData_v4",
          "eth_chainId",
          "eth_accounts",
          "wallet_switchEthereumChain",
        ],
        events: ["chainChanged", "accountsChanged"],
        accounts,
      },
    },
  });

  const session = await wallet.approveSession({
    id: proposal.id,
    namespaces: approvedNamespaces,
  });

  const entry: SessionConfig = { account: serialiseAccountRef(ref), smartWalletAddress, chainId };
  if (rpcUrl) entry.rpcUrl = rpcUrl;
  sessions.set(session.topic, entry);

  const peerName = session.peer?.metadata?.name || "Unknown DApp";
  const peerUrl = session.peer?.metadata?.url || "";

  console.log(`✅ WC session approved with ${peerName}. Topic: ${session.topic}`);

  return {
    topic: session.topic,
    smartWalletAddress,
    peerName,
    peerUrl,
  };
}

/**
 * Disconnect a session
 */
export async function disconnectSession(topic: string): Promise<void> {
  const wallet = await getWeb3Wallet();
  await wallet.disconnectSession({
    topic,
    reason: getSdkError("USER_DISCONNECTED"),
  });
  sessions.delete(topic);
  console.log(`🔌 Disconnected session: ${topic}`);
}

/**
 * Get all active sessions
 */
export async function getActiveSessions(): Promise<Array<{
  topic: string;
  smartWalletAddress: string;
  chainId: number;
  peerName: string;
  peerUrl: string;
}>> {
  const wallet = await getWeb3Wallet();
  const activeSessions = wallet.getActiveSessions();

  return Object.entries(activeSessions).map(([topic, session]) => {
    const config = sessions.get(topic);
    return {
      topic,
      smartWalletAddress: config?.smartWalletAddress || "unknown",
      chainId: config?.chainId || 0,
      peerName: session.peer?.metadata?.name || "Unknown",
      peerUrl: session.peer?.metadata?.url || "",
    };
  });
}

/**
 * Get all pending requests awaiting user approval
 */
export function getPendingRequests(): PendingRequest[] {
  return Array.from(pendingRequests.values()).map(({ pending }) => pending);
}

/** personal_sign params are hex; treat non-hex as UTF-8 text. */
function toSignable(message: unknown): string | { raw: Hex } {
  if (typeof message === "string" && isHex(message)) return { raw: message };
  return String(message);
}

function parseTypedData(raw: unknown): Record<string, unknown> {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

export interface PreviewResult {
  method: string;
  peerName: string;
  smartWalletAddress: string;
  chainId: number;
  requiresAuthProof: boolean;
  hashToSign?: Hex;
  ticketId?: string;
  expiresAtMs?: number;
  ttlMs?: number;
}

/**
 * Preview a pending request: builds the UserOp / message ticket and returns
 * the hash the passkey must sign. Non-signing methods need no proof.
 */
export async function previewSessionRequest(requestId: number): Promise<PreviewResult> {
  const entry = pendingRequests.get(requestId);
  if (!entry) throw new PasskeyError("TICKET_NOT_FOUND", `No pending request with id ${requestId}`);
  const { pending, sessionConfig } = entry;
  const base = {
    method: pending.method,
    peerName: pending.peerName,
    smartWalletAddress: pending.smartWalletAddress,
    chainId: pending.chainId,
  };
  const common = {
    chainId: sessionConfig.chainId,
    account: sessionConfig.account,
    ...(sessionConfig.rpcUrl ? { rpcUrl: sessionConfig.rpcUrl } : {}),
  };

  let ticket: { ticketId: string; hashToSign: Hex; expiresAt: number };
  let kind: "userop" | "message";
  switch (pending.method) {
    case "eth_sendTransaction": {
      const tx = pending.params[0] as { to: string; value?: string; data?: string };
      ticket = await prepareOperation({
        ...common,
        calls: [{ to: tx.to, value: tx.value || "0", data: tx.data || "0x" }],
        gas: { mode: "sponsored" },
        purpose: "walletconnect",
      });
      kind = "userop";
      break;
    }
    case "personal_sign":
    case "eth_sign": {
      const message = pending.method === "personal_sign" ? pending.params[0] : pending.params[1];
      ticket = await prepareMessage({ ...common, kind: "personal_sign", message: toSignable(message) });
      kind = "message";
      break;
    }
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4": {
      ticket = await prepareMessage({ ...common, kind: "typed_data", typedData: parseTypedData(pending.params[1]) });
      kind = "message";
      break;
    }
    default:
      return { ...base, requiresAuthProof: false };
  }

  wcTicketByRequestId.set(requestId, { ticketId: ticket.ticketId, kind, expiresAt: ticket.expiresAt });
  return {
    ...base,
    requiresAuthProof: true,
    hashToSign: ticket.hashToSign,
    ticketId: ticket.ticketId,
    expiresAtMs: ticket.expiresAt,
    ttlMs: Math.max(0, ticket.expiresAt - Date.now()),
  };
}

// Errors that mean "the user's approval didn't check out" — the dApp
// request stays pending so the user can preview / sign again.
const RETRYABLE = new Set([
  "PASSKEY_REQUIRED",
  "INVALID_PASSKEY_SIGNATURE",
  "SIGNER_NOT_OWNER",
  "TICKET_NOT_FOUND",
  "VALIDATION_ERROR",
]);

/**
 * Approve a pending request with the user's passkey proof. Signing methods
 * need a prior preview (ticket) plus `{ authProof, signer }`.
 */
export async function approveRequest(
  requestId: number,
  approval: { authProof?: unknown; signer?: unknown } = {}
): Promise<{ success: true; result: any }> {
  const entry = pendingRequests.get(requestId);
  if (!entry) throw new PasskeyError("TICKET_NOT_FOUND", `No pending request with id ${requestId}`);
  const { pending, sessionConfig } = entry;
  const wallet = await getWeb3Wallet();

  let result: any;
  if (SIGNING_METHODS.has(pending.method)) {
    if (!approval.authProof) throw new PasskeyError("PASSKEY_REQUIRED", "approve requires authProof (kind: passkey)");
    const ticket = wcTicketByRequestId.get(requestId);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      throw new PasskeyError("TICKET_NOT_FOUND", "call /preview first (or again — the ticket expired)");
    }
    try {
      if (ticket.kind === "userop") {
        const r = await submitOperation({ ticketId: ticket.ticketId, signer: approval.signer, authProof: approval.authProof });
        if (!r.success) throw new PasskeyError("SUBMIT_FAILED", `UserOp ${r.userOpHash} reverted on chain`);
        // dApps poll eth_getTransactionReceipt, so prefer the tx hash.
        result = r.transactionHash ?? r.userOpHash;
      } else {
        result = (await submitMessage({ ticketId: ticket.ticketId, signer: approval.signer, authProof: approval.authProof })).signature;
      }
    } catch (error: any) {
      if (error instanceof PasskeyError && RETRYABLE.has(error.code)) throw error;
      await wallet.respondSessionRequest({
        topic: pending.topic,
        response: { id: pending.id, jsonrpc: "2.0", error: { code: -32000, message: error?.message ?? "failed" } },
      });
      pendingRequests.delete(requestId);
      wcTicketByRequestId.delete(requestId);
      emitEvent({ type: "request_failed", topic: pending.topic, data: { method: pending.method, error: error?.message } });
      throw error;
    }
  } else {
    switch (pending.method) {
      case "eth_chainId":
        result = `0x${sessionConfig.chainId.toString(16)}`;
        break;
      case "eth_accounts":
        result = [sessionConfig.smartWalletAddress];
        break;
      case "wallet_switchEthereumChain":
        // Session is bound to one chain; acknowledge without switching.
        result = null;
        break;
      default:
        throw new PasskeyError("VALIDATION_ERROR", `Unsupported method: ${pending.method}`);
    }
  }

  await wallet.respondSessionRequest({
    topic: pending.topic,
    response: { id: pending.id, jsonrpc: "2.0", result },
  });
  pendingRequests.delete(requestId);
  wcTicketByRequestId.delete(requestId);
  emitEvent({ type: "request_approved", topic: pending.topic, data: { method: pending.method } });
  console.log(`✅ Request ${requestId} approved: ${pending.method}`);
  return { success: true, result };
}

/**
 * Reject a pending request — tells the DApp the user denied it
 */
export async function rejectRequest(requestId: number): Promise<void> {
  const entry = pendingRequests.get(requestId);
  if (!entry) {
    throw new Error(`No pending request with id ${requestId}`);
  }

  const { pending } = entry;
  const wallet = await getWeb3Wallet();

  await wallet.respondSessionRequest({
    topic: pending.topic,
    response: {
      id: pending.id,
      jsonrpc: "2.0",
      error: getSdkError("USER_REJECTED"),
    },
  });

  pendingRequests.delete(requestId);
  wcTicketByRequestId.delete(requestId);
  emitEvent({ type: "request_rejected", topic: pending.topic, data: { method: pending.method } });
  console.log(`❌ Request ${requestId} rejected by user: ${pending.method}`);
}

// ─── Test hooks (WalletKit needs a relay; tests inject a fake) ───────

export function __setWeb3WalletForTests(wallet: IWeb3Wallet | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test hook");
  web3wallet = wallet;
}

export function __queueRequestForTests(
  pending: Omit<PendingRequest, "createdAt" | "smartWalletAddress" | "chainId">,
  session: { account: unknown; chainId: number; rpcUrl?: string }
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test hook");
  const ref = parseAccountRef(session.account);
  const cfg: SessionConfig = { account: serialiseAccountRef(ref), smartWalletAddress: ref.address, chainId: session.chainId };
  if (session.rpcUrl) cfg.rpcUrl = session.rpcUrl;
  queuePendingRequest(
    { ...pending, chainId: session.chainId, smartWalletAddress: ref.address, createdAt: new Date().toISOString() },
    cfg
  );
}
