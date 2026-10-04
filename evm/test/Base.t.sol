// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// Shared setup: the demo circle (SPEC section 5): n = 5, c = 50, g = 35, min cover 120, haircut 20%,
/// coverage 130%, warn 110%, round 120 s, grace 60 s. Members lock 150 USDG (H = 120).
abstract contract Base is Test {
    uint256 internal constant U = 1e6;
    uint256 internal constant RESERVE_LOSSES_SLOT = 11;
    uint256 internal constant ESCROW_DEFICIT_SLOT = 14;
    uint256 internal constant NEXT_GATE_SHORT_BY_SLOT = 19;

    MockUSDG internal usdg;
    OthelloFactory internal factory;
    OthelloCircle internal circle;
    address[] internal m;
    address internal outsider = makeAddr("outsider");

    function demoParams() internal pure returns (OthelloCircle.Params memory p) {
        p = OthelloCircle.Params({
            n: 5,
            c: 50 * U,
            g: 35 * U,
            minStockCover: 120 * U,
            haircutBps: 2000,
            coverageBps: 13000,
            warnBps: 11000,
            roundSecs: 120,
            graceSecs: 60
        });
    }

    function _deployWith(MockUSDG token) internal {
        vm.warp(1_800_000_000);
        usdg = token;
        factory = new OthelloFactory(IERC20(address(token)));
    }

    function _members(uint256 n) internal returns (address[] memory out) {
        delete m;
        out = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = makeAddr(string.concat("member", vm.toString(i)));
            m.push(out[i]);
            usdg.mint(out[i], 1_000_000 * U);
        }
    }

    function _create(OthelloCircle.Params memory p) internal returns (OthelloCircle) {
        address[] memory ms = _members(p.n);
        vm.prank(ms[0]);
        circle = OthelloCircle(factory.createCircle(p, ms));
        for (uint256 i = 0; i < ms.length; ++i) {
            vm.prank(ms[i]);
            usdg.approve(address(circle), type(uint256).max);
        }
        return circle;
    }

    function _joinAll(uint256 amount) internal {
        for (uint256 i = 0; i < m.length; ++i) {
            vm.prank(m[i]);
            circle.joinAndLock(amount);
        }
    }

    function _activeDemo() internal {
        _create(demoParams());
        _joinAll(150 * U);
        vm.prank(m[0]);
        circle.activate();
    }

    function _payRound(uint256 skipMask) internal {
        for (uint256 i = 0; i < m.length; ++i) {
            if ((skipMask >> i) & 1 == 1) continue;
            vm.prank(m[i]);
            circle.contribute();
        }
    }

    function _pastGrace() internal {
        vm.warp(circle.deadline() + circle.graceSecs() + 1);
    }

    /// Forces an escrow deficit (unreachable in USDG-only circles, see ARB-FINDINGS.md) to exercise the
    /// consent path. Keeps nextGateShortBy >= escrowDeficit, as every reachable state does.
    function _forceDeficit(uint256 d) internal {
        vm.store(address(circle), bytes32(ESCROW_DEFICIT_SLOT), bytes32(d));
        uint256 v = circle.nextGateShortBy();
        if (v < d) vm.store(address(circle), bytes32(NEXT_GATE_SHORT_BY_SLOT), bytes32(d));
        assertEq(circle.escrowDeficit(), d);
    }
}
