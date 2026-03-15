# Light Infra — API Reference

Gasless smart wallet infrastructure with client-side signing. Users sign transactions locally — private keys never touch the server.

## Overview

Light Infra is an ERC-4337 smart wallet API that lets users:
- Send ERC-20 token transfers (USDC, USDT, etc.)
- Sign and execute arbitrary contract calls (approve, swap, mint, etc.)
- Bridge tokens cross-chain via Across Protocol
- Pay gas fees in ERC-20 tokens instead of ETH

All operations use Safe v1.4.1 smart accounts with deterministic addresses across all chains.

## Supported Chains

| Chain | ID | Bundler | Paymaster | Gas Tokens |
|-------|------|---------|-----------|------------|
| Ethereum | 1 | Pimlico | Pimlico ERC-20 | USDC |
| Base | 8453 | Pimlico | Pimlico ERC-20 | USDC |
| Polygon | 137 | Pimlico | Pimlico ERC-20 | USDC, USDT |
| Celo | 42220 | Pimlico | Pimlico ERC-20 | USDC, USDT |
| Arbitrum | 42161 | Pimlico | Pimlico ERC-20 | USDC |
| Avalanche | 43114 | Pimlico | Pimlico ERC-20 | USDC |
| BNB Chain | 56 | Pimlico | Pimlico ERC-20 | USDT |
| Berachain | 80094 | Pimlico | Pimlico ERC-20 | USDC |
| Lisk | 1135 | Gelato | Custom LiskPaymaster | Bridged USDC, Bridged USDT |

Lisk tokens: Bridged USDC `0xF242275d3a6527d877f2c927a82D9b057609cc71`, Bridged USDT `0x05D032ac25d322df992303dCa074EE7392C117b9`

---

## V2 API — Client-Side Signing

### POST /api/v2/prepare

Build an unsigned UserOperation. Returns a hash for the client to sign.

**Request Body — Token Transfer:**

```json
{
  "ownerAddress": "0xYourEOAAddress",
  "chainId": 1135,
  "rpcUrl": "https://rpc.api.lisk.com",
  "tokenAddress": "0xF242275d3a6527d877f2c927a82D9b057609cc71",
  "recipient": "0xRecipientAddress",
  "amount": 5.0
}
```

**Request Body — Universal Transaction (arbitrary calls):**

```json
{
  "ownerAddress": "0xYourEOAAddress",
  "chainId": 137,
  "rpcUrl": "https://polygon-rpc.com",
  "calls": [
    {
      "to": "0xTokenAddress",
      "abi": ["function approve(address spender, uint256 amount)"],
      "functionName": "approve",
      "args": ["0xSpenderAddress", "1000000"]
    }
  ],
  "paymasterToken": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| ownerAddress | address | Yes | EOA address (NOT private key) |
| chainId | number | Yes | Target chain ID |
| rpcUrl | string | Yes | Chain RPC endpoint |
| tokenAddress | address | Transfer mode | ERC-20 token to transfer |
| recipient | address | Transfer mode | Transfer recipient |
| amount | number | Transfer mode | Amount in human-readable format (e.g. 5.0) |
| calls | array | Transaction mode | Array of contract calls |
| paymasterToken | address | No | Token to pay gas with (required for transaction mode on non-transfer calls) |

**Call object structure:**

Each call in the `calls` array can use one of three formats:

1. **ABI-encoded**: `{ to, abi, functionName, args }` — automatically encoded
2. **Raw calldata**: `{ to, data }` — sent as raw hex
3. **Value transfer**: `{ to, value }` — native ETH transfer

| Field | Type | Description |
|-------|------|-------------|
| to | address | Target contract address |
| value | string | Optional ETH value in wei |
| data | hex string | Optional raw calldata |
| abi | array | Optional human-readable ABI |
| functionName | string | Function name (requires abi + args) |
| args | array | Function arguments (requires abi + functionName) |

**Response:**

```json
{
  "success": true,
  "data": {
    "smartAccountAddress": "0xYourSafeAddress",
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
    "chainId": 1135
  },
  "message": "UserOperation prepared. Sign hashToSign with personal_sign..."
}
```

---

### POST /api/v2/submit

Submit a signed UserOperation to the bundler.

**Request Body:**

```json
{
  "chainId": 1135,
  "userOperation": { "...full userOperation from prepare response..." },
  "signature": "0x...65-byte ECDSA signature..."
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| chainId | number | Yes | Must match chain from prepare |
| userOperation | object | Yes | Full UserOp from prepare response |
| signature | hex string | Yes | 65-byte ECDSA signature (0x + 130 hex chars) |

**Response:**

```json
{
  "success": true,
  "data": {
    "userOperationHash": "0x1234...",
    "chainId": 1135
  },
  "message": "UserOperation submitted successfully on chain 1135"
}
```

---

### POST /api/bridge

Bridge tokens cross-chain using Across Protocol. Works with all Pimlico-supported chains.

**Request Body:**

```json
{
  "privateKey": "0x...",
  "sourceChainId": 137,
  "destChainId": 42161,
  "rpcUrl": "https://polygon-rpc.com",
  "tokenAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "amount": 10.0,
  "recipient": "0xRecipientOnDestChain"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| privateKey | hex string | Yes | Owner's private key (v1 endpoint) |
| sourceChainId | number | Yes | Source chain ID |
| destChainId | number | Yes | Destination chain ID |
| rpcUrl | string | Yes | Source chain RPC |
| tokenAddress | address | Yes | Token to bridge |
| amount | number | Yes | Amount in human-readable format |
| recipient | address | No | Recipient on destination chain (defaults to same smart account) |

**Response:**

```json
{
  "success": true,
  "data": {
    "transactionHash": "0x...",
    "sourceChainId": 137,
    "destChainId": 42161,
    "amount": "10.0",
    "token": "0x...",
    "smartWalletAddress": "0x...",
    "recipient": "0x...",
    "estimatedFillTime": "~2-5 minutes"
  }
}
```

---

## Signing Guide

The `hashToSign` from `/api/v2/prepare` is the Safe operation hash (EIP-712). Sign it with `personal_sign`:

**ethers.js:**
```javascript
const signature = await wallet.signMessage(ethers.utils.arrayify(hashToSign));
```

**viem:**
```javascript
const signature = await account.signMessage({ message: { raw: hashToSign } });
```

**MetaMask / Browser Wallet:**
```javascript
const signature = await window.ethereum.request({
  method: 'personal_sign',
  params: [hashToSign, ownerAddress],
});
```

**Privy:**
```javascript
const { signMessage } = useSignMessage();
const signature = await signMessage(hashToSign);
```

**wagmi:**
```javascript
const { signMessageAsync } = useSignMessage();
const signature = await signMessageAsync({ message: { raw: toBytes(hashToSign) } });
```

Use `personal_sign` (EIP-191), not `eth_sign`. The server adjusts the v value (+4) for Safe's eth_sign verification path.

---

## Examples

### Token Transfer (Lisk Bridged USDC)
```bash
# Step 1: Prepare
curl -X POST https://smart-wallet-519w.onrender.com/api/v2/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "ownerAddress": "0xYourEOA",
    "chainId": 1135,
    "rpcUrl": "https://rpc.api.lisk.com",
    "tokenAddress": "0xF242275d3a6527d877f2c927a82D9b057609cc71",
    "recipient": "0xRecipient",
    "amount": 5.0
  }'

# Step 2: Sign hashToSign locally with your wallet

# Step 3: Submit
curl -X POST https://smart-wallet-519w.onrender.com/api/v2/submit \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1135,
    "userOperation": { "...from prepare response..." },
    "signature": "0x...your signature..."
  }'
```

### ERC-20 Approve (any chain)
```bash
curl -X POST https://smart-wallet-519w.onrender.com/api/v2/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "ownerAddress": "0xYourEOA",
    "chainId": 137,
    "rpcUrl": "https://polygon-rpc.com",
    "calls": [
      {
        "to": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        "abi": ["function approve(address spender, uint256 amount)"],
        "functionName": "approve",
        "args": ["0xSpenderContract", "1000000000"]
      }
    ],
    "paymasterToken": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
  }'
```

### Multi-call: Approve + Swap (single UserOp)
```bash
curl -X POST https://smart-wallet-519w.onrender.com/api/v2/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "ownerAddress": "0xYourEOA",
    "chainId": 8453,
    "rpcUrl": "https://mainnet.base.org",
    "calls": [
      {
        "to": "0xTokenAddress",
        "abi": ["function approve(address,uint256)"],
        "functionName": "approve",
        "args": ["0xDEXRouter", "1000000"]
      },
      {
        "to": "0xDEXRouter",
        "data": "0x...encoded swap calldata..."
      }
    ],
    "paymasterToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }'
```

### Raw Calldata (any contract interaction)
```bash
curl -X POST https://smart-wallet-519w.onrender.com/api/v2/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "ownerAddress": "0xYourEOA",
    "chainId": 1135,
    "rpcUrl": "https://rpc.api.lisk.com",
    "calls": [
      {
        "to": "0xContractAddress",
        "data": "0xabcdef...raw calldata...",
        "value": "0"
      }
    ],
    "paymasterToken": "0xF242275d3a6527d877f2c927a82D9b057609cc71"
  }'
```

### Cross-Chain Bridge (Across Protocol)
```bash
curl -X POST https://smart-wallet-519w.onrender.com/api/bridge \
  -H "Content-Type: application/json" \
  -d '{
    "privateKey": "0x...",
    "sourceChainId": 137,
    "destChainId": 42161,
    "rpcUrl": "https://polygon-rpc.com",
    "tokenAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "amount": 50.0
  }'
```

---

## Architecture

```
Client                          Light Infra Server                Bundler
  |                               |                               |
  |  POST /api/v2/prepare         |                               |
  |  { ownerAddress, chainId,     |                               |
  |    calls/token, ... }         |                               |
  |------------------------------>|                               |
  |                               |  Build UserOp, estimate gas,  |
  |                               |  get paymaster signature      |
  |  { userOperation, hashToSign }|                               |
  |<------------------------------|                               |
  |                               |                               |
  |  Sign hashToSign locally      |                               |
  |  (personal_sign)              |                               |
  |                               |                               |
  |  POST /api/v2/submit          |                               |
  |  { userOperation, signature } |                               |
  |------------------------------>|                               |
  |                               |  eth_sendUserOperation        |
  |                               |------------------------------>|
  |  { userOperationHash }        |                               |
  |<------------------------------|                               |
```

## LiskPaymaster Contract

- Address: `0x427236c2FbF46372e115027c367E63Bbb11F932C`
- Chain: Lisk Mainnet (1135)
- EntryPoint: `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (v0.7)
- ETH price fetched from Enso API via Ethereum mainnet WETH
- Price markup: 110% (10% safety margin)
- Supported tokens: Bridged USDC, Bridged USDT (both 6 decimals)
