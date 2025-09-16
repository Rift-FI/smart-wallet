# Smart Wallets Server 🔥

**ERC-4337 Account Abstraction API** - Gasless ERC-20 token transfers with Pimlico integration

A production-ready TypeScript Express server that enables **gasless token transfers** using **smart contract wallets** and **ERC-20 paymasters**. Users pay gas fees in USDC/tokens instead of ETH, making Web3 accessible to mainstream users.

## 🚀 What This Does

- **Smart Contract Wallets**: Every user gets a deterministic Safe smart account
- **Gasless Transactions**: Users pay gas fees in USDC/tokens, not ETH
- **Account Abstraction**: ERC-4337 standard with Pimlico bundler/paymaster
- **Multi-chain Support**: Base, Polygon, and 100+ EVM chains
- **Universal API**: Single `/api/transfer` endpoint for all chains
- **Production Ready**: Rate limiting, circuit breakers, error handling

## 🏗️ How It Works

1. **User submits transfer** with private key + token details
2. **Smart account created** deterministically (same address across chains)
3. **Pimlico paymaster** sponsors gas fees using user's tokens
4. **Transaction executed** instantly, returns UserOperation hash
5. **User tracks** transaction on block explorer

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

Edit `.env` with your Pimlico API key:
```env
# Pimlico API Key (get from https://dashboard.pimlico.io)
PIMLICO_API_KEY=your_pimlico_api_key_here

# Base Chain (Chain ID: 8453)
BASE_BUNDLER_URL=https://api.pimlico.io/v1/base/rpc?apikey=your_pimlico_api_key_here
BASE_PAYMASTER_RPC=https://api.pimlico.io/v2/base/rpc?apikey=your_pimlico_api_key_here

# Polygon Chain (Chain ID: 137)
POLYGON_BUNDLER_URL=https://api.pimlico.io/v1/polygon/rpc?apikey=your_pimlico_api_key_here
POLYGON_PAYMASTER_RPC=https://api.pimlico.io/v2/polygon/rpc?apikey=your_pimlico_api_key_here

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

**Currently Configured:**
- **Base** (Chain ID: 8453) - Coinbase L2
- **Polygon** (Chain ID: 137) - Polygon PoS

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
- **Smart Accounts**: Safe v1.4.1 smart contract wallets
- **Bundler**: Pimlico ERC-4337 bundler for UserOperation submission
- **Paymaster**: ERC-20 paymaster for gas sponsorship in tokens
- **Rate Limiter**: 1000 requests/minute per IP
- **Circuit Breaker**: Resilience for external service calls

### Project Structure
```
src/
├── server.ts        # Express server setup
├── config.ts        # Environment configuration  
├── types.ts         # TypeScript interfaces
├── middleware.ts    # Error handling & logging
├── routes.ts        # API endpoints & validation
├── abstraction.ts   # Smart account & Pimlico logic
├── utils.ts         # Rate limiting & circuit breakers
└── chains.ts        # Blockchain configurations
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

**Built with ❤️ using ERC-4337, Pimlico, Safe, and TypeScript**