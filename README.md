# Smart Wallets Server

The ERC-4337 service that Rift's backend talks to whenever it needs
to send a UserOperation. Wraps Pimlico bundlers, builds Safe Account
Abstraction transactions, and either signs them locally (legacy
mode) or hands the userOpHash off to a Nitro Enclave for signing
(Phase 2 enclave mode). Same API contract for callers either way.

Stack: TypeScript, Express, viem, permissionless SDK, Pimlico v2
bundlers, the Safe singleton at version 1.4.1, and an EVM-side
ERC-20 paymaster.

## What it does

Takes a request shape that looks like "send N tokens from owner X
on chain Y to address Z" and turns it into a signed and bundled
ERC-4337 UserOperation that the recipient receives a couple of
seconds later. Gas is paid in the same token being transferred, via
the paymaster, so end users do not need ETH.

Two signing modes, picked at runtime by the SIGNING_MODE env var:

- Local mode (default). The owner's plaintext private key, either
  sent directly as ownerPrivateKey or recovered in process from an
  envelope blob, is held in JavaScript memory long enough to sign
  the userOpHash. Used in production today (smartwallet.riftfi.xyz).
- Enclave mode. The owner's plaintext key is never recovered here at
  all. The smart-wallet builds the userOpHash, then posts it to the
  parent-proxy /sign endpoint running on the EC2 alongside the Nitro
  Enclave. The enclave does the secp256k1 signing inside the TEE.
  Used in sandbox today (smart-wallet-tee Railway service) and
  scheduled for production cutover.

Both modes are wire-compatible. The caller (backend, integrating
partners) sends the same body shape regardless of which signing
mode is on. The dual implementation lives behind the makeSigner
factory in src/signerFactory.ts.

## API

### POST /api/transfer

Transfer any ERC-20 token on any supported chain with gas paid in
the same token.

```json
{
  "chainId": 8453,
  "tokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "recipient": "0x...",
  "amount": 3,
  "ownerEncryptedKey": "enc:v1:AQIDAH...:0a1b2c...:8f9e0d...",
  "ownerAddress": "0x...",
  "rpcUrl": "https://base-mainnet.g.alchemy.com/v2/<key>"
}
```

The caller has two equivalent options for key material:

- ownerEncryptedKey (preferred). The KMS envelope blob from the
  backend's encrypted_keys table. The smart-wallet decrypts in
  process via KMS in local mode, or forwards to the enclave in
  enclave mode. ownerAddress must be the EVM address of the owner
  EOA, sent alongside.
- ownerPrivateKey (legacy). The plaintext hex private key. Still
  supported for backwards compatibility with older backend
  deploys. Only works in local mode.

Validation:

- chainId, tokenAddress, recipient, amount, rpcUrl always required.
- In local mode, ownerPrivateKey is required. The service verifies
  it derives to the same address as ownerAddress before continuing.
- In enclave mode, ownerEncryptedKey and ownerAddress are required.
  No private-key derivation is possible, so ownerAddress is taken
  on trust. If the enclave eventually produces a signature
  recoverable to that address, the UserOp succeeds. Otherwise it
  fails at the bundler with a signature-verification error.

Response:

```json
{
  "success": true,
  "data": {
    "userOperationHash": "0x...",
    "chainId": 8453
  },
  "message": "Transfer completed successfully on chain 8453",
  "timestamp": "2026-06-25T13:46:58.490Z"
}
```

### POST /api/transaction

Same dispatch as /api/transfer, but accepts an array of arbitrary
calls (to, data, value, or to, abi, functionName, args). Useful for
contract interactions other than plain ERC-20 transfers. Same
key-material handling.

### POST /api/bridge

Wraps Across Protocol for crosschain USDC and USDT. Builds the
deposit on the source chain, signs the UserOp, sends, and returns
the bundle hash. The recipient on the destination chain defaults to
the sender's own Safe smart-account address since Safe addresses are
canonical across EVM chains.

### POST /api/smart-account/address

Computes the deterministic Safe smart-account address for a given
EOA. Pure derivation, no chain side-effects. Accepts ownerAddress
directly (preferred); falls back to ownerPrivateKey to derive the
address from for backwards compatibility.

The returned address is valid on every EVM chain Rift supports. The
Safe singleton and Proxy Factory are deployed at canonical addresses
on every supported chain, so CREATE2 with the same salt produces
the same address everywhere.

### POST /api/sign

Direct signing primitive. Forwards a precomputed 32-byte digest to
the enclave's /sign endpoint. Used by direct callers who have built
their own UserOp and just need a signature. Only valid in enclave
mode.

### POST /api/walletconnect/pair, /approve, /reject, /requests

Holds a WalletConnect v2 session inside this process so the SDK
client does not have to. Pairs a URI to a smart-account, holds the
session, and routes approvals back through the same Safe signing
path as everything else.

### GET /health

Returns plain "ok". Used by Railway's healthcheck.

## Signing-mode internals

### Local mode

The body either has ownerPrivateKey (used as-is) or ownerEncryptedKey
(decrypted by middleware/resolveOwnerKey.ts via the KMS client in
src/keyEncryption.ts before the route handler runs). Either way,
ownerPrivateKey is populated on req.body by the time the route
handler runs.

makeSigner builds a viem account with privateKeyToAccount and that
gets passed to toSafeSmartAccount. The Safe builds and signs the
UserOp in process.

This is what production smartwallet.riftfi.xyz runs today. The
plaintext lives in JS memory for the lifetime of one signing call.

### Enclave mode (SIGNING_MODE=enclave)

middleware/resolveOwnerKey.ts is short-circuited: when in enclave
mode, it does not decrypt the envelope. It leaves the envelope on
req.body and stamps ownerAddress so route handlers know which
address the eventual signature will be valid for.

makeSigner builds a viem account using viem's toAccount() with a
custom signMessage that posts the message hash to the parent-proxy
/sign endpoint over HTTPS. The Bearer token is read from
PARENT_PROXY_AUTH_TOKEN. The parent-proxy authenticates,
forwards to the enclave over vsock, and returns the 65-byte
signature.

toSafeSmartAccount sees a normal viem account, calls .signMessage()
on it when building the UserOp, and never knows the signing
happened in a TEE.

The flow:

```
caller
  |
  POST /api/transfer (body has envelope + ownerAddress)
  v
smart-wallet (Railway)
  |
  build UserOp, compute userOpHash
  |
  POST /sign (body has envelope + userOpHash + kms_key_arn)
  v
parent-proxy (EC2)
  |
  vsock to enclave (port 5005)
  v
enclave
  |
  NSM attest, KMS Decrypt with Recipient, AES-decrypt envelope,
  secp256k1 sign userOpHash, zeroize
  |
  vsock reply with 65-byte signature
  v
parent-proxy
  |
  HTTPS reply with signature_hex
  v
smart-wallet
  |
  attach signature, send UserOp to Pimlico bundler, paymaster
  pays gas
  |
  HTTPS reply with userOperationHash
  v
caller
```

The plaintext EOA private key never enters the smart-wallet process
in enclave mode. It only ever exists inside the enclave's RAM,
released by KMS after PCR0 attestation, for the duration of one
ECDSA signing operation.

## Setup

```sh
npm install
cp env.example .env
```

Edit .env. Required:

```
PIMLICO_API_KEY=<your Pimlico key>

# Per-chain bundler URLs (Pimlico)
ETHEREUM_BUNDLER_URL=https://api.pimlico.io/v1/ethereum/rpc?apikey=<key>
ETHEREUM_PAYMASTER_RPC=https://api.pimlico.io/v2/ethereum/rpc?apikey=<key>
BASE_BUNDLER_URL=https://api.pimlico.io/v1/base/rpc?apikey=<key>
BASE_PAYMASTER_RPC=https://api.pimlico.io/v2/base/rpc?apikey=<key>
POLYGON_BUNDLER_URL=https://api.pimlico.io/v1/polygon/rpc?apikey=<key>
POLYGON_PAYMASTER_RPC=https://api.pimlico.io/v2/polygon/rpc?apikey=<key>
CELO_BUNDLER_URL=https://api.pimlico.io/v1/celo/rpc?apikey=<key>
CELO_PAYMASTER_ADDRESS=<deployed Celo paymaster address>
CELO_PAYMASTER_SIGNER_KEY=<celo paymaster signer key>
CELO_PAYMASTER_OWNER_KEY=<celo paymaster owner key>

NODE_ENV=development
PORT=3000
```

For local mode KMS envelope handling:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
KMS_KEY_ARN=arn:aws:kms:us-east-1:<account>:key/<key-id>
ENCRYPTION_KEY=...   # only needed if any caller still sends legacy AES blobs
```

For enclave mode:

```
SIGNING_MODE=enclave
PARENT_PROXY_URL=https://<EC2 nginx host>
PARENT_PROXY_AUTH_TOKEN=<32-byte hex secret>
KMS_KEY_ARN=arn:aws:kms:us-east-1:<account>:key/<key-id>
```

KMS_KEY_ARN is the CMK whose policy has the PCR0 attestation
condition. The smart-wallet passes it through to the parent-proxy
which passes it through to KMS.

Then:

```sh
npm run dev
```

## Supported chains

ERC-4337 with Pimlico bundlers and paymasters: Ethereum, Base,
Polygon, Arbitrum, Optimism, Avalanche, BSC, Lisk.

Celo runs the same flow but uses Rift's own verifying paymaster
contract instead of Pimlico's ERC-20 paymaster, because Pimlico does
not yet cover Celo with ERC-20 gas. See CELO_PAYMASTER.md for the
contract layout, the off-chain price-feed loop that signs
pricePerNative into the paymasterAndData blob per UserOp, and the
ops loop.

For adding a new chain:

1. Add the chain to src/chains.ts with chainId, rpcUrl, bundlerUrl,
   paymasterRpc.
2. Add the chain's bundler and paymaster env vars to .env.
3. Update routes.ts if the chain needs any special handling.

## Project layout

```
src/
  server.ts            Express bootstrap
  routes.ts            Endpoint definitions and validation
  abstraction.ts       Safe smart-account + Pimlico flow per chain
  signerFactory.ts     makeSigner; picks enclave or local based on env
  signingMode.ts       enclave-side helpers (signWithEnclave, parseEnvelope)
  middleware/
    resolveOwnerKey.ts unwraps envelope to plaintext in local mode;
                       leaves envelope on body in enclave mode
  keyEncryption.ts     KMS Decrypt + legacy AES fallback
  kms.ts               AWS KMS client wrapper
  relay.ts             Direct relay path for client-signed UserOps
  celo-paymaster.ts    Off-chain pricePerNative signer for Celo
  utils.ts             Rate limit + circuit breaker
contracts/
  src/
    Erc20Paymaster.sol      Verifying paymaster (ERC-4337 v0.7)
  script/
    DeployErc20Paymaster.s.sol
scripts/
  configure-celo-paymaster.ts
  probe-celo-paymaster-tokens.ts
```

## Operational notes

- Pushes to feat/enclave-mode auto-deploy to the Railway service
  smart-wallet-tee. That service has SIGNING_MODE=enclave set.
- Pushes to main auto-deploy to smartwallet.riftfi.xyz (Render).
  That service has SIGNING_MODE unset (local mode).
- The backend's selectSmartWalletEndpoint helper picks between the
  two based on the X-Rift-Mode request header. Sandbox traffic goes
  to the enclave-aware service, production stays on the legacy one
  until prod cutover.
- KMS_KEY_ARN must be set on the smart-wallet service when running
  in enclave mode. The service does not call KMS itself in enclave
  mode but it passes the ARN through to the parent-proxy.

## Validation history

The full enclave-signed flow has been validated end-to-end on Base
mainnet. Sample run:

- POST /api/transfer with envelope + ownerAddress arrives at
  smart-wallet-tee.
- smart-wallet-tee builds the UserOp and posts the userOpHash to
  parent-proxy /sign.
- Parent-proxy authenticates the Bearer token and forwards over
  vsock.
- Enclave generates an ephemeral RSA-2048 keypair, requests an NSM
  attestation, asks KMS Decrypt with Recipient, unwraps the DEK,
  decrypts the envelope, secp256k1 signs, zeroizes, replies.
- Smart-wallet attaches the signature and sends the UserOp to
  Pimlico.
- Pimlico bundles it on chain, paymaster pays gas in the token
  being transferred.
- Recipient receives the funds.

Example transaction hash from a 3.996 USDC transfer on Base:
0x01a936f2226f27b0484d3700ce6ec90ba82d13ddde2bbd7c066b96cdf842e019.

## Security features

- Helmet for security headers.
- Rate limit: 1000 requests per minute per IP.
- Circuit breakers around Pimlico, Coingecko, and any other
  upstream that can fail.
- Address validation (viem isAddress).
- Owner-address-against-private-key check in local mode; skipped in
  enclave mode (the enclave will produce a signature recoverable to
  whichever address it can sign for, and the bundler will reject any
  mismatch).
- CORS configurable.
- KMS envelope decryption in local mode and enclave-routed signing
  in enclave mode mean the plaintext private key never crosses
  HTTPS in either configuration.

## Threat model

Pre-Phase-0:

- Caller sent plaintext ownerPrivateKey over HTTPS.
- Smart-wallet held the plaintext in middleware and in Express
  request context for the lifetime of the call.
- LB, CDN, or any proxy logging the body could capture the key.
- Any breakpoint or memory dump on smart-wallet host could capture
  the key.

Phase 0.5 (local mode in production today):

- Caller sends opaque envelope blob.
- Smart-wallet calls KMS to decrypt in process. Plaintext lives in
  JS memory for the lifetime of the signing call.
- HTTPS body and any external proxy never see plaintext.
- Memory dump on the smart-wallet host can still capture the key
  for the short window it is in scope.

Phase 2 (enclave mode in sandbox today):

- Caller sends opaque envelope blob plus ownerAddress.
- Smart-wallet never decrypts. It forwards the envelope plus the
  userOpHash to the parent-proxy.
- Plaintext is reconstructed only inside the Nitro Enclave, which
  has no network, no disk, and is not introspectable by AWS, Rift,
  or any operator.
- KMS releases the wrapped DEK only to attestation documents whose
  PCR0 hash matches the allowlist in the CMK key policy. Without
  the exact enclave image you cannot decrypt, even with full IAM
  access.

## License

Proprietary, Rift Finance.
