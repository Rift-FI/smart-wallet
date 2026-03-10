// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/LiskPaymaster.sol";

contract DeployScript is Script {
    function run() external {
        vm.startBroadcast();

        LiskPaymaster paymaster = new LiskPaymaster(
            IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032),
            msg.sender // verifyingSigner = deployer for now
        );

        console.log("LiskPaymaster deployed at:", address(paymaster));

        vm.stopBroadcast();
    }
}
