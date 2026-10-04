// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";

/// Page path (ARB-DESIGN r9 section 9.1): deploys ONLY the factory, from the commit review 2 approved.
/// Joshua runs it with his own key; the broadcast receipt (evm/broadcast/DeployFactory.s.sol/46630/run-latest.json,
/// addresses and hashes only, no key) is committed with the config commit and checked by CI job `trust-config`.
///   forge script script/DeployFactory.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast
/// with DEPLOYER_KEY set in the environment.
contract DeployFactory is Script {
    uint256 internal constant ROBINHOOD_TESTNET = 46630;
    address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    function run() external returns (OthelloFactory factory) {
        require(block.chainid == ROBINHOOD_TESTNET, "DeployFactory: not Robinhood Chain testnet");
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        factory = new OthelloFactory(IERC20(USDG));
        vm.stopBroadcast();
        console2.log("factory", address(factory));
        console2.logBytes32(address(factory).codehash);
    }
}
