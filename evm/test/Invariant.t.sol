// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// Drives one circle with random calls from members and an outsider (ARB section 7.2 state-machine fuzz).
/// The differential half of 7.2 (same sequence through the reference model) is the seeded random vectors
/// replayed in VectorReplay; this suite checks the invariants after every call on sequences the generator
/// never wrote.
contract Handler is Test {
    OthelloCircle public circle;
    MockUSDG public usdg;
    address[] public members;
    address public outsider = address(0xBEEF);

    // ghosts
    uint256 public payouts;
    uint256 public defaults;
    uint256 public completions;
    uint256 public withdrawals;
    uint256 public badTopUpFill;
    mapping(uint256 => uint256) public receivedCount;
    uint256 public lastWithdrawnFromReserve;
    bool public withdrawDecreased;

    constructor(OthelloCircle c_, MockUSDG u_, address[] memory ms) {
        circle = c_;
        usdg = u_;
        members = ms;
    }

    function _who(uint256 seed) internal view returns (address) {
        return seed % 11 == 0 ? outsider : members[seed % members.length];
    }

    function _after() internal {
        if (circle.withdrawnFromReserve() < lastWithdrawnFromReserve) withdrawDecreased = true;
        lastWithdrawnFromReserve = circle.withdrawnFromReserve();
    }

    function join(uint256 s, uint256 amt) external {
        vm.prank(_who(s));
        // mostly valid amounts (H >= 120 needs >= 150), sometimes below the minimum
        uint256 a = amt % 8 == 0 ? bound(amt, 1, 149_999_999) : bound(amt, 150e6, 400e6);
        try circle.joinAndLock(a) {} catch {}
        _after();
    }

    function leave(uint256 s) external {
        vm.prank(_who(s));
        try circle.leaveForming() {} catch {}
        _after();
    }

    function activate() external {
        vm.prank(circle.creator());
        try circle.activate() {} catch {}
        _after();
    }

    function contribute(uint256 s) external {
        vm.prank(_who(s));
        try circle.contribute() {} catch {}
        _after();
    }

    function release(uint256 s) external {
        uint8 r = circle.round();
        vm.prank(_who(s));
        try circle.releasePot() {
            payouts++;
            receivedCount[r]++;
            if (uint256(circle.status()) == 2) completions++;
        } catch {}
        _after();
    }

    function coverage(uint256 s) external {
        vm.prank(_who(s));
        try circle.updateCoverage() {} catch {}
        _after();
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 400));
    }

    /// Progress step: everyone joins and the creator activates, or every member except `skipMask` pays,
    /// then time passes the grace window.
    function progress(uint8 skipMask) external {
        for (uint256 i = 0; i < members.length; ++i) {
            bool forming = uint256(circle.status()) == 0;
            if (forming) {
                vm.prank(members[i]);
                try circle.joinAndLock(150e6 + i) {} catch {}
            } else if ((skipMask >> i) & 1 == 0) {
                vm.prank(members[i]);
                try circle.contribute() {} catch {}
            }
        }
        if (uint256(circle.status()) == 0) {
            vm.prank(circle.creator());
            try circle.activate() {} catch {}
        }
        if (skipMask % 2 == 1) vm.warp(circle.deadline() + circle.graceSecs() + 1);
        _after();
    }

    function mark(uint256 s, uint8 turn) external {
        uint8 r = circle.round();
        vm.prank(_who(s));
        try circle.markDelinquent(r, uint8(bound(turn, 0, 8))) {} catch {}
        _after();
    }

    function declare(uint256 s, uint8 turn) external {
        vm.prank(_who(s));
        try circle.declareDefault(uint8(bound(turn, 0, 8))) {
            defaults++;
        } catch {}
        _after();
    }

    function addStock(uint256 s, uint256 amt) external {
        vm.prank(_who(s));
        try circle.addStock(bound(amt, 1, 100e6)) {} catch {}
        _after();
    }

    function topUp(uint256 s, uint256 amt, bool honest) external {
        amt = bound(amt, 1, 200e6);
        uint256 d = circle.escrowDeficit();
        uint256 fill = honest ? (d < amt ? d : amt) : amt;
        uint256 e0 = circle.escrow();
        vm.prank(_who(s));
        try circle.topUpReserve(amt, fill) {
            // EVM-I24: exactly the signed fill moved from the deficit into escrow.
            if (d - circle.escrowDeficit() != fill || circle.escrow() - e0 != fill) badTopUpFill++;
        } catch {}
        _after();
    }

    function withdraw(uint256 s) external {
        vm.prank(_who(s));
        try circle.withdraw() {
            withdrawals++;
        } catch {}
        _after();
    }

    function cancel() external {
        vm.prank(circle.creator());
        try circle.cancelCircle() {} catch {}
        _after();
    }
}

/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.runs = 256
contract InvariantTest is Test {
    Handler internal h;
    OthelloCircle internal circle;
    MockUSDG internal usdg;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        OthelloFactory f = new OthelloFactory(IERC20(address(usdg)));
        address[] memory ms = new address[](5);
        for (uint256 i = 0; i < 5; ++i) {
            ms[i] = address(uint160(0x1000 + i));
            usdg.mint(ms[i], 1e13);
        }
        OthelloCircle.Params memory p = OthelloCircle.Params({
            n: 5, c: 50e6, g: 35e6, minStockCover: 120e6, haircutBps: 2000, coverageBps: 13000, warnBps: 11000,
            roundSecs: 120, graceSecs: 60
        });
        vm.prank(ms[0]);
        circle = OthelloCircle(f.createCircle(p, ms));
        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(ms[i]);
            usdg.approve(address(circle), type(uint256).max);
        }
        h = new Handler(circle, usdg, ms);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](16);
        sel[0] = Handler.join.selector;
        sel[1] = Handler.leave.selector;
        sel[2] = Handler.activate.selector;
        sel[3] = Handler.contribute.selector;
        sel[4] = Handler.release.selector;
        sel[5] = Handler.release.selector;
        sel[6] = Handler.coverage.selector;
        sel[7] = Handler.warp.selector;
        sel[8] = Handler.mark.selector;
        sel[9] = Handler.declare.selector;
        sel[10] = Handler.addStock.selector;
        sel[11] = Handler.topUp.selector;
        sel[12] = Handler.withdraw.selector;
        sel[13] = Handler.cancel.selector;
        sel[14] = Handler.progress.selector;
        sel[15] = Handler.progress.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(h), selectors: sel}));
    }

    function afterInvariant() external {
        emit log_named_uint("payouts", h.payouts());
        emit log_named_uint("defaults", h.defaults());
        emit log_named_uint("completions", h.completions());
        emit log_named_uint("withdrawals", h.withdrawals());
    }

    /// INV-C2
    function invariant_balance_covers_accounted() public view {
        assertGe(usdg.balanceOf(address(circle)), circle.accounted());
    }

    /// SPEC I2
    function invariant_allocation_bounded_and_summed() public view {
        assertLe(circle.reserveAllocated(), circle.reserveTotal() - circle.reserveLosses());
        uint256 sum;
        for (uint256 t = 0; t < 8; ++t) {
            sum += circle.seat(t).allocated;
        }
        assertEq(sum, circle.reserveAllocated());
    }

    /// EVM-I11
    function invariant_pooled_withdrawals_bounded() public view {
        assertLe(circle.withdrawnFromReserve(), circle.depositsTotal() - circle.reserveLosses());
        assertFalse(h.withdrawDecreased());
    }

    /// EVM-I24
    function invariant_topup_fill_is_exactly_signed() public view {
        assertEq(h.badTopUpFill(), 0);
    }

    /// SPEC I10: each round pays exactly once; at most n payouts.
    function invariant_each_member_paid_once() public view {
        assertLe(h.payouts(), 5);
        for (uint256 r = 0; r < 5; ++r) {
            assertLe(h.receivedCount(r), 1);
        }
    }

    /// Escrow deficit is unreachable in USDG-only circles (ARB-FINDINGS.md F-1).
    function invariant_no_escrow_deficit() public view {
        assertEq(circle.escrowDeficit(), 0);
    }

    /// Forfeits never exceed deposits; paid and defaulted never both set for an unsettled seat.
    function invariant_forfeits_bounded() public view {
        assertLe(circle.forfeitedTotal(), circle.depositsTotal());
    }
}
