# Deploying the Safe passkey contracts on a new chain

Docs only. Nothing in this repo sends these transactions.

Passkey-owned Safes need three contracts from the Safe passkey module
(safe-modules `modules/passkey`, **v0.2.1**). They are deployed with the
Safe singleton factory, so they land at the **same address on every
chain**:

| Contract | Address |
|---|---|
| `SafeWebAuthnSharedSigner` | `0x94a4F6affBd8975951142c3999aEAB7ecee555c2` |
| `SafeWebAuthnSignerFactory` | `0x1d31F259eE307358a26dFb23EB365939E8641195` |
| FCL P-256 verifier (`FCLP256Verifier`) | `0xA86e0054C51E4894D88762a017ECc5E5235f5DBA` |

The Safe 1.4.1 / Safe4337Module v0.3.0 stack must already be present
(`SafeProxyFactory 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, singleton
`0x41675C099F32341bf84BFc5382aF534df5C7461a`, module
`0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`, EntryPoint v0.7).

## Current status (see `src/passkey/constants.ts`)

| Chain | shared signer | signer factory |
|---|---|---|
| Ethereum 1, Base 8453, Polygon 137, Celo 42220, Arbitrum 42161, Avalanche 43114, BSC 56 | yes | yes |
| Berachain 80094 | yes | **no** |
| Lisk 1135 (not a supported chain yet) | no | no |

Without the factory, a chain can still host passkey-native Safes signed by
their first passkey (shared signer), but extra passkeys and EOA → passkey
migration fail with `PASSKEY_UNSUPPORTED_ON_CHAIN`.

## 1. Check what is there

```sh
RPC=https://rpc.berachain.com
for a in 0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7 \
         0x94a4F6affBd8975951142c3999aEAB7ecee555c2 \
         0x1d31F259eE307358a26dFb23EB365939E8641195 \
         0xA86e0054C51E4894D88762a017ECc5E5235f5DBA; do
  echo "$a $(cast code $a --rpc-url $RPC | wc -c)"
done
```

`3` characters (`0x` + newline) means no code. Also check the RIP-7212
precompile: `cast call 0x0000000000000000000000000000000000000100 <valid-input>`
returns `0x…01` where supported. Without it, `VERIFIERS` still works: the
P256 library falls back to the FCL verifier (more gas).

## 2. Safe singleton factory

The singleton factory `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` is a
CREATE2 deployer (calldata = `salt (32 bytes) ‖ initCode`). If it is
missing on the chain, request a presigned deployment from
`safe-global/safe-singleton-factory` (it needs a chain-specific signed
transaction; it cannot be deployed by anyone else at that address).

## 3. Deploy

Use the safe-modules repository's own deployment scripts at the passkey
**v0.2.1** release (`modules/passkey`), which deploy deterministically
through the singleton factory. Do not change the compiler
settings from the release: any drift changes the init code and therefore
the address. Before sending, check that the CREATE2 address computed from
the factory, salt and init code equals the address in the table above.

```sh
git clone https://github.com/safe-global/safe-modules && cd safe-modules
git checkout <passkey v0.2.1 release tag>
cd modules/passkey
# add the chain to the hardhat network config, then run the release's
# deploy task for the missing contract(s) only
```

Deploy only what step 1 showed is missing (on Berachain: the signer
factory).

## 4. Verify, then enable here

```sh
cast code 0x1d31F259eE307358a26dFb23EB365939E8641195 --rpc-url $RPC   # non-empty
# getSigner must return the same proxy address as on Base for the same key
cast call 0x1d31F259eE307358a26dFb23EB365939E8641195 \
  "getSigner(uint256,uint256,uint176)(address)" <x> <y> \
  0x0100A86e0054C51E4894D88762a017ECc5E5235f5DBA --rpc-url $RPC
```

Then flip the capability in `src/passkey/constants.ts` (or, without a
deploy, set `PASSKEY_CAPABILITY_OVERRIDES='{"80094":{"signerFactory":true}}'`
on the smart-wallet service). Run the fork suite against that chain
(`anvil --fork-url $RPC`) before turning on migrations there.
