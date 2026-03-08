import "dotenv/config";
import { getAddress, maxUint256, parseAbi, Address } from "viem";

// Across Protocol SpokePool V3 depositV3 ABI
const SPOKE_POOL_ABI = parseAbi([
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message)"
]);

// ERC20 approve ABI
const ERC20_ABI = parseAbi([
  "function approve(address,uint256)"
]);

export interface BridgeQuoteResponse {
  spokePoolAddress: string;
  outputAmount: string;
  totalRelayFee: { pct: string; total: string };
  timestamp: string;
  fillDeadline: string;
  exclusiveRelayer: string;
  exclusivityDeadline: number;
  isAmountTooLow: boolean;
  outputToken: { address: string; symbol: string; decimals: number; chainId: number };
  inputToken: { address: string; symbol: string; decimals: number; chainId: number };
  limits: {
    minDeposit: string;
    maxDeposit: string;
    maxDepositInstant: string;
    maxDepositShortDelay: string;
  };
}

export interface BridgeParams {
  sourceChainId: number;
  destChainId: number;
  tokenAddress: string;
  amount: number;
  ownerPrivateKey: string;
  recipient?: string; // optional, defaults to smart wallet address on dest chain
  rpcUrl: string;
}

/**
 * Get a bridge quote from Across Protocol
 */
export async function getAcrossQuote(
  originChainId: number,
  destinationChainId: number,
  tokenAddress: string,
  amountInWei: string,
  recipient: string
): Promise<BridgeQuoteResponse> {
  const params = new URLSearchParams({
    token: tokenAddress,
    originChainId: originChainId.toString(),
    destinationChainId: destinationChainId.toString(),
    amount: amountInWei,
    recipient,
  });

  const response = await fetch(`https://app.across.to/api/suggested-fees?${params}`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Across API error (${response.status}): ${errorText}`);
  }

  const quote = await response.json() as BridgeQuoteResponse;

  if (quote.isAmountTooLow) {
    throw new Error(`Amount too low for bridging. Minimum deposit: ${quote.limits.minDeposit}`);
  }

  return quote;
}

/**
 * Build the transaction calls for an Across bridge deposit.
 * Returns an array of calls to execute via the smart account:
 * 1. Approve paymaster to spend tokens (for gas)
 * 2. Approve SpokePool to spend tokens (for bridge)
 * 3. Call depositV3 on SpokePool
 */
export function buildBridgeCalls(
  quote: BridgeQuoteResponse,
  depositor: string,
  recipient: string,
  inputToken: string,
  inputAmountWei: bigint,
  destChainId: number
): Array<{ to: Address; abi: any; functionName: string; args: any[]; value?: bigint }> {
  const spokePool = getAddress(quote.spokePoolAddress);
  const outputToken = getAddress(quote.outputToken.address);

  return [
    // Approve SpokePool to spend input tokens
    {
      to: getAddress(inputToken),
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spokePool, maxUint256],
    },
    // Call depositV3 on SpokePool
    {
      to: spokePool,
      abi: SPOKE_POOL_ABI,
      functionName: "depositV3",
      args: [
        getAddress(depositor),          // depositor
        getAddress(recipient),           // recipient
        getAddress(inputToken),          // inputToken
        outputToken,                     // outputToken (on destination chain)
        inputAmountWei,                  // inputAmount
        BigInt(quote.outputAmount),      // outputAmount (after fees)
        BigInt(destChainId),             // destinationChainId
        getAddress(quote.exclusiveRelayer), // exclusiveRelayer
        Number(quote.timestamp),         // quoteTimestamp
        Number(quote.fillDeadline),      // fillDeadline
        Number(quote.exclusivityDeadline), // exclusivityDeadline
        "0x",                            // message (empty)
      ],
    },
  ];
}
