/**
 * Two-phase UserOperation flow for v3 (device-bound) envelopes.
 *
 * v3 envelopes require every signature to carry an `authProof` whose
 * challenge equals the user_op_hash being signed. The hash isn't known
 * until the smart-wallet has built the user op (gas estimates, paymaster
 * data, nonce). So the client can't sign upfront — hence preview/submit:
 *
 *   POST /api/transaction/preview          → { user_op_hash_hex, ticket_id }
 *     ↓ client signs hash with passkey / OIDC
 *   POST /api/transaction/submit-prepared  → { transactionHash | userOperationHash }
 *
 * Scope of this module:
 *   - Sponsored-gas Pimlico path only (no Celo custom paymaster, no
 *     ERC-20 paymaster). v3 sandbox users run on sponsored gas; the
 *     other variants can be added when v3 graduates to prod with full
 *     paymaster coverage.
 *
 * What stays unchanged:
 *   - `submitUniversalTransaction` (the one-phase legacy path) is
 *     untouched — v1 / v2 envelopes keep flowing through it.
 */

import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createPublicClient, http, getAddress } from "viem";
import {
  entryPoint07Address,
  type EntryPointVersion,
  getUserOperationHash,
} from "viem/account-abstraction";
import { CHAINS } from "./abstraction";
import { makeSigner, type SignerOptions } from "./signerFactory";
import { type AuthProof } from "./signingMode";
import { stashTicket, consumeTicket, ticketTtlMs } from "./ticketCache";

type Call =
  | {
      to: string;
      value?: string;
      data?: string;
    }
  | {
      // ABI-encoded call — what buildBridgeCalls (and any future flow
      // using a typed contract method) returns. Mutually exclusive with
      // the raw `data` form above.
      to: string;
      value?: string | bigint;
      abi: any[];
      functionName: string;
      args: any[];
    };

// What we stash between preview and submit. The userOp is the
// fully-prepared (but unsigned) UserOperation; the rest is the bundler
// connection info we need to actually submit it.
interface PreviewedTicket {
  // viem's UserOperation type is a wide union; widen here to skip the
  // generic parameter dance — we re-serialise via JSON on the wire anyway.
  preparedUserOp: Record<string, unknown>;
  chainId: number;
  rpcNodeProvider: string;
  bundlerUrl: string;
  ownerAddress: string;
  ownerEncryptedKey: string;
  kmsKeyArn?: string;
}

/**
 * Phase 1 — build the user op, return the hash and a ticket. The client
 * uses the hash as the WebAuthn challenge / OIDC nonce when collecting
 * the user's consent.
 *
 * Caller MUST be in enclave mode + supply `ownerEncryptedKey` +
 * `ownerAddress`. Local mode is unsupported for v3 — v3 envelopes by
 * definition never leave KMS unwrapped except inside the enclave.
 */
export async function previewUniversalTransaction(params: {
  chainId: number;
  rpcNodeProvider: string;
  calls: Call[];
  ownerAddress: string;
  ownerEncryptedKey: string;
  bundlerUrl: string;
  paymasterRPC: string;
}): Promise<
  | {
      success: true;
      userOpHashHex: string;
      ticketId: string;
      expiresAt: number;
      ttlMs: number;
      smartAccountAddress: string;
      chainId: number;
    }
  | { success: false; error: string }
> {
  try {
    const chain = CHAINS[params.chainId as keyof typeof CHAINS];
    if (!chain) {
      return { success: false, error: `Unsupported chain ID: ${params.chainId}` };
    }

    const kmsKeyArn = process.env.KMS_KEY_ARN;
    if (!kmsKeyArn) {
      return {
        success: false,
        error: "KMS_KEY_ARN env unset — required to build enclave signer",
      };
    }

    const publicClient = createPublicClient({
      transport: http(params.rpcNodeProvider),
      chain,
    });

    const pimlicoClient = createPimlicoClient({
      chain,
      transport: http(params.paymasterRPC),
      entryPoint: {
        address: entryPoint07Address,
        version: "0.7" as EntryPointVersion,
      },
    });

    // Build the no-key signer: address only. signMessage WILL eventually
    // get called by viem (for getStubSignature → gas estimation), but
    // Safe's stub-sig path is constant — it doesn't really call our
    // closure. If it does we'd error out cleanly here.
    const signerOpts: SignerOptions = {
      envelopeBlob: params.ownerEncryptedKey,
      kmsKeyArn,
      ownerAddress: params.ownerAddress,
      // NOTE: no authProof — preview phase doesn't sign anything for
      // real. The real signer (with authProof) is built in submit phase.
    };
    const signer = await makeSigner(signerOpts);

    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [signer],
      version: "1.4.1",
    });

    const smartAccountClient = createSmartAccountClient({
      account: smartAccount,
      chain,
      bundlerTransport: http(params.bundlerUrl),
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () =>
          (await pimlicoClient.getUserOperationGasPrice()).fast,
      },
    });

    const transactionCalls = params.calls.map((call: any) => {
      const value = call.value ? BigInt(call.value as any) : BigInt(0);
      if (call.abi && call.functionName) {
        return {
          to: getAddress(call.to),
          value,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
        };
      }
      if (call.data) {
        return {
          to: getAddress(call.to),
          value,
          data: call.data as `0x${string}`,
        };
      }
      return {
        to: getAddress(call.to),
        value,
      };
    });

    // viem v2's prepareUserOperation: builds the user op WITHOUT
    // signing. Gas estimation uses the smart account's stub signature
    // (Safe returns a constant pattern), so the no-key signer never
    // gets a real sign-message call during this step.
    const preparedUserOp: any = await (smartAccountClient as any).prepareUserOperation({
      calls: transactionCalls,
    });

    const userOpHashHex = getUserOperationHash({
      userOperation: preparedUserOp,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: "0.7",
      chainId: params.chainId,
    });

    // BigInt-aware JSON: stash the userOp as plain hex-stringified
    // BigInts so we can hash-compare on submit and pass it to viem
    // without losing precision. The submit handler will revive them.
    const serializableUserOp = bigIntToHexFields(preparedUserOp);

    const ticket: PreviewedTicket = {
      preparedUserOp: serializableUserOp,
      chainId: params.chainId,
      rpcNodeProvider: params.rpcNodeProvider,
      bundlerUrl: params.bundlerUrl,
      ownerAddress: params.ownerAddress,
      ownerEncryptedKey: params.ownerEncryptedKey,
      kmsKeyArn,
    };

    const { ticketId, expiresAt } = stashTicket(ticket);

    return {
      success: true,
      userOpHashHex,
      ticketId,
      expiresAt,
      ttlMs: ticketTtlMs(),
      smartAccountAddress: smartAccount.address,
      chainId: params.chainId,
    };
  } catch (err: any) {
    console.error("[previewUniversalTransaction] failed:", err);
    return {
      success: false,
      error: err?.message || "preview failed",
    };
  }
}

/**
 * Phase 2 — consume the ticket, sign the prepared user op with authProof,
 * submit to the bundler, wait for the receipt.
 *
 * Single-use: ticket is deleted on lookup whether or not submit succeeds.
 * Retrying after failure requires a fresh /preview call.
 */
export async function submitPreparedUniversalTransaction(params: {
  ticketId: string;
  authProof: AuthProof;
}): Promise<{
  success: boolean;
  userOperationHash?: string;
  transactionHash?: string;
  chainId?: number;
  error?: string;
}> {
  try {
    const ticket = consumeTicket<PreviewedTicket>(params.ticketId);
    if (!ticket) {
      return {
        success: false,
        error: "ticket not found or expired (TTL is 60s, single-use)",
      };
    }

    const chain = CHAINS[ticket.chainId as keyof typeof CHAINS];
    if (!chain) {
      return { success: false, error: `Unsupported chain ID: ${ticket.chainId}` };
    }

    const publicClient = createPublicClient({
      transport: http(ticket.rpcNodeProvider),
      chain,
    });

    // Build the signer WITH authProof this time. Safe's signUserOperation
    // hashes the user op and calls signer.signMessage(hash); our closure
    // forwards (hash, authProof) to parent-proxy /sign → enclave verifies
    // challenge binding → returns the signature.
    const signerOpts: SignerOptions = {
      envelopeBlob: ticket.ownerEncryptedKey,
      ownerAddress: ticket.ownerAddress,
      authProof: params.authProof,
    };
    if (ticket.kmsKeyArn) signerOpts.kmsKeyArn = ticket.kmsKeyArn;
    const signer = await makeSigner(signerOpts);

    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [signer],
      version: "1.4.1",
    });

    const bundlerClient = createSmartAccountClient({
      account: smartAccount,
      chain,
      bundlerTransport: http(ticket.bundlerUrl),
    });

    // Revive BigInts from the stashed preparedUserOp.
    const preparedUserOp = hexFieldsToBigInt(ticket.preparedUserOp);

    // Sign + submit. signUserOperation runs the enclave signing path
    // (with authProof) under the hood. sendUserOperation just submits.
    const signature = await smartAccount.signUserOperation(preparedUserOp as any);
    const userOperationHash = await (bundlerClient as any).sendUserOperation({
      ...preparedUserOp,
      signature,
    });

    // Optionally wait for receipt to surface the on-chain tx hash.
    // 30s is enough for most testnets / mainnet under normal load.
    let transactionHash: string | undefined;
    try {
      const receipt = await (bundlerClient as any).waitForUserOperationReceipt({
        hash: userOperationHash,
        timeout: 30_000,
      });
      transactionHash = receipt?.receipt?.transactionHash;
    } catch {
      // Receipt timeout isn't fatal — the userOp may still land. Return
      // the userOperationHash so the client can poll.
    }

    const out: {
      success: true;
      userOperationHash: string;
      transactionHash?: string;
      chainId: number;
    } = {
      success: true,
      userOperationHash,
      chainId: ticket.chainId,
    };
    if (transactionHash) out.transactionHash = transactionHash;
    return out;
  } catch (err: any) {
    console.error("[submitPreparedUniversalTransaction] failed:", err);
    return {
      success: false,
      error: err?.message || "submit failed",
    };
  }
}

// ─── BigInt JSON helpers ──────────────────────────────────────────────
//
// viem's UserOperation has ~8 BigInt fields (callGasLimit, nonce,
// maxFeePerGas, etc.). JSON.stringify on a BigInt throws, so before
// stashing in the ticket cache we convert each known BigInt field to
// "0x"-prefixed hex. On submit we revive them.

const BIGINT_FIELDS = [
  "callGasLimit",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "paymasterPostOpGasLimit",
  "paymasterVerificationGasLimit",
  "preVerificationGas",
  "verificationGasLimit",
] as const;

function bigIntToHexFields(obj: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of BIGINT_FIELDS) {
    if (typeof obj[k] === "bigint") {
      out[k] = "0x" + (obj[k] as bigint).toString(16);
    }
  }
  return out;
}

function hexFieldsToBigInt(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of BIGINT_FIELDS) {
    const v = obj[k];
    if (typeof v === "string" && v.startsWith("0x")) {
      out[k] = BigInt(v);
    }
  }
  return out;
}
