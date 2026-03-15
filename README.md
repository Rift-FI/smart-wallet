# Smart Wallets Server 🔥

**ERC-4337 Account Abstraction API** - Gasless ERC-20 token transfers with Pimlico + Custom Paymaster infrastructure

A production-ready TypeScript Express server that enables **gasless token transfers** using **smart contract wallets** and **ERC-20 paymasters**. Users pay gas fees in USDC/tokens instead of ETH, making Web3 accessible to mainstream users.

## 🚀 What This Does

- **Smart Contract Wallets**: Every user gets a deterministic Safe smart account
- **Gasless Transactions**: Users pay gas fees in USDC/tokens, not ETH
- **Account Abstraction**: ERC-4337 standard with Pimlico bundler/paymaster
- **Custom Paymaster (Lisk)**: Self-hosted verifying paymaster for chains not supported by Pimlico
- **Multi-chain Support**: Base, Polygon, Lisk, and 100+ EVM chains
- **Universal API**: Single `/api/transfer` endpoint for all chains — same request format regardless of chain
- **Production Ready**: Rate limiting, circuit breakers, error handling

## 🏗️ How It Works

1. **User submits transfer** with private key + token details
2. **Smart account created** deterministically (same address across chains)
3. **Paymaster sponsors gas** using user's tokens:
   - **Most chains**: Pimlico ERC-20 paymaster
   - **Lisk**: Custom `LiskPaymaster` verifying paymaster + Gelato bundler
4. **Transaction executed** instantly, returns UserOperation hash
5. **User tracks** transaction on block explorer

> **Note**: The API interface is identical for all chains. Lisk uses a custom paymaster behind the scenes, but callers send the exact same request body and receive the same response format.

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

# Celo Chain (Chain ID: 42220)
CELO_BUNDLER_URL=https://api.pimlico.io/v1/celo/rpc?apikey=your_pimlico_api_key_here
CELO_PAYMASTER_RPC=https://api.pimlico.io/v2/celo/rpc?apikey=your_pimlico_api_key_here

# ── Lisk Custom Paymaster (Chain ID: 1135) ──
LISK_PAYMASTER_ADDRESS=0x427236c2FbF46372e115027c367E63Bbb11F932C
LISK_PAYMASTER_SIGNER_KEY=your_paymaster_signer_private_key
GELATO_API_KEY=your_gelato_api_key_here
ENSO_API_KEY=your_enso_api_key_here

# Development settings
NODE_ENV=development
PORT=3000
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

```json
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
| Celo | 42220 | Pimlico | Pimlico ERC-20 |
| Arbitrum | 42161 | Pimlico | Pimlico ERC-20 |
| Avalanche | 43114 | Pimlico | Pimlico ERC-20 |
| BNB Chain | 56 | Pimlico | Pimlico ERC-20 |
| Berachain | 80094 | Pimlico | Pimlico ERC-20 |

**Custom paymaster chains:**
| Chain | ID | Bundler | Paymaster | Supported Tokens |
|-------|------|---------|-----------|-----------------|
| Lisk | 1135 | Gelato | Custom `LiskPaymaster` | Bridged USDC (`0xF242...cc71`), Bridged USDT (`0x05D0...C117b9`) |

> Lisk is not supported by Pimlico, so we run a self-hosted **verifying paymaster** contract with Gelato as the bundler. The API is identical — callers don't need to know the difference.

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
- **Bundler**: Pimlico (most chains) / Gelato (Lisk) for UserOperation submission
- **Paymaster**: Pimlico ERC-20 paymaster (most chains) / Custom verifying paymaster (Lisk)
- **ETH Price Oracle**: Enso API (queried via Ethereum mainnet WETH) for real-time ETH pricing on custom paymaster chains
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
                    │ isLiskChain? │
                    └──────┬──────┘
                     No    │    Yes
              ┌────────────┴────────────┐
              ▼                         ▼
    ┌─────────────────┐     ┌──────────────────────┐
    │    Pimlico       │     │  Custom Paymaster     │
    │  ─────────────   │     │  ──────────────────   │
    │  Bundler: Pimlico│     │  Bundler: Gelato      │
    │  Paymaster: ERC20│     │  Paymaster: LiskPM    │
    │  Gas: Pimlico    │     │  Gas: Lisk RPC        │
    │  Price: Pimlico  │     │  Price: Enso API      │
    └─────────────────┘     └──────────────────────┘
              │                         │
              └────────────┬────────────┘
                           ▼
              Same response format to caller
```

### Custom Paymaster (Lisk) - How It Works

1. **Backend signs** the UserOperation off-chain with `LISK_PAYMASTER_SIGNER_KEY`
2. **LiskPaymaster contract** verifies the signature in `validatePaymasterUserOp`
3. **User's callData executes** (includes token approve + transfer)
4. **postOp** pulls tokens from the smart account to cover gas costs
5. **Token cost** = gas used * ETH price / token price + markup (configurable)

Contract: [`0x427236c2FbF46372e115027c367E63Bbb11F932C`](https://blockscout.lisk.com/address/0x427236c2FbF46372e115027c367E63Bbb11F932C) on Lisk mainnet.

### Project Structure
```
src/
├── server.ts          # Express server setup
├── config.ts          # Environment configuration
├── types.ts           # TypeScript interfaces
├── middleware.ts      # Error handling & logging
├── routes.ts          # API endpoints & validation
├── abstraction.ts     # Smart account & Pimlico/Lisk routing logic
├── lisk-paymaster.ts  # Custom paymaster middleware, gas estimation, Enso pricing
├── utils.ts           # Rate limiting & circuit breakers
└── chains.ts          # Blockchain configurations

contracts/
├── src/
│   └── LiskPaymaster.sol  # Verifying paymaster (ERC-4337 v0.7, EntryPoint v0.7)
├── foundry.toml
└── remappings.txt
```

## 🔒 Security Features

- **Helmet**: Security headers protection
- **Rate Limiting**: Prevents API abuse (1000 req/min)
- **Circuit Breakers**: Prevents cascading failures
- **Input Validation**: Address & amount validation
- **Private Key Verification**: Ensures key matches address
- **Error Handling**: Graceful error responses
- **CORS**: Configurable cross-origin protection

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

### Lisk Bridged USDC/USDT Transfer Example (Custom Paymaster) 🟢

> These use the exact same API as other chains. The custom paymaster is handled transparently on the backend. Lisk uses **bridged** versions of USDC and USDT (not native Circle/Tether tokens). The ETH price for gas conversion is fetched from the Enso API using **Ethereum mainnet** (chain ID 1) since Enso does not support the Lisk chain directly.

13. **Transfer Bridged USDC on Lisk**:
```bash
curl -X POST http://localhost:3000/api/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1135,
    "tokenAddress": "0xF242275d3a6527d877f2c927a82D9b057609cc71",
    "recipient": "0xRecipientAddress",
    "amount": 5.0,
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourEOAAddress",
    "rpcUrl": "https://rpc.api.lisk.com"
  }'
```

14. **Transfer Bridged USDT on Lisk**:
```bash
curl -X POST http://localhost:3000/api/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1135,
    "tokenAddress": "0x05D032ac25d322df992303dCa074EE7392C117b9",
    "recipient": "0xRecipientAddress",
    "amount": 10.0,
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourEOAAddress",
    "rpcUrl": "https://rpc.api.lisk.com"
  }'
```

15. **Universal transaction on Lisk** (with Bridged USDC for gas):
```bash
curl -X POST http://localhost:3000/api/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1135,
    "calls": [
      {
        "to": "0xF242275d3a6527d877f2c927a82D9b057609cc71",
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
        "args": ["0xRecipientAddress", "5000000"]
      }
    ],
    "ownerPrivateKey": "YOUR_PRIVATE_KEY_HERE",
    "ownerAddress": "0xYourEOAAddress",
    "rpcUrl": "https://rpc.api.lisk.com",
    "paymasterToken": "0xF242275d3a6527d877f2c927a82D9b057609cc71"
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

### V2 on Lisk (works identically)

```bash
# Prepare (Lisk USDC transfer — no private key sent!)
curl -X POST http://localhost:3000/api/v2/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "ownerAddress": "0xYourEOAAddress",
    "chainId": 1135,
    "rpcUrl": "https://rpc.api.lisk.com",
    "tokenAddress": "0xF242275d3a6527d877f2c927a82D9b057609cc71",
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