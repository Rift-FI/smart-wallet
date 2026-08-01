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
import { createPublicClient, http, getAddress, hashTypedData, concat, concatHex, pad, toHex, type Hex } from "viem";
import {
  entryPoint07Address,
  type EntryPointVersion,
} from "viem/account-abstraction";
import { CHAINS } from "./abstraction";
import { makeSigner, type SignerOptions } from "./signerFactory";
import { type AuthProof } from "./signingMode";
import { stashTicket, consumeTicket, ticketTtlMs } from "./ticketCache";

// ─── Safe 4337 module — EIP-712 SafeOp hash ──────────────────────────
//
// Safe smart accounts don't sign the raw ERC-4337 user_op_hash. Their
// on-chain 4337 module (Safe4337Module) verifies signatures against a
// SafeOp EIP-712 typed-data hash whose domain is the module contract.
//
// This means:
//   - At submit time, permissionless's signUserOperation calls the owner
//     with signTypedData({domain: {chainId, verifyingContract: module},
//     types: SafeOp, message: safeOpFromUserOp}) — see
//     node_modules/permissionless/_cjs/accounts/safe/signUserOperation.js
//     line 162-172.
//   - Our signerFactory.signTypedData hashes that typed data and forwards
//     the resulting SafeOp EIP-712 hash to the enclave as user_op_hash_hex.
//   - The enclave verifies clientDataJSON.challenge equals that hash.
//
// So the challenge the client signs during PREVIEW must also be the
// SafeOp EIP-712 hash. If we returned the standalone ERC-4337 hash
// (getUserOperationHash from viem) instead, the client signs one hash
// but the enclave receives a different one — verification fails with
// "challenge binding failed" (surfaced upstream as "consent factor
// missing/wrong").
//
// Values below are lifted verbatim from permissionless's
// EIP712_SAFE_OPERATION_TYPE_V07 + SAFE_VERSION_TO_ADDRESSES_MAP for
// Safe 1.4.1 + EntryPoint 0.7. If either default changes upstream we
// have to bump these together.
const SAFE_4337_MODULE_ADDRESS_V07 =
  "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226" as const;

const EIP712_SAFE_OPERATION_TYPE_V07 = {
  SafeOp: [
    { type: "address", name: "safe" },
    { type: "uint256", name: "nonce" },
    { type: "bytes", name: "initCode" },
    { type: "bytes", name: "callData" },
    { type: "uint128", name: "verificationGasLimit" },
    { type: "uint128", name: "callGasLimit" },
    { type: "uint256", name: "preVerificationGas" },
    { type: "uint128", name: "maxPriorityFeePerGas" },
    { type: "uint128", name: "maxFeePerGas" },
    { type: "bytes", name: "paymasterAndData" },
    { type: "uint48", name: "validAfter" },
    { type: "uint48", name: "validUntil" },
    { type: "address", name: "entryPoint" },
  ],
} as const;

/**
 * Pack the paymaster fields of a v0.7 UserOperation into the single
 * paymasterAndData bytes field that SafeOp expects. Mirrors permissionless's
 * getPaymasterAndData helper.
 */
function packPaymasterAndData(userOp: any): Hex {
  if (!userOp.paymaster) return "0x";
  return concat([
    userOp.paymaster as Hex,
    pad(toHex(userOp.paymasterVerificationGasLimit ?? 0n), { size: 16 }),
    pad(toHex(userOp.paymasterPostOpGasLimit ?? 0n), { size: 16 }),
    (userOp.paymasterData ?? "0x") as Hex,
  ]);
}

/** Pack factory + factoryData into the initCode field. "0x" for existing accounts. */
function packInitCode(userOp: any): Hex {
  if (userOp.factory && userOp.factoryData) {
    return concatHex([userOp.factory as Hex, userOp.factoryData as Hex]);
  }
  return "0x";
}

/**
 * Compute the SafeOp EIP-712 hash for a prepared UserOperation. This is
 * the hash Safe's owner will actually sign at submit time — return it
 * from preview so the client's WebAuthn / OIDC challenge matches.
 */
function computeSafeOpHash(preparedUserOp: any, chainId: number): Hex {
  const safeOpMessage = {
    safe: preparedUserOp.sender as `0x${string}`,
    nonce: BigInt(preparedUserOp.nonce ?? 0),
    initCode: packInitCode(preparedUserOp),
    callData: (preparedUserOp.callData ?? "0x") as Hex,
    verificationGasLimit: BigInt(preparedUserOp.verificationGasLimit ?? 0),
    callGasLimit: BigInt(preparedUserOp.callGasLimit ?? 0),
    preVerificationGas: BigInt(preparedUserOp.preVerificationGas ?? 0),
    maxPriorityFeePerGas: BigInt(preparedUserOp.maxPriorityFeePerGas ?? 0),
    maxFeePerGas: BigInt(preparedUserOp.maxFeePerGas ?? 0),
    paymasterAndData: packPaymasterAndData(preparedUserOp),
    validAfter: 0,
    validUntil: 0,
    entryPoint: entryPoint07Address as `0x${string}`,
  };
  return hashTypedData({
    domain: {
      chainId,
      verifyingContract: SAFE_4337_MODULE_ADDRESS_V07,
    },
    types: EIP712_SAFE_OPERATION_TYPE_V07 as any,
    primaryType: "SafeOp",
    message: safeOpMessage as any,
  });
}

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

    // IMPORTANT: return the SafeOp EIP-712 hash, NOT the raw ERC-4337
    // hash. Safe's signUserOperation at submit time signs the SafeOp
    // hash via signTypedData, our signer forwards THAT hash to the
    // enclave, and the enclave checks the WebAuthn / OIDC challenge
    // against it. If we return getUserOperationHash here, the client
    // signs one thing and the enclave sees another — every v3 tx
    // fails with "challenge binding failed" (surfaced as "consent
    // factor missing/wrong"). See computeSafeOpHash comment at top.
    const userOpHashHex = computeSafeOpHash(preparedUserOp, params.chainId);

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
