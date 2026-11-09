/**
 * Gas plan / markup construction (no chain). The fork can't run Pimlico,
 * so the token-paymaster approve + markup ordering is pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, maxUint256, parseAbi, type Address } from "viem";
import { buildGasPlan, buildMarkupCalls, parseGasSpec, singleTransferAmount } from "./gas";
import { PasskeyError } from "./errors";

// celo-paymaster.ts reads CELO_PAYMASTER_ADDRESS at import time.
vi.hoisted(() => {
  process.env.CELO_PAYMASTER_ADDRESS = "0x00000000000000000000000000000000000ce10a";
});

const ERC20 = parseAbi(["function transfer(address,uint256)", "function approve(address,uint256)"]);
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SAFE: Address = "0x5B75c3E0Ea03585dead3d9F0f414b2901f77d759";
const RECIPIENT: Address = getAddress("0x00000000000000000000000000000000000000aa");
const PAYMASTER: Address = getAddress("0x0000000000000039cd5e8ae05257ce51c473ddd1");
const RIFT: Address = getAddress("0x000000000000000000000000000000000000dead");
const PROJECT: Address = getAddress("0x00000000000000000000000000000000000000bb");

const CELO_PM: Address = getAddress("0x00000000000000000000000000000000000ce10a");
const transfer = (amount: bigint) => ({
  to: USDC,
  value: 0n,
  data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [RECIPIENT, amount] }),
});
const decode = (data: `0x${string}`) => decodeFunctionData({ abi: ERC20, data });

/** Fake public client: only `allowance` reads are needed. */
const clientWithAllowance = (allowance: bigint) => ({ readContract: async () => allowance }) as any;

const saved = { ...process.env };
beforeEach(() => {
  process.env.RIFT_MARKUP_TREASURY_ADDRESS = RIFT;
  process.env.MARKUP_BPS = "50";
  process.env.MARKUP_FLAT_FEE_TOKEN_UNITS = "100000";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("parseGasSpec", () => {
  it("defaults to sponsored and reads flat or nested markup fields", () => {
    expect(parseGasSpec(undefined)).toEqual({ mode: "sponsored", markup: {} });
    expect(parseGasSpec({ mode: "token", token: USDC, projectMarkupBps: 10 })).toEqual({
      mode: "token", token: USDC, markup: { projectMarkupBps: 10 },
    });
    expect(parseGasSpec({ mode: "token", token: USDC, markup: { markupBps: 0 } }).markup).toEqual({ markupBps: 0 });
  });
  it("rejects bad input", () => {
    expect(() => parseGasSpec({ mode: "token" })).toThrow(PasskeyError);
    expect(() => parseGasSpec({ mode: "free" })).toThrow(PasskeyError);
    expect(() => parseGasSpec({ mode: "sponsored", markupBps: -1 })).toThrow(PasskeyError);
  });
});

describe("buildMarkupCalls", () => {
  it("token-mode single transfer → Rift % + project % on the amount (old /api/transfer)", () => {
    const gas = parseGasSpec({ mode: "token", token: USDC, projectMarkupBps: 100, projectTreasuryAddress: PROJECT });
    const calls = buildMarkupCalls(gas, [transfer(10_000_000n)]);
    expect(calls.map((c) => decode(c.data).args)).toEqual([
      [RIFT, 50_000n],
      [PROJECT, 100_000n],
    ]);
  });

  it("per-key markupBps override (0 disables Rift markup)", () => {
    const gas = parseGasSpec({ mode: "token", token: USDC, markupBps: 0 });
    expect(buildMarkupCalls(gas, [transfer(10_000_000n)])).toEqual([]);
  });

  it("token-mode arbitrary calls → flat markup in the gas token (old /api/transaction)", () => {
    const gas = parseGasSpec({ mode: "token", token: USDC });
    const calls = buildMarkupCalls(gas, [{ to: RECIPIENT, value: 1n, data: "0x" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(USDC);
    expect(decode(calls[0]!.data).args).toEqual([RIFT, 100_000n]);
  });

  it("sponsored mode only charges what's explicitly asked for (old preview)", () => {
    expect(buildMarkupCalls(parseGasSpec({ mode: "sponsored" }), [transfer(1n)])).toEqual([]);
    const pct = buildMarkupCalls(
      parseGasSpec({ mode: "sponsored", transferTokenAddress: USDC, transferBaseAmountWei: "2000000" }),
      [{ to: RECIPIENT, value: 0n, data: "0x" }]
    );
    expect(pct.map((c) => decode(c.data).args)).toEqual([[RIFT, 10_000n]]);
    const flat = buildMarkupCalls(parseGasSpec({ mode: "sponsored", flatMarkupTokenAddress: USDC }), []);
    expect(flat.map((c) => decode(c.data).args)).toEqual([[RIFT, 100_000n]]);
  });

  it("no treasury configured → no markup", () => {
    delete process.env.RIFT_MARKUP_TREASURY_ADDRESS;
    expect(buildMarkupCalls(parseGasSpec({ mode: "token", token: USDC }), [transfer(5n)])).toEqual([]);
  });

  it("singleTransferAmount only matches one plain transfer of the token", () => {
    expect(singleTransferAmount([transfer(7n)], USDC)).toBe(7n);
    expect(singleTransferAmount([transfer(7n), transfer(1n)], USDC)).toBeNull();
    expect(singleTransferAmount([{ ...transfer(7n), value: 1n }], USDC)).toBeNull();
    expect(singleTransferAmount([transfer(7n)], RECIPIENT)).toBeNull();
  });
});

describe("buildGasPlan", () => {
  it("token mode: [approve(max), transfer, markups] + paymasterContext", async () => {
    const plan = await buildGasPlan({
      gas: parseGasSpec({ mode: "token", token: USDC }),
      chainId: 8453,
      client: clientWithAllowance(0n),
      safe: SAFE,
      userCalls: [transfer(1_000_000n)],
      quoteToken: async () => PAYMASTER,
    });
    expect(plan.paymasterContext).toEqual({ token: USDC });
    expect(plan.paymasterAddress).toBe(PAYMASTER);
    const decoded = plan.calls.map((c) => decode(c.data));
    expect(decoded[0]).toMatchObject({ functionName: "approve", args: [PAYMASTER, maxUint256] });
    expect(decoded[1]).toMatchObject({ functionName: "transfer", args: [RECIPIENT, 1_000_000n] });
    expect(decoded[2]).toMatchObject({ functionName: "transfer", args: [RIFT, 5_000n] });
  });

  it("token mode with depleted allowance: Tether-safe approve(0) then approve(max)", async () => {
    const plan = await buildGasPlan({
      gas: parseGasSpec({ mode: "token", token: USDC }),
      chainId: 8453,
      client: clientWithAllowance(5n),
      safe: SAFE,
      userCalls: [transfer(1n)],
      quoteToken: async () => PAYMASTER,
    });
    expect(plan.calls.slice(0, 2).map((c) => decode(c.data).args)).toEqual([[PAYMASTER, 0n], [PAYMASTER, maxUint256]]);
  });

  it("token mode with ample allowance skips approve", async () => {
    const plan = await buildGasPlan({
      gas: parseGasSpec({ mode: "token", token: USDC }),
      chainId: 8453,
      client: clientWithAllowance(maxUint256),
      safe: SAFE,
      userCalls: [transfer(1n)],
      quoteToken: async () => PAYMASTER,
    });
    expect(decode(plan.calls[0]!.data).functionName).toBe("transfer");
  });

  it("Celo token mode uses Rift's Erc20Paymaster and rejects unsupported tokens", async () => {
    const celoUsdc: Address = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
    const plan = await buildGasPlan({
      gas: parseGasSpec({ mode: "token", token: celoUsdc }),
      chainId: 42220,
      client: clientWithAllowance(0n),
      safe: SAFE,
      userCalls: [{ to: celoUsdc, value: 0n, data: "0x" }],
      quoteToken: async () => {
        throw new Error("Pimlico must not be asked on Celo");
      },
    });
    expect(plan.celoPaymaster).toBe(true);
    expect(plan.paymasterAddress).toBe(CELO_PM);
    expect(decode(plan.calls[0]!.data).args).toEqual([CELO_PM, maxUint256]);
    await expect(
      buildGasPlan({
        gas: parseGasSpec({ mode: "token", token: USDC }),
        chainId: 42220,
        client: clientWithAllowance(0n),
        safe: SAFE,
        userCalls: [transfer(1n)],
        quoteToken: async () => null,
      })
    ).rejects.toThrow(/not supported by Celo paymaster/);
  });

  it("sponsored mode adds no approve and no paymasterContext", async () => {
    const plan = await buildGasPlan({
      gas: parseGasSpec({ mode: "sponsored" }),
      chainId: 8453,
      client: clientWithAllowance(0n),
      safe: SAFE,
      userCalls: [transfer(1n)],
      quoteToken: async () => {
        throw new Error("no quote in sponsored mode");
      },
    });
    expect(plan.calls).toHaveLength(1);
    expect(plan.paymasterContext).toBeUndefined();
  });
});
