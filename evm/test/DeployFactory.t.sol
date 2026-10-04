// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeployFactory} from "../script/DeployFactory.s.sol";
import {OthelloFactory} from "../src/OthelloFactory.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// The page-path deploy script: factory only, pinned USDG, Robinhood testnet only.
contract DeployFactoryTest is Test {
    address internal constant USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    function test_deploys_factory_bound_to_usdg_on_robinhood_testnet() public {
        vm.etch(USDG, address(new MockUSDG()).code);
        vm.chainId(46630);
        vm.setEnv("DEPLOYER_KEY", vm.toString(uint256(keccak256("deployer test key"))));
        OthelloFactory f = new DeployFactory().run();
        assertEq(address(f.usdg()), USDG);
        assertEq(f.circleCount(), 0);
    }

    function test_refuses_other_chains() public {
        DeployFactory d = new DeployFactory();
        vm.chainId(1);
        vm.expectRevert(bytes("DeployFactory: not Robinhood Chain testnet"));
        d.run();
    }
}
