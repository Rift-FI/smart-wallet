// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/Erc20Paymaster.sol";

contract DeployErc20PaymasterScript is Script {
    function run() external {
        vm.startBroadcast();

        Erc20Paymaster paymaster = new Erc20Paymaster(
            IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032),
            msg.sender // verifyingSigner = deployer; rotate later via setVerifyingSigner
        );

        console.log("Erc20Paymaster deployed at:", address(paymaster));

        vm.stopBroadcast();
    }
}
