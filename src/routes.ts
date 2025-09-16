import { Router } from 'express';
import { HealthCheckResponse, TypedResponse } from './types';
import { submitTransaction } from './abstraction';
import { 
  RateLimiter,
  CircuitBreaker
} from './utils';
import { ethers } from 'ethers';

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