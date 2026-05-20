import { Router } from 'express';
import { HealthCheckResponse, TypedResponse } from './types';
import { submitTransaction, submitUniversalTransaction } from './abstraction';
import { prepareTransfer, prepareTransaction, submitSignedUserOp } from './relay';
import { estimateTransfer } from './estimateTransfer';
import { estimateBridge } from './estimateBridge';
import { getAcrossQuote, buildBridgeCalls } from './bridge';
import { pairAndApprove, disconnectSession, getActiveSessions, getPendingRequests, approveRequest, rejectRequest } from './walletconnect';
import { 
  RateLimiter,
  CircuitBreaker
} from './utils';
import { ethers } from 'ethers';
import { CHAINS } from './abstraction';
import { privateKeyToAccount } from "viem/accounts";
import { 
  createPublicClient, 
  http
} from "viem";
import { toSafeSmartAccount } from 'permissionless/accounts';

const router = Router();

const SUPPORTED_CHAINS_LIST = 'Ethereum (1), Base (8453), Polygon (137), Celo (42220), Arbitrum (42161), Avalanche (43114), BSC (56), Berachain (80094)';

function getChainConfig(chainId: number): { bundlerUrl: string; paymasterRPC: string; envPrefix: string } | null {
  const configs: Record<number, { envPrefix: string }> = {
    1: { envPrefix: 'ETHEREUM' },
    8453: { envPrefix: 'BASE' },
    137: { envPrefix: 'POLYGON' },
    42220: { envPrefix: 'CELO' },
    42161: { envPrefix: 'ARBITRUM' },
    43114: { envPrefix: 'AVALANCHE' },
    56: { envPrefix: 'BSC' },
    80094: { envPrefix: 'BERACHAIN' },
  };

  const config = configs[chainId];
  if (!config) return null;

  return {
    bundlerUrl: process.env[`${config.envPrefix}_BUNDLER_URL`]!,
    paymasterRPC: process.env[`${config.envPrefix}_PAYMASTER_RPC`]!,
    envPrefix: config.envPrefix,
  };
}

// Initialize rate limiter and circuit breakers for scalability
const rateLimiter = new RateLimiter(1000, 60000); // 1000 requests per minute per IP
const paymasterCircuitBreaker = new CircuitBreaker(5, 30000); // 5 failures, 30s timeout
const rpcCircuitBreaker = new CircuitBreaker(3, 60000); // 3 failures, 60s timeout

// Rate limiting middleware
const checkRateLimit = (req: any, res: any, next: any) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  
  if (!rateLimiter.isAllowed(clientIP)) {
    return res.status(429).json({
      success: false,
      error: 'Rate Limit Exceeded',
      message: 'Too many requests. Please try again later.',
      timestamp: new Date().toISOString(),
    });
  }
  
  next();
};

// Health check endpoint
router.get('/health', (_req, res: TypedResponse<HealthCheckResponse>) => {
  const healthData: HealthCheckResponse = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };

  res.json({
    success: true,
    data: healthData,
    timestamp: new Date().toISOString(),
  });
});

// ==================== UNIVERSAL TRANSFER ENDPOINT ====================

// Simple universal transfer interface
interface UniversalTransferBody {
  chainId: number;
  tokenAddress: string;
  recipient: string;
  amount: number;
  ownerPrivateKey: string;
  ownerAddress: string;
  rpcUrl: string;
  /**
   * Optional per-key markup override (bps) from the backend. When
   * present, overrides the global MARKUP_BPS env for this transfer's
   * send markup. 0 = no markup for this key.
   */
  markupBps?: number;
}

router.post('/api/transfer', checkRateLimit, async (req, res: TypedResponse<{
  transactionHash?: string;
  userOperationHash?: string;
  chainId: number;
  gasUsed?: string;
}>) => {
  try {
    const {
      chainId,
      tokenAddress,
      recipient,
      amount,
      ownerPrivateKey,
      ownerAddress,
      rpcUrl,
      markupBps
    } = req.body as UniversalTransferBody;

    // Validate required fields
    if (!chainId || !tokenAddress || !recipient || !amount || !ownerPrivateKey || !ownerAddress || !rpcUrl) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'All fields required: chainId, tokenAddress, recipient, amount, ownerPrivateKey, ownerAddress, rpcUrl',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Validate addresses
    if (!ethers.utils.isAddress(tokenAddress) || !ethers.utils.isAddress(recipient) || !ethers.utils.isAddress(ownerAddress)) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid address format',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Validate amount
    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Amount must be a positive number',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Verify owner address matches private key
    try {
      const wallet = new ethers.Wallet(ownerPrivateKey);
      if (wallet.address.toLowerCase() !== ownerAddress.toLowerCase()) {
        res.status(400).json({
          success: false,
          error: 'Authentication Error',
          message: 'Private key does not match owner address',
          timestamp: new Date().toISOString(),
        } as any);
        return;
      }
    } catch (error) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid private key format',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Get bundler and paymaster URLs based on chainId
    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    const bundlerUrl = chainConfig.bundlerUrl;
    const paymasterRPC = chainConfig.paymasterRPC;

    if (!bundlerUrl || !paymasterRPC) {
      res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing environment variables for chain ${chainId}. Check ${chainConfig.envPrefix}_BUNDLER_URL/${chainConfig.envPrefix}_PAYMASTER_RPC`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    console.log(`🚀 Processing transfer on chain ${chainId}:`, {
      tokenAddress,
      amount,
      recipient,
      ownerAddress,
      rpcUrl,
      bundlerUrl,
      paymasterRPC
    });

    // Balance check is handled within submitTransaction for smart accounts
    console.log(`💰 Balance validation will be performed during smart account transaction`);
    console.log(`⚡ Gas will be sponsored by ERC-20 paymaster using user's tokens`);

    // Execute transfer with circuit breaker
    const result = await paymasterCircuitBreaker.execute(() =>
      submitTransaction(
        chainId,
        rpcUrl,
        tokenAddress,
        amount,
        recipient,
        ownerPrivateKey,
        bundlerUrl,
        paymasterRPC,
        markupBps
      )
    );

    if (result.success) {
      res.json({
        success: true,
        data: {
          ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
          ...(result.userOperationHash ? { userOperationHash: result.userOperationHash } : {}),
          chainId
        },
        message: `Transfer completed successfully on chain ${chainId}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Transfer Failed',
        message: result.error || 'Transfer failed',
        timestamp: new Date().toISOString(),
      } as any);
    }

  } catch (error: any) {
    console.error('Universal transfer error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to process transfer',
      timestamp: new Date().toISOString(),
    } as any);
  }
});

// ==================== FEE ESTIMATION ENDPOINT ====================

/**
 * Estimate the paymaster's gas fee, denominated in the same token the user
 * is sending. Read-only — no private key required.
 *
 * Use this BEFORE calling /api/transfer to:
 *   - Show the user a "send X, gas ~Y, total Z" preview.
 *   - Hard-block submission when totalNeeded > balance (the exact failure
 *     mode that produces opaque "paymaster rejected" errors on Ethereum
 *     mainnet when the user has exactly enough for the send but not for
 *     the gas).
 */
interface EstimateFeeBody {
  chainId: number;
  tokenAddress: string;
  recipient: string;
  amount: number;
  ownerAddress: string;
  rpcUrl: string;
  /** Per-key markup override (bps) so the preview matches the charge. */
  markupBps?: number;
}

router.post('/api/estimate-fee', checkRateLimit, async (req, res) => {
  try {
    const {
      chainId,
      tokenAddress,
      recipient,
      amount,
      ownerAddress,
      rpcUrl,
      markupBps,
    } = req.body as EstimateFeeBody;

    if (!chainId || !tokenAddress || !recipient || !amount || !ownerAddress || !rpcUrl) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'All fields required: chainId, tokenAddress, recipient, amount, ownerAddress, rpcUrl',
        timestamp: new Date().toISOString(),
      });
    }
    if (!ethers.utils.isAddress(tokenAddress) || !ethers.utils.isAddress(recipient) || !ethers.utils.isAddress(ownerAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid address format',
        timestamp: new Date().toISOString(),
      });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Amount must be a positive number',
        timestamp: new Date().toISOString(),
      });
    }

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }
    if (!chainConfig.bundlerUrl || !chainConfig.paymasterRPC) {
      return res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing bundler/paymaster env for chain ${chainId} (${chainConfig.envPrefix})`,
        timestamp: new Date().toISOString(),
      });
    }

    const result = await paymasterCircuitBreaker.execute(() =>
      estimateTransfer({
        chainId,
        rpcUrl,
        tokenAddress,
        amount,
        recipient,
        ownerAddress,
        bundlerUrl: chainConfig.bundlerUrl,
        paymasterRPC: chainConfig.paymasterRPC,
        ...(markupBps !== undefined ? { markupBps } : {}),
      })
    );

    if (result.success) {
      return res.json({
        success: true,
        data: result.data,
        message: `Fee estimated for chain ${chainId}`,
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(400).json({
      success: false,
      error: 'Estimate Failed',
      message: result.error || 'Could not estimate fee',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Estimate fee error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to estimate fee',
      timestamp: new Date().toISOString(),
    });
  }
});

// ==================== UNIVERSAL TRANSACTION ENDPOINT ====================

// Universal transaction interface
interface UniversalTransactionBody {
  chainId: number;
  calls: Array<{
    to: string;
    value?: string;
    data?: string;
    abi?: any[];
    functionName?: string;
    args?: any[];
  }>;
  ownerPrivateKey: string;
  ownerAddress: string;
  rpcUrl: string;
  paymasterToken?: string; // Optional: token address to pay gas with
}

router.post('/api/transaction', checkRateLimit, async (req, res: TypedResponse<{
  transactionHash?: string;
  userOperationHash?: string;
  chainId: number;
  gasUsed?: string;
}>) => {
  try {
    const {
      chainId,
      calls,
      ownerPrivateKey,
      ownerAddress,
      rpcUrl,
      paymasterToken
    } = req.body as UniversalTransactionBody;

    // Validate required fields
    if (!chainId || !calls || !Array.isArray(calls) || calls.length === 0 || !ownerPrivateKey || !ownerAddress || !rpcUrl) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'All fields required: chainId, calls (non-empty array), ownerPrivateKey, ownerAddress, rpcUrl',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Validate owner address
    if (!ethers.utils.isAddress(ownerAddress)) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid owner address format',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Validate each call
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      
      if (!call || !call.to || !ethers.utils.isAddress(call.to)) {
        res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: `Invalid 'to' address in call ${i}`,
          timestamp: new Date().toISOString(),
        } as any);
        return;
      }

      // Validate value if provided
      if (call && call.value !== undefined) {
        try {
          BigInt(call.value);
        } catch (error) {
          res.status(400).json({
            success: false,
            error: 'Validation Error',
            message: `Invalid 'value' format in call ${i}. Must be a valid number string.`,
            timestamp: new Date().toISOString(),
          } as any);
          return;
        }
      }

      // Validate that call has either data, or abi+functionName+args, or is a simple value transfer
      const hasData = !!(call && call.data);
      const hasAbiCall = !!(call && call.abi && call.functionName);
      const hasValue = !!(call && call.value && call.value !== '0');

      if (!hasData && !hasAbiCall && !hasValue) {
        res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: `Call ${i} must have either 'data', or 'abi'+'functionName'+'args', or 'value' > 0`,
          timestamp: new Date().toISOString(),
        } as any);
        return;
      }
    }

    // Validate paymaster token if provided
    if (paymasterToken && !ethers.utils.isAddress(paymasterToken)) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid paymaster token address format',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Verify owner address matches private key
    try {
      const wallet = new ethers.Wallet(ownerPrivateKey);
      if (wallet.address.toLowerCase() !== ownerAddress.toLowerCase()) {
        res.status(400).json({
          success: false,
          error: 'Authentication Error',
          message: 'Private key does not match owner address',
          timestamp: new Date().toISOString(),
        } as any);
        return;
      }
    } catch (error) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid private key format',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Get bundler and paymaster URLs based on chainId
    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    const bundlerUrl = chainConfig.bundlerUrl;
    const paymasterRPC = chainConfig.paymasterRPC;

    if (!bundlerUrl || !paymasterRPC) {
      res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing environment variables for chain ${chainId}. Check ${chainConfig.envPrefix}_BUNDLER_URL/${chainConfig.envPrefix}_PAYMASTER_RPC`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    console.log(`🚀 Processing universal transaction on chain ${chainId}:`, {
      callsCount: calls.length,
      ownerAddress,
      rpcUrl,
      bundlerUrl,
      paymasterRPC,
      paymasterToken: paymasterToken || 'sponsored gas'
    });

    console.log(`⚡ Gas will be ${paymasterToken ? `paid with ${paymasterToken} tokens via ERC-20 paymaster` : 'sponsored by paymaster'}`);

    // Execute universal transaction with circuit breaker
    const result = await paymasterCircuitBreaker.execute(() =>
      submitUniversalTransaction(
        chainId,
        rpcUrl,
        calls,
        ownerPrivateKey,
        bundlerUrl,
        paymasterRPC,
        paymasterToken
      )
    );

    if (result.success) {
      res.json({
        success: true,
        data: {
          ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
          ...(result.userOperationHash ? { userOperationHash: result.userOperationHash } : {}),
          chainId
        },
        message: `Universal transaction completed successfully on chain ${chainId}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Transaction Failed',
        message: result.error || 'Universal transaction failed',
        timestamp: new Date().toISOString(),
      } as any);
    }

  } catch (error: any) {
    console.error('Universal transaction error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to process universal transaction',
      timestamp: new Date().toISOString(),
    } as any);
  }
});


router.post('/api/sign',  async (req, res) => {
  const {privateKey, chainId, rpcUrl} = req.body;

  try{
    const chain = CHAINS[chainId as keyof typeof CHAINS];
    if (!chain) {
      res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

     // Create clients
     const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain
    });

    // Chain validation is handled in the universal transaction function

    // Create signer from private key
    const signer = privateKeyToAccount(privateKey as `0x${string}`);
    console.log(`👤 Owner address: ${signer.address}`);
     // Create Safe smart account
     const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [signer],
      version: "1.4.1"
    });

    console.log(`🏦 Smart Account Address: ${smartAccount.address}`);


    



  }
  catch(error: any){
    console.error('Sign error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to process sign',
      timestamp: new Date().toISOString(),
    } as any);
  }
  
});

// ==================== SMART ACCOUNT ENDPOINTS ====================

// Get smart account address endpoint
router.post('/api/smart-account/address', checkRateLimit, async (req, res) => {
  try {
    const { chainId, ownerPrivateKey, rpcUrl } = req.body;

    // Validate required fields - we need private key to deterministically calculate address
    if (!chainId || !ownerPrivateKey) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'chainId and ownerPrivateKey are required',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate chain support
    const chain = CHAINS[chainId as keyof typeof CHAINS];
    if (!chain) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Validate private key format
    try {
      const wallet = new ethers.Wallet(ownerPrivateKey);
      console.log(`👤 Owner address: ${wallet.address}`);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid private key format',
        timestamp: new Date().toISOString(),
      });
    }

    // Use provided RPC URL or default
    const defaultRpcUrls: Record<number, string> = {
      1: 'https://eth.llamarpc.com',
      8453: 'https://mainnet.base.org',
      137: 'https://polygon-rpc.com',
      42220: 'https://forno.celo.org',
      42161: 'https://arb1.arbitrum.io/rpc',
      43114: 'https://api.avax.network/ext/bc/C/rpc',
      56: 'https://bsc-dataseed.binance.org',
      80094: 'https://rpc.berachain.com/',
    };
    const finalRpcUrl = rpcUrl || defaultRpcUrls[chainId] || 'https://eth.llamarpc.com';

    console.log(`🔍 Getting smart account address on chain ${chainId}`);

    // Create public client
    const publicClient = createPublicClient({
      transport: http(finalRpcUrl),
      chain
    });

    // Create signer from private key
    const signer = privateKeyToAccount(ownerPrivateKey as `0x${string}`);
    console.log(`👤 Owner address: ${signer.address}`);
    
    // Create Safe smart account to get the deterministic address
    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [signer],
      version: "1.4.1"
    });

    console.log(`🏦 Smart Account Address: ${smartAccount.address}`);

    res.json({
      success: true,
      data: {
        address: smartAccount.address,
        chainId: chainId
      },
      message: `Smart account address retrieved successfully for chain ${chainId}`,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error('Get smart account address error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to get smart account address',
      timestamp: new Date().toISOString(),
    });
  }
});

// Create smart account endpoint
router.post('/api/smart-account/create', checkRateLimit, async (req, res) => {
  try {
    const { chainId, ownerPrivateKey, rpcUrl } = req.body;

    // Validate required fields
    if (!chainId || !ownerPrivateKey || !rpcUrl) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'chainId, ownerPrivateKey, and rpcUrl are required',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate chain support
    const chain = CHAINS[chainId as keyof typeof CHAINS];
    if (!chain) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Validate private key format
    try {
      const wallet = new ethers.Wallet(ownerPrivateKey);
      console.log(`👤 Owner address: ${wallet.address}`);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid private key format',
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`🏗️ Creating smart account on chain ${chainId}`);

    // Create public client
    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain
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

    // Check if smart account is already deployed
    const accountCode = await publicClient.getBytecode({ address: smartAccount.address });
    const isDeployed = accountCode && accountCode !== '0x';
    
    console.log(`🏦 Smart account deployment status:`, {
      address: smartAccount.address,
      isDeployed,
      codeLength: accountCode?.length || 0
    });

    let transactionHash: string | undefined;

    if (!isDeployed) {
      console.log(`🚀 Smart account not deployed yet. It will be deployed on first transaction.`);
      // Note: Safe smart accounts are deployed lazily on first transaction
      // We don't need to deploy them explicitly
    } else {
      console.log(`✅ Smart account already deployed at ${smartAccount.address}`);
    }

    res.json({
      success: true,
      data: {
        address: smartAccount.address,
        chainId: chainId,
        ...(transactionHash ? { transactionHash } : {})
      },
      message: `Smart account ${isDeployed ? 'retrieved' : 'prepared for deployment'} successfully on chain ${chainId}`,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error('Create smart account error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to create smart account',
      timestamp: new Date().toISOString(),
    });
  }
});

// ==================== BRIDGE ENDPOINT ====================

interface BridgeBody {
  sourceChainId: number;
  destChainId: number;
  tokenAddress: string;
  amount: number;
  ownerPrivateKey: string;
  rpcUrl: string;
  recipient?: string; // optional, defaults to same smart wallet on dest chain
}

// ==================== BRIDGE QUOTE (read-only) ====================

/**
 * Get a real bridge quote (Across rate + paymaster gas in the token).
 * Read-only — no private key required.
 *
 * Use this BEFORE /api/bridge so the user sees the actual outputAmount
 * (net of Across LP+relayer fees) AND the gas they'll pay in the same
 * token. The existing /bridge/quote backend route previously returned
 * `inputAmount × 0.999` which silently disagreed with what /api/bridge
 * actually delivered.
 */
interface BridgeQuoteBody {
  sourceChainId: number;
  destChainId: number;
  tokenAddress: string;
  amount: number;
  ownerAddress: string;
  recipient?: string;
  rpcUrl: string;
}

router.post('/api/bridge-quote', checkRateLimit, async (req, res) => {
  try {
    const {
      sourceChainId,
      destChainId,
      tokenAddress,
      amount,
      ownerAddress,
      recipient,
      rpcUrl,
    } = req.body as BridgeQuoteBody;

    if (!sourceChainId || !destChainId || !tokenAddress || !amount || !ownerAddress || !rpcUrl) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Required: sourceChainId, destChainId, tokenAddress, amount, ownerAddress, rpcUrl',
        timestamp: new Date().toISOString(),
      });
    }
    if (!ethers.utils.isAddress(tokenAddress) || !ethers.utils.isAddress(ownerAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid address format',
        timestamp: new Date().toISOString(),
      });
    }
    if (recipient && !ethers.utils.isAddress(recipient)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid recipient address',
        timestamp: new Date().toISOString(),
      });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Amount must be a positive number',
        timestamp: new Date().toISOString(),
      });
    }

    const chainConfig = getChainConfig(sourceChainId);
    if (!chainConfig) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Source chain ${sourceChainId} not supported. ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }
    if (!chainConfig.bundlerUrl || !chainConfig.paymasterRPC) {
      return res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing bundler/paymaster env for chain ${sourceChainId} (${chainConfig.envPrefix})`,
        timestamp: new Date().toISOString(),
      });
    }

    const result = await paymasterCircuitBreaker.execute(() =>
      estimateBridge({
        sourceChainId,
        destChainId,
        tokenAddress,
        amount,
        ownerAddress,
        ...(recipient ? { recipient } : {}),
        rpcUrl,
        bundlerUrl: chainConfig.bundlerUrl,
        paymasterRPC: chainConfig.paymasterRPC,
      })
    );

    if (result.success) {
      return res.json({
        success: true,
        data: result.data,
        message: `Bridge quote ${sourceChainId} → ${destChainId}`,
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(400).json({
      success: false,
      error: 'Quote Failed',
      message: result.error || 'Could not produce bridge quote',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Bridge quote error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to produce bridge quote',
      timestamp: new Date().toISOString(),
    });
  }
});

// ==================== BRIDGE EXECUTE (signs and broadcasts) ====================

router.post('/api/bridge', checkRateLimit, async (req, res) => {
  try {
    const {
      sourceChainId,
      destChainId,
      tokenAddress,
      amount,
      ownerPrivateKey,
      rpcUrl,
      recipient: explicitRecipient
    } = req.body as BridgeBody;

    // Validate required fields
    if (!sourceChainId || !destChainId || !tokenAddress || !amount || !ownerPrivateKey || !rpcUrl) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'All fields required: sourceChainId, destChainId, tokenAddress, amount, ownerPrivateKey, rpcUrl',
        timestamp: new Date().toISOString(),
      });
    }

    if (sourceChainId === destChainId) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Source and destination chains must be different',
        timestamp: new Date().toISOString(),
      });
    }

    if (!ethers.utils.isAddress(tokenAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid token address format',
        timestamp: new Date().toISOString(),
      });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Amount must be a positive number',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate source chain support
    const sourceChain = CHAINS[sourceChainId as keyof typeof CHAINS];
    if (!sourceChain) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Source chain ID ${sourceChainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Validate private key
    try {
      new ethers.Wallet(ownerPrivateKey);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid private key format',
        timestamp: new Date().toISOString(),
      });
    }

    // Compute smart wallet address
    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain: sourceChain
    });

    const signer = privateKeyToAccount(ownerPrivateKey as `0x${string}`);
    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [signer],
      version: "1.4.1"
    });

    const smartWalletAddress = smartAccount.address;
    // Recipient defaults to same smart wallet address (deterministic across chains)
    const recipient = explicitRecipient && ethers.utils.isAddress(explicitRecipient)
      ? explicitRecipient
      : smartWalletAddress;

    console.log(`🌉 Bridge request: ${amount} of ${tokenAddress} from chain ${sourceChainId} → ${destChainId}`);
    console.log(`🏦 Smart wallet: ${smartWalletAddress}, Recipient: ${recipient}`);

    // Get token decimals
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ['function decimals() view returns (uint8)'],
      new ethers.providers.JsonRpcProvider(rpcUrl)
    );
    const decimals = await tokenContract.decimals();
    const amountInWei = ethers.utils.parseUnits(amount.toString(), decimals).toString();

    console.log(`💰 Amount in wei: ${amountInWei} (${decimals} decimals)`);

    // Get quote from Across Protocol
    console.log(`📊 Fetching Across bridge quote...`);
    const quote = await getAcrossQuote(
      sourceChainId,
      destChainId,
      tokenAddress,
      amountInWei,
      recipient
    );

    console.log(`📊 Quote received:`, {
      outputAmount: quote.outputAmount,
      outputToken: quote.outputToken.address,
      totalFee: quote.totalRelayFee.total,
      spokePool: quote.spokePoolAddress,
      fillDeadline: quote.fillDeadline,
    });

    // Build bridge calls (approve SpokePool + depositV3)
    const bridgeCalls = buildBridgeCalls(
      quote,
      smartWalletAddress,
      recipient,
      tokenAddress,
      BigInt(amountInWei),
      destChainId
    );

    // Convert to the format submitUniversalTransaction expects
    const calls = bridgeCalls.map(call => ({
      to: call.to as string,
      abi: call.abi as any[],
      functionName: call.functionName,
      args: call.args,
    }));

    // Get bundler/paymaster config for source chain
    const chainConfig = getChainConfig(sourceChainId);
    if (!chainConfig) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Source chain ID ${sourceChainId} not configured for bundler/paymaster`,
        timestamp: new Date().toISOString(),
      });
    }

    if (!chainConfig.bundlerUrl || !chainConfig.paymasterRPC) {
      return res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing ${chainConfig.envPrefix}_BUNDLER_URL or ${chainConfig.envPrefix}_PAYMASTER_RPC`,
        timestamp: new Date().toISOString(),
      });
    }

    // Execute bridge via smart account with ERC-20 paymaster (gas paid in the bridged token)
    console.log(`🚀 Executing bridge transaction via smart account...`);
    const result = await paymasterCircuitBreaker.execute(() =>
      submitUniversalTransaction(
        sourceChainId,
        rpcUrl,
        calls,
        ownerPrivateKey,
        chainConfig.bundlerUrl,
        chainConfig.paymasterRPC,
        tokenAddress // pay gas in the token being bridged
      )
    );

    if (result.success) {
      res.json({
        success: true,
        data: {
          ...(result.userOperationHash ? { userOperationHash: result.userOperationHash } : {}),
          ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
          sourceChainId,
          destChainId,
          inputToken: tokenAddress,
          outputToken: quote.outputToken.address,
          inputAmount: amount.toString(),
          outputAmount: ethers.utils.formatUnits(quote.outputAmount, quote.outputToken.decimals),
          fee: ethers.utils.formatUnits(quote.totalRelayFee.total, decimals),
          recipient,
          smartWalletAddress,
        },
        message: `Bridge initiated: ${amount} ${quote.inputToken.symbol} from chain ${sourceChainId} → ${quote.outputToken.symbol} on chain ${destChainId}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Bridge Failed',
        message: result.error || 'Bridge transaction failed',
        timestamp: new Date().toISOString(),
      });
    }

  } catch (error: any) {
    console.error('Bridge error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to process bridge',
      timestamp: new Date().toISOString(),
    });
  }
});

// ==================== WALLETCONNECT ENDPOINTS ====================

// Pair with a DApp via WalletConnect URI
router.post('/api/walletconnect/pair', checkRateLimit, async (req, res) => {
  try {
    const { uri, ownerPrivateKey, chainId, rpcUrl } = req.body;

    if (!uri || !ownerPrivateKey || !chainId) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Required fields: uri, ownerPrivateKey, chainId. Optional: rpcUrl',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate chain
    const chain = CHAINS[chainId as keyof typeof CHAINS];
    if (!chain) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Validate private key
    try {
      new ethers.Wallet(ownerPrivateKey);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid private key format',
        timestamp: new Date().toISOString(),
      });
    }

    // Resolve RPC, bundler, paymaster
    const defaultRpcUrls: Record<number, string> = {
      1: 'https://eth.llamarpc.com',
      8453: 'https://mainnet.base.org',
      137: 'https://polygon-rpc.com',
      42220: 'https://forno.celo.org',
      42161: 'https://arb1.arbitrum.io/rpc',
      43114: 'https://api.avax.network/ext/bc/C/rpc',
      56: 'https://bsc-dataseed.binance.org',
      80094: 'https://rpc.berachain.com/',
    };
    const finalRpcUrl = rpcUrl || defaultRpcUrls[chainId] || 'https://eth.llamarpc.com';

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig || !chainConfig.bundlerUrl || !chainConfig.paymasterRPC) {
      return res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing bundler/paymaster config for chain ${chainId}`,
        timestamp: new Date().toISOString(),
      });
    }

    const result = await pairAndApprove(
      uri,
      ownerPrivateKey,
      chainId,
      finalRpcUrl,
      chainConfig.bundlerUrl,
      chainConfig.paymasterRPC
    );

    res.json({
      success: true,
      data: {
        topic: result.topic,
        smartWalletAddress: result.smartWalletAddress,
        chainId,
        peerName: result.peerName,
        peerUrl: result.peerUrl,
      },
      message: `Connected to ${result.peerName}. Transactions require approval via /api/walletconnect/requests/:id/approve`,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('WalletConnect pair error:', error);
    res.status(500).json({
      success: false,
      error: 'WalletConnect Error',
      message: error?.message || 'Failed to pair with DApp',
      timestamp: new Date().toISOString(),
    });
  }
});

// List active WalletConnect sessions
router.get('/api/walletconnect/sessions', checkRateLimit, async (_req, res) => {
  try {
    const activeSessions = await getActiveSessions();
    res.json({
      success: true,
      data: { sessions: activeSessions },
      message: `${activeSessions.length} active session(s)`,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to get sessions',
      timestamp: new Date().toISOString(),
    });
  }
});

// Disconnect a WalletConnect session
router.delete('/api/walletconnect/sessions/:topic', checkRateLimit, async (req, res) => {
  try {
    const { topic } = req.params;
    await disconnectSession(topic);
    res.json({
      success: true,
      message: `Session ${topic} disconnected`,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to disconnect session',
      timestamp: new Date().toISOString(),
    });
  }
});

// Get pending WalletConnect requests awaiting approval
router.get('/api/walletconnect/requests', checkRateLimit, async (_req, res) => {
  try {
    const pending = getPendingRequests();
    res.json({
      success: true,
      data: { requests: pending },
      message: `${pending.length} pending request(s)`,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to get pending requests',
      timestamp: new Date().toISOString(),
    });
  }
});

// Approve a pending WalletConnect request
router.post('/api/walletconnect/requests/:id/approve', checkRateLimit, async (req, res) => {
  try {
    const requestId = parseInt(req.params.id, 10);
    if (isNaN(requestId)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid request ID',
        timestamp: new Date().toISOString(),
      });
    }

    const result = await approveRequest(requestId);
    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: result.error,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: { result: result.result },
      message: 'Request approved and executed',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'Failed to approve request',
      timestamp: new Date().toISOString(),
    });
  }
});

// Reject a pending WalletConnect request
router.post('/api/walletconnect/requests/:id/reject', checkRateLimit, async (req, res) => {
  try {
    const requestId = parseInt(req.params.id, 10);
    if (isNaN(requestId)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid request ID',
        timestamp: new Date().toISOString(),
      });
    }

    await rejectRequest(requestId);
    res.json({
      success: true,
      message: 'Request rejected',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(error.message?.includes('No pending request') ? 404 : 500).json({
      success: false,
      error: error.message?.includes('No pending request') ? 'Not Found' : 'Internal Server Error',
      message: error?.message || 'Failed to reject request',
      timestamp: new Date().toISOString(),
    });
  }
});

// ==================== V2 CLIENT-SIDE SIGNING ENDPOINTS ====================

// Prepare a UserOperation for client-side signing (no private key needed)
router.post('/api/v2/prepare', checkRateLimit, async (req, res) => {
  try {
    const {
      ownerAddress,
      chainId,
      rpcUrl,
      // Transfer-specific fields
      tokenAddress,
      recipient,
      amount,
      // Transaction-specific fields
      calls,
      paymasterToken,
    } = req.body;

    // Validate required fields
    if (!ownerAddress || !chainId || !rpcUrl) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Required fields: ownerAddress, chainId, rpcUrl',
        timestamp: new Date().toISOString(),
      });
    }

    if (!ethers.utils.isAddress(ownerAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid ownerAddress format',
        timestamp: new Date().toISOString(),
      });
    }

    // Get chain config
    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }

    if (!chainConfig.bundlerUrl || !chainConfig.paymasterRPC) {
      return res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing bundler/paymaster config for chain ${chainId}`,
        timestamp: new Date().toISOString(),
      });
    }

    let result;

    if (tokenAddress && recipient && amount) {
      // Simple transfer mode
      if (!ethers.utils.isAddress(tokenAddress) || !ethers.utils.isAddress(recipient)) {
        return res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: 'Invalid tokenAddress or recipient format',
          timestamp: new Date().toISOString(),
        });
      }

      console.log(`🔧 [v2] Preparing transfer on chain ${chainId}: ${amount} of ${tokenAddress} → ${recipient}`);

      result = await paymasterCircuitBreaker.execute(() =>
        prepareTransfer({
          ownerAddress,
          chainId,
          rpcUrl,
          tokenAddress,
          recipient,
          amount,
          bundlerUrl: chainConfig.bundlerUrl,
          paymasterRPC: chainConfig.paymasterRPC,
        })
      );
    } else if (calls && Array.isArray(calls) && calls.length > 0) {
      // Universal transaction mode
      for (let i = 0; i < calls.length; i++) {
        if (!calls[i]?.to || !ethers.utils.isAddress(calls[i].to)) {
          return res.status(400).json({
            success: false,
            error: 'Validation Error',
            message: `Invalid 'to' address in call ${i}`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      console.log(`🔧 [v2] Preparing transaction on chain ${chainId}: ${calls.length} calls`);

      result = await paymasterCircuitBreaker.execute(() =>
        prepareTransaction({
          ownerAddress,
          chainId,
          rpcUrl,
          calls,
          bundlerUrl: chainConfig.bundlerUrl,
          paymasterRPC: chainConfig.paymasterRPC,
          paymasterToken,
        })
      );
    } else {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Provide either (tokenAddress + recipient + amount) for a transfer, or (calls) for a transaction',
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: {
        smartAccountAddress: result.smartAccountAddress,
        userOperation: result.userOperation,
        hashToSign: result.hashToSign,
        chainId: result.chainId,
      },
      message: 'UserOperation prepared. Sign hashToSign with personal_sign and submit to /api/v2/submit',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[v2] Prepare error:', error);
    res.status(500).json({
      success: false,
      error: 'Prepare Failed',
      message: error?.message || 'Failed to prepare UserOperation',
      timestamp: new Date().toISOString(),
    });
  }
});

// Submit a client-signed UserOperation
router.post('/api/v2/submit', checkRateLimit, async (req, res) => {
  try {
    const { chainId, userOperation, signature } = req.body;

    if (!chainId || !userOperation || !signature) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Required fields: chainId, userOperation, signature',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate signature format (65 bytes = 0x + 130 hex chars)
    if (typeof signature !== 'string' || !signature.startsWith('0x') || signature.length !== 132) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Signature must be a 65-byte hex string (0x + 130 chars)',
        timestamp: new Date().toISOString(),
      });
    }

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported`,
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`📤 [v2] Submitting signed UserOp on chain ${chainId}`);

    const result = await paymasterCircuitBreaker.execute(() =>
      submitSignedUserOp({
        chainId,
        userOperation,
        signature: signature as `0x${string}`,
        bundlerUrl: chainConfig.bundlerUrl,
      })
    );

    res.json({
      success: true,
      data: {
        userOperationHash: result.userOperationHash,
        chainId,
      },
      message: `UserOperation submitted successfully on chain ${chainId}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[v2] Submit error:', error);
    res.status(500).json({
      success: false,
      error: 'Submit Failed',
      message: error?.message || 'Failed to submit UserOperation',
      timestamp: new Date().toISOString(),
    });
  }
});

// ==================== V2 BRIDGE ENDPOINT (CLIENT-SIDE SIGNING) ====================

router.post('/api/v2/bridge', checkRateLimit, async (req, res) => {
  try {
    const {
      ownerAddress,
      sourceChainId,
      destChainId,
      tokenAddress,
      amount,
      rpcUrl,
      recipient: explicitRecipient
    } = req.body;

    // Validate required fields
    if (!ownerAddress || !sourceChainId || !destChainId || !tokenAddress || !amount || !rpcUrl) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Required fields: ownerAddress, sourceChainId, destChainId, tokenAddress, amount, rpcUrl',
        timestamp: new Date().toISOString(),
      });
    }

    if (sourceChainId === destChainId) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Source and destination chains must be different',
        timestamp: new Date().toISOString(),
      });
    }

    if (!ethers.utils.isAddress(ownerAddress) || !ethers.utils.isAddress(tokenAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid address format',
        timestamp: new Date().toISOString(),
      });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Amount must be a positive number',
        timestamp: new Date().toISOString(),
      });
    }

    const sourceChain = CHAINS[sourceChainId as keyof typeof CHAINS];
    if (!sourceChain) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Source chain ID ${sourceChainId} is not supported`,
        timestamp: new Date().toISOString(),
      });
    }

    const chainConfig = getChainConfig(sourceChainId);
    if (!chainConfig || !chainConfig.bundlerUrl || !chainConfig.paymasterRPC) {
      return res.status(400).json({
        success: false,
        error: 'Configuration Error',
        message: `Chain ${sourceChainId} not configured for bundler/paymaster`,
        timestamp: new Date().toISOString(),
      });
    }

    // Compute smart wallet address from ownerAddress
    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain: sourceChain
    });

    const { toAccount } = await import('viem/accounts');
    const dummyOwner = toAccount({
      address: ownerAddress as `0x${string}`,
      async signMessage() { return "0x" + "00".repeat(31) + "01" + "00".repeat(31) + "01" + "1b" as `0x${string}`; },
      async signTransaction() { return "0x" as `0x${string}`; },
      async signTypedData() { return "0x" as `0x${string}`; },
    });

    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [dummyOwner as any],
      version: "1.4.1"
    });

    const smartWalletAddress = smartAccount.address;
    const recipient = explicitRecipient && ethers.utils.isAddress(explicitRecipient)
      ? explicitRecipient
      : smartWalletAddress;

    console.log(`🌉 [v2] Bridge prepare: ${amount} of ${tokenAddress} from chain ${sourceChainId} → ${destChainId}`);
    console.log(`🏦 [v2] Smart wallet: ${smartWalletAddress}, Recipient: ${recipient}`);

    // Get token decimals
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ['function decimals() view returns (uint8)'],
      new ethers.providers.JsonRpcProvider(rpcUrl)
    );
    const decimals = await tokenContract.decimals();
    const amountInWei = ethers.utils.parseUnits(amount.toString(), decimals).toString();

    // Get Across quote
    console.log(`📊 [v2] Fetching Across bridge quote...`);
    const quote = await getAcrossQuote(
      sourceChainId,
      destChainId,
      tokenAddress,
      amountInWei,
      recipient
    );

    console.log(`📊 [v2] Quote received: output=${quote.outputAmount}, fee=${quote.totalRelayFee.total}`);

    // Build bridge calls (approve SpokePool + depositV3)
    const bridgeCalls = buildBridgeCalls(
      quote,
      smartWalletAddress,
      recipient,
      tokenAddress,
      BigInt(amountInWei),
      destChainId
    );

    // Convert to format prepareTransaction expects
    const calls = bridgeCalls.map(call => ({
      to: call.to as string,
      abi: call.abi as any[],
      functionName: call.functionName,
      args: call.args.map((arg: any) => typeof arg === 'bigint' ? arg.toString() : arg),
    }));

    // Prepare UserOp via v2 relay (client-side signing)
    const result = await prepareTransaction({
      ownerAddress,
      chainId: sourceChainId,
      rpcUrl,
      calls,
      bundlerUrl: chainConfig.bundlerUrl,
      paymasterRPC: chainConfig.paymasterRPC,
      paymasterToken: tokenAddress, // pay gas in the token being bridged
    });

    res.json({
      success: true,
      data: {
        ...result,
        bridge: {
          sourceChainId,
          destChainId,
          inputToken: tokenAddress,
          outputToken: quote.outputToken.address,
          inputAmount: amount.toString(),
          outputAmount: ethers.utils.formatUnits(quote.outputAmount, quote.outputToken.decimals),
          fee: ethers.utils.formatUnits(quote.totalRelayFee.total, decimals),
          recipient,
          smartWalletAddress,
          estimatedFillTime: '~2-5 minutes',
        },
      },
      message: 'Bridge UserOperation prepared. Sign hashToSign with personal_sign and submit to /api/v2/submit',
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error('[v2] Bridge prepare error:', error);
    res.status(500).json({
      success: false,
      error: 'Bridge Prepare Failed',
      message: error?.message || 'Failed to prepare bridge UserOperation',
      timestamp: new Date().toISOString(),
    });
  }
});

// System status endpoint for monitoring
router.get('/api/system/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      timestamp: new Date().toISOString(),
      services: {
        paymaster: paymasterCircuitBreaker.getState(),
        rpc: rpcCircuitBreaker.getState()
      },
      rateLimiting: {
        enabled: true,
        maxRequestsPerMinute: 1000
      }
    },
    message: 'System status retrieved successfully'
  });
});

export default router;