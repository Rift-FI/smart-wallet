import { Router } from 'express';
import { parseUnits, type Address } from 'viem';
import { HealthCheckResponse, TypedResponse } from './types';
import { estimateTransfer } from './estimateTransfer';
import { estimateBridge } from './estimateBridge';
import { getAcrossQuote, buildBridgeCalls } from './bridge';
import {
  pairAndApprove,
  disconnectSession,
  getActiveSessions,
  getPendingRequests,
  approveRequest,
  rejectRequest,
  previewSessionRequest,
} from './walletconnect';
import { getChainConfig, getPublicClient, getRpcUrl, SUPPORTED_CHAINS_LIST } from './chainConfig';
import { checkRateLimit, paymasterCircuitBreaker, rpcCircuitBreaker } from './rateLimit';
import { fail, gone, ok } from './http';
import { getCapabilityTable } from './passkey/constants';
import { PasskeyError } from './passkey/errors';
import { addressOnlyOwner, buildLegacySafe, parseAccountRef, parseAddress, parseCoords } from './passkey/account';
import {
  assertChain,
  getOwners,
  passkeyNativeAddress,
  passkeyProxyAddress,
  prepareMessage,
  prepareOperation,
  submitMessage,
  submitOperation,
} from './passkey/service';
import { migrateSafe } from './passkey/migration';
import v2Routes from './routesV2';

const router = Router();

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

// Health check endpoint (the only unauthenticated route)
router.get('/health', (_req, res: TypedResponse<HealthCheckResponse>) => {
  const healthData: HealthCheckResponse = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '2.0.0',
  };

  res.json({
    success: true,
    data: healthData,
    timestamp: new Date().toISOString(),
  });
});

// ==================== PASSKEY WALLET API (spec §2f) ====================
//
// Backend → smart-wallet. Every fund-moving / signing operation is
// two-phase: prepare → { ticketId, hashToSign } → the user's passkey signs
// hashToSign on their device → submit { ticketId, signer, authProof }.
// This service never holds a key that can move user funds; the only key
// it ever sees is a legacy EOA key on /api/v3/migrate, used once for the
// owner swap and never logged.

router.get('/api/passkey/capabilities', (_req, res) => {
  ok(res, { chains: getCapabilityTable() });
});

// { credential: { x, y } } → { address } (passkey-native Safe, same on every chain)
router.post('/api/passkey/address', checkRateLimit, async (req, res) => {
  try {
    ok(res, await passkeyNativeAddress(req.body?.credential));
  } catch (e) {
    fail(res, e, '/api/passkey/address');
  }
});

// { x, y } → { proxyAddress } (SafeWebAuthnSignerProxy for an extra passkey)
router.post('/api/passkey/signer', checkRateLimit, async (req, res) => {
  try {
    ok(res, await passkeyProxyAddress(req.body));
  } catch (e) {
    fail(res, e, '/api/passkey/signer');
  }
});

// { chainId, account, calls[], gas, purpose, intent? } → { ticketId, hashToSign, userOp, expiresAt }
router.post('/api/v3/prepare', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const rpcUrl = optionalString(b.rpcUrl);
    const out = await paymasterCircuitBreaker.execute(() =>
      prepareOperation({
        chainId: b.chainId,
        account: b.account,
        calls: b.calls,
        gas: b.gas,
        purpose: b.purpose,
        intent: b.intent,
        ...(rpcUrl ? { rpcUrl } : {}),
      })
    );
    ok(res, { ...out });
  } catch (e) {
    fail(res, e, '/api/v3/prepare');
  }
});

// { ticketId, signer: { address, kind }, authProof } → { userOpHash, transactionHash, success }
router.post('/api/v3/submit', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const out = await submitOperation({ ticketId: b.ticketId, signer: b.signer, authProof: b.authProof });
    res.json({ ...out, success: out.success, data: out, timestamp: new Date().toISOString() });
  } catch (e) {
    fail(res, e, '/api/v3/submit');
  }
});

// { chainId, account, kind, message | typedData } → { ticketId, hashToSign }
router.post('/api/v3/message/prepare', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const rpcUrl = optionalString(b.rpcUrl);
    ok(res, {
      ...(await prepareMessage({
        chainId: b.chainId,
        account: b.account,
        kind: b.kind,
        message: b.message,
        typedData: b.typedData,
        ...(rpcUrl ? { rpcUrl } : {}),
      })),
    });
  } catch (e) {
    fail(res, e, '/api/v3/message/prepare');
  }
});

// { ticketId, signer, authProof } → { signature } (ERC-1271, or ERC-6492 if undeployed)
router.post('/api/v3/message/submit', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    ok(res, { ...(await submitMessage({ ticketId: b.ticketId, signer: b.signer, authProof: b.authProof })) });
  } catch (e) {
    fail(res, e, '/api/v3/message/submit');
  }
});

// { chainId, account (migrated AccountRef), eoaPrivateKey, passkeys: [{x,y}] }
// Builds + EOA-signs + submits the §1c owner swap. The body is never logged.
router.post('/api/v3/migrate', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const chainId = assertChain(b.chainId);
    const ref = parseAccountRef(b.account);
    if (ref.kind !== 'migrated') {
      throw new PasskeyError('VALIDATION_ERROR', 'account.kind must be "migrated" (legacy EOA Safe)');
    }
    if (!Array.isArray(b.passkeys) || b.passkeys.length === 0) {
      throw new PasskeyError('VALIDATION_ERROR', 'passkeys must be a non-empty array of { x, y }');
    }
    const passkeys = b.passkeys.map((p: unknown, i: number) => parseCoords(p, `passkeys[${i}]`));
    const rpcUrl = optionalString(b.rpcUrl);
    const out = await migrateSafe({
      chainId,
      client: getPublicClient(chainId, rpcUrl),
      ...(rpcUrl ? { rpcUrl } : {}),
      safeAddress: ref.address,
      legacyOwner: ref.legacyOwner,
      eoaPrivateKey: b.eoaPrivateKey,
      passkeys,
    });
    res.json({ ...out, data: out, timestamp: new Date().toISOString() });
  } catch (e) {
    fail(res, e, '/api/v3/migrate');
  }
});

// { chainId, safe } → { deployed, owners }
router.post('/api/v3/owners', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    ok(res, { ...(await rpcCircuitBreaker.execute(() => getOwners(b.chainId, b.safe, optionalString(b.rpcUrl)))) });
  } catch (e) {
    fail(res, e, '/api/v3/owners');
  }
});

// ==================== LEGACY ROUTE NAMES ====================
//
// Two-phase routes keep their paths + response field names but now take
// an AccountRef (`account`) instead of key material.

router.post('/api/transaction/preview', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const rpcUrl = optionalString(b.rpcUrl);
    const gas = b.gas ?? {
      ...(b.paymasterToken ? { mode: 'token', token: b.paymasterToken } : { mode: 'sponsored' }),
      markupBps: b.markupBps,
      projectMarkupBps: b.projectMarkupBps,
      projectTreasuryAddress: b.projectTreasuryAddress,
      transferTokenAddress: b.transferTokenAddress,
      transferBaseAmountWei: b.transferBaseAmountWei,
      flatMarkupTokenAddress: b.flatMarkupTokenAddress,
    };
    if (b.account === undefined) {
      throw new PasskeyError('VALIDATION_ERROR', 'account (AccountRef) is required; key material is no longer accepted');
    }
    const out = await paymasterCircuitBreaker.execute(() =>
      prepareOperation({ chainId: b.chainId, account: b.account, calls: b.calls, gas, purpose: b.purpose ?? 'transaction', ...(rpcUrl ? { rpcUrl } : {}) })
    );
    ok(res, {
      ...out,
      user_op_hash_hex: out.hashToSign,
      ticket_id: out.ticketId,
      expires_at_ms: out.expiresAt,
      ttl_ms: Math.max(0, out.expiresAt - Date.now()),
      smart_account_address: out.sender,
      chain_id: out.chainId,
    }, 'User op prepared. Passkey-sign hashToSign and POST /api/transaction/submit-prepared.');
  } catch (e) {
    fail(res, e, '/api/transaction/preview');
  }
});

// Bridge preview — approve(SpokePool) + depositV3 via Across, flat markup in
// the bridged token, then the shared submit.
router.post('/api/bridge/preview', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const sourceChainId = assertChain(b.sourceChainId);
    const destChainId = assertChain(b.destChainId);
    if (sourceChainId === destChainId) throw new PasskeyError('VALIDATION_ERROR', 'Source and destination chains must differ');
    const tokenAddress = parseAddress(b.tokenAddress, 'tokenAddress');
    if (typeof b.amount !== 'number' || b.amount <= 0) throw new PasskeyError('VALIDATION_ERROR', 'amount must be a positive number');
    const ref = parseAccountRef(b.account);
    const rpcUrl = optionalString(b.rpcUrl);
    const recipient = b.recipient ? parseAddress(b.recipient, 'recipient') : ref.address;

    const client = getPublicClient(sourceChainId, rpcUrl);
    const decimals = Number(await client.readContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }],
      functionName: 'decimals',
    }));
    const amountInWei = parseUnits(b.amount.toString(), decimals);
    const quote = await getAcrossQuote(sourceChainId, destChainId, tokenAddress, amountInWei.toString(), recipient);
    const bridgeCalls = buildBridgeCalls(quote, ref.address, recipient, tokenAddress, amountInWei, destChainId);

    const out = await paymasterCircuitBreaker.execute(() =>
      prepareOperation({
        chainId: sourceChainId,
        account: b.account,
        calls: bridgeCalls.map((c: any) => ({ to: c.to, value: c.value !== undefined ? String(c.value) : '0', abi: c.abi, functionName: c.functionName, args: c.args })),
        gas: b.gas ?? { mode: 'sponsored', flatMarkupTokenAddress: tokenAddress },
        purpose: 'bridge',
        ...(rpcUrl ? { rpcUrl } : {}),
      })
    );
    ok(res, {
      ...out,
      user_op_hash_hex: out.hashToSign,
      ticket_id: out.ticketId,
      expires_at_ms: out.expiresAt,
      ttl_ms: Math.max(0, out.expiresAt - Date.now()),
      smart_account_address: out.sender,
      chain_id: sourceChainId,
      bridge: {
        source_chain_id: sourceChainId,
        dest_chain_id: destChainId,
        input_token: tokenAddress,
        input_amount_wei: amountInWei.toString(),
        output_token: quote.outputToken.address,
        output_amount_wei: quote.outputAmount,
        spoke_pool: quote.spokePoolAddress,
        recipient,
      },
    }, 'Bridge UO prepared. Passkey-sign hashToSign and POST /api/transaction/submit-prepared.');
  } catch (e) {
    fail(res, e, '/api/bridge/preview');
  }
});

// { ticketId, authProof, signer? } — signer defaults to the shared signer
// for passkey-native Safes.
router.post('/api/transaction/submit-prepared', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const out = await submitOperation({ ticketId: b.ticketId, signer: b.signer, authProof: b.authProof });
    res.json({
      ...out,
      data: { ...out, userOperationHash: out.userOpHash },
      message: out.success ? 'User op submitted' : 'User op reverted on chain',
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    fail(res, e, '/api/transaction/submit-prepared');
  }
});

// Removed one-phase routes (server-held key signing).
router.post('/api/transfer', (_req, res) => gone(res, 'REPLACED_BY_PASSKEY_WALLETS', '/api/v3/prepare'));
router.post('/api/transaction', (_req, res) => gone(res, 'REPLACED_BY_PASSKEY_WALLETS', '/api/v3/prepare'));
router.post('/api/bridge', (_req, res) => gone(res, 'REPLACED_BY_PASSKEY_WALLETS', '/api/bridge/preview'));
router.post('/api/sign', (_req, res) => gone(res, 'EOA_SIGNING_REMOVED', '/api/v3/message/prepare'));

// ==================== READ-ONLY ESTIMATES ====================

/**
 * Estimate the paymaster's gas fee in the token being sent. Read-only.
 * Takes `account` (AccountRef, preferred) or a legacy `ownerAddress`.
 */
router.post('/api/estimate-fee', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const chainId = assertChain(b.chainId);
    parseAddress(b.tokenAddress, 'tokenAddress');
    parseAddress(b.recipient, 'recipient');
    if (b.account === undefined) parseAddress(b.ownerAddress, 'ownerAddress');
    if (typeof b.amount !== 'number' || b.amount <= 0) throw new PasskeyError('VALIDATION_ERROR', 'amount must be a positive number');
    const chainConfig = getChainConfig(chainId);
    if (!chainConfig?.bundlerUrl || !chainConfig.paymasterRPC) {
      throw new PasskeyError('CONFIGURATION_ERROR', `Missing bundler/paymaster env for chain ${chainId} (${chainConfig?.envPrefix})`);
    }
    const result = await paymasterCircuitBreaker.execute(() =>
      estimateTransfer({
        chainId,
        rpcUrl: getRpcUrl(chainId, optionalString(b.rpcUrl)),
        tokenAddress: b.tokenAddress,
        amount: b.amount,
        recipient: b.recipient,
        ...(b.ownerAddress ? { ownerAddress: b.ownerAddress } : {}),
        ...(b.account !== undefined ? { account: b.account } : {}),
        bundlerUrl: chainConfig.bundlerUrl,
        paymasterRPC: chainConfig.paymasterRPC,
        ...(b.markupBps !== undefined ? { markupBps: b.markupBps } : {}),
        ...(b.projectMarkupBps !== undefined ? { projectMarkupBps: b.projectMarkupBps } : {}),
        ...(b.projectTreasuryAddress !== undefined ? { projectTreasuryAddress: b.projectTreasuryAddress } : {}),
      })
    );
    if (!result.success) throw new PasskeyError('PREPARE_FAILED', result.error || 'Could not estimate fee');
    ok(res, { ...result.data }, `Fee estimated for chain ${chainId}`);
  } catch (e) {
    fail(res, e, '/api/estimate-fee');
  }
});

/** Real Across quote + paymaster gas in the token. Read-only. */
router.post('/api/bridge-quote', checkRateLimit, async (req, res) => {
  try {
    const b = req.body ?? {};
    const sourceChainId = assertChain(b.sourceChainId);
    const destChainId = assertChain(b.destChainId);
    parseAddress(b.tokenAddress, 'tokenAddress');
    if (b.account === undefined) parseAddress(b.ownerAddress, 'ownerAddress');
    if (b.recipient) parseAddress(b.recipient, 'recipient');
    if (typeof b.amount !== 'number' || b.amount <= 0) throw new PasskeyError('VALIDATION_ERROR', 'amount must be a positive number');
    const chainConfig = getChainConfig(sourceChainId);
    if (!chainConfig?.bundlerUrl || !chainConfig.paymasterRPC) {
      throw new PasskeyError('CONFIGURATION_ERROR', `Missing bundler/paymaster env for chain ${sourceChainId}`);
    }
    const result = await paymasterCircuitBreaker.execute(() =>
      estimateBridge({
        sourceChainId,
        destChainId,
        tokenAddress: b.tokenAddress,
        amount: b.amount,
        ...(b.ownerAddress ? { ownerAddress: b.ownerAddress } : {}),
        ...(b.account !== undefined ? { account: b.account } : {}),
        ...(b.recipient ? { recipient: b.recipient } : {}),
        rpcUrl: getRpcUrl(sourceChainId, optionalString(b.rpcUrl)),
        bundlerUrl: chainConfig.bundlerUrl,
        paymasterRPC: chainConfig.paymasterRPC,
      })
    );
    if (!result.success) throw new PasskeyError('PREPARE_FAILED', result.error || 'Could not produce bridge quote');
    ok(res, { ...result.data }, `Bridge quote ${sourceChainId} → ${destChainId}`);
  } catch (e) {
    fail(res, e, '/api/bridge-quote');
  }
});

// ==================== LEGACY SAFE ADDRESS (EOA-owned) ====================
//
// Address of a pre-migration EOA-owned Safe, from the owner ADDRESS only
// (the old private-key fallback is gone). Used to locate legacy wallets.

async function legacyAddress(body: any): Promise<{ address: Address; chainId: number; deployed: boolean }> {
  const chainId = assertChain(body?.chainId);
  const owner = parseAddress(body?.ownerAddress, 'ownerAddress');
  const client = getPublicClient(chainId, optionalString(body?.rpcUrl));
  const safe = await buildLegacySafe(client, addressOnlyOwner(owner));
  const code = await client.getCode({ address: safe.address }).catch(() => undefined);
  return { address: safe.address, chainId, deployed: !!code && code !== '0x' };
}

router.post('/api/smart-account/address', checkRateLimit, async (req, res) => {
  try {
    ok(res, { ...(await legacyAddress(req.body)) });
  } catch (e) {
    fail(res, e, '/api/smart-account/address');
  }
});

router.post('/api/smart-account/create', checkRateLimit, async (req, res) => {
  try {
    // Safes deploy lazily with their first UserOp — nothing to send here.
    ok(res, { ...(await legacyAddress(req.body)) });
  } catch (e) {
    fail(res, e, '/api/smart-account/create');
  }
});

// ==================== WALLETCONNECT ====================
//
// Sessions run server-side; every signing request is two-phase:
// /requests/:id/preview → hash_to_sign → passkey → /requests/:id/approve
// { authProof, signer }.

router.post('/api/walletconnect/pair', checkRateLimit, async (req, res) => {
  try {
    const { uri, chainId, account, rpcUrl } = req.body ?? {};
    if (!uri || typeof uri !== 'string') throw new PasskeyError('VALIDATION_ERROR', 'uri is required');
    if (account === undefined) {
      throw new PasskeyError('VALIDATION_ERROR', 'account (AccountRef) is required; key material is no longer accepted');
    }
    const result = await pairAndApprove(uri, account, chainId, optionalString(rpcUrl));
    ok(res, { ...result, chainId }, `Connected to ${result.peerName}. Requests need /preview + passkey /approve.`);
  } catch (e) {
    fail(res, e, '/api/walletconnect/pair');
  }
});

router.get('/api/walletconnect/sessions', checkRateLimit, async (_req, res) => {
  try {
    const sessions = await getActiveSessions();
    ok(res, { sessions }, `${sessions.length} active session(s)`);
  } catch (e) {
    fail(res, e, '/api/walletconnect/sessions');
  }
});

router.delete('/api/walletconnect/sessions/:topic', checkRateLimit, async (req, res) => {
  try {
    const topic = String(req.params.topic);
    await disconnectSession(topic);
    ok(res, {}, `Session ${topic} disconnected`);
  } catch (e) {
    fail(res, e, '/api/walletconnect/sessions/:topic');
  }
});

router.get('/api/walletconnect/requests', checkRateLimit, (_req, res) => {
  const requests = getPendingRequests();
  ok(res, { requests }, `${requests.length} pending request(s)`);
});

function requestId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new PasskeyError('VALIDATION_ERROR', 'Invalid request ID');
  return id;
}

router.post('/api/walletconnect/requests/:id/preview', checkRateLimit, async (req, res) => {
  try {
    const r = await previewSessionRequest(requestId(String(req.params.id)), {
      paymasterToken: typeof req.body?.paymasterToken === "string" ? req.body.paymasterToken : undefined,
    });
    ok(res, {
      method: r.method,
      peerName: r.peerName,
      smart_account_address: r.smartWalletAddress,
      chain_id: r.chainId,
      chainId: r.chainId,
      hash_to_sign: r.hashToSign,
      hashToSign: r.hashToSign,
      ticket_id: r.ticketId,
      ticketId: r.ticketId,
      expires_at_ms: r.expiresAtMs,
      expiresAt: r.expiresAtMs,
      ttl_ms: r.ttlMs,
      requires_auth_proof: r.requiresAuthProof,
    }, r.requiresAuthProof
      ? 'Passkey-sign hash_to_sign and POST /approve with { authProof, signer }.'
      : 'Nothing to sign — approve() directly.');
  } catch (e) {
    fail(res, e, '/api/walletconnect/requests/:id/preview');
  }
});

router.post('/api/walletconnect/requests/:id/approve', checkRateLimit, async (req, res) => {
  try {
    const { authProof, signer } = req.body ?? {};
    const result = await approveRequest(requestId(String(req.params.id)), { authProof, signer });
    ok(res, { result: result.result }, 'Request approved and executed');
  } catch (e) {
    fail(res, e, '/api/walletconnect/requests/:id/approve');
  }
});

router.post('/api/walletconnect/requests/:id/reject', checkRateLimit, async (req, res) => {
  try {
    await rejectRequest(requestId(String(req.params.id)));
    ok(res, {}, 'Request rejected');
  } catch (e: any) {
    if (e?.message?.includes('No pending request')) {
      fail(res, new PasskeyError('TICKET_NOT_FOUND', e.message), 'reject');
      return;
    }
    fail(res, e, '/api/walletconnect/requests/:id/reject');
  }
});

// ==================== V2 CLIENT-EOA RELAY ====================
router.use(v2Routes);

router.get('/api/system/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      timestamp: new Date().toISOString(),
      services: {
        paymaster: paymasterCircuitBreaker.getState(),
        rpc: rpcCircuitBreaker.getState(),
      },
      rateLimiting: {
        enabled: true,
        maxRequestsPerMinute: 1000,
      },
      passkeyCapabilities: getCapabilityTable(),
      supportedChains: SUPPORTED_CHAINS_LIST,
    },
    message: 'System status retrieved successfully',
  });
});

export default router;
