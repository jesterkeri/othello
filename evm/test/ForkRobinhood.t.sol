// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Demo} from "../script/Demo.s.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";

interface IPaxosToken {
    function paused() external view returns (bool);
    function isFrozen(address) external view returns (bool);
}

/// ARB-DESIGN r9 section 7.2 "Fork (Robinhood testnet, read-only)": the REAL USDG proxy on a local fork of
/// Robinhood Chain testnet. Nothing is broadcast; all writes happen inside the local fork.
/// Run: forge test --match-contract ForkRobinhood (needs network; CI runs it as its own job).
contract ForkRobinhoodTest is Test {
    string internal constant RPC = "https://rpc.testnet.chain.robinhood.com";
    address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
    /// EIP-1967 implementation slot; value recorded 2026-09-28 (ARB-DESIGN r9 section 0.3).
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address internal constant RECORDED_IMPL = 0xF0863D7A29a55d0c4263c11bFac754312ff078DF;

    function setUp() public {
        vm.createSelectFork(RPC);
        assertEq(block.chainid, 46630, "Robinhood Chain testnet");
    }

    function test_real_usdg_shape() public view {
        assertGt(USDG.code.length, 0);
        assertEq(IERC20Metadata(USDG).decimals(), 6);
        assertEq(IERC20Metadata(USDG).symbol(), "USDG");
        address impl = address(uint160(uint256(vm.load(USDG, IMPL_SLOT))));
        assertEq(impl, RECORDED_IMPL, "USDG implementation changed since it was recorded; re-check before deploying");
        assertFalse(IPaxosToken(USDG).paused());
    }

    function test_real_usdg_exact_transfer_between_fork_accounts() public {
        address a = makeAddr("fork-a");
        address b = makeAddr("fork-b");
        deal(USDG, a, 10e6);
        uint256 before = IERC20(USDG).balanceOf(b);
        vm.prank(a);
        IERC20(USDG).transfer(b, 3e6);
        assertEq(IERC20(USDG).balanceOf(b) - before, 3e6, "no fee on transfer");
        assertEq(IERC20(USDG).balanceOf(a), 7e6);
    }

    /// The demonstrator end to end against the real USDG implementation (exact deltas enforced by the circle).
    function test_demo_full_circle_on_real_usdg() public {
        uint256[] memory keys = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) {
            keys[i] = uint256(keccak256(abi.encode("fork demo member", i)));
            deal(USDG, vm.addr(keys[i]), 5e6);
        }
        Demo d = new Demo();
        (OthelloFactory f, OthelloCircle c) = d.runWith(IERC20(USDG), keys);
        assertTrue(f.isCircle(address(c)));
        assertEq(uint256(c.status()), 2, "Completed");
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(IERC20(USDG).balanceOf(vm.addr(keys[i])), 5e6, "whole balance back");
            assertEq(IERC20(USDG).allowance(vm.addr(keys[i]), address(c)), 0);
            assertFalse(IPaxosToken(USDG).isFrozen(vm.addr(keys[i])));
        }
        assertEq(IERC20(USDG).balanceOf(address(c)), 0);
    }
}
