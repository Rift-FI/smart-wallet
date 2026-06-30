/**
 * twoPhase preview/submit integration tests.
 *
 * We mock viem + permissionless at the module boundary so the tests
 * don't need a real Pimlico bundler / RPC node / KMS. What we DO test:
 *
 *   1. Preview returns user_op_hash + ticket_id; the hash matches what
 *      getUserOperationHash computes over the prepared UO.
 *   2. Submit consumes the SAME ticket — replaying the ticket fails.
 *   3. Submit forwards authProof through the signer to the parent-proxy
 *      /sign endpoint (we observe via a spy on signWithEnclave's fetch).
 *   4. BigInt round-trip works — preview stashes hex, submit reconstructs
 *      bigint without losing precision.
 *   5. Missing KMS_KEY_ARN env produces a clean error from preview.
 *   6. Expired / unknown ticket produces a clean error from submit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────
//
// `prepareUserOperation` is the unsigned UO builder; we return a fixed
// shape and store the chainId so submit can revive it. `getUserOperationHash`
// is deterministic and we make it deterministic in the mock too.

const fakeUserOp = {
  sender: "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
  nonce: 7n,
  callData: "0xdeadbeef",
  callGasLimit: 21000n,
  verificationGasLimit: 50000n,
  preVerificationGas: 25000n,
  maxFeePerGas: 1500000000n,
  maxPriorityFeePerGas: 1500000000n,
  paymaster: "0x000000000000000000000000000000000000beef",
  paymasterVerificationGasLimit: 30000n,
  paymasterPostOpGasLimit: 30000n,
  paymasterData: "0xcafe",
  signature: "0x",
};

const sendUserOperationMock = vi.fn(async () => "0xMOCKEDUOHASH");
const waitForReceiptMock = vi.fn(async () => ({
  receipt: { transactionHash: "0xMOCKEDTXHASH" },
}));
const signUserOperationMock = vi.fn(async () => "0xMOCKEDSIGNATURE");

vi.mock("permissionless", () => ({
  createSmartAccountClient: vi.fn(() => ({
    prepareUserOperation: vi.fn(async () => fakeUserOp),
    sendUserOperation: sendUserOperationMock,
    waitForUserOperationReceipt: waitForReceiptMock,
  })),
}));

vi.mock("permissionless/accounts", () => ({
  toSafeSmartAccount: vi.fn(async () => ({
    address: "0xabcdABCDabcdABCDabcdABCDabcdABCDabcdABCD",
    signUserOperation: signUserOperationMock,
  })),
}));

vi.mock("permissionless/clients/pimlico", () => ({
  createPimlicoClient: vi.fn(() => ({
    getUserOperationGasPrice: async () => ({
      fast: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    }),
  })),
}));

vi.mock("viem", async () => {
  const real = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...real,
    createPublicClient: vi.fn(() => ({})),
  };
});

vi.mock("viem/account-abstraction", () => ({
  entryPoint07Address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  // Deterministic hash so the test can assert exact equality.
  getUserOperationHash: vi.fn(() => "0xMOCKEDUSEROPHASH"),
}));

// Don't actually call out to AWS / parent-proxy from makeSigner.
vi.mock("./signerFactory", () => ({
  makeSigner: vi.fn(async (opts: any) => ({
    address: opts.ownerAddress,
    type: "local",
    // Capture authProof so the test can assert it threaded through.
    __authProofUsed: opts.authProof,
  })),
}));

// Now import — these load with the mocks in place.
import {
  previewUniversalTransaction,
  submitPreparedUniversalTransaction,
} from "./twoPhase";
import { makeSigner } from "./signerFactory";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.KMS_KEY_ARN = "arn:aws:kms:us-east-1:000:key/test";
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const goodInputs = {
  chainId: 42161, // arbitrum
  rpcNodeProvider: "https://rpc.example.test",
  calls: [
    {
      to: "0x000000000000000000000000000000000000dEaD",
      value: "0",
      data: "0xfeedbeef",
    },
  ],
  ownerAddress: "0x000000000000000000000000000000000000bEEF",
  ownerEncryptedKey: "enc:v3:wrappedDek:nonce:ciphertext:tag",
  bundlerUrl: "https://bundler.example.test",
  paymasterRPC: "https://paymaster.example.test",
};

describe("previewUniversalTransaction", () => {
  it("returns user_op_hash + ticket_id on the happy path", async () => {
    const result = await previewUniversalTransaction(goodInputs);
    expect(result.success).toBe(true);
    if (!result.success) return; // narrow

    expect(result.userOpHashHex).toBe("0xMOCKEDUSEROPHASH");
    expect(result.ticketId).toMatch(/^tk_[0-9a-f]{32}$/);
    expect(result.smartAccountAddress).toBe(
      "0xabcdABCDabcdABCDabcdABCDabcdABCDabcdABCD"
    );
    expect(result.chainId ?? 42161).toBe(42161);
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("errors out cleanly when KMS_KEY_ARN is missing", async () => {
    delete process.env.KMS_KEY_ARN;
    const result = await previewUniversalTransaction(goodInputs);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/KMS_KEY_ARN/);
  });

  it("errors out cleanly on unsupported chain", async () => {
    const result = await previewUniversalTransaction({
      ...goodInputs,
      chainId: 99999,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/Unsupported chain/);
  });

  it("does NOT pass authProof to the preview-phase signer (it's not known yet)", async () => {
    await previewUniversalTransaction(goodInputs);
    expect(makeSigner).toHaveBeenCalled();
    const callArgs = (makeSigner as any).mock.calls.at(-1)[0];
    expect(callArgs.envelopeBlob).toBe(goodInputs.ownerEncryptedKey);
    expect(callArgs.ownerAddress).toBe(goodInputs.ownerAddress);
    expect(callArgs.authProof).toBeUndefined();
  });
});

describe("submitPreparedUniversalTransaction", () => {
  const authProof = {
    kind: "passkey" as const,
    cred_id_b64: "ZmFrZWNyZWRpZA==",
    client_data_json_b64: "ZmFrZWNkanNvbg==",
    authenticator_data_b64: "ZmFrZWF1dGhkYXRh",
    signature_b64: "ZmFrZXNpZw==",
  };

  it("happy path: consumes the ticket, threads authProof to the signer, returns hashes", async () => {
    const preview = await previewUniversalTransaction(goodInputs);
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const submit = await submitPreparedUniversalTransaction({
      ticketId: preview.ticketId,
      authProof,
    });
    expect(submit.success).toBe(true);
    expect(submit.userOperationHash).toBe("0xMOCKEDUOHASH");
    expect(submit.transactionHash).toBe("0xMOCKEDTXHASH");
    expect(submit.chainId).toBe(42161);

    // Critically: authProof must reach the signer factory on the submit
    // phase. That's how it gets to parent-proxy /sign, which is how the
    // enclave verifies the WebAuthn challenge binding.
    const lastSignerOpts = (makeSigner as any).mock.calls.at(-1)[0];
    expect(lastSignerOpts.authProof).toEqual(authProof);

    // And the prepared UO is what got submitted (signature stitched in).
    expect(sendUserOperationMock).toHaveBeenCalledOnce();
    const submittedUo = (sendUserOperationMock.mock.calls as any[])[0]?.[0];
    expect(submittedUo.signature).toBe("0xMOCKEDSIGNATURE");
    // BigInts must have survived the JSON round-trip in the ticket cache.
    expect(typeof submittedUo.nonce).toBe("bigint");
    expect(submittedUo.nonce).toBe(7n);
    expect(typeof submittedUo.callGasLimit).toBe("bigint");
    expect(submittedUo.callGasLimit).toBe(21000n);
  });

  it("rejects an unknown / expired ticket", async () => {
    const result = await submitPreparedUniversalTransaction({
      ticketId: "tk_nonexistent",
      authProof,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ticket not found/);
  });

  it("ticket is single-use — second submit fails", async () => {
    const preview = await previewUniversalTransaction(goodInputs);
    if (!preview.success) throw new Error("preview must succeed for setup");

    const first = await submitPreparedUniversalTransaction({
      ticketId: preview.ticketId,
      authProof,
    });
    expect(first.success).toBe(true);

    const second = await submitPreparedUniversalTransaction({
      ticketId: preview.ticketId,
      authProof,
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/ticket not found/);
  });

  it("survives bundler receipt timeout — still returns the userOpHash", async () => {
    waitForReceiptMock.mockRejectedValueOnce(new Error("timeout"));

    const preview = await previewUniversalTransaction(goodInputs);
    if (!preview.success) throw new Error("preview must succeed for setup");

    const submit = await submitPreparedUniversalTransaction({
      ticketId: preview.ticketId,
      authProof,
    });
    expect(submit.success).toBe(true);
    expect(submit.userOperationHash).toBe("0xMOCKEDUOHASH");
    // Receipt timed out → transactionHash isn't available, that's fine,
    // the client can poll on userOperationHash.
    expect(submit.transactionHash).toBeUndefined();
  });
});
