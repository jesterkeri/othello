// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Demo} from "../script/Demo.s.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// ARB section 7.1 "deployment config (r8)": the demonstrator runs end to end and takes the factory
/// address only from its own deployment, never from a constant.
contract DemoTest is Test {
    function test_demo_runs_end_to_end_with_its_own_factory() public {
        MockUSDG usdg = new MockUSDG();
        uint256[] memory keys = new uint256[](3);
        for (uint256 i = 0; i < 3; ++i) {
            keys[i] = uint256(keccak256(abi.encode("demo member", i)));
            usdg.mint(vm.addr(keys[i]), 5e6);
        }
        Demo d = new Demo();
        (OthelloFactory f, OthelloCircle c) = d.runWith(IERC20(address(usdg)), keys);
        assertTrue(f.isCircle(address(c)));
        assertEq(c.factory(), address(f));
        assertEq(uint256(c.status()), 2, "Completed");
        for (uint256 i = 0; i < 3; ++i) {
            // each member: paid 3 rounds, received one pot of 3, got collateral and guarantee back
            assertEq(usdg.balanceOf(vm.addr(keys[i])), 5e6, "whole balance back");
            assertEq(usdg.allowance(vm.addr(keys[i]), address(c)), 0, "exact approvals leave none");
        }
        assertEq(usdg.balanceOf(address(c)), 0);
        // the script source holds no factory address constant
        string memory src = vm.readFile(string.concat(vm.projectRoot(), "/script/Demo.s.sol"));
        assertFalse(vm.contains(src, "FACTORY"), "no pinned factory");
    }

    function test_demo_refuses_other_chains() public {
        Demo d = new Demo();
        vm.chainId(1);
        vm.expectRevert(bytes("Demo: not Robinhood Chain testnet"));
        d.run();
    }
}
