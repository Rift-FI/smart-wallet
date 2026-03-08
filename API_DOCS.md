# Smart Wallet API Documentation

**Base URL:** `https://smart-wallet-519w.onrender.com`

---

## Supported Chains

| Chain | Chain ID | USDC | USDT |
|-------|----------|------|------|
| Ethereum | `1` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| Base | `8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | — |
| Polygon | `137` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | — |
| Arbitrum | `42161` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | — |
| Avalanche | `43114` | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | — |
| BSC | `56` | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | — |
| Celo | `42220` | — | — |
| Berachain | `80094` | `0x549943e04f40284185054145c6E4e9568C1D3241` | — |
| Lisk | `1135` | `0xBb739a6e04d07B08e38b66bA137d0C9Cd270C750` | `0x05D032ac25d322df992303dCa074EE7392C117b9` |

---

## Endpoints

### 1. Health Check

```
GET /health
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 12345.67,
    "timestamp": "2026-03-08T10:00:00.000Z",
    "version": "1.0.0"
  },
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 2. Transfer Tokens

Transfer ERC-20 tokens from a smart wallet to any address. Gas is paid in the token being transferred (no native tokens needed).

```
POST /api/transfer
```

**Payload:**
```json
{
  "chainId": 8453,
  "tokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "recipient": "0xRecipientAddress",
  "amount": 10.5,
  "ownerPrivateKey": "0xYourPrivateKey",
  "ownerAddress": "0xYourEOAAddress",
  "rpcUrl": "https://mainnet.base.org"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chainId` | number | Yes | Chain ID (see supported chains) |
| `tokenAddress` | string | Yes | ERC-20 token contract address on the source chain |
| `recipient` | string | Yes | Destination wallet address |
| `amount` | number | Yes | Amount in human-readable format (e.g. `10.5` = 10.5 USDC) |
| `ownerPrivateKey` | string | Yes | Private key of the smart wallet owner |
| `ownerAddress` | string | Yes | EOA address matching the private key |
| `rpcUrl` | string | Yes | RPC URL for the chain |

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "userOperationHash": "0xabc123...",
    "chainId": 8453
  },
  "message": "Transfer completed successfully on chain 8453",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

**Error Response (400):**
```json
{
  "success": false,
  "error": "Transfer Failed",
  "message": "Insufficient token balance. Required: 10.5, Available: 2.0",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 3. Universal Transaction

Execute arbitrary smart contract calls through the smart wallet. Supports batching multiple calls in one transaction.

```
POST /api/transaction
```

**Payload:**
```json
{
  "chainId": 137,
  "calls": [
    {
      "to": "0xContractAddress",
      "abi": ["function transfer(address,uint256)"],
      "functionName": "transfer",
      "args": ["0xRecipient", "1000000"]
    }
  ],
  "ownerPrivateKey": "0xYourPrivateKey",
  "ownerAddress": "0xYourEOAAddress",
  "rpcUrl": "https://polygon-rpc.com",
  "paymasterToken": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chainId` | number | Yes | Chain ID |
| `calls` | array | Yes | Array of contract calls (see below) |
| `ownerPrivateKey` | string | Yes | Private key of the smart wallet owner |
| `ownerAddress` | string | Yes | EOA address matching the private key |
| `rpcUrl` | string | Yes | RPC URL for the chain |
| `paymasterToken` | string | No | Token address to pay gas with. If omitted, uses sponsored gas |

**Call object formats:**

ABI-based call:
```json
{
  "to": "0xContractAddress",
  "abi": ["function myFunction(address,uint256)"],
  "functionName": "myFunction",
  "args": ["0xAddr", "100"]
}
```

Raw data call:
```json
{
  "to": "0xContractAddress",
  "data": "0xabcdef..."
}
```

Native value transfer:
```json
{
  "to": "0xRecipient",
  "value": "1000000000000000000"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "userOperationHash": "0xabc123...",
    "chainId": 137
  },
  "message": "Universal transaction completed successfully on chain 137",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 4. Bridge Tokens (Cross-Chain)

Bridge USDC or USDT between chains using Across Protocol. Gas is paid in the token being bridged — no native tokens needed. The bridge fee is deducted from the bridged amount.

```
POST /api/bridge
```

**Payload:**
```json
{
  "sourceChainId": 8453,
  "destChainId": 42161,
  "tokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": 100,
  "ownerPrivateKey": "0xYourPrivateKey",
  "rpcUrl": "https://mainnet.base.org",
  "recipient": "0xOptionalRecipient"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceChainId` | number | Yes | Origin chain ID |
| `destChainId` | number | Yes | Destination chain ID |
| `tokenAddress` | string | Yes | Token address on the **source** chain |
| `amount` | number | Yes | Amount in human-readable format (e.g. `100` = 100 USDC) |
| `ownerPrivateKey` | string | Yes | Private key of the smart wallet owner |
| `rpcUrl` | string | Yes | RPC URL for the **source** chain |
| `recipient` | string | No | Recipient on destination chain. Defaults to the same smart wallet address (deterministic across chains) |

**How it works:**
1. Computes your smart wallet address from the private key
2. Gets a bridge quote from Across Protocol (fee, output amount, destination token)
3. Executes `approve` + `depositV3` on the Across SpokePool in one UserOperation
4. Gas paid in USDC/USDT via Pimlico ERC-20 paymaster
5. Across relayers fill the order on the destination chain (typically < 30 seconds for L2s)

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "userOperationHash": "0xabc123...",
    "sourceChainId": 8453,
    "destChainId": 42161,
    "inputToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "outputToken": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "inputAmount": "100",
    "outputAmount": "99.94",
    "fee": "0.06",
    "recipient": "0xSmartWalletAddress",
    "smartWalletAddress": "0xSmartWalletAddress"
  },
  "message": "Bridge initiated: 100 USDC from chain 8453 → USDC on chain 42161",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

**Error Response (400):**
```json
{
  "success": false,
  "error": "Bridge Failed",
  "message": "Across API error: Route not available",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 5. Get Smart Account Address

Get the deterministic smart wallet address for a given private key on a specific chain. The address is the same across all chains.

```
POST /api/smart-account/address
```

**Payload:**
```json
{
  "chainId": 8453,
  "ownerPrivateKey": "0xYourPrivateKey",
  "rpcUrl": "https://mainnet.base.org"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chainId` | number | Yes | Chain ID |
| `ownerPrivateKey` | string | Yes | Private key of the owner |
| `rpcUrl` | string | No | RPC URL (uses default if omitted) |

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "address": "0xSmartWalletAddress",
    "chainId": 8453
  },
  "message": "Smart account address retrieved successfully for chain 8453",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 6. Create Smart Account

Prepare a smart account for deployment. The account deploys automatically on its first transaction.

```
POST /api/smart-account/create
```

**Payload:**
```json
{
  "chainId": 8453,
  "ownerPrivateKey": "0xYourPrivateKey",
  "rpcUrl": "https://mainnet.base.org"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chainId` | number | Yes | Chain ID |
| `ownerPrivateKey` | string | Yes | Private key of the owner |
| `rpcUrl` | string | Yes | RPC URL for the chain |

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "address": "0xSmartWalletAddress",
    "chainId": 8453
  },
  "message": "Smart account prepared for deployment successfully on chain 8453",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 7. WalletConnect — Pair with a DApp

Connect to any WalletConnect-compatible DApp (Uniswap, OpenSea, Aave, etc.). The API acts as a server-side wallet. When the DApp sends a transaction, it is queued as a pending request — the frontend must approve or reject it before it executes.

```
POST /api/walletconnect/pair
```

**Payload:**
```json
{
  "uri": "wc:a1b2c3d4...@2?relay-protocol=irn&symKey=abc123...",
  "ownerPrivateKey": "0xYourPrivateKey",
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `uri` | string | Yes | WalletConnect pairing URI from the DApp (starts with `wc:`) |
| `ownerPrivateKey` | string | Yes | Private key of the smart wallet owner |
| `chainId` | number | Yes | Chain ID to operate on |
| `rpcUrl` | string | No | RPC URL (uses default if omitted) |

**How to get the URI:** In any DApp, click "Connect Wallet" → "WalletConnect" → copy the URI (or scan the QR code to get it).

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "topic": "abc123def456...",
    "smartWalletAddress": "0xSmartWalletAddress",
    "chainId": 8453,
    "peerName": "Uniswap",
    "peerUrl": "https://app.uniswap.org"
  },
  "message": "Connected to Uniswap. Transactions require approval via /api/walletconnect/requests/:id/approve",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 8. WalletConnect — List Pending Requests

Get all pending DApp requests awaiting user approval. Poll this endpoint to show incoming transaction/sign requests to the user.

```
GET /api/walletconnect/requests
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "requests": [
      {
        "id": 1709901234567,
        "topic": "abc123def456...",
        "method": "eth_sendTransaction",
        "params": [{ "to": "0x...", "data": "0x...", "value": "0x0" }],
        "peerName": "Uniswap",
        "chainId": 8453,
        "smartWalletAddress": "0xSmartWalletAddress",
        "createdAt": "2026-03-08T10:00:00.000Z"
      }
    ]
  },
  "message": "1 pending request(s)",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 9. WalletConnect — Approve Request

Approve a pending request. The transaction is executed through the smart wallet and the result is sent back to the DApp.

```
POST /api/walletconnect/requests/:id/approve
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | number (URL param) | Yes | Request ID from the pending requests list |

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "result": "0xTransactionOrSignatureHash..."
  },
  "message": "Request approved and executed",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

**Error Response (404):**
```json
{
  "success": false,
  "error": "Not Found",
  "message": "No pending request with id 123456",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 10. WalletConnect — Reject Request

Reject a pending request. The DApp is notified that the user denied the request.

```
POST /api/walletconnect/requests/:id/reject
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | number (URL param) | Yes | Request ID from the pending requests list |

**Success Response (200):**
```json
{
  "success": true,
  "message": "Request rejected",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 11. WalletConnect — List Active Sessions

Get all currently active WalletConnect sessions.

```
GET /api/walletconnect/sessions
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "topic": "abc123def456...",
        "smartWalletAddress": "0xSmartWalletAddress",
        "chainId": 8453,
        "peerName": "Uniswap",
        "peerUrl": "https://app.uniswap.org"
      }
    ]
  },
  "message": "1 active session(s)",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 12. WalletConnect — Disconnect Session

Disconnect from a DApp session.

```
DELETE /api/walletconnect/sessions/:topic
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `topic` | string (URL param) | Yes | Session topic from the pair response |

**Success Response (200):**
```json
{
  "success": true,
  "message": "Session abc123def456... disconnected",
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

---

### 13. System Status

```
GET /api/system/status
```

**Response:**
```json
{
  "success": true,
  "data": {
    "timestamp": "2026-03-08T10:00:00.000Z",
    "services": {
      "paymaster": "closed",
      "rpc": "closed"
    },
    "rateLimiting": {
      "enabled": true,
      "maxRequestsPerMinute": 1000
    }
  },
  "message": "System status retrieved successfully"
}
```

---

## Common Errors

| HTTP Code | Error | Cause |
|-----------|-------|-------|
| 400 | Validation Error | Missing/invalid fields in request |
| 400 | Unsupported Chain | Chain ID not in supported list |
| 400 | Authentication Error | Private key doesn't match owner address |
| 400 | Transfer Failed | Insufficient balance or token not supported by paymaster |
| 429 | Rate Limit Exceeded | Too many requests (max 1000/min per IP) |
| 500 | Configuration Error | Missing bundler/paymaster env vars on server |
| 500 | Internal Server Error | Unexpected failure |

---

## How Gas Works

All transactions use **Pimlico's ERC-20 Paymaster**. Users never need native tokens (ETH, MATIC, etc.) for gas. The gas cost is deducted from the token being transferred or bridged.

**Flow:**
1. Smart wallet approves the paymaster to spend tokens
2. Paymaster sponsors the UserOperation gas
3. Paymaster deducts the equivalent gas cost from the user's token balance
4. Transaction executes

---

## How Bridging Works

Bridging uses **Across Protocol** under the hood.

1. **You call** `POST /api/bridge` with source chain, dest chain, token, and amount
2. **API fetches** a real-time quote from Across (fees, output amount, destination token address)
3. **API executes** `approve` + `depositV3` on the Across SpokePool contract via the smart wallet
4. **Gas is paid** in the bridged token via Pimlico ERC-20 paymaster
5. **Across relayers** detect the deposit and fill the order on the destination chain
6. **Recipient receives** tokens on the destination chain (typically < 30 seconds for L2→L2)

The bridge fee (usually < 0.1%) is deducted from the amount — you send 100 USDC, receive ~99.94 USDC on the other side. No native tokens needed anywhere in the flow.

---

## How WalletConnect Works

WalletConnect lets users interact with any DApp (Uniswap, OpenSea, Aave, etc.) using their smart wallet — without a browser extension. All DApp requests require explicit user approval before executing.

**Flow:**
1. **User opens a DApp** and clicks "Connect Wallet" → "WalletConnect"
2. **DApp shows a QR code / URI** (starts with `wc:...`)
3. **Frontend calls** `POST /api/walletconnect/pair` with the URI and user's private key
4. **API pairs with the DApp** and exposes the user's smart wallet address
5. **DApp sends a transaction** (swap, approval, mint, etc.)
6. **API queues the request** as pending — does NOT auto-execute
7. **Frontend polls** `GET /api/walletconnect/requests` to show the request to the user
8. **User approves or rejects:**
   - Approve → `POST /api/walletconnect/requests/:id/approve` → executes through smart wallet
   - Reject → `POST /api/walletconnect/requests/:id/reject` → DApp gets `USER_REJECTED`
9. **Gas is paid** in tokens via Pimlico paymaster — no native tokens needed

**Supported DApp requests:**
| Method | What it does |
|--------|-------------|
| `eth_sendTransaction` | Executes transactions through the smart wallet (swaps, transfers, etc.) |
| `personal_sign` | Signs messages (login signatures, etc.) |
| `eth_sign` | Signs raw messages |
| `eth_signTypedData_v4` | Signs EIP-712 typed data (permits, orders, etc.) |
| `eth_chainId` | Returns the connected chain ID |
| `eth_accounts` | Returns the smart wallet address |

**Example integration flow:**
```
1. GET WC URI from DApp (user scans QR or copies link)

2. POST /api/walletconnect/pair
   → Returns: { topic, smartWalletAddress, peerName }

3. DApp is now connected. User interacts with DApp normally.

4. Poll GET /api/walletconnect/requests for incoming requests.
   → Show each request to the user (method, params, DApp name, chain).

5. User decides:
   → POST /api/walletconnect/requests/:id/approve  (execute)
   → POST /api/walletconnect/requests/:id/reject   (deny)

6. When done: DELETE /api/walletconnect/sessions/:topic
```

**Important notes:**
- Sessions persist as long as the server is running
- Each session is bound to one chain — if the DApp requests a chain switch, it's acknowledged but the session stays on the original chain
- The `topic` from the pair response is used to identify and manage the session
- Pending requests that are neither approved nor rejected will remain in the queue until the session is disconnected or the server restarts
