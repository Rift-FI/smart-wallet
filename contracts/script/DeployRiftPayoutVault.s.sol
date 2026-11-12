// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {RiftPayoutVault} from "../src/RiftPayoutVault.sol";

/**
 * Deploys RiftPayoutVault with CREATE2, so it gets the SAME address on every
 * chain (constructor args and salt are identical everywhere), then lists that
 * chain's USDC and USDT with the configured limits and gives up the
 * deployer's setup rights.
 *
 * Env:
 *   VAULT_ADMIN          owner (cold wallet). Required.
 *   VAULT_OPERATORS      comma-separated backend operator addresses. Required.
 *   VAULT_DELAY          seconds big transfers wait (default 86400 = 24h, min 3600).
 *   VAULT_SALT           CREATE2 salt (default "rift-payout-vault-v1").
 *   VAULT_PER_PAYOUT     largest instant payout, whole USD (default 5000).
 *   VAULT_PER_DAY        instant payouts per day per token, whole USD (default 100000).
 *   VAULT_FINISH_SETUP   "false" keeps the deployer's setup role (default true).
 *
 * Usage (per chain):
 *   forge script script/DeployRiftPayoutVault.s.sol --rpc-url <rpc> --broadcast --verify
 * Dry run / predicted address: same command without --broadcast.
 */
contract DeployRiftPayoutVaultScript is Script {
    struct Tokens {
        address usdc;
        address usdt;
    }

    function tokensFor(uint256 chainId) internal pure returns (Tokens memory) {
        if (chainId == 8453) return Tokens(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2); // Base
        if (chainId == 1) return Tokens(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 0xdAC17F958D2ee523a2206206994597C13D831ec7); // Ethereum
        if (chainId == 42161) return Tokens(0xaf88d065e77c8cC2239327C5EDb3A432268e5831, 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9); // Arbitrum
        if (chainId == 137) return Tokens(0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, 0xc2132D05D31c914a87C6611C10748AEb04B58e8F); // Polygon
        revert("unsupported chain");
    }

    function run() external {
        address admin = vm.envAddress("VAULT_ADMIN");
        address[] memory operators = vm.envAddress("VAULT_OPERATORS", ",");
        uint64 delay = uint64(vm.envOr("VAULT_DELAY", uint256(86400)));
        bytes32 salt = keccak256(bytes(vm.envOr("VAULT_SALT", string("rift-payout-vault-v1"))));
        uint128 perPayout = uint128(vm.envOr("VAULT_PER_PAYOUT", uint256(5_000))) * 1e6;
        uint128 perDay = uint128(vm.envOr("VAULT_PER_DAY", uint256(100_000))) * 1e6;
        bool finish = vm.envOr("VAULT_FINISH_SETUP", true);
        Tokens memory t = tokensFor(block.chainid);

        vm.startBroadcast();
        address deployer = msg.sender;
        bytes memory init = abi.encodePacked(type(RiftPayoutVault).creationCode, abi.encode(admin, deployer, operators, delay));
        address predicted = vm.computeCreate2Address(salt, keccak256(init));

        RiftPayoutVault vault;
        if (predicted.code.length == 0) {
            vault = new RiftPayoutVault{salt: salt}(admin, deployer, operators, delay);
            require(address(vault) == predicted, "address mismatch");
        } else {
            vault = RiftPayoutVault(payable(predicted));
        }

        // USDC and USDT are 6 decimals on all four chains. Skipped on a re-run
        // after setup was finished (the admin changes limits from then on).
        if (vault.hasRole(vault.CONFIGURATOR_ROLE(), deployer)) {
            vault.setLimits(t.usdc, perPayout, perDay);
            vault.setLimits(t.usdt, perPayout, perDay);
            if (finish) vault.finishSetup();
        }
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("RiftPayoutVault", address(vault));
        console.log("admin", admin);
        console.log("USDC", t.usdc);
        console.log("USDT", t.usdt);
    }
}
