// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {RiftPayoutVault} from "../src/RiftPayoutVault.sol";

/**
 * RiftPayoutVault deployment through the standard CREATE2 factory
 * (0x4e59b44847b379578588920ca78fbf26c0b4956c, present on every chain).
 * Constructor arguments are identical on every chain, so the vault has the
 * same address everywhere, and it is fully set up by the one deploy
 * transaction (tokens + limits are constructor arguments).
 *
 * Two ways to deploy:
 *   1) From any wallet (e.g. a Rift smart wallet, gas sponsored): send ONE
 *      transaction to the factory with the calldata this script writes to
 *      vault-deploy.json (`to`, `data`). Run without --broadcast to produce it.
 *   2) From an EOA: forge script ... --rpc-url <rpc> --broadcast
 *
 * Env:
 *   VAULT_ADMIN       owner (cold / treasury wallet). Required.
 *   VAULT_OPERATORS   comma-separated backend operator addresses. Required.
 *   VAULT_DELAY       seconds big transfers wait (default 86400, min 3600).
 *   VAULT_SALT        CREATE2 salt string (default "rift-payout-vault-v3").
 *   VAULT_GAS_ALLOWANCE  standing gas paymaster allowance, whole USD (default 50, max 1000).
 *   VAULT_GAS_PER_DAY    total gas allowance top-ups per UTC day, whole USD (default 200, max 1000).
 *   VAULT_QUEUE_PER_DAY  total queued (24h-delayed) transfers per UTC day per token, whole USD (default 50000).
 *   VAULT_PER_PAYOUT  largest instant payout, whole USD (default 5000).
 *   VAULT_PER_DAY     instant payouts per UTC day per token, whole USD (default 100000).
 */
contract DeployRiftPayoutVaultScript is Script {
    address constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// ERC-4337 EntryPoint v0.7 (same address on every chain).
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    /// Pimlico ERC-20 paymaster (same address on every chain): gas paid in the vault's USDC.
    address constant GAS_PAYMASTER = 0x777777777777AeC03fd955926DbF81597e66834C;

    /// USDC + USDT on Base, Ethereum, Arbitrum, Polygon (all 6 decimals).
    function tokens() internal pure returns (address[] memory t) {
        t = new address[](8);
        t[0] = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base USDC
        t[1] = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2; // Base USDT
        t[2] = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // Ethereum USDC
        t[3] = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // Ethereum USDT
        t[4] = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // Arbitrum USDC
        t[5] = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9; // Arbitrum USDT
        t[6] = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359; // Polygon USDC
        t[7] = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F; // Polygon USDT
    }

    function run() external {
        address admin = vm.envAddress("VAULT_ADMIN");
        address[] memory operators = vm.envAddress("VAULT_OPERATORS", ",");
        uint64 delay = uint64(vm.envOr("VAULT_DELAY", uint256(86400)));
        bytes32 salt = keccak256(bytes(vm.envOr("VAULT_SALT", string("rift-payout-vault-v3"))));
        uint128 gasAllowance = uint128(vm.envOr("VAULT_GAS_ALLOWANCE", uint256(50))) * 1e6;
        uint128 gasPerDay = uint128(vm.envOr("VAULT_GAS_PER_DAY", uint256(200))) * 1e6;
        uint128 queuePerDay = uint128(vm.envOr("VAULT_QUEUE_PER_DAY", uint256(50_000))) * 1e6;
        uint128 perPayout = uint128(vm.envOr("VAULT_PER_PAYOUT", uint256(5_000))) * 1e6;
        uint128 perDay = uint128(vm.envOr("VAULT_PER_DAY", uint256(100_000))) * 1e6;

        bytes memory init = abi.encodePacked(
            type(RiftPayoutVault).creationCode, abi.encode(admin, operators, delay, tokens(), perPayout, perDay, queuePerDay, ENTRY_POINT, GAS_PAYMASTER, gasAllowance, gasPerDay)
        );
        address predicted = vm.computeCreate2Address(salt, keccak256(init), FACTORY);
        bytes memory factoryCalldata = abi.encodePacked(salt, init);

        console.log("chain", block.chainid);
        console.log("predicted RiftPayoutVault", predicted);
        console.log("already deployed", predicted.code.length > 0);

        string memory obj = "deploy";
        vm.serializeAddress(obj, "vault", predicted);
        vm.serializeAddress(obj, "to", FACTORY);
        vm.serializeBytes32(obj, "initCodeHash", keccak256(init));
        string memory json = vm.serializeBytes(obj, "data", factoryCalldata);
        vm.writeJson(json, "./vault-deploy.json");

        if (predicted.code.length == 0) {
            vm.startBroadcast();
            (bool ok,) = FACTORY.call(factoryCalldata);
            require(ok && predicted.code.length > 0, "deploy failed");
            vm.stopBroadcast();
        }
        console.log("RiftPayoutVault", predicted);
    }
}
