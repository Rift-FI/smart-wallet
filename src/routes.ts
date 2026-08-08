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
import { resolveOwnerKey } from './middleware/resolveOwnerKey';
import { ethers } from 'ethers';
import { CHAINS } from './abstraction';
import { privateKeyToAccount } from "viem/accounts";
import { 
  createPublicClient, 
  http
} from "viem";
import { toSafeSmartAccount } from 'permissionless/accounts';

const router = Router();

// Resolves the EOA key from EITHER `ownerPrivateKey` (legacy: backend
// posts plaintext over HTTPS) OR `ownerEncryptedKey` (Phase 0.5: backend
// posts the envelope blob, this middleware KMS-decrypts it in-process).
// Routes downstream all read `ownerPrivateKey` regardless, so they don't
// know which path the caller used.
router.use(resolveOwnerKey);

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
  /** Project's own markup bps — paid to the project's own treasury. */
  projectMarkupBps?: number;
  /** Project's treasury address (required when projectMarkupBps > 0). */
  projectTreasuryAddress?: string;
  /**
   * Optional project id for multi-tenant enclave routing. When set
   * and the backend has a ProjectEnclaveConfig row for this project,
   * signing goes to the integrator's own parent-proxy + KMS instead
   * of Rift's centralized defaults. Null / omitted → env defaults.
   */
  projectId?: string;
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
      markupBps,
      projectMarkupBps,
      projectTreasuryAddress,
      projectId,
    } = req.body as UniversalTransferBody;

    // Multi-tenant enclave routing: resolve THIS project's config
    // (parent-proxy URL/bearer + KMS ARN + per-chain bundler+rpc+
    // paymaster). Returns null when the project has no override,
    // in which case every subsequent line falls back to env defaults
    // exactly like the single-tenant Rift-hosted flow.
    const { resolveChainConfig, resolveEnclaveConfig } = await import(
      "./enclaveConfigClient"
    );
    const enclaveConfig = projectId
      ? await resolveEnclaveConfig(projectId)
      : null;
    const chainOverride = projectId
      ? await resolveChainConfig(projectId, chainId)
      : null;

    // Key material requirements depend on signing mode:
    //   local mode  → `ownerPrivateKey` must be present
    //   enclave mode → `ownerEncryptedKey` (in body) + `ownerAddress` are enough
    const inEnclaveMode = (process.env.SIGNING_MODE || "").trim().toLowerCase() === "enclave";
    const hasEnvelope = typeof (req.body as any).ownerEncryptedKey === "string"
      && (req.body as any).ownerEncryptedKey.length > 0;
    const keyMaterialOk = inEnclaveMode
      ? (hasEnvelope && !!ownerAddress)
      : !!ownerPrivateKey;

    if (!chainId || !tokenAddress || !recipient || !amount || !keyMaterialOk || !ownerAddress || !rpcUrl) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: inEnclaveMode
          ? 'All fields required: chainId, tokenAddress, recipient, amount, ownerEncryptedKey, ownerAddress, rpcUrl'
          : 'All fields required: chainId, tokenAddress, recipient, amount, ownerPrivateKey, ownerAddress, rpcUrl',
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

    // Verify owner address matches private key — local mode only. In
    // enclave mode the plaintext key never enters this process so
    // there's nothing to verify against; `ownerAddress` is taken on
    // trust (parent-proxy /sign produces a signature recoverable to
    // that address, or fails).
    if (!inEnclaveMode) {
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

    // Prefer per-project chain routing when the project has an
    // override row; fall back to env-based Rift-hosted defaults
    // otherwise. Same shape either way.
    const bundlerUrl = chainOverride?.bundlerUrl ?? chainConfig.bundlerUrl;
    const paymasterRPC =
      chainOverride?.paymasterUrl ?? chainConfig.paymasterRPC;

    if (!bundlerUrl || !paymasterRPC) {
      res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing environment variables for chain ${chainId}. Check ${chainConfig.envPrefix}_BUNDLER_URL/${chainConfig.envPrefix}_PAYMASTER_RPC (or per-project chain config for project ${projectId ?? "n/a"}).`,
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

    // Execute transfer with circuit breaker.
    // Phase 1: pass through the envelope blob + KMS ARN + ownerAddress
    // so makeSigner can route to the enclave's no-key path (plaintext
    // never enters this Node process when SIGNING_MODE=enclave).
    const transferSignerOpts: {
      envelopeBlob?: string;
      kmsKeyArn?: string;
      ownerAddress?: string;
      password?: string;
      authProof?: import("./signingMode").AuthProof;
      route?: { parentProxyUrl: string; parentProxyBearer: string } | null;
    } = {};
    const transferBlob = (req.body as any).ownerEncryptedKey;
    if (typeof transferBlob === "string") transferSignerOpts.envelopeBlob = transferBlob;
    // KMS ARN precedence: per-project config > env. So an integrator
    // hosting their own KMS in their own AWS account decrypts their
    // users' DEKs against THEIR key, not Rift's.
    if (enclaveConfig?.kmsKeyArn) {
      transferSignerOpts.kmsKeyArn = enclaveConfig.kmsKeyArn;
    } else if (process.env.KMS_KEY_ARN) {
      transferSignerOpts.kmsKeyArn = process.env.KMS_KEY_ARN;
    }
    // Parent-proxy route override: when the project has their own
    // Nitro Enclave stack, every sign call goes there with their
    // bearer instead of Rift's centralized proxy.
    if (enclaveConfig) {
      transferSignerOpts.route = {
        parentProxyUrl: enclaveConfig.parentProxyUrl,
        parentProxyBearer: enclaveConfig.parentProxyBearer,
      };
    }
    transferSignerOpts.ownerAddress = ownerAddress;
    // v2 password (non-custodial). Required if the envelope is v2.
    const transferPassword = (req.body as any).password;
    if (typeof transferPassword === "string" && transferPassword.length > 0) {
      transferSignerOpts.password = transferPassword;
    }
    // v3 authProof (device-bound). Required if the envelope is v3.
    const transferAuthProof = (req.body as any).authProof;
    if (transferAuthProof && typeof transferAuthProof === "object") {
      transferSignerOpts.authProof = transferAuthProof;
    }
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
        markupBps,
        projectMarkupBps,
        projectTreasuryAddress,
        transferSignerOpts
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
  /** Project's own markup bps — so the preview matches what's charged. */
  projectMarkupBps?: number;
  /** Project's treasury address (required when projectMarkupBps > 0). */
  projectTreasuryAddress?: string;
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
      projectMarkupBps,
      projectTreasuryAddress,
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
        ...(projectMarkupBps !== undefined ? { projectMarkupBps } : {}),
        ...(projectTreasuryAddress !== undefined
          ? { projectTreasuryAddress }
          : {}),
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

    // Key material requirements depend on signing mode:
    //   local mode  → `ownerPrivateKey` must be present
    //   enclave mode → `ownerEncryptedKey` (in body) + `ownerAddress` are enough
    const inEnclaveMode = (process.env.SIGNING_MODE || "").trim().toLowerCase() === "enclave";
    const hasEnvelope = typeof (req.body as any).ownerEncryptedKey === "string"
      && (req.body as any).ownerEncryptedKey.length > 0;
    const keyMaterialOk = inEnclaveMode
      ? (hasEnvelope && !!ownerAddress)
      : !!ownerPrivateKey;

    // Validate required fields
    if (!chainId || !calls || !Array.isArray(calls) || calls.length === 0 || !keyMaterialOk || !ownerAddress || !rpcUrl) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: inEnclaveMode
          ? 'All fields required: chainId, calls (non-empty array), ownerEncryptedKey, ownerAddress, rpcUrl'
          : 'All fields required: chainId, calls (non-empty array), ownerPrivateKey, ownerAddress, rpcUrl',
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

    // Verify owner address matches private key — local mode only. In
    // enclave mode the plaintext key never enters this process so
    // there's nothing to verify against; `ownerAddress` is taken on
    // trust (parent-proxy /sign produces a signature recoverable to
    // that address, or fails).
    if (!inEnclaveMode) {
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

    // Execute universal transaction with circuit breaker.
    // Phase 1: pass envelope + KMS ARN + ownerAddress for enclave no-key routing.
    const universalSignerOpts: {
      envelopeBlob?: string;
      kmsKeyArn?: string;
      ownerAddress?: string;
      password?: string;
      authProof?: import("./signingMode").AuthProof;
      projectId?: string;
      signedConfig?: { signed_config_json: string; signature_b64: string };
    } = {};
    const universalBlob = (req.body as any).ownerEncryptedKey;
    if (typeof universalBlob === "string") universalSignerOpts.envelopeBlob = universalBlob;
    if (process.env.KMS_KEY_ARN) universalSignerOpts.kmsKeyArn = process.env.KMS_KEY_ARN;
    if (ownerAddress) universalSignerOpts.ownerAddress = ownerAddress;
    // v2 password (non-custodial). Required if the envelope is v2.
    const universalPassword = (req.body as any).password;
    if (typeof universalPassword === "string" && universalPassword.length > 0) {
      universalSignerOpts.password = universalPassword;
    }
    // v3 authProof (device-bound). Required if the envelope is v3.
    const universalAuthProof = (req.body as any).authProof;
    if (universalAuthProof && typeof universalAuthProof === "object") {
      universalSignerOpts.authProof = universalAuthProof;
    }
    // v3 per-project signed WebAuthn accept-list (multi-tenant unblock).
    // Passed through by the backend route layer after fetching from
    // project_enclave_configs (accepted_origins + accepted_rp_ids +
    // config_signature). Absent → enclave uses hardcoded default
    // policy (Rift's own domains). See rift-signer-enclave/enclave/
    // src/project_config.rs for the verify path.
    const universalProjectId = (req.body as any).projectId;
    if (typeof universalProjectId === "string" && universalProjectId.length > 0) {
      universalSignerOpts.projectId = universalProjectId;
    }
    const universalSignedConfig = (req.body as any).signedConfig;
    if (
      universalSignedConfig &&
      typeof universalSignedConfig === "object" &&
      typeof universalSignedConfig.signed_config_json === "string" &&
      typeof universalSignedConfig.signature_b64 === "string"
    ) {
      universalSignerOpts.signedConfig = {
        signed_config_json: universalSignedConfig.signed_config_json,
        signature_b64: universalSignedConfig.signature_b64,
      };
    }
    const result = await paymasterCircuitBreaker.execute(() =>
      submitUniversalTransaction(
        chainId,
        rpcUrl,
        calls,
        ownerPrivateKey,
        bundlerUrl,
        paymasterRPC,
        paymasterToken,
        universalSignerOpts
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


// ==================== TWO-PHASE v3 (DEVICE-BOUND) ENDPOINTS ====================
//
// v3 envelopes need an authProof whose challenge equals the user_op_hash
// being signed. Hash isn't known until the user op is built, so the flow
// is two-step:
//
//   1. POST /api/transaction/preview            → user_op_hash + ticket_id
//   2. (client signs hash with passkey / OIDC)
//   3. POST /api/transaction/submit-prepared    → submits with authProof
//
// Ticket is single-use, 60s TTL. Stateless callers welcome — the ticket
// is opaque on the wire and only meaningful within this process.
//
// v1 / v2 envelopes keep using POST /api/transaction (one-phase) since
// they don't need a challenge bound to the user op hash.

router.post('/api/transaction/preview', checkRateLimit, async (req, res) => {
  try {
    const {
      chainId,
      calls,
      ownerEncryptedKey,
      ownerAddress,
      rpcUrl,
      // Optional markup fields. When these are present AND a valid
      // transferTokenAddress + transferBaseAmountWei pair is supplied,
      // the preview endpoint appends the Rift + project markup transfer
      // calls to the calls array before running preview. Backend v3
      // controllers set these; the v1 flows never hit this endpoint.
      markupBps,
      projectMarkupBps,
      projectTreasuryAddress,
      transferTokenAddress,
      transferBaseAmountWei,
      // Optional flat markup: used for non-transfer flows (bridge,
      // arbitrary calls) where the percentage markup has no clear base.
      // The paymaster token is charged a flat fee per UserOp.
      flatMarkupTokenAddress,
    } = req.body as {
      chainId: number;
      calls: Array<{ to: string; value?: string; data?: string }>;
      ownerEncryptedKey: string;
      ownerAddress: string;
      rpcUrl: string;
      markupBps?: number;
      projectMarkupBps?: number;
      projectTreasuryAddress?: string;
      transferTokenAddress?: string;
      transferBaseAmountWei?: string;
      flatMarkupTokenAddress?: string;
    };

    if (
      !chainId ||
      !Array.isArray(calls) ||
      calls.length === 0 ||
      !ownerEncryptedKey ||
      !ownerAddress ||
      !rpcUrl
    ) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message:
          'All fields required: chainId, calls (non-empty), ownerEncryptedKey, ownerAddress, rpcUrl',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    if (!ethers.utils.isAddress(ownerAddress)) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid owner address',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} not supported. Supported: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // ─── Inject markup calls (v3 monetization) ─────────────────────
    // Percentage markup applies when the caller supplied a real
    // transfer base. Flat markup applies when the caller only supplied
    // a paymaster token (bridge, arbitrary txns). Either can be
    // present, both, or neither; each markup helper safely returns
    // null when its inputs are missing.
    const augmentedCalls: Array<{ to: string; value?: string; data?: string }> = [...calls];
    try {
      const { getMarkupConfig, buildMarkupTransferCall, buildProjectMarkupTransferCall, getFlatMarkupConfig, buildFlatMarkupTransferCall } = await import('./markup');
      const { encodeFunctionData } = await import('viem');

      // Percentage markup on the transfer base.
      if (transferTokenAddress && transferBaseAmountWei && ethers.utils.isAddress(transferTokenAddress)) {
        let baseWei: bigint;
        try {
          baseWei = BigInt(transferBaseAmountWei);
        } catch {
          baseWei = 0n;
        }
        if (baseWei > 0n) {
          const riftConfig = getMarkupConfig(markupBps);
          const riftCall = buildMarkupTransferCall({
            tokenAddress: transferTokenAddress as any,
            transferAmountWei: baseWei,
            config: riftConfig,
          });
          if (riftCall) {
            augmentedCalls.push({
              to: riftCall.to,
              value: '0',
              data: encodeFunctionData({
                abi: riftCall.abi,
                functionName: riftCall.functionName,
                args: riftCall.args,
              }),
            });
            console.log(`[markup-preview] Rift ${riftConfig.bps} bps → ${riftConfig.treasury} amount=${riftCall.args[1]}`);
          }
          const projectCall = buildProjectMarkupTransferCall({
            tokenAddress: transferTokenAddress as any,
            transferAmountWei: baseWei,
            projectBps: projectMarkupBps,
            projectTreasury: projectTreasuryAddress,
          });
          if (projectCall) {
            augmentedCalls.push({
              to: projectCall.to,
              value: '0',
              data: encodeFunctionData({
                abi: projectCall.abi,
                functionName: projectCall.functionName,
                args: projectCall.args,
              }),
            });
            console.log(`[markup-preview] Project ${projectMarkupBps} bps → ${projectCall.args[0]} amount=${projectCall.args[1]}`);
          }
        }
      }

      // Flat markup for non-transfer flows (bridge / arbitrary).
      if (flatMarkupTokenAddress && ethers.utils.isAddress(flatMarkupTokenAddress)) {
        const flatConfig = getFlatMarkupConfig();
        const flatCall = buildFlatMarkupTransferCall({
          tokenAddress: flatMarkupTokenAddress as any,
          config: flatConfig,
        });
        if (flatCall) {
          augmentedCalls.push({
            to: flatCall.to,
            value: '0',
            data: encodeFunctionData({
              abi: flatCall.abi,
              functionName: flatCall.functionName,
              args: flatCall.args,
            }),
          });
          console.log(`[markup-preview] Flat markup ${flatConfig.amountWei} → ${flatConfig.treasury}`);
        }
      }
    } catch (markupErr: any) {
      // Never let a markup failure block a preview. Log + continue with
      // the unmodified calls array. Missing markup is a revenue leak we
      // can catch later; a failed preview is a broken UX.
      console.warn('[markup-preview] failed to inject markup calls, continuing without:', markupErr?.message || markupErr);
    }

    const { previewUniversalTransaction } = await import('./twoPhase');
    const result = await previewUniversalTransaction({
      chainId,
      rpcNodeProvider: rpcUrl,
      calls: augmentedCalls,
      ownerAddress,
      ownerEncryptedKey,
      bundlerUrl: chainConfig.bundlerUrl,
      paymasterRPC: chainConfig.paymasterRPC,
    });

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Preview Failed',
        message: result.error,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    res.json({
      success: true,
      data: {
        user_op_hash_hex: result.userOpHashHex,
        ticket_id: result.ticketId,
        expires_at_ms: result.expiresAt,
        ttl_ms: result.ttlMs,
        smart_account_address: result.smartAccountAddress,
        chain_id: chainId,
      },
      message: 'User op prepared. Sign user_op_hash_hex with your passkey / OIDC and POST to /api/transaction/submit-prepared.',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[/api/transaction/preview] error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'preview failed',
      timestamp: new Date().toISOString(),
    } as any);
  }
});

// Bridge preview — same two-phase pattern, but builds the
// approve(SpokePool) + depositV3 calls via Across SDK first. Submit
// uses the shared /api/transaction/submit-prepared (the ticket carries
// chain + bundler config, no per-flow submit endpoint needed).
router.post('/api/bridge/preview', checkRateLimit, async (req, res) => {
  try {
    const {
      sourceChainId,
      destChainId,
      tokenAddress,
      amount,
      ownerEncryptedKey,
      ownerAddress,
      rpcUrl,
      recipient: explicitRecipient,
    } = req.body as {
      sourceChainId: number;
      destChainId: number;
      tokenAddress: string;
      amount: number;
      ownerEncryptedKey: string;
      ownerAddress: string;
      rpcUrl: string;
      recipient?: string;
    };

    if (
      !sourceChainId ||
      !destChainId ||
      !tokenAddress ||
      !amount ||
      !ownerEncryptedKey ||
      !ownerAddress ||
      !rpcUrl
    ) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message:
          'Required: sourceChainId, destChainId, tokenAddress, amount, ownerEncryptedKey, ownerAddress, rpcUrl',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    if (sourceChainId === destChainId) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Source and destination chains must differ',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    const sourceChain = CHAINS[sourceChainId as keyof typeof CHAINS];
    if (!sourceChain) {
      res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Source chain ID ${sourceChainId} is not supported.`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    const chainConfig = getChainConfig(sourceChainId);
    if (!chainConfig?.bundlerUrl || !chainConfig?.paymasterRPC) {
      res.status(500).json({
        success: false,
        error: 'Configuration Error',
        message: `Missing bundler/paymaster config for chain ${sourceChainId}`,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    // Compute the smart wallet address from ownerAddress (no key needed).
    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain: sourceChain,
    });
    const { makeSigner } = await import('./signerFactory');
    const noKeySigner = await makeSigner({
      envelopeBlob: ownerEncryptedKey,
      kmsKeyArn: process.env.KMS_KEY_ARN || 'unused-for-address-derivation',
      ownerAddress,
    });
    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [noKeySigner],
      version: '1.4.1',
    });
    const smartWalletAddress = smartAccount.address;
    const recipient =
      explicitRecipient && ethers.utils.isAddress(explicitRecipient)
        ? explicitRecipient
        : smartWalletAddress;

    // Token decimals + Across quote.
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ['function decimals() view returns (uint8)'],
      new ethers.providers.JsonRpcProvider(rpcUrl)
    );
    const decimals = await tokenContract.decimals();
    const amountInWei = ethers.utils
      .parseUnits(amount.toString(), decimals)
      .toString();

    const { getAcrossQuote, buildBridgeCalls } = await import('./bridge');
    const quote = await getAcrossQuote(
      sourceChainId,
      destChainId,
      tokenAddress,
      amountInWei,
      recipient
    );

    const bridgeCalls = buildBridgeCalls(
      quote,
      smartWalletAddress,
      recipient,
      tokenAddress,
      BigInt(amountInWei),
      destChainId
    );

    // Bridge uses the flat markup (not percentage — bridge has no
    // clean "transfer amount" base to charge against). We append a
    // transfer(treasury, flat_fee) call to the bridge calls array so
    // the same UserOp that runs the bridge also pays the fee.
    const augmentedBridgeCalls: any[] = bridgeCalls.map((c: any) => ({
      to: c.to as string,
      value: c.value !== undefined ? String(c.value) : '0',
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    }));
    try {
      const { getFlatMarkupConfig, buildFlatMarkupTransferCall } = await import('./markup');
      const flatConfig = getFlatMarkupConfig();
      const flatCall = buildFlatMarkupTransferCall({
        tokenAddress: tokenAddress as any,
        config: flatConfig,
      });
      if (flatCall) {
        augmentedBridgeCalls.push({
          to: flatCall.to,
          value: '0',
          abi: flatCall.abi,
          functionName: flatCall.functionName,
          args: flatCall.args,
        });
        console.log(`[markup-preview] Bridge flat markup ${flatConfig.amountWei} → ${flatConfig.treasury}`);
      }
    } catch (markupErr: any) {
      console.warn('[markup-preview] bridge flat markup failed, continuing without:', markupErr?.message || markupErr);
    }

    // Hand to the generic preview — it will run prepareUserOperation
    // over these ABI-style calls and stash the prepared UO + chain
    // context in the ticket cache.
    const { previewUniversalTransaction } = await import('./twoPhase');
    const previewResult = await previewUniversalTransaction({
      chainId: sourceChainId,
      rpcNodeProvider: rpcUrl,
      calls: augmentedBridgeCalls as any,
      ownerAddress,
      ownerEncryptedKey,
      bundlerUrl: chainConfig.bundlerUrl,
      paymasterRPC: chainConfig.paymasterRPC,
    });

    if (!previewResult.success) {
      res.status(400).json({
        success: false,
        error: 'Preview Failed',
        message: previewResult.error,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    res.json({
      success: true,
      data: {
        user_op_hash_hex: previewResult.userOpHashHex,
        ticket_id: previewResult.ticketId,
        expires_at_ms: previewResult.expiresAt,
        ttl_ms: previewResult.ttlMs,
        smart_account_address: previewResult.smartAccountAddress,
        chain_id: sourceChainId,
        // Bridge-specific extras the client may want to display before
        // the user signs (so they can see what they're approving):
        bridge: {
          source_chain_id: sourceChainId,
          dest_chain_id: destChainId,
          input_token: tokenAddress,
          input_amount_wei: amountInWei,
          output_token: quote.outputToken.address,
          output_amount_wei: quote.outputAmount,
          spoke_pool: quote.spokePoolAddress,
          recipient,
        },
      },
      message:
        'Bridge UO prepared. Sign user_op_hash_hex with your passkey and POST to /api/transaction/submit-prepared.',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[/api/bridge/preview] error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'bridge preview failed',
      timestamp: new Date().toISOString(),
    } as any);
  }
});

router.post('/api/transaction/submit-prepared', checkRateLimit, async (req, res) => {
  try {
    const { ticketId, authProof } = req.body as {
      ticketId?: string;
      authProof?: {
        kind: 'oidc' | 'passkey';
        [k: string]: unknown;
      };
    };

    if (!ticketId || !authProof || !authProof.kind) {
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'ticketId and authProof (with kind=oidc|passkey) are required',
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    const { submitPreparedUniversalTransaction } = await import('./twoPhase');
    const result = await submitPreparedUniversalTransaction({
      ticketId,
      authProof: authProof as any,
    });

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Submit Failed',
        message: result.error,
        timestamp: new Date().toISOString(),
      } as any);
      return;
    }

    res.json({
      success: true,
      data: {
        userOperationHash: result.userOperationHash,
        transactionHash: result.transactionHash,
        chainId: result.chainId,
      },
      message: 'User op submitted',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[/api/transaction/submit-prepared] error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'submit failed',
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

// Get smart account address endpoint.
//
// Accepts `ownerAddress` (preferred — Phase-2 no-plaintext-on-wire) and
// falls back to `ownerPrivateKey` for rollout-window compatibility with
// older backend deploys. The Safe smart-account address is deterministic
// from JUST the EOA's public address (CREATE2 with keccak256(owner) as
// salt), so we never need the private key to compute it.
router.post('/api/smart-account/address', checkRateLimit, async (req, res) => {
  try {
    const { chainId, ownerPrivateKey, rpcUrl } = req.body as {
      chainId?: number;
      ownerPrivateKey?: string;
      ownerAddress?: string;
      rpcUrl?: string;
    };
    let { ownerAddress } = req.body as { ownerAddress?: string };

    if (!chainId || (!ownerAddress && !ownerPrivateKey)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'chainId and ownerAddress (or legacy ownerPrivateKey) are required',
        timestamp: new Date().toISOString(),
      });
    }

    const chain = CHAINS[chainId as keyof typeof CHAINS];
    if (!chain) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported Chain',
        message: `Chain ID ${chainId} is not supported. Supported chains: ${SUPPORTED_CHAINS_LIST}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Derive ownerAddress from ownerPrivateKey only if the caller didn't
    // give us one directly. This is the rollout shim — it goes away
    // once every backend deploy is sending `ownerAddress`.
    if (!ownerAddress) {
      try {
        ownerAddress = new ethers.Wallet(ownerPrivateKey as string).address;
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: 'Invalid private key format (legacy field) — prefer `ownerAddress`',
          timestamp: new Date().toISOString(),
        });
      }
    } else if (!ethers.utils.isAddress(ownerAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid ownerAddress',
        timestamp: new Date().toISOString(),
      });
    }

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

    console.log(`🔍 Getting smart account address on chain ${chainId} for owner ${ownerAddress}`);

    const publicClient = createPublicClient({
      transport: http(finalRpcUrl),
      chain,
    });

    // No-key signer — viem's toAccount() lets us hand permissionless a
    // signer object that knows its address but refuses to sign. The
    // Safe SDK only needs `signer.address` to compute the deterministic
    // smart-account address.
    const viewOnlySigner = {
      address: ownerAddress as `0x${string}`,
      signMessage: async () => {
        throw new Error('view-only signer cannot sign');
      },
      signTransaction: async () => {
        throw new Error('view-only signer cannot sign');
      },
      signTypedData: async () => {
        throw new Error('view-only signer cannot sign');
      },
      source: 'view-only',
      type: 'local',
      publicKey: '0x' as `0x${string}`,
    } as any;

    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [viewOnlySigner],
      version: '1.4.1',
    });

    console.log(`🏦 Smart Account Address: ${smartAccount.address}`);

    res.json({
      success: true,
      data: {
        address: smartAccount.address,
        chainId,
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

// Create smart account endpoint.
//
// Accepts EITHER:
//   - `ownerAddress` (envelope mode — preferred; matches /smart-account/address)
//   - `ownerPrivateKey` (legacy plaintext — kept for backwards compat)
//
// Safe smart-account addresses are CREATE2-deterministic from the EOA's
// address alone (no key required), so this endpoint should never have
// required the private key in the first place. Migrating brings it in
// line with /address — any caller (current backend / older deploys /
// envelope-only signup) just works.
router.post('/api/smart-account/create', checkRateLimit, async (req, res) => {
  try {
    const { chainId, ownerPrivateKey, rpcUrl } = req.body as {
      chainId?: number;
      ownerPrivateKey?: string;
      ownerAddress?: string;
      rpcUrl?: string;
    };
    let { ownerAddress } = req.body as { ownerAddress?: string };

    // Validate required fields
    if (!chainId || !rpcUrl || (!ownerAddress && !ownerPrivateKey)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message:
          'chainId, rpcUrl, and ownerAddress (or legacy ownerPrivateKey) are required',
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

    // Derive ownerAddress from ownerPrivateKey only when the caller
    // didn't give us one directly. Rollout shim — goes away once every
    // caller sends `ownerAddress`.
    if (!ownerAddress) {
      try {
        ownerAddress = new ethers.Wallet(ownerPrivateKey as string).address;
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: 'Invalid private key format',
          timestamp: new Date().toISOString(),
        });
      }
    } else if (!ethers.utils.isAddress(ownerAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid ownerAddress format',
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`🏗️ Creating smart account on chain ${chainId} for owner ${ownerAddress}`);

    // Create public client
    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain
    });

    // Build a no-key viem account that just carries the address. Safe's
    // address derivation only needs `owners[0].address`, so we never
    // actually call signMessage / signTransaction here. If something
    // accidentally tries to, it'll throw a clear error.
    const { toAccount } = await import('viem/accounts');
    const noKeySigner = toAccount({
      address: ownerAddress as `0x${string}`,
      async signMessage() {
        throw new Error(
          'no-key signer: /smart-account/create does not sign — address derivation only'
        );
      },
      async signTransaction() {
        throw new Error('no-key signer: /smart-account/create does not sign');
      },
      async signTypedData() {
        throw new Error('no-key signer: /smart-account/create does not sign');
      },
    });

    // Create Safe smart account
    const smartAccount = await toSafeSmartAccount({
      client: publicClient,
      owners: [noKeySigner],
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
  /** Local-mode plaintext key. Mutually exclusive with the enclave-mode
   *  `ownerEncryptedKey + ownerAddress` pair. Optional now — validation
   *  picks which path is required based on SIGNING_MODE. */
  ownerPrivateKey?: string;
  /** Phase-2 envelope-aware path. When the backend sends an envelope blob
   *  via `ownerEncryptedKey`, it also sends `ownerAddress` so the enclave
   *  signing path knows whose address to sign for without ever touching
   *  plaintext. */
  ownerAddress?: string;
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
      ownerAddress,
      rpcUrl,
      recipient: explicitRecipient
    } = req.body as BridgeBody;

    // Key material requirements depend on signing mode:
    //   local mode  → `ownerPrivateKey` must be present
    //   enclave mode → `ownerEncryptedKey` (envelope blob, in body) + `ownerAddress` are enough
    const inEnclaveMode = (process.env.SIGNING_MODE || "").trim().toLowerCase() === "enclave";
    const hasEnvelope = typeof (req.body as any).ownerEncryptedKey === "string"
      && (req.body as any).ownerEncryptedKey.length > 0;
    const keyMaterialOk = inEnclaveMode
      ? (hasEnvelope && !!ownerAddress)
      : !!ownerPrivateKey;

    // Validate required fields
    if (!sourceChainId || !destChainId || !tokenAddress || !amount || !keyMaterialOk || !rpcUrl) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: inEnclaveMode
          ? 'All fields required: sourceChainId, destChainId, tokenAddress, amount, ownerEncryptedKey, ownerAddress, rpcUrl'
          : 'All fields required: sourceChainId, destChainId, tokenAddress, amount, ownerPrivateKey, rpcUrl',
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

    // Validate the key material. In local mode the private key must parse;
    // in enclave mode the address must be well-formed (the envelope is
    // opaque here and only the enclave can unseal it).
    if (!inEnclaveMode) {
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
    } else if (!ethers.utils.isAddress(ownerAddress!)) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid ownerAddress format',
        timestamp: new Date().toISOString(),
      });
    }

    // Compute smart wallet address. In enclave mode we use the no-key
    // signer so the plaintext private key never enters this process.
    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain: sourceChain
    });

    let signer: any;
    if (inEnclaveMode) {
      const { makeSigner } = await import('./signerFactory');
      signer = await makeSigner({
        envelopeBlob: (req.body as any).ownerEncryptedKey,
        kmsKeyArn: process.env.KMS_KEY_ARN || 'unused-for-address-derivation',
        ownerAddress: ownerAddress!,
      });
    } else {
      signer = privateKeyToAccount(ownerPrivateKey as `0x${string}`);
    }
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
    // Phase 1: pass envelope + KMS ARN + ownerAddress for enclave no-key routing.
    console.log(`🚀 Executing bridge transaction via smart account...`);
    const bridgeSignerOpts: {
      envelopeBlob?: string;
      kmsKeyArn?: string;
      ownerAddress?: string;
      password?: string;
      authProof?: import("./signingMode").AuthProof;
    } = {};
    const bridgeBlob = (req.body as any).ownerEncryptedKey;
    if (typeof bridgeBlob === "string") bridgeSignerOpts.envelopeBlob = bridgeBlob;
    if (process.env.KMS_KEY_ARN) bridgeSignerOpts.kmsKeyArn = process.env.KMS_KEY_ARN;
    if (ownerAddress) bridgeSignerOpts.ownerAddress = ownerAddress;
    const bridgePassword = (req.body as any).password;
    if (typeof bridgePassword === "string" && bridgePassword.length > 0) {
      bridgeSignerOpts.password = bridgePassword;
    }
    // v3 authProof (device-bound). Required if the envelope is v3.
    const bridgeAuthProof = (req.body as any).authProof;
    if (bridgeAuthProof && typeof bridgeAuthProof === "object") {
      bridgeSignerOpts.authProof = bridgeAuthProof;
    }
    const result = await paymasterCircuitBreaker.execute(() =>
      submitUniversalTransaction(
        sourceChainId,
        rpcUrl,
        calls,
        ownerPrivateKey,
        chainConfig.bundlerUrl,
        chainConfig.paymasterRPC,
        tokenAddress, // pay gas in the token being bridged
        bridgeSignerOpts
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

// Pair with a DApp via WalletConnect URI.
//
// Accepts EITHER:
//   - `ownerPrivateKey` (legacy local-mode)
//   - `ownerEncryptedKey + ownerAddress` (envelope / enclave mode — v3)
//
// For v3 wallets, every individual dApp signing request submitted
// through the resulting session must carry an `authProof` in the
// /api/walletconnect/requests/:id/approve body. The session itself
// doesn't store authProof — sessions outlive any single gesture.
router.post('/api/walletconnect/pair', checkRateLimit, async (req, res) => {
  try {
    const {
      uri,
      ownerPrivateKey,
      ownerEncryptedKey,
      ownerAddress,
      chainId,
      rpcUrl,
    } = req.body as {
      uri?: string;
      ownerPrivateKey?: string;
      ownerEncryptedKey?: string;
      ownerAddress?: string;
      chainId?: number;
      rpcUrl?: string;
    };

    const inEnclaveMode =
      (process.env.SIGNING_MODE || "").trim().toLowerCase() === "enclave";
    const hasEnvelope =
      typeof ownerEncryptedKey === "string" &&
      ownerEncryptedKey.length > 0 &&
      typeof ownerAddress === "string" &&
      ethers.utils.isAddress(ownerAddress);
    const hasPrivateKey =
      typeof ownerPrivateKey === "string" && ownerPrivateKey.length > 0;
    const keyMaterialOk = inEnclaveMode
      ? (hasEnvelope || hasPrivateKey)
      : (hasPrivateKey || hasEnvelope);

    if (!uri || !chainId || !keyMaterialOk) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message:
          'Required: uri, chainId, and (ownerEncryptedKey + ownerAddress) OR ownerPrivateKey. Optional: rpcUrl.',
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

    // Validate the key material that's actually present. Envelope is
    // opaque here (only the enclave can unseal); for the plaintext path
    // we sanity-check it parses as a private key.
    if (hasPrivateKey) {
      try {
        new ethers.Wallet(ownerPrivateKey as string);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: 'Validation Error',
          message: 'Invalid private key format',
          timestamp: new Date().toISOString(),
        });
      }
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
      hasEnvelope
        ? { ownerEncryptedKey, ownerAddress }
        : { ownerPrivateKey },
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
// v3 non-custodial preview: computes the hash the enclave will sign for
// a pending WC request so the client can bind an authProof (WebAuthn
// challenge / OIDC nonce) to that exact value before /approve runs the
// signing. For eth_sendTransaction it also stashes the prepared UO in
// the ticket cache — /approve then submits the cached op instead of
// rebuilding one, guaranteeing the hash the client signed matches.
//
// Legacy (local-mode) sessions return { requiresAuthProof: false } and
// can skip straight to /approve — this endpoint is a cheap no-op for them.
router.post('/api/walletconnect/requests/:id/preview', checkRateLimit, async (req, res) => {
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

    const { previewSessionRequest } = await import('./walletconnect');
    const result = await previewSessionRequest(requestId);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: 'Preview Failed',
        message: result.error,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: {
        method: result.method,
        peerName: result.peerName,
        smart_account_address: result.smartWalletAddress,
        chain_id: result.chainId,
        hash_to_sign: result.hashToSign,
        ticket_id: result.ticketId,
        expires_at_ms: result.expiresAtMs,
        ttl_ms: result.ttlMs,
        requires_auth_proof: result.requiresAuthProof,
      },
      message: result.requiresAuthProof
        ? 'Sign hash_to_sign with your passkey / OIDC and POST /approve with authProof.'
        : 'Legacy session — approve() directly, no authProof needed.',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[/api/walletconnect/requests/:id/preview] error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error?.message || 'preview failed',
      timestamp: new Date().toISOString(),
    });
  }
});

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

    // v3 (envelope-mode) sessions require an authProof on every approve.
    // Legacy sessions ignore it. approveRequest enforces this by
    // checking the session config — we just forward whatever the
    // client sent.
    const authProof = (req.body as any)?.authProof;
    const result = await approveRequest(requestId, authProof);
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