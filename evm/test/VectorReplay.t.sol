// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// Replays the reference model's trace vectors (core/vectors/v1) against the real contracts.
/// After every call: the outcome (success, or the exact custom error and its arguments), every circle and
/// seat field, every USDG balance and allowance must equal the model's. Also INV-C1 and INV-C2 per step.
/// This consumer implements `common-v1` and `evm-usdg-v1` only and refuses any other ruleset.
contract VectorReplayTest is Test {
    string internal constant ROOT = "/../core/vectors/v1/";

    MockUSDG internal usdg;
    OthelloFactory internal factory;
    OthelloCircle internal circle;
    string internal json;
    string internal actionsJson;
    address[] internal memberAddrs;

    function actor(uint256 id) internal pure returns (address) {
        return id == 0 ? address(0) : address(uint160(0xA11CE0000 + id));
    }

    // ------------------------------------------------------------------ entry points
    function test_replay_common_v1() external {
        _replayProfile("common-v1");
    }

    function test_replay_evm_usdg_v1() external {
        _replayProfile("evm-usdg-v1");
    }

    function _replayProfile(string memory profile) internal {
        string memory dir = string.concat(vm.projectRoot(), ROOT, profile, "/");
        string memory idx = vm.readFile(string.concat(dir, "index.json"));
        assertEq(vm.parseJsonString(idx, ".profile"), profile, "index profile");
        string[] memory names = vm.parseJsonStringArray(idx, ".names");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(idx, ".sha256");
        assertEq(names.length, hashes.length);
        assertGt(names.length, 0, "no vectors");
        for (uint256 i = 0; i < names.length; ++i) {
            string memory path = string.concat(dir, names[i]);
            assertEq(sha256(bytes(vm.readFile(path))), hashes[i], string.concat("sha256 ", names[i]));
            uint256 snap = vm.snapshotState();
            this.replayFile(path, profile);
            vm.revertToState(snap);
        }
    }

    /// External so the refusal tests can expect its revert.
    function replayFile(string memory path, string memory profile) external {
        _requireProfile(profile);
        actionsJson = vm.readFile(string.concat(vm.projectRoot(), ROOT, profile, "/ACTIONS.json"));
        require(
            keccak256(bytes(vm.parseJsonString(actionsJson, ".profile"))) == keccak256(bytes(profile)),
            "ACTIONS.json profile differs"
        );
        json = vm.readFile(path);
        string memory rs = vm.parseJsonString(json, ".ruleset");
        require(keccak256(bytes(rs)) == keccak256(bytes(profile)), "ruleset: vector profile differs from consumer");
        _setUp();
        string memory name = vm.parseJsonString(json, ".name");
        if (!_create(name)) return;
        _compareState(".initialState", name, type(uint256).max);
        uint256 steps = _count(".steps");
        for (uint256 i = 0; i < steps; ++i) {
            _step(i, name);
        }
    }

    function _requireProfile(string memory profile) internal pure {
        bytes32 h = keccak256(bytes(profile));
        require(h == keccak256("common-v1") || h == keccak256("evm-usdg-v1"), "ruleset: not implemented here");
    }

    // ------------------------------------------------------------------ setup
    function _setUp() internal {
        vm.warp(vm.parseJsonUint(json, ".start"));
        usdg = new MockUSDG();
        factory = new OthelloFactory(usdg);
        uint256[] memory ids = vm.parseJsonUintArray(json, ".members");
        uint256[] memory bals = vm.parseJsonUintArray(json, ".balances");
        delete memberAddrs;
        for (uint256 i = 0; i < ids.length; ++i) {
            memberAddrs.push(actor(ids[i]));
            if (ids[i] != 0) usdg.mint(actor(ids[i]), bals[i]);
        }
    }

    function _params() internal view returns (OthelloCircle.Params memory p) {
        p.n = vm.parseJsonUint(json, ".params.n");
        p.c = vm.parseJsonUint(json, ".params.c");
        p.g = vm.parseJsonUint(json, ".params.g");
        p.minStockCover = vm.parseJsonUint(json, ".params.min_stock_cover");
        p.haircutBps = vm.parseJsonUint(json, ".params.haircut_bps");
        p.coverageBps = vm.parseJsonUint(json, ".params.coverage_bps");
        p.warnBps = vm.parseJsonUint(json, ".params.warn_bps");
        p.roundSecs = vm.parseJsonUint(json, ".params.round_secs");
        p.graceSecs = vm.parseJsonUint(json, ".params.grace_secs");
    }

    function _create(string memory name) internal returns (bool) {
        OthelloCircle.Params memory p = _params();
        address creator = actor(vm.parseJsonUint(json, ".creator"));
        uint256 before = factory.circleCount();
        vm.prank(creator);
        (bool ok, bytes memory ret) =
            address(factory).call(abi.encodeCall(OthelloFactory.createCircle, (p, memberAddrs)));
        if (vm.keyExistsJson(json, ".create.error")) {
            assertFalse(ok, string.concat(name, ": create should refuse"));
            assertEq(ret, _expectedRevert(".create"), string.concat(name, ": create refusal"));
            assertEq(factory.circleCount(), before, "no circle on refusal");
            return false;
        }
        assertTrue(ok, string.concat(name, ": create should succeed"));
        circle = OthelloCircle(abi.decode(ret, (address)));
        assertTrue(factory.isCircle(address(circle)));
        assertEq(circle.factory(), address(factory));
        assertEq(circle.creator(), creator);
        uint256[] memory allows = vm.parseJsonUintArray(json, ".allowances");
        for (uint256 i = 0; i < memberAddrs.length; ++i) {
            vm.prank(memberAddrs[i]);
            usdg.approve(address(circle), allows[i]);
        }
        return true;
    }

    // ------------------------------------------------------------------ one step
    function _step(uint256 i, string memory name) internal {
        string memory k = string.concat(".steps[", vm.toString(i), "]");
        string memory action = vm.parseJsonString(json, string.concat(k, ".action"));
        string memory where = string.concat(name, " step ", vm.toString(i), " ", action);
        uint256 accBefore = circle.accounted();
        uint256 balBefore = usdg.balanceOf(address(circle));
        (bool ok, bytes memory ret, bool direct) = _call(k, action, where);
        _checkOutcome(k, where, keccak256(bytes(action)), ok, ret);
        // INV-C2: the ledger covers every bucket. INV-C1: accounted moves exactly with the circle's own transfers.
        uint256 accAfter = circle.accounted();
        uint256 balAfter = usdg.balanceOf(address(circle));
        assertGe(balAfter, accAfter, string.concat(where, ": INV-C2"));
        if (!direct) {
            assertEq(
                int256(accAfter) - int256(accBefore),
                int256(balAfter) - int256(balBefore),
                string.concat(where, ": INV-C1")
            );
        }
        _compareState(string.concat(k, ".state"), where, i);
    }

    function _call(string memory k, string memory action, string memory where)
        internal
        returns (bool ok, bytes memory ret, bool direct)
    {
        uint256[] memory a = vm.parseJsonUintArray(json, string.concat(k, ".args"));
        address caller = actor(vm.parseJsonUint(json, string.concat(k, ".caller")));
        vm.warp(vm.parseJsonUint(json, string.concat(k, ".t")));
        _requireListed(action, a.length, where);
        bytes32 h = keccak256(bytes(action));
        vm.prank(caller);
        if (h == keccak256("usdgApprove")) {
            (ok, ret) = address(usdg).call(abi.encodeCall(usdg.approve, (address(circle), a[0])));
        } else if (h == keccak256("usdgSendToCircle")) {
            (ok, ret) = address(usdg).call(abi.encodeCall(usdg.transfer, (address(circle), a[0])));
            direct = true;
        } else {
            (ok, ret) = address(circle).call(_encode(h, a));
        }
    }

    function _checkOutcome(string memory k, string memory where, bytes32 h, bool ok, bytes memory ret) internal view {
        if (vm.keyExistsJson(json, string.concat(k, ".outcome.error"))) {
            assertFalse(ok, string.concat(where, ": should refuse"));
            assertEq(ret, _expectedRevert(string.concat(k, ".outcome")), string.concat(where, ": refusal"));
            return;
        }
        assertTrue(ok, string.concat(where, ": should succeed"));
        if (h == keccak256("quote")) {
            uint256[] memory r = vm.parseJsonUintArray(json, string.concat(k, ".returns"));
            (uint256 value, uint256 hv) = abi.decode(ret, (uint256, uint256));
            assertEq(value, r[0], string.concat(where, ": quote value"));
            assertEq(hv, r[1], string.concat(where, ": quote h"));
        }
    }

    function _encode(bytes32 h, uint256[] memory a) internal pure returns (bytes memory) {
        if (h == keccak256("joinAndLock")) return abi.encodeCall(OthelloCircle.joinAndLock, (a[0]));
        if (h == keccak256("leaveForming")) return abi.encodeCall(OthelloCircle.leaveForming, ());
        if (h == keccak256("cancelCircle")) return abi.encodeCall(OthelloCircle.cancelCircle, ());
        if (h == keccak256("activate")) return abi.encodeCall(OthelloCircle.activate, ());
        if (h == keccak256("contribute")) return abi.encodeCall(OthelloCircle.contribute, ());
        if (h == keccak256("releasePot")) return abi.encodeCall(OthelloCircle.releasePot, ());
        if (h == keccak256("updateCoverage")) return abi.encodeCall(OthelloCircle.updateCoverage, ());
        if (h == keccak256("markDelinquent")) {
            return abi.encodeCall(OthelloCircle.markDelinquent, (uint8(a[0]), uint8(a[1])));
        }
        if (h == keccak256("declareDefault")) return abi.encodeCall(OthelloCircle.declareDefault, (uint8(a[0])));
        if (h == keccak256("addStock")) return abi.encodeCall(OthelloCircle.addStock, (a[0]));
        if (h == keccak256("withdraw")) return abi.encodeCall(OthelloCircle.withdraw, ());
        if (h == keccak256("quote")) return abi.encodeCall(OthelloCircle.quote, (a[0]));
        if (h == keccak256("topUpReserve")) return abi.encodeCall(OthelloCircle.topUpReserve, (a[0], a[1]));
        revert("encoder: unknown action");
    }

    /// Encoder table: (action, argument count). Must match ACTIONS.json exactly (tested in ActionSchema.t.sol).
    function encoderArity(bytes32 h) public pure returns (bool known, uint256 arity) {
        if (h == keccak256("joinAndLock") || h == keccak256("addStock") || h == keccak256("quote")
            || h == keccak256("declareDefault")) return (true, 1);
        if (h == keccak256("markDelinquent") || h == keccak256("topUpReserve")) return (true, 2);
        if (h == keccak256("leaveForming") || h == keccak256("cancelCircle") || h == keccak256("activate")
            || h == keccak256("contribute") || h == keccak256("releasePot") || h == keccak256("updateCoverage")
            || h == keccak256("withdraw")) return (true, 0);
        return (false, 0);
    }

    /// The consumer refuses any action its profile does not list, or listed with another argument count.
    function _requireListed(string memory action, uint256 argc, string memory where) internal view {
        string memory key = string.concat(".actions.", action);
        string memory hkey = string.concat(".harness.", action);
        bool inProfile = vm.keyExistsJson(actionsJson, key);
        require(inProfile || vm.keyExistsJson(actionsJson, hkey), string.concat(where, ": action not in profile"));
        uint256 listed = _countIn(actionsJson, string.concat(inProfile ? key : hkey, ".args"));
        require(listed == argc, string.concat(where, ": argument count differs from ACTIONS.json"));
    }

    // ------------------------------------------------------------------ expectations
    function _expectedRevert(string memory k) internal view returns (bytes memory out) {
        string memory sig = vm.parseJsonString(json, string.concat(k, ".sig"));
        uint256[] memory args = vm.parseJsonUintArray(json, string.concat(k, ".args"));
        out = abi.encodePacked(bytes4(keccak256(bytes(sig))));
        for (uint256 i = 0; i < args.length; ++i) {
            out = abi.encodePacked(out, args[i]);
        }
    }

    function _compareState(string memory k, string memory where, uint256) internal view {
        uint256[] memory cs = vm.parseJsonUintArray(json, string.concat(k, ".circle"));
        uint256[21] memory got = circleState(circle);
        for (uint256 f = 0; f < 21; ++f) {
            assertEq(got[f], cs[f], string.concat(where, ": circle field ", vm.toString(f)));
        }
        uint256[] memory ss = vm.parseJsonUintArray(json, string.concat(k, ".seats"));
        for (uint256 t = 0; t < 8; ++t) {
            uint256[8] memory sg = seatState(circle, t);
            for (uint256 f = 0; f < 8; ++f) {
                assertEq(sg[f], ss[t * 8 + f], string.concat(where, ": seat ", vm.toString(t), " field ", vm.toString(f)));
            }
        }
        uint256[] memory bs = vm.parseJsonUintArray(json, string.concat(k, ".balances"));
        assertEq(usdg.balanceOf(address(circle)), bs[0], string.concat(where, ": circle balance"));
        uint256[] memory al = vm.parseJsonUintArray(json, string.concat(k, ".allowances"));
        for (uint256 i = 0; i < memberAddrs.length; ++i) {
            assertEq(usdg.balanceOf(memberAddrs[i]), bs[i + 1], string.concat(where, ": member balance ", vm.toString(i)));
            assertEq(usdg.allowance(memberAddrs[i], address(circle)), al[i], string.concat(where, ": allowance ", vm.toString(i)));
        }
    }

    /// Order = core/reference.py CIRCLE_FIELDS.
    function circleState(OthelloCircle x) public view returns (uint256[21] memory s) {
        s[0] = uint256(x.status());
        s[1] = x.round();
        s[2] = x.deadline();
        s[3] = x.paidBitmap();
        s[4] = x.joinedBitmap();
        s[5] = x.withdrawnBitmap();
        s[6] = x.receivedBitmap();
        s[7] = x.defaultedBitmap();
        s[8] = x.delinquentBitmap();
        s[9] = x.reserveTotal();
        s[10] = x.reserveLosses();
        s[11] = x.reserveAllocated();
        s[12] = x.escrow();
        s[13] = x.escrowDeficit();
        s[14] = x.withdrawnFromReserve();
        s[15] = x.collateralReturned();
        s[16] = x.depositsTotal();
        s[17] = x.forfeitedTotal();
        s[18] = x.nextGateShortBy();
        s[19] = x.heldContributions();
        s[20] = x.lastCoverageAt();
    }

    /// Order = core/reference.py SEAT_FIELDS.
    function seatState(OthelloCircle x, uint256 t) public view returns (uint256[8] memory s) {
        OthelloCircle.Seat memory st = x.seat(t);
        s[0] = st.collateral;
        s[1] = st.g;
        s[2] = st.topUps;
        s[3] = st.forfeited;
        s[4] = st.roundsPaid;
        s[5] = st.allocated;
        s[6] = st.lastCoverageBps;
        s[7] = st.delinquentMarks;
    }

    // ------------------------------------------------------------------ json helpers
    function _count(string memory key) internal view returns (uint256) {
        return _countIn(json, key);
    }

    function _countIn(string memory src, string memory key) internal view returns (uint256 c) {
        while (vm.keyExistsJson(src, string.concat(key, "[", vm.toString(c), "]"))) ++c;
    }
}
