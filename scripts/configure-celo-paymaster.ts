/**
 * Enable USDC and USDT as supported gas tokens on the deployed Celo Erc20Paymaster.
 *
 * Reads:
 *   CELO_PAYMASTER_ADDRESS    — the deployed paymaster contract on Celo
 *   CELO_PAYMASTER_OWNER_KEY  — the owner's private key
 *   CELO_RPC_URL              — Celo RPC (defaults to forno)
 *
 * No price config needed — the new contract takes pricePerNative from
 * each UserOp's signed paymasterData, so prices are always fresh from the
 * backend's Coingecko fetch.
 *
 * Run:
 *   npx ts-node --transpile-only scripts/configure-celo-paymaster.ts
 */
import "dotenv/config";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  Address,
  Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO_TOKENS } from "../src/celo-paymaster";

const PAYMASTER_ABI = parseAbi([
  "function setSupportedToken(address token, bool supported) external",
  "function supportedTokens(address) view returns (bool)",
  "function owner() view returns (address)",
]);

async function main() {
  const paymaster = (process.env.CELO_PAYMASTER_ADDRESS || "") as Address;
  const ownerKey = (process.env.CELO_PAYMASTER_OWNER_KEY || "") as Hex;
  const rpcUrl = process.env.CELO_RPC_URL || "https://forno.celo.org";

  if (!paymaster) throw new Error("CELO_PAYMASTER_ADDRESS not set in .env");
  if (!ownerKey) throw new Error("CELO_PAYMASTER_OWNER_KEY not set in .env");

  const account = privateKeyToAccount(ownerKey);
  const publicClient = createPublicClient({ chain: celo, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: celo, transport: http(rpcUrl) });

  const onChainOwner = await publicClient.readContract({
    address: paymaster,
    abi: PAYMASTER_ABI,
    functionName: "owner",
  });
  if (String(onChainOwner).toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `Owner mismatch. Contract owner=${onChainOwner}, signer=${account.address}.`
    );
  }

  // Track the highest receipt block so the final readback hits an RPC node
  // that has at least that block — Forno is load-balanced and individual
  // nodes can lag a couple of blocks behind, causing stale reads.
  let lastBlock: bigint | undefined;

  for (const [symbol, t] of Object.entries(CELO_TOKENS)) {
    const already = await publicClient.readContract({
      address: paymaster,
      abi: PAYMASTER_ABI,
      functionName: "supportedTokens",
      args: [t.address],
    });
    if (already) {
      console.log(`✓ ${symbol} (${t.address}) already supported, skipping`);
      continue;
    }

    console.log(`Enabling ${symbol} at ${t.address}...`);
    const txHash = await walletClient.writeContract({
      address: paymaster,
      abi: PAYMASTER_ABI,
      functionName: "setSupportedToken",
      args: [t.address, true],
    });
    console.log(`  tx: ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`${symbol} setSupportedToken failed`);
    console.log(`  ✅ ${symbol} enabled (block ${receipt.blockNumber})`);
    if (lastBlock === undefined || receipt.blockNumber > lastBlock) {
      lastBlock = receipt.blockNumber;
    }
  }

  console.log("\nFinal on-chain state:");
  for (const [symbol, t] of Object.entries(CELO_TOKENS)) {
    const supported = await publicClient.readContract({
      address: paymaster,
      abi: PAYMASTER_ABI,
      functionName: "supportedTokens",
      args: [t.address],
      ...(lastBlock !== undefined ? { blockNumber: lastBlock } : {}),
    });
    console.log(`  ${symbol} (${t.address}): supported=${supported}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
