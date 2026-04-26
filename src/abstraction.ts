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
import { base, polygon, celo, mainnet, arbitrum, avalanche, bsc, berachain } from "viem/chains";
import {
  isCeloChain,
  isCeloSupportedToken,
  createCeloPaymasterMiddleware,
  getCeloPaymasterAddress,
  buildCeloPaymasterApprovalCall,
} from "./celo-paymaster";

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
  80094: berachain
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

    // Celo builds its own client below (uses our custom paymaster middleware).
    const smartAccountClient = isCeloChain(chainId)
      ? null
      : createSmartAccountClient({
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

    // Build and send UserOperation
    console.log(`🔧 Sending UserOperation with ERC-20 paymaster (gas paid in tokens)...`);
    let userOperationHash: string;

    if (isCeloChain(chainId)) {
      // ── Celo: use custom paymaster + Pimlico bundler ──
      if (!isCeloSupportedToken(tokenAddress)) {
        return {
          success: false,
          error: `Token ${tokenAddress} not supported by Celo paymaster. Supported: USDC, USDT`,
        };
      }

      const celoPaymaster = createCeloPaymasterMiddleware(tokenAddress as Address);
      const paymasterAddress = getCeloPaymasterAddress();
      console.log(`💳 Using Celo custom paymaster: ${paymasterAddress}`);
      console.log(`📡 Using Pimlico bundler for Celo: ${bundlerUrl}`);

      const celoSmartAccountClient = createSmartAccountClient({
        account: smartAccount,
        chain,
        bundlerTransport: http(bundlerUrl),
        paymaster: celoPaymaster,
        userOperation: {
          estimateFeesPerGas: async () => {
            return (await pimlicoClient.getUserOperationGasPrice()).fast;
          },
        },
      });

      userOperationHash = await celoSmartAccountClient.sendTransaction({
        calls: [
          {
            to: getAddress(tokenAddress),
            abi: parseAbi(["function approve(address,uint256)"]),
            functionName: "approve",
            args: [paymasterAddress, maxUint256],
          },
          {
            to: getAddress(tokenAddress),
            abi: parseAbi(["function transfer(address,uint256)"]),
            functionName: "transfer",
            args: [getAddress(recipient), amountInWei],
          },
        ],
      });
    } else {
      // ── Other chains: use Pimlico paymaster ──
      console.log(`💰 Getting token quotes for ERC-20 paymaster...`);
      const quotes = await pimlicoClient.getTokenQuotes({
        chain,
        tokens: [tokenAddress as Address],
      });

      if (!quotes || quotes.length === 0) {
        return {
          success: false,
          error: `Token ${tokenAddress} not supported by ERC-20 paymaster`,
        };
      }

      const paymaster = quotes[0]?.paymaster;
      if (!paymaster) {
        return {
          success: false,
          error: `No paymaster available for token ${tokenAddress}`,
        };
      }
      console.log(`💳 Using paymaster: ${paymaster}`);

      userOperationHash = await smartAccountClient!.sendTransaction({
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
          },
        ],
        paymasterContext: {
          token: tokenAddress as Address,
        },
      });
    }

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

    let userOperationHash: string;

    if (isCeloChain(chainId) && paymasterToken) {
      // ── Celo with ERC-20 paymaster: use custom paymaster + Pimlico bundler ──
      if (!isCeloSupportedToken(paymasterToken)) {
        return {
          success: false,
          error: `Token ${paymasterToken} not supported by Celo paymaster. Supported: USDC, USDT`,
        };
      }

      const celoPaymaster = createCeloPaymasterMiddleware(paymasterToken as Address);
      const paymasterAddress = getCeloPaymasterAddress();
      console.log(`💳 Using Celo custom paymaster: ${paymasterAddress}`);
      console.log(`📡 Using Pimlico bundler for Celo: ${bundlerUrl}`);

      transactionCalls.unshift(buildCeloPaymasterApprovalCall(paymasterToken as Address));

      smartAccountClient = createSmartAccountClient({
        account: smartAccount,
        chain,
        bundlerTransport: http(bundlerUrl),
        paymaster: celoPaymaster,
        userOperation: {
          estimateFeesPerGas: async () => {
            return (await pimlicoClient!.getUserOperationGasPrice()).fast;
          },
        },
      });

      console.log(`🔧 Sending UserOperation with Celo custom paymaster...`);
      userOperationHash = await smartAccountClient.sendTransaction({
        calls: transactionCalls,
      });
    } else {
      // ── Other chains: use Pimlico ──
      if (paymasterToken) {
        console.log(`💰 Getting token quotes for ERC-20 paymaster with token: ${paymasterToken}...`);

        const quotes = await pimlicoClient!.getTokenQuotes({
          chain,
          tokens: [paymasterToken as Address],
        });

        if (!quotes || quotes.length === 0) {
          return {
            success: false,
            error: `Token ${paymasterToken} not supported by ERC-20 paymaster`,
          };
        }

        const paymaster = quotes[0]?.paymaster;
        if (!paymaster) {
          return {
            success: false,
            error: `No paymaster available for token ${paymasterToken}`,
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
        console.log(`💳 Using sponsored gas paymaster`);
      }

      smartAccountClient = createSmartAccountClient({
        account: smartAccount,
        chain,
        bundlerTransport: http(bundlerUrl),
        paymaster: pimlicoClient!,
        userOperation: {
          estimateFeesPerGas: async () => {
            return (await pimlicoClient!.getUserOperationGasPrice()).fast;
          },
        },
      });

      console.log(`🔧 Sending UserOperation with ${paymasterToken ? 'ERC-20' : 'sponsored'} paymaster...`);
      userOperationHash = await smartAccountClient.sendTransaction({
        calls: transactionCalls,
        ...(paymasterToken ? { paymasterContext } : {}),
      });
    }

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
