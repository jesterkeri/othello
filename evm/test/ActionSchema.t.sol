// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {VectorReplayTest} from "./VectorReplay.t.sol";

/// ARB section 7.1 rows "ruleset profiles" and "profile action lists (r7)": the Foundry consumer's encoder
/// matches every ACTIONS.json schema exactly, and the consumer refuses vectors of other profiles, vectors
/// without a ruleset, and actions its profile does not list.
contract ActionSchemaTest is Test {
    VectorReplayTest internal replay;
    string internal constant ROOT = "/../core/vectors/v1/";

    function setUp() public {
        replay = new VectorReplayTest();
    }

    function _fixture(string memory name) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/", name);
    }

    function _checkEncoder(string memory profile, string[] memory expected) internal view {
        string memory a = vm.readFile(string.concat(vm.projectRoot(), ROOT, profile, "/ACTIONS.json"));
        string[] memory keys = vm.parseJsonKeys(a, ".actions");
        assertEq(keys.length, expected.length, string.concat(profile, ": action count"));
        for (uint256 i = 0; i < keys.length; ++i) {
            (bool known, uint256 arity) = replay.encoderArity(keccak256(bytes(keys[i])));
            assertTrue(known, string.concat(profile, ": encoder lacks ", keys[i]));
            uint256 listed;
            while (vm.keyExistsJson(a, string.concat(".actions.", keys[i], ".args[", vm.toString(listed), "]"))) {
                ++listed;
            }
            assertEq(arity, listed, string.concat(profile, ": arity of ", keys[i]));
            bool found;
            for (uint256 j = 0; j < expected.length; ++j) {
                if (keccak256(bytes(expected[j])) == keccak256(bytes(keys[i]))) found = true;
            }
            assertTrue(found, string.concat(profile, ": unexpected action ", keys[i]));
        }
    }

    function _common() internal pure returns (string[] memory c) {
        c = new string[](12);
        c[0] = "joinAndLock";
        c[1] = "leaveForming";
        c[2] = "cancelCircle";
        c[3] = "activate";
        c[4] = "contribute";
        c[5] = "releasePot";
        c[6] = "updateCoverage";
        c[7] = "markDelinquent";
        c[8] = "declareDefault";
        c[9] = "addStock";
        c[10] = "withdraw";
        c[11] = "quote";
    }

    function test_common_v1_schema_has_no_top_up() public view {
        _checkEncoder("common-v1", _common());
        string memory a = vm.readFile(string.concat(vm.projectRoot(), ROOT, "common-v1/ACTIONS.json"));
        assertFalse(vm.keyExistsJson(a, ".actions.topUpReserve"));
    }

    function test_evm_usdg_v1_schema_matches_encoder() public view {
        string[] memory c = _common();
        string[] memory e = new string[](13);
        for (uint256 i = 0; i < 12; ++i) {
            e[i] = c[i];
        }
        e[12] = "topUpReserve";
        _checkEncoder("evm-usdg-v1", e);
        string memory a = vm.readFile(string.concat(vm.projectRoot(), ROOT, "evm-usdg-v1/ACTIONS.json"));
        assertEq(vm.parseJsonString(a, ".actions.topUpReserve.args[1][0]"), "expectedFill");
    }

    function test_refuses_solana_profile_consumer() public {
        vm.expectRevert(bytes("ruleset: not implemented here"));
        replay.replayFile(_fixture("solana-profile-vector.json"), "solana-pyth-v2");
    }

    function test_refuses_solana_vector_in_evm_consumer() public {
        vm.expectRevert(bytes("ruleset: vector profile differs from consumer"));
        replay.replayFile(_fixture("solana-profile-vector.json"), "common-v1");
    }

    function test_refuses_vector_without_ruleset() public {
        vm.expectRevert();
        replay.replayFile(_fixture("no-ruleset-vector.json"), "common-v1");
    }

    function test_refuses_top_up_in_common_vector() public {
        vm.expectRevert(bytes("topup-refusals-and-consent step 0 topUpReserve: action not in profile"));
        replay.replayFile(_fixture("common-vector-with-topup.json"), "common-v1");
    }
}
