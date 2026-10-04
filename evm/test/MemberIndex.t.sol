// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {OthelloCircle} from "../src/OthelloCircle.sol";
import {Base} from "./Base.t.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {FakeCircle} from "./mocks/FakeCircle.sol";

/// ARB-DESIGN r10: the factory's per-account index lists circles an account created or joined, and nothing else.
contract MemberIndexTest is Base {
    function setUp() public {
        _deployWith(new MockUSDG());
    }

    function _page(address who) internal view returns (address[] memory) {
        return factory.circlesOfPage(who, 0, 50);
    }

    function test_creator_listed_at_creation_named_members_not() public {
        _create(demoParams());
        address[] memory mine = _page(m[0]);
        assertEq(mine.length, 1);
        assertEq(mine[0], address(circle));
        assertTrue(factory.listed(m[0], address(circle)));
        for (uint256 i = 1; i < m.length; ++i) {
            assertEq(factory.circlesOfCount(m[i]), 0, "named but not joined: not listed");
            assertFalse(factory.listed(m[i], address(circle)));
        }
    }

    function test_member_listed_at_first_join_once_through_leave_and_rejoin() public {
        _create(demoParams());
        vm.prank(m[1]);
        circle.joinAndLock(150 * U);
        assertEq(factory.circlesOfCount(m[1]), 1);
        assertEq(_page(m[1])[0], address(circle));

        vm.prank(m[1]);
        circle.leaveForming();
        vm.prank(m[1]);
        circle.joinAndLock(150 * U);
        assertEq(factory.circlesOfCount(m[1]), 1, "a leave and rejoin adds nothing");

        // the creator joining its own circle adds nothing either
        vm.prank(m[0]);
        circle.joinAndLock(150 * U);
        assertEq(factory.circlesOfCount(m[0]), 1);
    }

    function test_strangers_circles_naming_the_victim_add_nothing_until_the_victim_joins() public {
        address victim = makeAddr("victim");
        address stranger = makeAddr("stranger");
        address other = makeAddr("other");
        address other2 = makeAddr("other2");
        address other3 = makeAddr("other3");
        OthelloCircle.Params memory p = demoParams();
        address[] memory ms = new address[](5);
        (ms[0], ms[1], ms[2], ms[3], ms[4]) = (stranger, victim, other, other2, other3);
        vm.startPrank(stranger);
        for (uint256 i = 0; i < 40; ++i) {
            factory.createCircle(p, ms);
        }
        vm.stopPrank();
        assertEq(factory.circlesOfCount(victim), 0, "40 circles naming the victim: its list is still empty");
        assertEq(factory.circlesOfCount(stranger), 40);

        // the victim joins one of them: exactly that one is listed
        OthelloCircle joined = OthelloCircle(factory.circles(17));
        usdg.mint(victim, 1_000 * U);
        vm.startPrank(victim);
        usdg.approve(address(joined), type(uint256).max);
        joined.joinAndLock(150 * U);
        vm.stopPrank();
        address[] memory mine = _page(victim);
        assertEq(mine.length, 1);
        assertEq(mine[0], address(joined));
    }

    function test_recordJoin_refused_unless_called_by_a_circle_of_this_factory() public {
        _create(demoParams());
        address victim = makeAddr("victim");

        vm.prank(makeAddr("eoa"));
        vm.expectRevert(OthelloFactory.NotCircle.selector);
        factory.recordJoin(victim);

        FakeCircle fake = new FakeCircle(address(factory));
        vm.prank(address(fake));
        vm.expectRevert(OthelloFactory.NotCircle.selector);
        factory.recordJoin(victim);

        // a real circle of another factory (same code) is not this factory's circle
        OthelloFactory other = new OthelloFactory(IERC20(address(usdg)));
        vm.prank(m[0]);
        address foreign = other.createCircle(demoParams(), m);
        vm.prank(foreign);
        vm.expectRevert(OthelloFactory.NotCircle.selector);
        factory.recordJoin(victim);

        assertEq(factory.circlesOfCount(victim), 0);
    }

    function test_page_bounds() public {
        _members(5);
        OthelloCircle.Params memory p = demoParams();
        vm.startPrank(m[0]);
        address[] memory made = new address[](55);
        for (uint256 i = 0; i < 55; ++i) {
            made[i] = factory.createCircle(p, m);
        }
        vm.stopPrank();
        assertEq(factory.circlesOfCount(m[0]), 55);

        address[] memory first = factory.circlesOfPage(m[0], 0, 50);
        assertEq(first.length, 50);
        for (uint256 i = 0; i < 50; ++i) {
            assertEq(first[i], made[i], "oldest first");
        }
        vm.expectRevert(OthelloFactory.InvalidParams.selector);
        factory.circlesOfPage(m[0], 0, 51);

        address[] memory tail = factory.circlesOfPage(m[0], 50, 50);
        assertEq(tail.length, 5, "a range past the end returns what exists");
        assertEq(tail[4], made[54]);
        assertEq(factory.circlesOfPage(m[0], 55, 10).length, 0);
        assertEq(factory.circlesOfPage(m[0], type(uint256).max, 50).length, 0);
        assertEq(factory.circlesOfPage(makeAddr("nobody"), 0, 50).length, 0);
    }
}
