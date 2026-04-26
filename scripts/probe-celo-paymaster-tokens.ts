import "dotenv/config";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { http, Address } from "viem";
import { celo } from "viem/chains";
import { entryPoint07Address, EntryPointVersion } from "viem/account-abstraction";

const CELO_TOKENS: Record<string, Address> = {
  "USDT (Tether USD)": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  "USDC (Native USDC)": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  "USDC.e (Bridged)": "0x37f750B7cC259A2f741AF45294f6a16572CF5cAd",
  "cUSD": "0x765DE816845861e75A25fCA122bb6898B8B1282a",
  "cEUR": "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73",
  "cREAL": "0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787",
};

async function main() {
  const paymasterRPC = process.env.CELO_PAYMASTER_RPC;
  if (!paymasterRPC) {
    console.error("Missing CELO_PAYMASTER_RPC");
    process.exit(1);
  }

  const client = createPimlicoClient({
    chain: celo,
    transport: http(paymasterRPC),
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7" as EntryPointVersion,
    },
  });

  console.log("Probing Pimlico Celo paymaster for supported gas tokens...\n");
  for (const [label, addr] of Object.entries(CELO_TOKENS)) {
    try {
      const quotes = await client.getTokenQuotes({
        chain: celo,
        tokens: [addr],
      });
      const q = quotes?.[0];
      if (q?.paymaster) {
        console.log(`✅ ${label} (${addr})  →  paymaster=${q.paymaster}`);
        console.log(`     postOpGas=${q.postOpGas}  exchangeRate=${q.exchangeRate}`);
      } else {
        console.log(`❌ ${label} (${addr})  →  empty quotes`);
      }
    } catch (e: any) {
      console.log(`💥 ${label} (${addr})  →  error: ${e?.message ?? e}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
