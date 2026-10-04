// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OthelloCircle} from "./OthelloCircle.sol";
import {CircleMath} from "./CircleMath.sol";

/// @title OthelloFactory
/// @notice Deploys Othello circles with plain CREATE. No owner, no admin, no setters, no ETH.
/// `isCircle` is written in exactly one place (createCircle), for the address `new OthelloCircle` returned;
/// the Robinhood app trusts a circle only if this factory (pinned address and code hash) lists it (ARB section A).
/// `circlesOf` (ARB r10) lists, per account, the circles it created or joined; only that account's own actions add to
/// it (createCircle as the caller, or joinAndLock through the circle's recordJoin), so nobody can bury its circles.
contract OthelloFactory {
    error InvalidParams();
    error GuaranteeBelowPeakNeed(uint256 peakNeed, uint256 reserveAtStart);
    error InvalidToken();
    error NotCircle();

    event CircleCreated(address indexed circle, address indexed creator, uint256 index);

    IERC20 public immutable usdg;
    mapping(address => bool) public isCircle;
    address[] public circles;
    mapping(address => mapping(address => bool)) public listed;
    mapping(address => address[]) internal _circlesOf;

    uint256 internal constant MAX_C = 1e12;
    uint256 internal constant MAX_G = 1e12;
    uint256 internal constant MAX_AMOUNT = 1e13;
    uint256 internal constant MAX_PAGE = 50;

    constructor(IERC20 usdg_) {
        if (address(usdg_).code.length == 0) revert InvalidToken();
        if (IERC20Metadata(address(usdg_)).decimals() != 6) revert InvalidToken();
        usdg = usdg_;
    }

    function circleCount() external view returns (uint256) {
        return circles.length;
    }

    function circlesOfCount(address account) external view returns (uint256) {
        return _circlesOf[account].length;
    }

    /// Entries [start, start + count) of `account`'s list, oldest first; a range past the end returns what exists.
    function circlesOfPage(address account, uint256 start, uint256 count) external view returns (address[] memory page) {
        if (count > MAX_PAGE) revert InvalidParams();
        address[] storage all = _circlesOf[account];
        if (start >= all.length) return page;
        uint256 end = all.length - start < count ? all.length : start + count;
        page = new address[](end - start);
        for (uint256 i = 0; i < page.length; ++i) {
            page[i] = all[start + i];
        }
    }

    /// Called by a circle this factory created, from joinAndLock, with its joiner. Lists the circle for that member.
    function recordJoin(address member) external {
        if (!isCircle[msg.sender]) revert NotCircle();
        _list(member, msg.sender);
    }

    /// @notice Create a circle. The caller becomes its immutable creator and must be one of `members`.
    function createCircle(OthelloCircle.Params calldata p, address[] calldata members)
        external
        returns (address circle)
    {
        // ARB section 4.2 order: members.length == n first, then section 2 bounds, then creator, then peak.
        if (members.length != p.n) revert InvalidParams();
        if (p.n < 3 || p.n > 8) revert InvalidParams();
        bool creatorIn;
        for (uint256 i = 0; i < members.length; ++i) {
            if (members[i] == address(0)) revert InvalidParams();
            for (uint256 j = 0; j < i; ++j) {
                if (members[j] == members[i]) revert InvalidParams();
            }
            if (members[i] == msg.sender) creatorIn = true;
        }
        if (p.c < 1 || p.c > MAX_C || p.g < 1 || p.g > MAX_G) revert InvalidParams();
        if (p.minStockCover > MAX_AMOUNT) revert InvalidParams();
        if (p.haircutBps >= 10000) revert InvalidParams();
        if (!(10000 <= p.warnBps && p.warnBps < p.coverageBps && p.coverageBps <= 30000)) revert InvalidParams();
        if (p.roundSecs < 60 || p.roundSecs > 31_536_000) revert InvalidParams();
        if (p.graceSecs < 30 || p.graceSecs > 2_592_000) revert InvalidParams();
        if (!creatorIn) revert InvalidParams();
        uint256 peak = CircleMath.peakNeed(p.n, p.c, p.coverageBps, p.minStockCover);
        if (p.n * p.g < peak) revert GuaranteeBelowPeakNeed(peak, p.n * p.g);

        circle = address(new OthelloCircle(p, members, msg.sender, usdg));
        isCircle[circle] = true;
        circles.push(circle);
        _list(msg.sender, circle);
        emit CircleCreated(circle, msg.sender, circles.length - 1);
    }

    function _list(address account, address circle) internal {
        if (listed[account][circle]) return;
        listed[account][circle] = true;
        _circlesOf[account].push(circle);
    }
}
