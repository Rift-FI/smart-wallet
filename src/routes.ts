import { Router } from 'express';
import { HealthCheckResponse, TypedResponse } from './types';
import { submitTransaction, submitUniversalTransaction } from './abstraction';
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
      rpcUrl
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
    let bundlerUrl: string;
    let paymasterRPC: string;

    if (chainId === 8453) { // Base
      bundlerUrl = process.env.BASE_BUNDLER_URL!;
      paymasterRPC = process.env.BASE_PAYMASTER_RPC!;
    } else if (chainId === 137) { // Polygon
      bundlerUrl = process.env.POLYGON_BUNDLER_URL!;
      paymasterRPC = process.env.POLYGON_PAYMASTER_RPC!;
    } else {
      res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: Base (8453), Polygon (137)`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    if (!bundlerUrl || !paymasterRPC) {
      res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing environment variables for chain ${chainId}. Check BASE_BUNDLER_URL/BASE_PAYMASTER_RPC or POLYGON_BUNDLER_URL/POLYGON_PAYMASTER_RPC`,
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
        paymasterRPC
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
    let bundlerUrl: string;
    let paymasterRPC: string;

    if (chainId === 8453) { // Base
      bundlerUrl = process.env.BASE_BUNDLER_URL!;
      paymasterRPC = process.env.BASE_PAYMASTER_RPC!;
    } else if (chainId === 137) { // Polygon
      bundlerUrl = process.env.POLYGON_BUNDLER_URL!;
      paymasterRPC = process.env.POLYGON_PAYMASTER_RPC!;
    } else {
      res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: Base (8453), Polygon (137)`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    if (!bundlerUrl || !paymasterRPC) {
      res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing environment variables for chain ${chainId}. Check BASE_BUNDLER_URL/BASE_PAYMASTER_RPC or POLYGON_BUNDLER_URL/POLYGON_PAYMASTER_RPC`,
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
        message: `Chain ID ${chainId} is not supported. Supported chains: Base (8453), Polygon (137)`,
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
        message: `Chain ID ${chainId} is not supported. Supported chains: Base (8453), Polygon (137)`,
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
    const finalRpcUrl = rpcUrl || (chainId === 8453 ? 'https://mainnet.base.org' : 'https://polygon-rpc.com');

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
        message: `Chain ID ${chainId} is not supported. Supported chains: Base (8453), Polygon (137)`,
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