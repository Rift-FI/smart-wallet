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
import { base, polygon, celo, mainnet, arbitrum, avalanche, bsc, berachain, lisk } from "viem/chains";

// Environment variables loaded via import "dotenv/config"

// Chain configurations
export const CHAINS = {
  1: mainnet,
  8453: base,
  137: polygon,
  42220: celo,
  42161: arbitrum,
  43114: avalanche,
  56: bsc,
  80094: berachain,
  1135: lisk
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
      transport: http(paymasterRPC),
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

/**
 * Submit any transaction using Pimlico smart account with gas sponsorship
 * @param chainId - Chain ID (e.g., 8453 for Base, 137 for Polygon)
 * @param rpcNodeProvider - RPC URL for the chain
 * @param calls - Array of transaction calls to execute
 * @param ownerPrivateKey - Owner's private key for signing
 * @param bundlerUrl - Pimlico bundler URL
 * @param paymasterRPC - Pimlico paymaster URL
 * @param paymasterToken - Token address to pay gas with (optional, uses ETH if not provided)
 * @returns Transaction result
 */
export const submitUniversalTransaction = async (
  chainId: number,
  rpcNodeProvider: string,
  calls: Array<{
    to: string;
    value?: string;
    data?: string;
    abi?: any[];
    functionName?: string;
    args?: any[];
  }>,
  ownerPrivateKey: string,
  bundlerUrl: string,
  paymasterRPC: string,
  paymasterToken?: string
): Promise<{
  success: boolean;
  transactionHash?: string;
  error?: string;
  userOperationHash?: string;
}> => {
  try {
    console.log(`🚀 Starting Pimlico smart account universal transaction with gas sponsorship...`);
    console.log(`📝 Parameters:`, {
      chainId,
      calls: calls.map(call => ({
        to: call.to,
        value: call.value || '0',
        functionName: call.functionName || 'raw',
        hasData: !!call.data
      })),
      rpcNodeProvider,
      bundlerUrl,
      paymasterRPC,
      paymasterToken
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
      transport: http(paymasterRPC),
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

    // Prepare transaction calls
    const transactionCalls = calls.map(call => {
      if (call.abi && call.functionName && call.args) {
        // ABI-based call
        return {
          to: getAddress(call.to),
          value: call.value ? BigInt(call.value) : BigInt(0),
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
        };
      } else if (call.data) {
        // Raw data call
        return {
          to: getAddress(call.to),
          value: call.value ? BigInt(call.value) : BigInt(0),
          data: call.data as `0x${string}`,
        };
      } else {
        // Simple value transfer
        return {
          to: getAddress(call.to),
          value: call.value ? BigInt(call.value) : BigInt(0),
        };
      }
    });

    console.log(`🔧 Prepared ${transactionCalls.length} transaction calls`);

    // Create smart account client
    let smartAccountClient;
    let paymasterContext = {};

    if (paymasterToken) {
      // ERC-20 paymaster (user pays gas in tokens)
      console.log(`💰 Getting token quotes for ERC-20 paymaster with token: ${paymasterToken}...`);
      
      const quotes = await pimlicoClient.getTokenQuotes({
        chain,
        tokens: [paymasterToken as Address]
      });
      
      if (!quotes || quotes.length === 0) {
        return {
          success: false,
          error: `Token ${paymasterToken} not supported by ERC-20 paymaster`
        };
      }
      
      const paymaster = quotes[0]?.paymaster;
      if (!paymaster) {
        return {
          success: false,
          error: `No paymaster available for token ${paymasterToken}`
        };
      }
      
      console.log(`💳 Using ERC-20 paymaster: ${paymaster}`);
      paymasterContext = { token: paymasterToken as Address };

      // Add token approval call if using ERC-20 paymaster
      transactionCalls.unshift({
        to: getAddress(paymasterToken),
        value: BigInt(0),
        abi: parseAbi(["function approve(address,uint256)"]) as any,
        functionName: "approve",
        args: [paymaster, maxUint256],
      });
    } else {
      // Regular paymaster (sponsored gas)
      console.log(`💳 Using sponsored gas paymaster`);
    }

    smartAccountClient = createSmartAccountClient({
      account: smartAccount,
      chain,
      bundlerTransport: http(bundlerUrl),
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => {
          return (await pimlicoClient.getUserOperationGasPrice()).fast;
        },
      },
    });

    // Send transaction
    console.log(`🔧 Sending UserOperation with ${paymasterToken ? 'ERC-20' : 'sponsored'} paymaster...`);
    const userOperationHash = await smartAccountClient.sendTransaction({
      calls: transactionCalls,
      ...(paymasterToken ? { paymasterContext } : {})
    });

    console.log(`📤 UserOperation sent. Hash: ${userOperationHash}`);
    console.log(`🎉 Universal transaction submitted successfully!`);
    console.log(`💳 Gas paid with ${paymasterToken ? `${paymasterToken} tokens via ERC-20 paymaster` : 'sponsored gas'} 🔥`);
    console.log(`🔍 Track transaction status with UserOperation hash: ${userOperationHash}`);

    // Return success immediately after getting UserOperation hash
    return {
      success: true,
      userOperationHash
    };

  } catch (error: any) {
    console.error(`❌ Pimlico universal transaction failed:`, {
      error: error?.message || error,
      errorType: error?.constructor?.name || "Unknown",
      stack: error?.stack
    });

    return {
      success: false,
      error: error?.message || "Unknown error during universal transaction"
    };
  }
};
