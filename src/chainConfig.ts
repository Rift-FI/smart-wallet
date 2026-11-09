/**
 * Per-chain configuration: viem chain objects, RPC URLs and the Pimlico
 * bundler / paymaster endpoints.
 *
 * Env (per chain, PREFIX in CHAIN_ENV_PREFIX):
 *   <PREFIX>_RPC_URL        – JSON-RPC node (falls back to a public RPC)
 *   <PREFIX>_BUNDLER_URL    – Pimlico bundler
 *   <PREFIX>_PAYMASTER_RPC  – Pimlico paymaster (sponsorship + ERC-20 quotes)
 */

import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { arbitrum, avalanche, base, berachain, bsc, celo, mainnet, polygon } from "viem/chains";

export const CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  137: polygon,
  42220: celo,
  42161: arbitrum,
  43114: avalanche,
  56: bsc,
  80094: berachain,
};

export const CHAIN_ENV_PREFIX: Record<number, string> = {
  1: "ETHEREUM",
  8453: "BASE",
  137: "POLYGON",
  42220: "CELO",
  42161: "ARBITRUM",
  43114: "AVALANCHE",
  56: "BSC",
  80094: "BERACHAIN",
};

export const DEFAULT_RPC_URLS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  8453: "https://mainnet.base.org",
  137: "https://polygon-rpc.com",
  42220: "https://forno.celo.org",
  42161: "https://arb1.arbitrum.io/rpc",
  43114: "https://api.avax.network/ext/bc/C/rpc",
  56: "https://bsc-dataseed.binance.org",
  80094: "https://rpc.berachain.com/",
};

export const SUPPORTED_CHAINS_LIST =
  "Ethereum (1), Base (8453), Polygon (137), Celo (42220), Arbitrum (42161), Avalanche (43114), BSC (56), Berachain (80094)";

export function isSupportedChain(chainId: unknown): chainId is number {
  return typeof chainId === "number" && CHAINS[chainId] !== undefined;
}

export function getChain(chainId: number): Chain {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}

export function getRpcUrl(chainId: number, override?: string): string {
  if (override) return override;
  const prefix = CHAIN_ENV_PREFIX[chainId];
  const fromEnv = prefix ? process.env[`${prefix}_RPC_URL`] : undefined;
  return fromEnv || DEFAULT_RPC_URLS[chainId] || "";
}

export function getChainConfig(
  chainId: number
): { bundlerUrl: string; paymasterRPC: string; envPrefix: string } | null {
  const envPrefix = CHAIN_ENV_PREFIX[chainId];
  if (!envPrefix) return null;
  return {
    bundlerUrl: process.env[`${envPrefix}_BUNDLER_URL`] ?? "",
    paymasterRPC: process.env[`${envPrefix}_PAYMASTER_RPC`] ?? "",
    envPrefix,
  };
}

export function getPublicClient(chainId: number, rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: getChain(chainId),
    transport: http(getRpcUrl(chainId, rpcUrl)),
  }) as PublicClient;
}
