// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";

/// Minimal demonstrator (ARB-DESIGN r9 section 9.1, no-page path): deploys the factory and runs one
/// three-member USDG circle end to end with the operator's own wallets. Every call after the deploy uses
/// the address `new OthelloFactory(...)` returned in this same run; nothing reads a pinned address.
///
/// Joshua runs it (keys come from his environment, never from this repo or a chat):
///   forge script script/Demo.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast
/// with MEMBER_KEY_0, MEMBER_KEY_1, MEMBER_KEY_2 set. Each wallet needs 5 USDG and a little ETH for gas.
contract Demo is Script {
    uint256 internal constant ROBINHOOD_TESTNET = 46630;
    /// Paxos USDG on Robinhood Chain testnet (ARB-DESIGN r9 section 0.3).
    address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    uint256 internal constant C = 1e6; // 1 USDG per round
    uint256 internal constant G = 5e5; // 0.5 USDG guarantee (peak need 1.4 for n = 3)
    uint256 internal constant LOCK = 15e5; // 1.5 USDG collateral (H = 1.2 = min cover)

    function run() external {
        require(block.chainid == ROBINHOOD_TESTNET, "Demo: not Robinhood Chain testnet");
        uint256[] memory keys = new uint256[](3);
        keys[0] = vm.envUint("MEMBER_KEY_0");
        keys[1] = vm.envUint("MEMBER_KEY_1");
        keys[2] = vm.envUint("MEMBER_KEY_2");
        runWith(IERC20(USDG), keys);
    }

    function params() public pure returns (OthelloCircle.Params memory) {
        return OthelloCircle.Params({
            n: 3,
            c: C,
            g: G,
            minStockCover: 12e5,
            haircutBps: 2000,
            coverageBps: 13000,
            warnBps: 11000,
            roundSecs: 60,
            graceSecs: 30
        });
    }

    /// Also called by the demonstrator test on a local chain with a mock USDG.
    function runWith(IERC20 usdg, uint256[] memory keys) public returns (OthelloFactory factory, OthelloCircle circle) {
        address[] memory members = new address[](3);
        for (uint256 i = 0; i < 3; ++i) {
            members[i] = vm.addr(keys[i]);
        }

        vm.startBroadcast(keys[0]);
        factory = new OthelloFactory(usdg);
        circle = OthelloCircle(factory.createCircle(params(), members));
        vm.stopBroadcast();
        console2.log("factory", address(factory));
        console2.log("circle", address(circle));

        for (uint256 i = 0; i < 3; ++i) {
            vm.startBroadcast(keys[i]);
            usdg.approve(address(circle), LOCK + G); // exact amount, never unlimited
            circle.joinAndLock(LOCK);
            vm.stopBroadcast();
        }
        vm.broadcast(keys[0]);
        circle.activate();

        for (uint256 r = 0; r < 3; ++r) {
            for (uint256 i = 0; i < 3; ++i) {
                vm.startBroadcast(keys[i]);
                usdg.approve(address(circle), C);
                circle.contribute();
                vm.stopBroadcast();
            }
            vm.broadcast(keys[r]);
            circle.releasePot();
            console2.log("pot released to member", r);
        }

        for (uint256 i = 0; i < 3; ++i) {
            vm.broadcast(keys[i]);
            circle.withdraw();
        }
        console2.log("circle completed; every member withdrew");
    }
}
