import "dotenv/config";
import { Core } from "@walletconnect/core";
import { Web3Wallet, Web3WalletTypes, IWeb3Wallet } from "@walletconnect/web3wallet";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import { ethers } from "ethers";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toSafeSmartAccount } from "permissionless/accounts";
import { CHAINS } from "./abstraction";
import { submitUniversalTransaction } from "./abstraction";
import { makeSigner } from "./signerFactory";
import type { AuthProof } from "./signingMode";

// Session store: maps WC topic → user config.
//
// Either `ownerPrivateKey` (legacy local-mode) OR
// `ownerEncryptedKey + ownerAddress` (envelope / enclave mode). The pair
// endpoint picks one when the session is established; downstream
// signing handlers use whichever is present.
//
// For v3 (device-bound) wallets, every individual dApp signing request
// must additionally carry a fresh `authProof` bound to that request's
// hash. authProof is supplied per-approve call, NOT stored on the
// session — sessions outlive any single user gesture.
interface SessionConfig {
  ownerPrivateKey?: string;
  ownerEncryptedKey?: string;
  ownerAddress: string;
  smartWalletAddress: string;
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  paymasterRPC: string;
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

const sessions = new Map<string, SessionConfig>();
const pendingRequests = new Map<number, { pending: PendingRequest; sessionConfig: SessionConfig }>();
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

  // Handle session requests (DApp sends a transaction/sign request)
  // Instead of auto-signing, queue as pending for user approval
  web3wallet.on("session_request", async (event) => {
    const { topic, params, id } = event;
    const { request } = params;

    console.log(`📥 WC session_request [${request.method}]:`, JSON.stringify(request.params).slice(0, 300));

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

    // Get peer name from active sessions
    const activeSessions = web3wallet!.getActiveSessions();
    const session = activeSessions[topic];
    const peerName = session?.peer?.metadata?.name || "Unknown DApp";

    // Queue the request for user approval
    const pending: PendingRequest = {
      id,
      topic,
      method: request.method,
      params: request.params,
      peerName,
      chainId: sessionConfig.chainId,
      smartWalletAddress: sessionConfig.smartWalletAddress,
      createdAt: new Date().toISOString(),
    };

    pendingRequests.set(id, { pending, sessionConfig });
    console.log(`⏳ Request ${id} queued for approval: ${request.method} from ${peerName}`);
    emitEvent({ type: "pending_request", topic, data: pending });
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

/**
 * Handle incoming DApp requests
 */
/**
 * Build the Safe smart account for the given session — used by the
 * personal_sign / eth_sign / eth_signTypedData handlers so that signatures
 * verify against the SMART ACCOUNT address via EIP-1271, not the underlying
 * EOA. permissionless auto-wraps in ERC-6492 if the account isn't deployed.
 */
async function getSmartAccountForSession(
  config: SessionConfig,
  authProof?: AuthProof
) {
  const chain = CHAINS[config.chainId as keyof typeof CHAINS];
  if (!chain) throw new Error(`Unsupported chain: ${config.chainId}`);
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });

  // Pick the signer based on what the session stored. In envelope mode
  // the signer routes signMessage / signTypedData through the enclave
  // via parent-proxy /sign — authProof (when supplied) is closed over so
  // every signature produced by this signer carries it. For v3 wallets,
  // authProof is mandatory and the enclave will reject if it's missing.
  let owner;
  if (config.ownerEncryptedKey && config.ownerAddress) {
    const opts: any = {
      envelopeBlob: config.ownerEncryptedKey,
      ownerAddress: config.ownerAddress,
    };
    if (process.env.KMS_KEY_ARN) opts.kmsKeyArn = process.env.KMS_KEY_ARN;
    if (authProof) opts.authProof = authProof;
    owner = await makeSigner(opts);
  } else if (config.ownerPrivateKey) {
    owner = privateKeyToAccount(config.ownerPrivateKey as `0x${string}`);
  } else {
    throw new Error(
      "session has neither ownerPrivateKey nor ownerEncryptedKey+ownerAddress"
    );
  }

  return toSafeSmartAccount({ client: publicClient, owners: [owner], version: "1.4.1" });
}

async function handleSessionRequest(
  method: string,
  params: any[],
  config: SessionConfig,
  authProof?: AuthProof
): Promise<any> {
  // Envelope-mode (v3) sessions require an authProof on every dApp
  // request — the enclave's challenge binding will reject any signature
  // it didn't see a fresh proof for.
  const envelopeMode = !!config.ownerEncryptedKey;
  if (envelopeMode && !authProof) {
    throw new Error(
      "v3 (envelope-mode) WalletConnect session requires authProof on every request approval. Pass `authProof: { kind: 'passkey' | 'oidc', ... }` to /api/walletconnect/requests/:id/approve."
    );
  }

  switch (method) {
    case "eth_sendTransaction": {
      const tx = params[0];
      console.log(`🔧 eth_sendTransaction:`, {
        to: tx.to,
        value: tx.value || "0",
        dataLength: tx.data?.length || 0,
      });

      // Route through smart account
      const calls = [{
        to: tx.to,
        value: tx.value || "0",
        data: tx.data || undefined,
      }];

      // submitUniversalTransaction's signerOptions accepts both the
      // envelope+ownerAddress+authProof bundle and the legacy plaintext
      // key, so a single call covers both modes.
      const signerOptions: any = envelopeMode
        ? {
            envelopeBlob: config.ownerEncryptedKey,
            ownerAddress: config.ownerAddress,
            authProof,
            ...(process.env.KMS_KEY_ARN ? { kmsKeyArn: process.env.KMS_KEY_ARN } : {}),
          }
        : undefined;

      const result = await submitUniversalTransaction(
        config.chainId,
        config.rpcUrl,
        calls,
        config.ownerPrivateKey ?? "",
        config.bundlerUrl,
        config.paymasterRPC,
        undefined, // paymasterToken — sponsored
        signerOptions
      );

      if (!result.success) {
        throw new Error(result.error || "Transaction failed");
      }

      return result.userOperationHash || result.transactionHash;
    }

    case "personal_sign": {
      // params: [message, address]
      const message = params[0];
      console.log(`✍️ personal_sign: ${message.slice(0, 100)}...`);
      const smartAccount = await getSmartAccountForSession(config, authProof);
      return await smartAccount.signMessage({
        message: { raw: ethers.utils.arrayify(message) as `0x${string}` },
      });
    }

    case "eth_sign": {
      // params: [address, message]
      const message = params[1];
      const smartAccount = await getSmartAccountForSession(config, authProof);
      return await smartAccount.signMessage({
        message: { raw: ethers.utils.arrayify(message) as `0x${string}` },
      });
    }

    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4": {
      // params: [address, typedData]
      const typedData = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      const { domain, types, message, primaryType } = typedData;

      // Remove EIP712Domain from types — viem/permissionless handles it
      const filteredTypes = { ...types };
      delete filteredTypes.EIP712Domain;

      const smartAccount = await getSmartAccountForSession(config, authProof);
      return await smartAccount.signTypedData({
        domain,
        types: filteredTypes,
        primaryType,
        message,
      });
    }

    case "eth_chainId": {
      return `0x${config.chainId.toString(16)}`;
    }

    case "eth_accounts": {
      return [config.smartWalletAddress];
    }

    case "wallet_switchEthereumChain": {
      // DApp wants to switch chains — we acknowledge but don't change
      // since the session is bound to a specific chain
      return null;
    }

    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

/**
 * Pair with a DApp and create a session
 */
export async function pairAndApprove(
  uri: string,
  ownerKey: { ownerPrivateKey?: string; ownerEncryptedKey?: string; ownerAddress?: string },
  chainId: number,
  rpcUrl: string,
  bundlerUrl: string,
  paymasterRPC: string
): Promise<{
  topic: string;
  smartWalletAddress: string;
  peerName: string;
  peerUrl: string;
}> {
  const wallet = await getWeb3Wallet();

  // Compute smart wallet address
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);

  const publicClient = createPublicClient({ transport: http(rpcUrl), chain });

  // Pick the signer based on what the caller supplied. Safe address
  // derivation only depends on the owner's *address*, so the no-key
  // signer (envelope mode) is sufficient here even without authProof.
  let signer: any;
  let ownerAddress: string;
  if (ownerKey.ownerEncryptedKey && ownerKey.ownerAddress) {
    signer = await makeSigner({
      envelopeBlob: ownerKey.ownerEncryptedKey,
      kmsKeyArn: process.env.KMS_KEY_ARN || "unused-for-address-derivation",
      ownerAddress: ownerKey.ownerAddress,
    });
    ownerAddress = ownerKey.ownerAddress;
  } else if (ownerKey.ownerPrivateKey) {
    signer = privateKeyToAccount(ownerKey.ownerPrivateKey as `0x${string}`);
    ownerAddress = (signer as any).address;
  } else {
    throw new Error(
      "pairAndApprove: provide either ownerPrivateKey, or ownerEncryptedKey + ownerAddress"
    );
  }

  const smartAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [signer],
    version: "1.4.1",
  });
  const smartWalletAddress = smartAccount.address;

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

  // Build approved namespaces from the proposal
  // Support all EVM chains the DApp requests
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

  // Approve the session
  const session = await wallet.approveSession({
    id: proposal.id,
    namespaces: approvedNamespaces,
  });

  // Store session config — preserve whichever key shape the caller
  // gave us so handleSessionRequest can pick the right signing path.
  // Use exact-optional spread so we only set the fields that exist —
  // exactOptionalPropertyTypes rejects `undefined` for `string?`.
  const sessionEntry: SessionConfig = {
    ownerAddress,
    smartWalletAddress,
    chainId,
    rpcUrl,
    bundlerUrl,
    paymasterRPC,
  };
  if (ownerKey.ownerPrivateKey) sessionEntry.ownerPrivateKey = ownerKey.ownerPrivateKey;
  if (ownerKey.ownerEncryptedKey) sessionEntry.ownerEncryptedKey = ownerKey.ownerEncryptedKey;
  sessions.set(session.topic, sessionEntry);

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

/**
 * Approve a pending request — executes it and responds to the DApp.
 *
 * For v3 (envelope-mode) sessions, `authProof` is REQUIRED. Each
 * dApp signing request is its own user-consent gesture, so authProof
 * is passed in per-call (not stored on the session). The enclave will
 * reject any signature whose challenge/nonce doesn't match the
 * request's hash, so the proof must be bound to THIS specific
 * request's hash (the smart-wallet computes it during prepareUserOp
 * for sendTransaction; for personal_sign it's the EIP-191 digest;
 * for eth_signTypedData it's the EIP-712 digest).
 *
 * Legacy (local-mode) sessions don't need authProof — the plaintext
 * key in sessionConfig signs locally.
 */
export async function approveRequest(
  requestId: number,
  authProof?: AuthProof
): Promise<{
  success: boolean;
  result?: any;
  error?: string;
}> {
  const entry = pendingRequests.get(requestId);
  if (!entry) {
    return { success: false, error: `No pending request with id ${requestId}` };
  }

  const { pending, sessionConfig } = entry;
  const wallet = await getWeb3Wallet();

  try {
    const result = await handleSessionRequest(
      pending.method,
      pending.params,
      sessionConfig,
      authProof
    );
    await wallet.respondSessionRequest({
      topic: pending.topic,
      response: {
        id: pending.id,
        jsonrpc: "2.0",
        result,
      },
    });
    pendingRequests.delete(requestId);
    emitEvent({ type: "request_approved", topic: pending.topic, data: { method: pending.method, result } });
    console.log(`✅ Request ${requestId} approved and executed: ${pending.method}`);
    return { success: true, result };
  } catch (error: any) {
    await wallet.respondSessionRequest({
      topic: pending.topic,
      response: {
        id: pending.id,
        jsonrpc: "2.0",
        error: { code: -32000, message: error.message },
      },
    });
    pendingRequests.delete(requestId);
    emitEvent({ type: "request_failed", topic: pending.topic, data: { method: pending.method, error: error.message } });
    console.error(`❌ Request ${requestId} approved but failed: ${error.message}`);
    return { success: false, error: error.message };
  }
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
  emitEvent({ type: "request_rejected", topic: pending.topic, data: { method: pending.method } });
  console.log(`❌ Request ${requestId} rejected by user: ${pending.method}`);
}
