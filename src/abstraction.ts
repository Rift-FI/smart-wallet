import "dotenv/config";
import { ethers } from "ethers";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { 
  createPublicClient, 
  http, 
 
  Address, 
  parseUnits,
  getAddress,
  maxUint256,
  parseAbi,
  
} from "viem";
import { entryPoint07Address, EntryPointVersion } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { base, polygon } from "viem/chains";

// Environment variables loaded via import "dotenv/config"

// Chain configurations
const CHAINS = {
  8453: base,
  137: polygon
};

/**
 * Submit ERC20 token transfer using Pimlico smart account with gas sponsorship
 * @param chainId - Chain ID (e.g., 8453 for Base, 137 for Polygon)
 * @param rpcNodeProvider - RPC URL for the chain
 * @param tokenAddress - ERC20 token contract address
 * @param amount - Amount to transfer (in human readable format)
 * @param recipient - Recipient address
 * @param ownerPrivateKey - Owner's private key for signing
 * @param bundlerUrl - Pimlico bundler URL
 * @param paymasterRPC - Pimlico paymaster URL
 * @returns Transaction result
 */
export const submitTransaction = async (
  chainId: number,
  rpcNodeProvider: string,
  tokenAddress: string,
  amount: number,
  recipient: string,
  ownerPrivateKey: string,
  bundlerUrl: string,
  paymasterRPC: string
): Promise<{
  success: boolean;
  transactionHash?: string;
  error?: string;
  userOperationHash?: string;
}> => {
  try {
    console.log(`🚀 Starting Pimlico smart account ERC20 transfer with gas sponsorship...`);
    console.log(`📝 Parameters:`, {
      chainId,
      tokenAddress,
      amount,
      recipient,
      rpcNodeProvider,
      bundlerUrl,
      paymasterRPC
    });

    // Get chain config
    const chain = CHAINS[chainId as keyof typeof CHAINS];
    if (!chain) {
      return {
        success: false,
        error: `Unsupported chain ID: ${chainId}`
      };
    }

    // Create clients
    const publicClient = createPublicClient({
      transport: http(rpcNodeProvider),
      chain
    });

    const pimlicoClient = createPimlicoClient({
      chain,
      transport: http(bundlerUrl),
      entryPoint: {
        address: entryPoint07Address,
        version: "0.7" as EntryPointVersion,
      },
    });

    // Create signer from private key
    const signer = privateKeyToAccount(ownerPrivateKey as `0x${string}`);
    console.log(`👤 Owner address: ${signer.address}`);

    // Create Safe smart account
    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [signer],
      version: "1.4.1"
    });

    console.log(`🏦 Smart Account Address: ${smartAccount.address}`);

    // Get token decimals from contract
    const tokenContract = new ethers.Contract(
      tokenAddress, 
      ['function decimals() view returns (uint8)'], 
      new ethers.providers.JsonRpcProvider(rpcNodeProvider)
    );
    const decimals = await tokenContract.decimals();
    const amountInWei = parseUnits(amount.toString(), decimals);

    console.log(`💰 Transfer details:`, {
      token: tokenAddress,
      amount: amount.toString(),
      amountInWei: amountInWei.toString(),
      decimals,
      recipient
    });

    // Check smart account deployment status
    const accountCode = await publicClient.getBytecode({ address: smartAccount.address });
    const isDeployed = accountCode && accountCode !== '0x';
    
    console.log(`🏦 Smart account deployment status:`, {
      address: smartAccount.address,
      isDeployed,
      codeLength: accountCode?.length || 0
    });

    // Check account balance (native token)
    const accountBalance = await publicClient.getBalance({ address: smartAccount.address });
    console.log(`🔍 Smart account details:`, {
      nativeBalance: ethers.utils.formatEther(accountBalance.toString()),
      hasCode: isDeployed
    });

    // Create smart account client with ERC-20 paymaster (users pay gas in USDC)
    const smartAccountClient = createSmartAccountClient({
      account: smartAccount,
      chain,
      bundlerTransport: http(bundlerUrl),
      paymaster: pimlicoClient, // ERC-20 Paymaster
      userOperation: {
        estimateFeesPerGas: async () => {
          return (await pimlicoClient.getUserOperationGasPrice()).fast;
        },
      },
    });

    // Check token balance first
    const senderTokenBalance = await publicClient.readContract({
      abi: parseAbi(["function balanceOf(address account) returns (uint256)"]),
      address: tokenAddress as Address,
      functionName: "balanceOf",
      args: [smartAccount.address],
    });

    console.log(`💰 Smart account token balance: ${ethers.utils.formatUnits(String(senderTokenBalance), decimals)}`);

    if (senderTokenBalance < amountInWei) {
      return {
        success: false,
        error: `Insufficient token balance. Required: ${ethers.utils.formatUnits(amountInWei.toString(), decimals)}, Available: ${ethers.utils.formatUnits(String(senderTokenBalance), decimals)}`
      };
    }

    // Get token quotes for ERC-20 paymaster
    console.log(`💰 Getting token quotes for ERC-20 paymaster...`);
    const quotes = await pimlicoClient.getTokenQuotes({
      chain,
      tokens: [tokenAddress as Address]
    });
    
    if (!quotes || quotes.length === 0) {
      return {
        success: false,
        error: `Token ${tokenAddress} not supported by ERC-20 paymaster`
      };
    }
    
    const paymaster = quotes[0]?.paymaster;
    if (!paymaster) {
      return {
        success: false,
        error: `No paymaster available for token ${tokenAddress}`
      };
    }
    console.log(`💳 Using paymaster: ${paymaster}`);

    // Send transaction with ERC-20 paymaster (user pays gas in tokens)
    console.log(`🔧 Sending UserOperation with ERC-20 paymaster (gas paid in tokens)...`);
    const userOperationHash = await smartAccountClient.sendTransaction({
      calls: [
        {
          to: getAddress(tokenAddress),
          abi: parseAbi(["function approve(address,uint256)"]),
          functionName: "approve",
          args: [paymaster, maxUint256],
        },
        {
          to: getAddress(tokenAddress),
          abi: parseAbi(["function transfer(address,uint256)"]),
          functionName: "transfer",
          args: [getAddress(recipient), amountInWei],
        }
      ],
      paymasterContext: {
        token: tokenAddress as Address,
      },
    });

    console.log(`📤 UserOperation sent. Hash: ${userOperationHash}`);
    console.log(`🎉 Transaction submitted successfully!`);
    console.log(`💳 Gas paid with ${tokenAddress} tokens via ERC-20 paymaster! 🔥`);
    console.log(`🔍 Track transaction status with UserOperation hash: ${userOperationHash}`);

    // Return success immediately after getting UserOperation hash
    return {
      success: true,
      userOperationHash
    };

  } catch (error: any) {
    console.error(`❌ Pimlico smart account transaction failed:`, {
      error: error?.message || error,
      errorType: error?.constructor?.name || "Unknown",
      stack: error?.stack
    });

    return {
      success: false,
      error: error?.message || "Unknown error during smart account transaction"
    };
  }
};
