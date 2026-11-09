/**
 * Test-only helpers for the anvil Base fork (ANVIL_RPC_URL, default
 * http://127.0.0.1:8546). Integration suites call `forkAvailable()` and
 * skip (not fail) when anvil isn't reachable.
 */

import {
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";

export const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL || "http://127.0.0.1:8546";
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_WETH: Address = "0x4200000000000000000000000000000000000006";

export async function forkAvailable(): Promise<boolean> {
  try {
    const res = await fetch(ANVIL_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2000),
    });
    const json = (await res.json()) as { result?: string };
    return json.result === "0x2105";
  } catch {
    return false;
  }
}

/** Point the service at the fork and switch the relay to handleOps. */
export function useForkEnv(): void {
  process.env.BASE_RPC_URL = ANVIL_RPC_URL;
  process.env.RELAY_MODE = "direct";
  process.env.NODE_ENV = "test";
}

export function forkClients(): { publicClient: PublicClient; testClient: ReturnType<typeof createTestClient> } {
  return {
    publicClient: createPublicClient({ chain: base, transport: http(ANVIL_RPC_URL) }) as PublicClient,
    testClient: createTestClient({ chain: base, mode: "anvil", transport: http(ANVIL_RPC_URL) }),
  };
}

/** Base USDC (FiatTokenV2_2): balances live in mapping slot 9. */
export async function setUsdcBalance(testClient: ReturnType<typeof createTestClient>, who: Address, amount: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
  await testClient.setStorageAt({ address: BASE_USDC, index: slot, value: toHex(amount, { size: 32 }) });
}

export async function erc20Balance(client: PublicClient, token: Address, who: Address): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

export function randomAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return toHex(bytes) as Address;
}
