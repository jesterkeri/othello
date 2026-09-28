// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";
import {MockUSDG, FeeOnTransferUSDG, ShortPayUSDG, ReentrantUSDG, EightDecimals, OverdebitUSDG} from "./mocks/MockUSDG.sol";
import {Base} from "./Base.t.sol";

contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// ARB-DESIGN r9 section 7.1 rows the trace vectors cannot express (hostile tokens, factory, ETH, gas,
/// forced-state consent cases). Everything else in 7.1 is asserted by VectorReplay step by step.
contract OthelloCircleTest is Base {
    function setUp() public {
        _deployWith(new MockUSDG());
    }

    // ------------------------------------------------------------------ factory
    function test_factory_refuses_token_without_code() public {
        vm.expectRevert(OthelloFactory.InvalidToken.selector);
        new OthelloFactory(IERC20(makeAddr("eoa")));
    }

    function test_factory_refuses_wrong_decimals() public {
        EightDecimals t = new EightDecimals();
        vm.expectRevert(OthelloFactory.InvalidToken.selector);
        new OthelloFactory(IERC20(address(t)));
    }

    function test_factory_circle_config_equals_inputs() public {
        OthelloCircle.Params memory p = demoParams();
        _create(p);
        assertEq(circle.n(), p.n);
        assertEq(circle.c(), p.c);
        assertEq(circle.g(), p.g);
        assertEq(circle.minStockCover(), p.minStockCover);
        assertEq(circle.haircutBps(), p.haircutBps);
        assertEq(circle.coverageBps(), p.coverageBps);
        assertEq(circle.warnBps(), p.warnBps);
        assertEq(circle.roundSecs(), p.roundSecs);
        assertEq(circle.graceSecs(), p.graceSecs);
        assertEq(address(circle.usdg()), address(usdg));
        assertEq(circle.factory(), address(factory));
        assertEq(circle.creator(), m[0]);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(circle.members(i), m[i]);
        }
        assertEq(circle.members(5), address(0));
        assertTrue(factory.isCircle(address(circle)));
        assertEq(factory.circles(0), address(circle));
        assertEq(factory.circleCount(), 1);
        assertFalse(factory.isCircle(address(factory)));
    }

    function test_creator_is_factory_caller_not_first_member() public {
        address[] memory ms = _members(5);
        vm.prank(ms[3]);
        circle = OthelloCircle(factory.createCircle(demoParams(), ms));
        assertEq(circle.creator(), ms[3]);
        vm.prank(ms[0]);
        vm.expectRevert(OthelloCircle.Unauthorized.selector);
        circle.cancelCircle();
    }

    function test_creator_authority_factory_and_member_refused() public {
        _create(demoParams());
        _joinAll(150 * U);
        vm.prank(address(factory));
        vm.expectRevert(OthelloCircle.Unauthorized.selector);
        circle.activate();
        vm.prank(address(factory));
        vm.expectRevert(OthelloCircle.Unauthorized.selector);
        circle.cancelCircle();
        vm.prank(m[1]);
        vm.expectRevert(OthelloCircle.Unauthorized.selector);
        circle.activate();
        // tx.origin is not authority either
        vm.prank(m[1], m[0]);
        vm.expectRevert(OthelloCircle.Unauthorized.selector);
        circle.activate();
        vm.prank(m[0]);
        circle.activate();
        assertEq(uint256(circle.status()), 1);
    }

    function test_full_forming_circle_can_always_be_cancelled_by_creator() public {
        _create(demoParams());
        _joinAll(150 * U);
        vm.prank(m[0]);
        circle.cancelCircle();
        for (uint256 i = 0; i < 5; ++i) {
            uint256 before = usdg.balanceOf(m[i]);
            vm.prank(m[i]);
            circle.withdraw();
            assertEq(usdg.balanceOf(m[i]) - before, 185 * U);
        }
        assertEq(usdg.balanceOf(address(circle)), 0);
    }

    // ------------------------------------------------------------------ transfer deltas (3.2)
    function test_fee_on_transfer_refused_on_every_pull() public {
        _deployWith(new FeeOnTransferUSDG());
        _create(demoParams());
        vm.prank(m[0]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TransferAmountMismatch.selector, 185 * U, 185 * U - 185 * U / 100));
        circle.joinAndLock(150 * U);
        assertEq(circle.joinedBitmap(), 0);
        assertEq(circle.reserveTotal(), 0);
    }

    function test_short_pay_refused_on_every_push() public {
        ShortPayUSDG t = new ShortPayUSDG();
        _deployWith(t);
        _create(demoParams());
        _joinAll(150 * U);
        t.setShort(true);
        vm.prank(m[1]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TransferAmountMismatch.selector, 185 * U, 185 * U - 1));
        circle.leaveForming();
        assertEq(circle.joinedBitmap(), 31, "state rolled back");
        // pulls are short too: contribute and joins refuse
        t.setShort(false);
        vm.prank(m[0]);
        circle.activate();
        t.setShort(true);
        vm.prank(m[0]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TransferAmountMismatch.selector, 50 * U, 50 * U - 1));
        circle.contribute();
        t.setShort(false);
        _payRound(0);
        t.setShort(true);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TransferAmountMismatch.selector, 250 * U, 250 * U - 1));
        circle.releasePot();
        assertEq(circle.round(), 0);
    }

    // ------------------------------------------------------------------ reentrancy
    function test_reentrancy_refused_by_guard() public {
        ReentrantUSDG t = new ReentrantUSDG();
        _deployWith(t);
        _create(demoParams());
        _joinAll(150 * U);
        t.arm(address(circle), abi.encodeCall(OthelloCircle.leaveForming, ()));
        vm.prank(m[1]);
        circle.leaveForming();
        assertFalse(t.lastReentryOk());
        assertEq(
            bytes4(t.lastReentryData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "guard, not NotAMember"
        );
        assertEq(circle.joinedBitmap(), 31 & ~uint256(2));
    }

    // ------------------------------------------------------------------ ETH
    function test_plain_eth_send_reverts() public {
        _create(demoParams());
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(circle).call{value: 1}("");
        assertFalse(ok);
        (ok,) = address(factory).call{value: 1}("");
        assertFalse(ok);
    }

    function test_forced_eth_changes_nothing() public {
        _activeDemo();
        uint256 acc = circle.accounted();
        new ForceSend{value: 1 ether}(payable(address(circle)));
        assertEq(address(circle).balance, 1 ether);
        assertEq(circle.accounted(), acc);
        _payRound(0);
        circle.releasePot();
        assertEq(circle.round(), 1);
    }

    // ------------------------------------------------------------------ surplus
    function test_direct_usdg_is_never_counted_or_paid() public {
        _activeDemo();
        vm.prank(m[2]);
        usdg.transfer(address(circle), 7 * U);
        uint256 acc = circle.accounted();
        assertEq(usdg.balanceOf(address(circle)) - acc, 7 * U);
        for (uint256 r = 0; r < 5; ++r) {
            _payRound(0);
            circle.releasePot();
        }
        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(m[i]);
            circle.withdraw();
        }
        assertEq(circle.accounted(), 0);
        assertEq(usdg.balanceOf(address(circle)), 7 * U, "surplus stays locked (AL9)");
    }

    // ------------------------------------------------------------------ top-up consent (EVM-I24), forced deficit
    /// (a) The page read escrowDeficit = 0 and prepared topUpReserve(100, 0); the deficit then rose.
    function test_topup_refuses_when_deficit_rose_after_read() public {
        _activeDemo();
        uint256 expectedFill = 0;
        _forceDeficit(40 * U);
        uint256 bal = usdg.balanceOf(m[2]);
        vm.prank(m[2]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TopUpFillChanged.selector, expectedFill, 40 * U));
        circle.topUpReserve(100 * U, expectedFill);
        assertEq(usdg.balanceOf(m[2]), bal);
        assertEq(circle.escrowDeficit(), 40 * U);
    }

    /// (b) The page read fill x > 0; another member's top-up cleared the deficit first.
    function test_topup_refuses_when_deficit_cleared_first() public {
        _activeDemo();
        _forceDeficit(40 * U);
        uint256 shown = 40 * U;
        vm.prank(m[3]);
        circle.topUpReserve(40 * U, 40 * U);
        vm.prank(m[2]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TopUpFillChanged.selector, shown, 0));
        circle.topUpReserve(100 * U, shown);
    }

    /// (c) Unchanged state: fill applied exactly; the rest goes to the reserve.
    function test_topup_applies_exact_fill() public {
        _activeDemo();
        _forceDeficit(40 * U);
        uint256 r0 = circle.reserveTotal();
        uint256 e0 = circle.escrow();
        vm.expectEmit(address(circle));
        emit OthelloCircle.ReserveToppedUp(m[2], 2, 100 * U, 40 * U);
        uint256 v = circle.nextGateShortBy();
        vm.prank(m[2]);
        circle.topUpReserve(100 * U, 40 * U);
        // SPEC.md:113: max(0, (v - D) - (amount - fill)) + (D - fill)
        uint256 base = v - 40 * U;
        assertEq(circle.nextGateShortBy(), (base > 60 * U ? base - 60 * U : 0) + 0);
        assertEq(circle.escrowDeficit(), 0);
        assertEq(circle.escrow() - e0, 40 * U);
        assertEq(circle.reserveTotal() - r0, 60 * U);
        assertEq(circle.seat(2).topUps, 100 * U);
    }

    function test_topup_fill_smaller_than_deficit() public {
        _activeDemo();
        _forceDeficit(400 * U);
        vm.prank(m[2]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TopUpFillChanged.selector, 0, 100 * U));
        circle.topUpReserve(100 * U, 0);
        uint256 v = circle.nextGateShortBy();
        vm.prank(m[2]);
        circle.topUpReserve(100 * U, 100 * U);
        assertEq(circle.escrowDeficit(), 300 * U);
        assertEq(circle.nextGateShortBy(), v - 400 * U + 300 * U, "deficit left in shortBy");
    }

    // ------------------------------------------------------------------ withdraw order (I16)
    function test_withdraw_order_does_not_change_amounts() public {
        _activeDemo();
        vm.prank(m[3]);
        circle.addStock(20 * U);
        _payRound(0);
        circle.releasePot();
        _payRound(1); // m0 (received) skips round 1
        _pastGrace();
        circle.markDelinquent(1, 0);
        circle.declareDefault(0);
        circle.releasePot();
        for (uint256 r = 2; r < 5; ++r) {
            _payRound(1);
            circle.releasePot();
        }
        assertEq(uint256(circle.status()), 2);
        uint256 snap = vm.snapshotState();
        uint256[5] memory forward;
        for (uint256 i = 0; i < 5; ++i) {
            uint256 b = usdg.balanceOf(m[i]);
            vm.prank(m[i]);
            circle.withdraw();
            forward[i] = usdg.balanceOf(m[i]) - b;
        }
        vm.revertToState(snap);
        uint256[5] memory order = [uint256(3), 0, 4, 1, 2];
        for (uint256 j = 0; j < 5; ++j) {
            uint256 i = order[j];
            uint256 b = usdg.balanceOf(m[i]);
            vm.prank(m[i]);
            circle.withdraw();
            assertEq(usdg.balanceOf(m[i]) - b, forward[i], "order-independent");
        }
        // EVM-I11: pooled part never exceeds deposits minus losses
        assertLe(circle.withdrawnFromReserve(), circle.depositsTotal() - circle.reserveLosses());
    }

    // ------------------------------------------------------------------ outbound deltas, each side alone
    /// Circle side (M11): the circle loses one unit more than it sent; the recipient gets the exact amount.
    function test_outbound_overdebit_refused_by_circle_side_check() public {
        OverdebitUSDG t = new OverdebitUSDG();
        _deployWith(t);
        _create(demoParams());
        _joinAll(150 * U);
        t.setOver(true);
        vm.prank(m[1]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TransferAmountMismatch.selector, 185 * U, 185 * U + 1));
        circle.leaveForming();
    }

    /// Recipient side (M34): the circle sends the exact amount; a fee means the recipient gets less.
    function test_outbound_fee_refused_by_recipient_side_check() public {
        FeeOnTransferUSDG t = new FeeOnTransferUSDG();
        t.setFeeOff(true);
        _deployWith(t);
        _create(demoParams());
        _joinAll(150 * U);
        vm.prank(m[0]);
        circle.cancelCircle();
        t.setFeeOff(false);
        vm.prank(m[1]);
        vm.expectRevert(abi.encodeWithSelector(OthelloCircle.TransferAmountMismatch.selector, 185 * U, 185 * U - 185 * U / 100));
        circle.withdraw();
        assertEq(circle.withdrawnBitmap(), 0, "rolled back");
    }

    // ------------------------------------------------------------------ gate boundary and capped allocation
    /// SPEC I1 at the exact edge (M24): sum of needs = remaining passes, remaining - 1 refuses.
    function _gateState() internal returns (uint256 sum) {
        _activeDemo();
        _payRound(0);
        circle.releasePot(); // m0 received; round 1
        _payRound(0);
        // the round-1 gate: m0 (O = 150) and m1 as recipient (O = 150); H = 120 each; need = 195 - 120 = 75
        sum = 150 * U;
    }

    function test_gate_passes_when_needs_equal_remaining() public {
        uint256 sum = _gateState();
        vm.store(address(circle), bytes32(RESERVE_LOSSES_SLOT), bytes32(circle.reserveTotal() - sum));
        circle.releasePot();
        assertEq(circle.round(), 2);
        assertEq(circle.reserveAllocated(), sum);
    }

    function test_gate_refuses_one_unit_short() public {
        uint256 sum = _gateState();
        uint256 avail = sum - 1;
        vm.store(address(circle), bytes32(RESERVE_LOSSES_SLOT), bytes32(circle.reserveTotal() - avail));
        vm.expectRevert(
            abi.encodeWithSelector(OthelloCircle.ReserveOvercommitted.selector, sum, avail, 1, 75 * U, 75 * U, 0, 120 * U)
        );
        circle.releasePot();
    }

    /// Allocation is capped in turn order (M27): the earliest recipient gets min(need, remaining), later ones the rest.
    function test_allocation_capped_in_turn_order() public {
        _activeDemo();
        for (uint256 r = 0; r < 2; ++r) {
            _payRound(0);
            circle.releasePot();
        }
        // round 2: m0 (paid 2, O = 150, need 75) and m1 (paid 2, O = 150, need 75) have received
        uint256 remaining = 100 * U;
        vm.store(address(circle), bytes32(RESERVE_LOSSES_SLOT), bytes32(circle.reserveTotal() - remaining));
        circle.updateCoverage();
        assertEq(circle.seat(0).allocated, 75 * U, "first in turn order gets its whole need");
        assertEq(circle.seat(1).allocated, 25 * U, "second gets what remains");
        assertEq(circle.reserveAllocated(), remaining);
        assertEq(circle.seat(1).lastCoverageBps, uint32(((120 * U + 25 * U) * 10000) / (150 * U)));
    }

    // ------------------------------------------------------------------ gas ceiling (4.5)
    function test_gas_ceiling_n8_worst_case() public {
        OthelloCircle.Params memory p = demoParams();
        p.n = 8;
        p.g = 400 * U;
        _create(p);
        uint256 worst;
        for (uint256 i = 0; i < 8; ++i) {
            vm.prank(m[i]);
            uint256 g0 = gasleft();
            circle.joinAndLock(150 * U);
            worst = _max(worst, g0 - gasleft());
        }
        vm.prank(m[0]);
        circle.activate();
        for (uint256 r = 0; r < 8; ++r) {
            uint256 skip = r >= 2 ? 3 : 0; // seats 0 and 1 skip once they have received
            _payRound(skip);
            if (skip != 0 && r == 2) {
                _pastGrace();
                circle.markDelinquent(2, 1);
                circle.markDelinquent(2, 0);
                uint256 g0 = gasleft();
                circle.declareDefault(0);
                worst = _max(worst, g0 - gasleft());
                g0 = gasleft();
                circle.declareDefault(1);
                worst = _max(worst, g0 - gasleft());
            }
            uint256 g1 = gasleft();
            circle.updateCoverage();
            worst = _max(worst, g1 - gasleft());
            g1 = gasleft();
            circle.releasePot();
            worst = _max(worst, g1 - gasleft());
        }
        for (uint256 i = 0; i < 8; ++i) {
            vm.prank(m[i]);
            uint256 g0 = gasleft();
            circle.withdraw();
            worst = _max(worst, g0 - gasleft());
        }
        emit log_named_uint("worst-case gas at n = 8", worst);
        assertLe(worst, 1_500_000);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
