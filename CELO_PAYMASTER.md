# Celo Paymaster

The Celo paymaster lets users pay for gas in **USDC or USDT** instead of native CELO,
using a self-hosted ERC-4337 verifying paymaster + Pimlico's Celo bundler.

## Why a custom paymaster?

Pimlico's ERC-20 paymaster product is not active on Celo — `pimlico_getTokenQuotes`
returns an empty list for every token. We bundle through Pimlico (which works fine
on Celo) but run our own `Erc20Paymaster` contract for gas sponsorship.

## Architecture

```
                        ┌────────────────────────────────────┐
   /api/transfer        │  smart-wallet server (this repo)   │
   { chainId: 42220 }   │                                    │
   ───────────────────► │  ┌──────────────────────────────┐  │
                        │  │ celo-paymaster.ts            │  │
                        │  │  • fetch CELO/USD (Coingecko)│  │
                        │  │  • compute pricePerNative    │  │
                        │  │  • sign paymasterData        │  │
                        │  └──────────────────────────────┘  │
                        └──────────────┬─────────────────────┘
                                       │ UserOperation
                                       │ (with signed paymasterData)
                                       ▼
                        ┌─────────────────────────┐
                        │   Pimlico bundler       │  api.pimlico.io/v1/celo/rpc
                        │   eth_sendUserOperation │
                        └─────────────┬───────────┘
                                      │ submits bundle
                                      ▼
              ┌─────────────────────────────────────────────────┐
              │  Celo mainnet (chainId 42220)                    │
              │                                                  │
              │  EntryPoint v0.7                                 │
              │  0x0000000071727De22E5E9d8BAf0edAc6f37da032      │
              │     │                                            │
              │     ├─ validatePaymasterUserOp ──┐               │
              │     │                            ▼               │
              │     │   Erc20Paymaster.sol  (our contract)       │
              │     │   0xb11b9304db584045f35825f08d5f6da779c80da1│
              │     │     • verify signer                        │
              │     │     • check token allowlist                │
              │     │                                            │
              │     ├─ executes UserOp callData                  │
              │     │     1. approve(paymaster, max)             │
              │     │     2. transfer(recipient, amount)         │
              │     │                                            │
              │     └─ postOp ──┐                                │
              │                 ▼                                │
              │   pulls (gas × pricePerNative × 1.1) USDC/USDT   │
              │   from the smart account → into paymaster        │
              └─────────────────────────────────────────────────┘
```

## Addresses (Celo mainnet, chainId 42220)

| Role | Address |
|---|---|
| **Paymaster contract** (`Erc20Paymaster.sol`) | `0xb11b9304db584045f35825f08d5f6da779c80da1` |
| Owner / verifying signer EOA | `0x7ab104fe43968cbf2ca4b571d0c64c9d8eefe67c` |
| EntryPoint v0.7 (canonical) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| USDC | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` (6 dec) |
| USDT | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` (6 dec) |

The owner EOA currently doubles as the verifying signer. Split with
`paymaster.transferOwnership(newOwner)` + `paymaster.setVerifyingSigner(newSigner)`
when you want a hot/cold separation.

## How USDC/USDT gets deducted

The paymaster contract uses **price-in-paymasterData**: every UserOp carries a
fresh CELO/USD price signed by our backend, instead of reading from contract
storage. Per-UserOp flow:

1. **Backend** ([src/celo-paymaster.ts](src/celo-paymaster.ts)) prepares the UserOp middleware:
   - Fetches CELO/USD from Coingecko (`api.coingecko.com/api/v3/simple/price?ids=celo&vs_currencies=usd`)
   - Caches the price for 5 minutes
   - Computes `pricePerNative = round(celoPriceUsd × 10^6)` (USDC and USDT both have 6 decimals)
   - Signs `(UserOp fields + token + validUntil + validAfter + pricePerNative)` with `CELO_PAYMASTER_SIGNER_KEY`
   - Encodes paymasterData (129 bytes total):
     ```
     [ 0..20)  token            (address)
     [20..26)  validUntil       (uint48)
     [26..32)  validAfter       (uint48)
     [32..64)  pricePerNative   (uint256)
     [64..129) signature        (65-byte ECDSA)
     ```

2. **Pimlico bundler** submits the UserOp to EntryPoint on Celo.

3. **EntryPoint** calls `paymaster.validatePaymasterUserOp`:
   - Parses paymasterData
   - Checks `supportedTokens[token]` (USDC and USDT are enabled; anything else reverts)
   - Verifies the signature recovers to `verifyingSigner`
   - Returns context = `(sender, token, pricePerNative)`

4. **EntryPoint** runs the UserOp's callData — must be `approve(paymaster, max)` followed by the actual transfer.

5. **EntryPoint** calls `paymaster.postOp` with the actual gas cost:
   ```solidity
   actualTokenCost = (actualGasCost × pricePerNative × priceMarkup) / (1e18 × 10000)
   ```
   `priceMarkup` defaults to `11000` (110%, i.e. 10% safety buffer on top of the spot price).

   Then `IERC20(token).safeTransferFrom(sender, paymaster, actualTokenCost)` — the smart account pays the paymaster in USDC/USDT.

### Worked example

If a transfer's actual gas cost is **0.001 CELO** and CELO is at **$0.0929**:

```
pricePerNative = round(0.0929 × 1_000_000) = 92_900   (USDC, 6 dec)
actualGasCost  = 0.001 CELO                = 1e15 wei
priceMarkup    = 11000                                  (110%)

cost = (1e15 × 92_900 × 11000) / (1e18 × 10000)
     = 1.0219e23 / 1e22
     = 102 token units
     ≈ $0.000102 USDC

Sanity: $0.0929/CELO × 0.001 CELO × 1.10 = $0.000102  ✓
```

The user is charged `~0.0001 USDC` for that transfer. The paymaster keeps the
USDC (revenue), and CELO is paid out to the bundler from the paymaster's
EntryPoint deposit.

## Operations

### Top-up loop ("never fail" recipe)

What drains:

| Balance | Why it matters |
|---|---|
| `entryPoint.balanceOf(0xb11b9304...)` | Native CELO ledger inside EntryPoint. **Drains every successful UserOp.** When this hits zero, every transfer fails with `AA31 paymaster deposit too low`. |
| Owner EOA `0x7ab104fe...` CELO balance | Funds the `depositTo` top-up txs. |

What grows:

| Balance | Why it matters |
|---|---|
| `IERC20(USDC).balanceOf(0xb11b9304...)` | User payments accumulate here. Paymaster revenue. |
| `IERC20(USDT).balanceOf(0xb11b9304...)` | Same as USDC. |

### Topping up the deposit

From your owner EOA (or any EOA — `depositTo` is permissionless):

```bash
cast send 0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
  "depositTo(address)" 0xb11b9304db584045f35825f08d5f6da779c80da1 \
  --value 5ether \
  --rpc-url https://forno.celo.org \
  --private-key $CELO_PAYMASTER_OWNER_KEY
```

### Checking the deposit

```bash
cast call 0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
  'balanceOf(address)(uint256)' 0xb11b9304db584045f35825f08d5f6da779c80da1 \
  --rpc-url https://forno.celo.org
```

(Result is in wei. Divide by 1e18 for CELO.)

### Withdrawing accumulated revenue

```bash
cast send 0xb11b9304db584045f35825f08d5f6da779c80da1 \
  "withdrawTokens(address,address,uint256)" \
  0xcebA9300f2b948710d2653dD7B07f33A8B32118C $YOUR_TREASURY $AMOUNT_IN_UNITS \
  --rpc-url https://forno.celo.org \
  --private-key $CELO_PAYMASTER_OWNER_KEY
```

### Funding the owner EOA from an exchange

Send CELO **on the Celo network** (NOT BSC, NOT Ethereum — same address format,
but funds sent on the wrong network are gone) to:

```
0x7ab104fe43968cbf2ca4b571d0c64c9d8eefe67c
```

Do **not** send CELO directly to the paymaster contract `0xb11b9304...` — that
lands in `address(paymaster).balance` which the EntryPoint never reads, so it
won't pay for anything.

## Sizing

Each Celo UserOp costs roughly **0.001–0.005 CELO** of gas (varies with calldata
size and network congestion). 5 CELO covers ~1,000–5,000 transfers.

- **Initial deposit:** 5 CELO
- **Owner EOA float:** keep ~10 CELO so you can refill on demand
- **Alert threshold:** when `entryPoint.balanceOf(paymaster) < 1 ether`, top up

## Re-deployment / rotation

The contract is at [contracts/src/Erc20Paymaster.sol](contracts/src/Erc20Paymaster.sol).
The deploy script is [contracts/script/DeployErc20Paymaster.s.sol](contracts/script/DeployErc20Paymaster.s.sol).
Steps to redeploy on a fresh signer:

```bash
# Generate fresh key locally
cast wallet new

# Fund the new EOA with ~10 CELO

# Deploy
cd contracts
forge script script/DeployErc20Paymaster.s.sol \
  --rpc-url https://forno.celo.org \
  --broadcast \
  --private-key $NEW_KEY

# Update .env: CELO_PAYMASTER_ADDRESS, CELO_PAYMASTER_SIGNER_KEY, CELO_PAYMASTER_OWNER_KEY

# Enable USDC + USDT
npx ts-node --transpile-only scripts/configure-celo-paymaster.ts

# Fund the new paymaster's deposit
cast send 0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
  "depositTo(address)" $NEW_PAYMASTER_ADDR \
  --value 5ether \
  --rpc-url https://forno.celo.org \
  --private-key $NEW_KEY

# Restart server
npm run dev
```

## Rotating just the signer (no redeploy)

The verifying signer can be changed at any time; the contract owner can also
be rotated independently:

```solidity
paymaster.setVerifyingSigner(newSignerEOA)   // onlyOwner
paymaster.transferOwnership(newOwnerEOA)     // onlyOwner
```

Update the matching env var (`CELO_PAYMASTER_SIGNER_KEY` or `CELO_PAYMASTER_OWNER_KEY`),
restart server. Old key becomes inert — UserOps signed with it will fail in
`validatePaymasterUserOp`.

## Files

| Path | Purpose |
|---|---|
| [contracts/src/Erc20Paymaster.sol](contracts/src/Erc20Paymaster.sol) | The paymaster contract (ERC-4337 v0.7) |
| [contracts/script/DeployErc20Paymaster.s.sol](contracts/script/DeployErc20Paymaster.s.sol) | Foundry deploy script |
| [src/celo-paymaster.ts](src/celo-paymaster.ts) | Backend middleware: Coingecko fetch, paymasterData encoding, signing |
| [src/abstraction.ts](src/abstraction.ts) | `submitTransaction` and `submitUniversalTransaction` — Celo branch |
| [src/relay.ts](src/relay.ts) | v2 client-signed flow — Celo branch in `prepareUserOp`, `prepareTransaction`, `buildTransferCalls` |
| [scripts/configure-celo-paymaster.ts](scripts/configure-celo-paymaster.ts) | Enables USDC/USDT on the deployed paymaster |
| [.env.example](.env.example) | Env variable reference and architecture summary |
