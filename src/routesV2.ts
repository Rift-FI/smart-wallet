/**
 * /api/v2 — client-side EOA signing relay (relay.ts). The client owns an
 * EOA and personal_signs the SafeOp hash itself; no key reaches this
 * service. Unchanged by the passkey migration; behind the same
 * INTERNAL_SERVICE_TOKEN auth as every other route.
 */

import { Router } from 'express';
import { ethers } from 'ethers';
import { createPublicClient, http } from 'viem';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { prepareTransfer, prepareTransaction, submitSignedUserOp } from './relay';
import { getAcrossQuote, buildBridgeCalls } from './bridge';
import { CHAINS, getChainConfig, SUPPORTED_CHAINS_LIST } from './chainConfig';
import { checkRateLimit, paymasterCircuitBreaker } from './rateLimit';

const router = Router();
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

    return res.json({
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
    return res.status(500).json({
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

    return res.json({
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
    return res.status(500).json({
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

    return res.json({
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
    return res.status(500).json({
      success: false,
      error: 'Bridge Prepare Failed',
      message: error?.message || 'Failed to prepare bridge UserOperation',
      timestamp: new Date().toISOString(),
    });
  }
});

// System status endpoint for monitoring

export default router;
