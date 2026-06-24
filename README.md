# Smart Wallets Server 

**ERC-4337 Account Abstraction API** - Gasless ERC-20 token transfers with Pimlico + Custom Paymaster infrastructure

A production-ready TypeScript Express server that enables **gasless token transfers** using **smart contract wallets** and **ERC-20 paymasters**. Users pay gas fees in USDC/tokens instead of ETH, making Web3 accessible to mainstream users.

## 🚀 What This Does

- **Smart Contract Wallets**: Every user gets a deterministic Safe smart account
- **Gasless Transactions**: Users pay gas fees in USDC/tokens, not ETH
- **Account Abstraction**: ERC-4337 standard with Pimlico bundler/paymaster
- **Custom Paymaster (Celo)**: Self-hosted verifying paymaster for chains not supported by Pimlico's ERC-20 paymaster
- **Multi-chain Support**: Base, Polygon, Celo, and 100+ EVM chains
- **Universal API**: Single `/api/transfer` endpoint for all chains — same request format regardless of chain
- **Production Ready**: Rate limiting, circuit breakers, error handling
- **KMS Envelope Encryption**: Optionally accepts `ownerEncryptedKey` (envelope blob) instead of `ownerPrivateKey`. The service decrypts in-process via AWS KMS — plaintext keys never have to cross HTTPS. See [KMS Envelope Encryption](#-kms-envelope-encryption) below.

## 🏗️ How It Works

1. **Caller submits transfer** with EOA key material (either plaintext `ownerPrivateKey` OR envelope-encrypted `ownerEncryptedKey`) + token details
2. **`resolveOwnerKey` middleware** unwraps the envelope via AWS KMS when present, so downstream handlers always see a plaintext `ownerPrivateKey` in memory
3. **Smart account created** deterministically (same address across chains) — Safe 1.4.1 via the `permissionless` SDK
4. **Paymaster sponsors gas** using user's tokens:
   - **Most chains**: Pimlico ERC-20 paymaster
   - **Celo**: Custom `Erc20Paymaster` verifying paymaster + Pimlico bundler (see [CELO_PAYMASTER.md](CELO_PAYMASTER.md))
5. **Transaction executed** instantly, returns UserOperation hash
6. **Caller tracks** transaction on block explorer

> **Note**: The API interface is identical for all chains. Celo uses a custom paymaster behind the scenes, but callers send the exact same request body and receive the same response format.

## 🛠️ Quick Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Copy the example environment file:
```bash
cp env.example .env
```

Edit `.env` with your API keys:
```env
# Pimlico API Key (get from https://dashboard.pimlico.io)
PIMLICO_API_KEY=your_pimlico_api_key_here

# Ethereum Mainnet (Chain ID: 1)
ETHEREUM_BUNDLER_URL=https://api.pimlico.io/v1/ethereum/rpc?apikey=your_pimlico_api_key_here
ETHEREUM_PAYMASTER_RPC=https://api.pimlico.io/v2/ethereum/rpc?apikey=your_pimlico_api_key_here

# Base Chain (Chain ID: 8453)
BASE_BUNDLER_URL=https://api.pimlico.io/v1/base/rpc?apikey=your_pimlico_api_key_here
BASE_PAYMASTER_RPC=https://api.pimlico.io/v2/base/rpc?apikey=your_pimlico_api_key_here

# Polygon Chain (Chain ID: 137)
POLYGON_BUNDLER_URL=https://api.pimlico.io/v1/polygon/rpc?apikey=your_pimlico_api_key_here
POLYGON_PAYMASTER_RPC=https://api.pimlico.io/v2/polygon/rpc?apikey=your_pimlico_api_key_here

# Celo Chain (Chain ID: 42220) — bundler from Pimlico, custom paymaster contract
CELO_BUNDLER_URL=https://api.pimlico.io/v1/celo/rpc?apikey=your_pimlico_api_key_here
CELO_PAYMASTER_ADDRESS=your_deployed_celo_paymaster_address
CELO_PAYMASTER_SIGNER_KEY=your_celo_paymaster_signer_private_key
CELO_PAYMASTER_OWNER_KEY=your_celo_paymaster_owner_private_key

# Development settings
NODE_ENV=development
PORT=3000

# ── KMS envelope encryption (see "KMS Envelope Encryption" section below) ──
# Required when callers send `ownerEncryptedKey` instead of `ownerPrivateKey`.
# Without these, the service still works — it just falls back to the plaintext
# field. Reuse the same IAM user the backend uses (rift-backend-kms in our
# infra); permissions needed: kms:Decrypt on both prod and sandbox CMKs.
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1

# Optional: needed only when callers might send legacy AES blobs
# (pre-envelope rows that haven't been migrated yet). Same value as
# the backend's ENCRYPTION_KEY env. Drop this once every row in
# encrypted_keys is in `enc:v1:` format.
ENCRYPTION_KEY=...
```

### 3. Start Development Server
```bash
npm run dev
```

Server runs on `http://localhost:3000`

## 📡 API Usage

### Universal Transfer Endpoint

**POST** `/api/transfer`

Transfer any ERC-20 token on any supported chain with gas paid in tokens.

Two equivalent key-material options — see the [KMS Envelope Encryption](#-kms-envelope-encryption) section for which to prefer:

```json
// Envelope path (preferred — plaintext never leaves the caller's process or KMS)
{
  "chainId": 137,
  "tokenAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "recipient": "0xRecipientAddress",
  "amount": 1.5,
  "ownerEncryptedKey": "enc:v1:AQIDAHhZ8uEMe.../...:abc...:def...",
  "ownerAddress": "0xYourAddress",
  "rpcUrl": "https://polygon-rpc.com"
}

// Plaintext path (still supported — kept for backwards compatibility)
{
  "chainId": 137,
  "tokenAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "recipient": "0xRecipientAddress",
  "amount": 1.5,
  "ownerPrivateKey": "0xYourPrivateKey",
  "ownerAddress": "0xYourAddress",
  "rpcUrl": "https://polygon-rpc.com"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "userOperationHash": "0x1234...",
    "chainId": 137
  },
  "message": "Transfer completed successfully on chain 137",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Health Check

**GET** `/health`

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 12345,
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

## 🌐 Supported Chains

**Pimlico-powered chains:**
| Chain | ID | Bundler | Paymaster |
|-------|------|---------|-----------|
| Ethereum | 1 | Pimlico | Pimlico ERC-20 |
| Base | 8453 | Pimlico | Pimlico ERC-20 |
| Polygon | 137 | Pimlico | Pimlico ERC-20 |
| Arbitrum | 42161 | Pimlico | Pimlico ERC-20 |
| Avalanche | 43114 | Pimlico | Pimlico ERC-20 |
| BNB Chain | 56 | Pimlico | Pimlico ERC-20 |
| Berachain | 80094 | Pimlico | Pimlico ERC-20 |

**Custom paymaster chains:**
| Chain | ID | Bundler | Paymaster | Supported Tokens |
|-------|------|---------|-----------|-----------------|
| Celo | 42220 | Pimlico | Custom `Erc20Paymaster` | USDC (`0xceBA9300...18C`), USDT (`0x48065fbB...D5e`) |

> Pimlico's ERC-20 paymaster does not currently sponsor any tokens on Celo, so we run a self-hosted **verifying paymaster** contract there. The bundler is still Pimlico. The API is identical — callers don't need to know the difference. See [CELO_PAYMASTER.md](CELO_PAYMASTER.md) for full architecture, addresses, and operations.

**Easily Expandable to 100+ Chains:**
- Ethereum, Arbitrum, Optimism, zkSync Era
- Avalanche, BNB Chain, Fantom, Gnosis
- And many more EVM-compatible chains

## 🔧 How to Add New Chains

1. **Add environment variables** to `.env`:
```env
ARBITRUM_BUNDLER_URL=https://api.pimlico.io/v1/arbitrum/rpc?apikey=your_pimlico_api_key_here
ARBITRUM_PAYMASTER_RPC=https://api.pimlico.io/v2/arbitrum/rpc?apikey=your_pimlico_api_key_here
```


2. **Update chain config** in `src/abstraction.ts`:
```typescript
import { arbitrum } from "viem/chains";

const CHAINS = {
  8453: base,
  137: polygon,
  42161: arbitrum  // Add new chain
};
```

3. **Update routes** in `src/routes.ts` to handle new chain ID

## 🏗️ Architecture

### Core Components
- **Smart Accounts**: Safe v1.4.1 smart contract wallets (deterministic address across all chains)
- **Bundler**: Pimlico for all chains
- **Paymaster**: Pimlico ERC-20 paymaster (most chains) / Custom `Erc20Paymaster` verifying paymaster (Celo)
- **CELO/USD Price Oracle**: Coingecko free public API, fetched fresh per UserOp on Celo
- **Rate Limiter**: 1000 requests/minute per IP
- **Circuit Breaker**: Resilience for external service calls

### Paymaster Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     API Request                              │
│  POST /api/transfer { chainId, token, amount, ... }         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │ isCeloChain? │
                    └──────┬──────┘
                     No    │    Yes
              ┌────────────┴────────────┐
              ▼                         ▼
    ┌─────────────────┐     ┌──────────────────────┐
    │     Pimlico      │     │   Custom Paymaster    │
    │  ─────────────   │     │  ──────────────────   │
    │  Bundler: Pimlico│     │  Bundler: Pimlico     │
    │  Paymaster: ERC20│     │  Paymaster: own contr.│
    │  Gas: Pimlico    │     │  Price: Coingecko/req │
    └─────────────────┘     └──────────────────────┘
              │                         │
              └────────────┬────────────┘
                           ▼
              Same response format to caller
```

For Celo's full architecture, addresses, deduction math, and ops loop, see
[CELO_PAYMASTER.md](CELO_PAYMASTER.md).

### Project Structure
```
src/
├── server.ts          # Express server setup
├── types.ts           # TypeScript interfaces
├── routes.ts          # API endpoints & validation
├── abstraction.ts     # Smart account & Pimlico/Celo routing logic
├── celo-paymaster.ts  # Custom paymaster middleware, signs pricePerNative per UserOp
├── relay.ts           # Client-signed UserOp relay path
├── utils.ts           # Rate limiting & circuit breakers
└── ...

contracts/
├── src/
│   └── Erc20Paymaster.sol  # Verifying paymaster (ERC-4337 v0.7, EntryPoint v0.7)
├── script/
│   └── DeployErc20Paymaster.s.sol
├── foundry.toml
└── remappings.txt

scripts/
├── configure-celo-paymaster.ts   # Enables USDC/USDT on the deployed Celo paymaster
└── probe-celo-paymaster-tokens.ts # Diagnostic for Pimlico's Celo paymaster coverage
```

## 🔒 Security Features

- **Helmet**: Security headers protection
- **Rate Limiting**: Prevents API abuse (1000 req/min)
- **Circuit Breakers**: Prevents cascading failures
- **Input Validation**: Address & amount validation
- **Private Key Verification**: Ensures key matches address
- **Error Handling**: Graceful error responses
- **CORS**: Configurable cross-origin protection
- **KMS Envelope Decryption**: When callers send `ownerEncryptedKey`, plaintext keys never cross HTTPS — see below

## 🔐 KMS Envelope Encryption

> ✅ **Validated end-to-end in production**: real offramp executed successfully against a user whose `encrypted_keys` row had been migrated to the envelope format. Full chain — backend KMS decrypt → smart-wallet KMS decrypt → Safe signing → on-chain settlement — works.

### Why

The original API contract required the caller to send `ownerPrivateKey` (plaintext) over HTTPS. Even with TLS, that meant the plaintext EOA key sat in:

- the backend's HTTP response context after decrypting from DB
- the smart-wallet's request body / Express middleware chain
- any LB / CDN / proxy logging the body
- request-debug breakpoints anywhere on the network path

A single misconfigured proxy or accidental log line would leak key material. After Phase 0.5, the HTTPS body carries an opaque envelope blob; the smart-wallet decrypts it in-process via KMS just before signing, then the plaintext lives in memory for the duration of the signing call only.

### What changed in this repo

| File | Purpose |
|---|---|
| `src/kms.ts` | AWS KMS client — Decrypt only. KeyId is intentionally not pinned; KMS infers the CMK from the ciphertext metadata, so the same code handles production and sandbox CMKs without mode awareness here. |
| `src/keyEncryption.ts` | `decryptKey(blob)` — detects `enc:v1:` prefix → KMS path; otherwise falls back to legacy AES under `ENCRYPTION_KEY`. Byte-for-byte mirror of the backend's `utils/keyEncryption.ts`. |
| `src/middleware/resolveOwnerKey.ts` | Mounted at the router root. If `body.ownerEncryptedKey` is present, decrypts it and writes `body.ownerPrivateKey` so the 8 existing route handlers don't need code changes. If only `ownerPrivateKey` is present, it's a no-op. |

### Envelope format

Same column on the backend (`encrypted_keys.encrypted_keys`) carries either format; the prefix distinguishes them:

```
Legacy (pre-Phase 0):
  <iv_hex>:<ciphertext_hex>
  AES-256-CBC, key = sha256(ENCRYPTION_KEY)

Envelope (Phase 0 onwards):
  enc:v1:<wrapped_dek_b64>:<iv_hex>:<ciphertext_hex>
  - wrapped_dek_b64: AWS KMS-wrapped 256-bit DEK
  - iv_hex: 16 random bytes
  - ciphertext_hex: AES-256-CBC of the plaintext private key under that DEK
```

### Request shape — caller's options

The API accepts EITHER field; the middleware figures out which path to take. Backwards-compatible by design so backend + smart-wallet can be deployed in any order.

```jsonc
// New: envelope path (preferred)
{
  "chainId": 137,
  "ownerEncryptedKey": "enc:v1:AQIDAHhZ8uEMe.../...:abc...:def...",
  "ownerAddress": "0x...",
  // ... rest unchanged
}

// Legacy: plaintext path (still works)
{
  "chainId": 137,
  "ownerPrivateKey": "0xac09...",
  "ownerAddress": "0x...",
  // ... rest unchanged
}
```

If both are present, `ownerPrivateKey` wins (treated as legacy caller). Drop the plaintext field from your client once you've verified the envelope path works.

### Threat model — before vs after

| Failure mode | Before Phase 0.5 | After |
|---|---|---|
| Misconfigured proxy logs request bodies | Plaintext key in logs | Opaque envelope; useless without KMS |
| Stale CDN response cache | Plaintext leaks | Opaque envelope leaks |
| Compromised backend env (`ENCRYPTION_KEY` leaks) | Drains every user in the DB | No-op — KMS access also required |
| Stolen backend → smart-wallet HTTPS pcap | Plaintext key extracted | Envelope extracted; useless without KMS |
| Smart-wallet host root compromise | Plaintext keys in memory | Plaintext keys in memory (TEE work required to close this — Phase 1) |

The remaining attack — root on the smart-wallet host — is what AWS Nitro Enclaves or confidential VMs would close. That's Phase 1 territory; for Phase 0.5 the network/at-rest gaps are eliminated.

### Where the IAM permissions live

The smart-wallet reuses the same IAM user the backend uses (`rift-backend-kms` in our infra). The policy attached to that user:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowKmsEnvelopeOps",
    "Effect": "Allow",
    "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
    "Resource": [
      "arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/<prod-key-uuid>",
      "arn:aws:kms:us-east-1:<ACCOUNT_ID>:key/<sandbox-key-uuid>"
    ]
  }]
}
```

The smart-wallet only ever uses `kms:Decrypt`; the broader policy is fine because the same IAM user is shared with the backend (which does need `Encrypt` and `GenerateDataKey` for the migration script and new-user signups).

### Operational notes

- **Latency**: each `decryptKey()` call adds ~30-80ms (KMS round-trip + region latency). Subsequent calls in the same Node process don't get cached — KMS is hit on every decrypt by design (so revoking IAM at AWS instantly stops signing without a code change here).
- **CloudTrail**: every decrypt is logged in AWS CloudTrail with the caller's IAM principal, the CMK used, and the request ID. Look there if you ever need to forensically reconstruct which keys were unwrapped when.
- **Multi-region**: the CMKs are single-region (us-east-1). If the smart-wallet ever runs outside us-east-1 the KMS calls cross regions and pay the round-trip; consider multi-region keys at that point.
- **Wipe-after-use**: the unwrapped DEK is filled with zeros in a `finally` block after each decrypt to shrink the in-memory plaintext lifetime as much as the runtime allows.

## 🚀 Production Deployment

### Build & Start
```bash
npm run build
npm start
```

### Environment Variables for Production
```env
NODE_ENV=production
PORT=3000
PIMLICO_API_KEY=your_production_api_key_here
# Add all chain URLs with your API key...
```

### Health Monitoring
- **Health Check**: `GET /health`
- **System Status**: `GET /api/system/status`
- **Circuit Breaker States**: Monitor service health

## 📊 Example Use Cases

- **DeFi Apps**: Gasless token swaps and transfers
- **Gaming**: In-game token transactions without ETH
- **E-commerce**: USDC payments without gas complexity
- **Social Apps**: Tip/reward users in tokens
- **Cross-chain Apps**: Same smart account across chains

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## 📝 Scripts

- `npm run dev` - Development server with hot reload
- `npm run build` - Build TypeScript to JavaScript  
- `npm start` - Start production server
- `npm run type-check` - TypeScript type checking

---


### Signing transactions gaslessly


1. Example one is to do an approve transaction

```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 137,
    "calls": [
      {
        "to": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        "abi": [
          {
            "name": "approve",
            "type": "function",
            "stateMutability": "nonpayable",
            "inputs": [
              {"type": "address", "name": "spender"},
              {"type": "uint256", "name": "amount"}
            ],
            "outputs": [
              {"type": "bool"}
            ]
          }
        ],
        "functionName": "approve",
        "args": [
          "0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4",
          "10000000"
        ]
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xbEebf8C3a3E27389FC2072Fc1D6fd84b7fCC9075",
    "rpcUrl": "https://polygon-rpc.com",
    "paymasterToken": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
  }'
  ```


2. Example 2 is submit a crosschain swap transaction using li.fi
```bash
{
    "chainId": 137,
    "calls": [
      {
        "to": "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
        "value": "208572947037524672",
        "data": "0xa6010a660000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000004008d0639912783996e3fd5ba138cef3a8eed228cc75868d853ee5fb7d3345bcf6e0000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c499c542cef5e3811e1192ce70d8cc03d5c3359000000000000000000000000beebf8c3a3e27389fc2072fc1d6fd84b7fcc907500000000000000000000000000000000000000000000000000000000000003e6000000000000000000000000000000000000000000000000000000000000210500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a737461726761746556320000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086c6966692d61706900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000bd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9000000000000000000000000bd6c7b0d2f68c2b7805d88388319cfb6ecb50ea90000000000000000000000003c499c542cef5e3811e1192ce70d8cc03d5c33590000000000000000000000003c499c542cef5e3811e1192ce70d8cc03d5c335900000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000084eedd56e10000000000000000000000003c499c542cef5e3811e1192ce70d8cc03d5c335900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000b9c0de368bece5e76b52545a8e377a4c118f597b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000002e4fffd81ed92c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000beebf8c3a3e27389fc2072fc1d6fd84b7fcc907500000000000000000000000000000000000000000000000000000000000075e8000000000000000000000000beebf8c3a3e27389fc2072fc1d6fd84b7fcc907500000000000000000000000000000000000000000000000000000000000003e600000000000000000000000000000000000000000000000000000000000003df00000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "ownerPrivateKey": "",
    "ownerAddress": "0x888e16644448B9c94f23A1c19B83459f47332496",
    "rpcUrl": "https://polygon-rpc.com"
  }
  ```

### Native Token Transfers (ETH, MATIC, etc.) 💰

Send native tokens (ETH, MATIC) gaslessly using ERC-4337 and Pimlico paymasters.

3. **Send 1 MATIC on Polygon** (with sponsored gas):
```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 137,
    "calls": [
      {
        "to": "0xRecipientAddress",
        "value": "1000000000000000000"
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourAddress",
    "rpcUrl": "https://polygon-rpc.com"
  }'
```

4. **Send 0.5 ETH on Base** (pay gas with USDC):
```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 8453,
    "calls": [
      {
        "to": "0xRecipientAddress",
        "value": "500000000000000000"
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourAddress",
    "rpcUrl": "https://mainnet.base.org",
    "paymasterToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }'
```

5. **Batch native transfers** (send to multiple recipients):
```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 137,
    "calls": [
      {
        "to": "0xRecipient1",
        "value": "1000000000000000000"
      },
      {
        "to": "0xRecipient2",
        "value": "2000000000000000000"
      },
      {
        "to": "0xRecipient3",
        "value": "500000000000000000"
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourAddress",
    "rpcUrl": "https://polygon-rpc.com"
  }'
```

6. **Mixed transaction** (native transfer + token transfer):
```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 137,
    "calls": [
      {
        "to": "0xRecipient",
        "value": "1000000000000000000"
      },
      {
        "to": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        "abi": [
          {
            "name": "transfer",
            "type": "function",
            "inputs": [
              {"type": "address", "name": "to"},
              {"type": "uint256", "name": "amount"}
            ]
          }
        ],
        "functionName": "transfer",
        "args": ["0xRecipient", "1000000"]
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourAddress",
    "rpcUrl": "https://polygon-rpc.com",
    "paymasterToken": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
  }'
```

### Smart Account Management 🏦

Get smart account addresses and create accounts deterministically.

7. **Get smart account address**:
```bash
curl -X POST http://localhost:3000/api/smart-account/address \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 137,
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "rpcUrl": "https://polygon-rpc.com"
  }'
```

8. **Create smart account**:
```bash
curl -X POST http://localhost:3000/api/smart-account/create \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 137,
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "rpcUrl": "https://polygon-rpc.com"
  }'
```

### Ethereum Mainnet USDC Transfer Example 🔷

9. **Transfer USDC on Ethereum Mainnet**:
```bash
curl -X POST http://localhost:3000/api/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1,
    "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "recipient": "0xRecipientAddress",
    "amount": 10.5,
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourEOAAddress",
    "rpcUrl": "https://eth.llamarpc.com"
  }'
```

10. **Send ETH on Ethereum Mainnet** (pay gas with USDC):
```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1,
    "calls": [
      {
        "to": "0xRecipientAddress",
        "value": "1000000000000000000"
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourEOAAddress",
    "rpcUrl": "https://eth.llamarpc.com",
    "paymasterToken": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  }'
```

### Celo USDT Transfer Example 🟡

11. **Transfer USDT on Celo**:
```bash
curl -X POST http://localhost:3000/api/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 42220,
    "tokenAddress": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    "recipient": "0xRecipientAddress",
    "amount": 7.53,
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourEOAAddress",
    "rpcUrl": "https://forno.celo.org"
  }'
```

12. **Universal transaction on Celo** (with USDT for gas):
```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 42220,
    "calls": [
      {
        "to": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
        "abi": [
          {
            "name": "transfer",
            "type": "function",
            "inputs": [
              {"type": "address", "name": "to"},
              {"type": "uint256", "name": "amount"}
            ]
          }
        ],
        "functionName": "transfer",
        "args": ["0xRecipientAddress", "7530000"]
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourEOAAddress",
    "rpcUrl": "https://forno.celo.org",
    "paymasterToken": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"
  }'
```

---

## 🔐 V2 API — Client-Side Signing (No Private Keys)

The v2 API eliminates the need to send private keys to the server. Instead, the server prepares the UserOperation, returns a hash for the client to sign locally, and then relays the signed operation to the bundler.

**The server never sees the private key.**

### How It Works

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│  Client   │                    │  Server   │                    │ Bundler   │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │  POST /api/v2/prepare         │                               │
     │  { ownerAddress, chainId,     │                               │
     │    tokenAddress, amount, ... } │                               │
     │──────────────────────────────▶│                               │
     │                               │ Build UserOp, estimate gas,   │
     │                               │ get paymaster data             │
     │  { userOperation, hashToSign }│                               │
     │◀──────────────────────────────│                               │
     │                               │                               │
     │  Sign hashToSign locally      │                               │
     │  (personal_sign / eth_sign)   │                               │
     │                               │                               │
     │  POST /api/v2/submit          │                               │
     │  { userOperation, signature,  │                               │
     │    chainId }                  │                               │
     │──────────────────────────────▶│                               │
     │                               │  eth_sendUserOperation        │
     │                               │──────────────────────────────▶│
     │                               │  userOperationHash            │
     │  { userOperationHash }        │◀──────────────────────────────│
     │◀──────────────────────────────│                               │
```

### Step 1: Prepare UserOperation

**POST** `/api/v2/prepare`

**For a token transfer:**
```json
{
  "ownerAddress": "0xYourEOAAddress",
  "chainId": 137,
  "rpcUrl": "https://polygon-rpc.com",
  "tokenAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "recipient": "0xRecipientAddress",
  "amount": 1.5
}
```

**For a universal transaction:**
```json
{
  "ownerAddress": "0xYourEOAAddress",
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org",
  "calls": [
    {
      "to": "0xRecipientAddress",
      "value": "1000000000000000000"
    }
  ],
  "paymasterToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "smartAccountAddress": "0xYourSmartAccountAddress",
    "userOperation": {
      "sender": "0x...",
      "nonce": "0x...",
      "callData": "0x...",
      "callGasLimit": "0x...",
      "verificationGasLimit": "0x...",
      "preVerificationGas": "0x...",
      "maxFeePerGas": "0x...",
      "maxPriorityFeePerGas": "0x...",
      "paymaster": "0x...",
      "paymasterData": "0x...",
      "signature": "0x..."
    },
    "hashToSign": "0xabcdef...",
    "chainId": 137
  },
  "message": "UserOperation prepared. Sign hashToSign with personal_sign and submit to /api/v2/submit"
}
```

### Step 2: Sign Locally

The client signs `hashToSign` using `personal_sign` (EIP-191):

**JavaScript (ethers.js):**
```javascript
const wallet = new ethers.Wallet(privateKey);
const signature = await wallet.signMessage(ethers.utils.arrayify(hashToSign));
```

**JavaScript (viem):**
```javascript
import { privateKeyToAccount } from 'viem/accounts';
const account = privateKeyToAccount(privateKey);
const signature = await account.signMessage({ message: { raw: hashToSign } });
```

**Browser (MetaMask / any wallet):**
```javascript
const signature = await window.ethereum.request({
  method: 'personal_sign',
  params: [hashToSign, ownerAddress],
});
```

### Step 3: Submit Signed UserOperation

**POST** `/api/v2/submit`

```json
{
  "chainId": 137,
  "userOperation": { "...the full userOperation from step 1..." },
  "signature": "0xYourSignatureFromStep2..."
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "userOperationHash": "0x1234...",
    "chainId": 137
  },
  "message": "UserOperation submitted successfully on chain 137"
}
```

### Full Example (Node.js)

```javascript
import { ethers } from 'ethers';

const SERVER = 'https://your-server.com';
const PRIVATE_KEY = '0x...'; // never sent to server
const wallet = new ethers.Wallet(PRIVATE_KEY);

// Step 1: Prepare
const prepareRes = await fetch(`${SERVER}/api/v2/prepare`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ownerAddress: wallet.address,
    chainId: 137,
    rpcUrl: 'https://polygon-rpc.com',
    tokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    recipient: '0xRecipientAddress',
    amount: 1.5,
  }),
});
const { data } = await prepareRes.json();

// Step 2: Sign locally
const signature = await wallet.signMessage(
  ethers.utils.arrayify(data.hashToSign)
);

// Step 3: Submit
const submitRes = await fetch(`${SERVER}/api/v2/submit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chainId: 137,
    userOperation: data.userOperation,
    signature,
  }),
});
const result = await submitRes.json();
console.log('UserOp hash:', result.data.userOperationHash);
```

### V2 on Celo (works identically)

```bash
# Prepare (Celo USDC transfer — no private key sent!)
curl -X POST http://localhost:3000/api/v2/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "ownerAddress": "0xYourEOAAddress",
    "chainId": 42220,
    "rpcUrl": "https://forno.celo.org",
    "tokenAddress": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    "recipient": "0xRecipientAddress",
    "amount": 5.0
  }'
```

---

### Value Conversion Guide 📏

**Wei to Token Conversion:**
- `1000000000000000000` wei = 1 ETH/MATIC
- `500000000000000000` wei = 0.5 ETH/MATIC  
- `100000000000000000` wei = 0.1 ETH/MATIC
- `10000000000000000` wei = 0.01 ETH/MATIC

**Key Benefits:**
- ✅ **Gasless for users** - Paymaster sponsors gas fees
- ✅ **Pay gas with tokens** - Use USDC instead of ETH/MATIC
- ✅ **Batch transactions** - Multiple transfers in one operation
- ✅ **Same smart account** - Deterministic address across chains
- ✅ **Atomic execution** - All calls succeed or all fail
**Built with ❤️ using ERC-4337, Pimlico, Gelato, Safe, and TypeScript**