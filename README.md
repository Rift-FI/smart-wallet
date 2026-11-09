# Smart Wallets Server

The ERC-4337 service Rift's backend talks to whenever a user's Safe needs
to do something on chain. It builds Safe v1.4.1 UserOperations (EntryPoint
v0.7, Safe4337Module), routes gas through Pimlico (or Rift's own Celo
paymaster), and submits them.

**It holds no key that can move user funds.** Every Safe is owned only by
the user's passkeys (WebAuthn P-256). The passkey signs on the user's
device; the Safe verifies the signature on chain. This service only
builds the operation, encodes the signature the client sends back, checks
it, and relays it.

Stack: TypeScript, Express, viem 2.37, permissionless 0.2.57, Pimlico,
Safe passkey module v0.2.1.

## Model

- **Passkey-native Safe** (new users). Owner = `SafeWebAuthnSharedSigner`
  configured with the user's first passkey. Counterfactual address, same
  on every chain, deployed by the first UserOp on each chain. The deploy
  op also adds every other active passkey (`createSigner` +
  `addOwnerWithThreshold`).
- **Extra passkeys** are `SafeWebAuthnSignerProxy` owners
  (`factory.getSigner(x, y, VERIFIERS)`), added / removed by UserOps signed
  by an existing passkey.
- **Migrated Safe** (existing users, same address). Old owner was an EOA;
  `/api/v3/migrate` swaps it for passkey proxies in one UserOp. That op
  is the ONLY thing the old EOA key is ever used to sign, and the calldata
  is checked against an allowlist before signing (`passkey/migration.ts`).
- `VERIFIERS = (0x0100 << 160) | FCL_P256_VERIFIER` everywhere: RIP-7212
  precompile with the FCL verifier as fallback (also for the shared
  signer's configuration).

Per-chain capability table (`src/passkey/constants.ts`, `GET /api/passkey/capabilities`):

| Chain | shared signer | signer factory |
|---|---|---|
| 1, 8453, 137, 42220, 42161, 43114, 56 | yes | yes |
| 80094 Berachain | yes | no (no extra passkeys / migration yet) |

Missing contracts fail with `PASSKEY_UNSUPPORTED_ON_CHAIN`. Deployment
notes: `scripts/deploy-passkey-contracts.md`.

## Two-phase signing

```
backend                         smart-wallet                     user device
  │ POST /api/v3/prepare          │                                  │
  │ ───────────────────────────►  │ build UserOp (gas, paymaster)    │
  │ ◄─ { ticketId, hashToSign }   │ hashToSign = SafeOp EIP-712 hash │
  │ ─────────────────────────────────────────────────────────────►   │
  │                               │      navigator.credentials.get   │
  │ ◄──────────────────────────────────── authProof (challenge =     │
  │ POST /api/v3/submit           │       the 32 hash bytes)         │
  │ ───────────────────────────►  │ encode Safe contract signature,  │
  │                               │ Safe.checkSignatures (eth_call), │
  │                               │ submit to bundler, wait receipt  │
  │ ◄─ { userOpHash, transactionHash, success }                      │
```

Tickets are single-use, in-memory, `TICKET_TTL_MS` (default 120 s). A bad
signature does not burn the ticket; a submitted one does.

Signature placed in the UserOp (§1d):
`encodePacked(uint48 0, uint48 0, contractSignature)` with
`contractSignature = {r = signer}{s = 65}{v = 0}{len}{abi.encode(bytes authenticatorData, string clientDataFields, uint256[2] [r, s])}`.
`signer` is the shared signer for a native Safe's first passkey, the
proxy address otherwise. `passkey/webauthn.ts` builds it from the
`authProof` alone (no WebAuthn `getFn` server-side); a unit test checks it
is byte-identical to permissionless's own signing.

## API

All routes except `GET /health` require
`Authorization: Bearer $INTERNAL_SERVICE_TOKEN` (503 if the env is unset,
401 if wrong).

Success bodies put the payload at the top level **and** under `data`:
`{ success: true, address, data: { address }, timestamp }`. Errors:
`{ success: false, error: "<CODE>", message, details? }`.

Types used below:

```ts
AccountRef =
  | { kind: "passkey_native", address, firstPasskey: { x, y, credentialId }, extraPasskeys: [{ x, y }] }
  | { kind: "migrated", address, legacyOwner }        // legacyOwner = old EOA address
// x, y: 0x-hex (32 bytes) or decimal strings

authProof = { kind: "passkey", cred_id_b64, client_data_json_b64,
              authenticator_data_b64, signature_b64 }  // standard base64, DER sig
signer    = { address, kind: "shared" | "proxy" }

gas = { mode: "sponsored", ...markup? } | { mode: "token", token, ...markup? }
markup fields (flat on `gas` or under `gas.markup`):
  markupBps, projectMarkupBps, projectTreasuryAddress,
  transferTokenAddress, transferBaseAmountWei, flatMarkupTokenAddress
```

| Route | Body | Returns |
|---|---|---|
| `POST /api/passkey/address` | `{ credential: { x, y } }` | `{ address }` native Safe |
| `POST /api/passkey/signer` | `{ x, y }` | `{ proxyAddress }` |
| `GET /api/passkey/capabilities` | | `{ chains: { [id]: { sharedSigner, signerFactory } } }` |
| `POST /api/v3/prepare` | `{ chainId, account, calls[], gas, purpose, intent?, rpcUrl? }` | `{ ticketId, hashToSign, userOp, expiresAt, chainId, sender, deployed }` |
| `POST /api/v3/submit` | `{ ticketId, signer, authProof }` | `{ userOpHash, transactionHash, success, status }` |
| `POST /api/v3/message/prepare` | `{ chainId, account, kind: "personal_sign" \| "typed_data", message \| typedData }` | `{ ticketId, hashToSign, expiresAt, deployed }` |
| `POST /api/v3/message/submit` | `{ ticketId, signer, authProof }` | `{ signature, erc6492, messageHash }` |
| `POST /api/v3/migrate` | `{ chainId, account: migrated ref, eoaPrivateKey, passkeys: [{ x, y }] }` | `{ status: "migrated" \| "already_migrated" \| "pending", owners, userOpHash, transactionHash, success }` |
| `POST /api/v3/owners` | `{ chainId, safe }` | `{ deployed, owners, threshold }` |

Notes:

- `calls[]`: `{ to, value?, data? }` or `{ to, value?, abi, functionName, args }`.
- `intent` (optional convenience, may replace `calls`):
  `{ type: "add_passkey", passkey: { x, y } }` builds
  `[createSigner, addOwnerWithThreshold(proxy, 1)]`;
  `{ type: "remove_passkey", passkey | owner }` builds
  `removeOwner(prev, owner, 1)` and refuses the last owner (`409 LAST_OWNER`).
- `message` follows viem semantics: a string is UTF-8, `{ raw: "0x…" }` is
  bytes. Deployed Safe → ERC-1271 contract signature (checked with
  `isValidSignature`). Undeployed native Safe → ERC-6492-wrapped (checked
  with viem `verifyHash`). Only the first passkey (shared signer) can sign
  for an undeployed Safe.
- A migrated ref on a chain that isn't migrated yet → `409 MIGRATION_REQUIRED`.
- Migration gas: Pimlico sponsorship where available, else the Safe's own
  native balance, else `409 MIGRATION_NEEDS_GAS`. The request body is
  never logged and the key is never stored.
- Markup is unchanged from the old one-phase routes: in token mode a single
  ERC-20 transfer of the gas token gets Rift % + project % on its amount;
  any other token-mode op gets the flat fee; sponsored mode only charges
  what `transferBaseAmountWei` / `flatMarkupTokenAddress` ask for. Calls
  are ordered `[paymaster approve(s), user calls, markup transfers]`.

Error codes: `VALIDATION_ERROR`, `UNSUPPORTED_CHAIN`,
`PASSKEY_UNSUPPORTED_ON_CHAIN`, `PASSKEY_REQUIRED` (missing or `kind:
"oidc"` proof), `INVALID_PASSKEY_SIGNATURE`, `SIGNER_NOT_OWNER`,
`ACCOUNT_MISMATCH`, `TICKET_NOT_FOUND` (404), `MIGRATION_REQUIRED`,
`MIGRATION_NEEDS_GAS`, `MIGRATION_CALLDATA_REJECTED`, `EOA_MISMATCH`,
`LAST_OWNER`, `NOT_AN_OWNER`, `CONFIGURATION_ERROR` (500),
`PREPARE_FAILED`, `SUBMIT_FAILED`.

### Kept route names

- `POST /api/transaction/preview` `{ chainId, account, calls, gas? | paymasterToken? + markup fields }`
  and `POST /api/bridge/preview` `{ sourceChainId, destChainId, tokenAddress, amount, account, recipient? }`
  return the v3 prepare payload plus the old fields (`user_op_hash_hex`,
  `ticket_id`, `expires_at_ms`, `ttl_ms`, `smart_account_address`, `chain_id`).
- `POST /api/transaction/submit-prepared` `{ ticketId, authProof, signer? }`
  (`signer` defaults to the shared signer for a native Safe).
- `POST /api/estimate-fee`, `POST /api/bridge-quote`: read-only, take
  `account` (or a legacy `ownerAddress`).
- `POST /api/smart-account/address|create` `{ chainId, ownerAddress }`:
  legacy EOA-owned Safe address (the private-key fallback is gone).
- `/api/v2/*`: client-EOA relay (the client personal_signs), unchanged.
- WalletConnect (sessions held server-side):
  `POST /api/walletconnect/pair { uri, chainId, account }`,
  `GET /api/walletconnect/sessions`, `DELETE /api/walletconnect/sessions/:topic`,
  `GET /api/walletconnect/requests`,
  `POST /api/walletconnect/requests/:id/preview` → `{ hash_to_sign, ticket_id, requires_auth_proof }`
  (SafeOp hash for `eth_sendTransaction`, SafeMessage hash for the sign methods),
  `POST /api/walletconnect/requests/:id/approve { authProof, signer }` → submits and
  answers the dApp (tx hash, or the ERC-1271 / ERC-6492 signature),
  `POST /api/walletconnect/requests/:id/reject`. An invalid proof leaves the
  request pending.
- Removed: `POST /api/transfer`, `/api/transaction`, `/api/bridge` →
  `410 REPLACED_BY_PASSKEY_WALLETS`; `POST /api/sign` → `410 EOA_SIGNING_REMOVED`.
- `GET /api/system/status`, `GET /health`.

## Gas

Per chain, `<PREFIX>_BUNDLER_URL` and `<PREFIX>_PAYMASTER_RPC` (Pimlico)
and `<PREFIX>_RPC_URL` (node; public fallback). Prefixes: `ETHEREUM`,
`BASE`, `POLYGON`, `CELO`, `ARBITRUM`, `AVALANCHE`, `BSC`, `BERACHAIN`.

- `sponsored`: Pimlico verifying paymaster.
- `token`: Pimlico ERC-20 paymaster (`getTokenQuotes`, Tether-safe approve,
  `paymasterContext.token`). On Celo, Rift's own Erc20Paymaster
  (`celo-paymaster.ts`, see `CELO_PAYMASTER.md`; its signer signs
  paymaster data, never funds).

## Setup

```sh
npm install
cp .env.example .env      # INTERNAL_SERVICE_TOKEN, Pimlico URLs, markup treasury
npm run dev
```

## Tests

```sh
npm test                       # unit + route tests; fork suites skip if anvil is down
~/.foundry/bin/anvil --fork-url https://mainnet.base.org --port 8546 --silent &
ANVIL_RPC_URL=http://127.0.0.1:8546 npm test   # also runs the Base-fork integration suites
```

The fork suites (`src/passkey/fork.integration.test.ts`,
`src/routes.integration.test.ts`) use a software P-256 virtual passkey
(`src/testing/virtualPasskey.ts`) that produces real WebAuthn assertions,
and `RELAY_MODE=direct` (honoured only when `NODE_ENV=test`), which fills
gas itself and submits through `EntryPoint.handleOps` from an anvil
account instead of a bundler. Pimlico can't run on a fork, so paymaster /
markup call construction is unit-tested in `src/passkey/gas.test.ts`.

## Project layout

```
src/
  server.ts              listen + shutdown
  app.ts                 Express app (helmet, cors, auth, routes)
  auth.ts                INTERNAL_SERVICE_TOKEN bearer check
  routes.ts              HTTP routes (passkey API, kept route names, WalletConnect)
  routesV2.ts            /api/v2 client-EOA relay
  chainConfig.ts         chains, RPC / bundler / paymaster env
  passkey/
    constants.ts         addresses, VERIFIERS, capability table
    webauthn.ts          authProof → Safe contract signature (§1d)
    account.ts           AccountRef → Safe account, owner helpers
    userOp.ts            SafeOp hash / operationData, (de)serialisation
    gas.ts               paymaster approve + markup plan
    relay.ts             prepare / submit (Pimlico, or handleOps in tests)
    service.ts           prepare / submit / message / owners
    migration.ts         EOA → passkey owner swap + calldata allowlist
  walletconnect.ts       WalletKit sessions, two-phase approvals
  estimateTransfer.ts    read-only fee estimate
  estimateBridge.ts      read-only bridge quote
  relay.ts               v2 client-EOA relay helpers
  celo-paymaster.ts      Celo Erc20Paymaster data signer
  markup.ts              Rift / project / flat markup calls
  paymasterApprove.ts    Tether-safe paymaster approvals
  testing/               virtual passkey + anvil helpers (tests only)
scripts/
  deploy-passkey-contracts.md
```

## Security notes

- No server-held user keys; no KMS, no enclave signing path (removed).
- The legacy EOA key appears only in the `/api/v3/migrate` body, is used
  for one allowlisted UserOp, and is never logged or stored. Request
  logging never includes bodies.
- Before submit: challenge == hashToSign, `webauthn.get`, UP+UV flags,
  off-chain P-256 check where the key is known, and an on-chain
  `Safe.checkSignatures` / `isValidSignature` eth_call. Origin / rpId are
  checked by the backend (defence in depth; on-chain doesn't check them).
- Helmet, per-IP rate limit, circuit breakers around Pimlico and RPC.
