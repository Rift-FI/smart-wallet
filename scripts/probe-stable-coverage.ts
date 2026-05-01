/**
 * Probe Pimlico's ERC-20 paymaster coverage of USDC + USDT across the chains
 * we want to support: Ethereum, Base, Polygon, Arbitrum.
 * Celo is handled by our own paymaster — not probed here.
 */
import "dotenv/config";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { http, Address } from "viem";
import {
  mainnet,
  base,
  polygon,
  arbitrum,
} from "viem/chains";
import {
  entryPoint07Address,
  EntryPointVersion,
} from "viem/account-abstraction";

type ChainProbe = {
  name: string;
  chain: any;
  paymasterRpc: string | undefined;
  tokens: { symbol: string; address: Address }[];
};

const PROBES: ChainProbe[] = [
  {
    name: "Ethereum (1)",
    chain: mainnet,
    paymasterRpc: process.env.ETHEREUM_PAYMASTER_RPC,
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    ],
  },
  {
    name: "Base (8453)",
    chain: base,
    paymasterRpc: process.env.BASE_PAYMASTER_RPC,
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      { symbol: "USDT (Tether on Base)", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
    ],
  },
  {
    name: "Polygon (137)",
    chain: polygon,
    paymasterRpc: process.env.POLYGON_PAYMASTER_RPC,
    tokens: [
      { symbol: "USDC (native)", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
      { symbol: "USDC.e (bridged)", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" },
      { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
    ],
  },
  {
    name: "Arbitrum (42161)",
    chain: arbitrum,
    paymasterRpc: process.env.ARBITRUM_PAYMASTER_RPC,
    tokens: [
      { symbol: "USDC (native)", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
      { symbol: "USDC.e (bridged)", address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
    ],
  },
];

async function main() {
  for (const p of PROBES) {
    console.log(`\n=== ${p.name} ===`);
    if (!p.paymasterRpc) {
      console.log("  no PAYMASTER_RPC env var; skipping");
      continue;
    }
    const client = createPimlicoClient({
      chain: p.chain,
      transport: http(p.paymasterRpc),
      entryPoint: { address: entryPoint07Address, version: "0.7" as EntryPointVersion },
    });

    for (const t of p.tokens) {
      try {
        const quotes = await client.getTokenQuotes({
          chain: p.chain,
          tokens: [t.address],
        });
        const q = quotes?.[0];
        if (q?.paymaster) {
          console.log(`  ✅ ${t.symbol} (${t.address})  →  paymaster=${q.paymaster}`);
        } else {
          console.log(`  ❌ ${t.symbol} (${t.address})  →  empty quotes`);
        }
      } catch (e: any) {
        console.log(`  💥 ${t.symbol} (${t.address})  →  error: ${e?.message ?? e}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
