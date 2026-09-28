// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title CircleMath
/// @notice Pure arithmetic for an Othello circle (ARB-DESIGN r9 section 2; SPEC sections 4 to 7).
/// USDG base units (6 dp). Collateral rounds down, obligations round up. Every bound is enforced by the
/// caller before these run, so no intermediate can overflow (ARB section 2: all far below 2^128).
library CircleMath {
    uint32 internal constant U32_MAX = type(uint32).max;

    /// H = floor(collateral x (10000 - haircut) / 10000).
    function haircutValue(uint256 collateral, uint256 haircutBps) internal pure returns (uint256) {
        return (collateral * (10000 - haircutBps)) / 10000;
    }

    /// need = max(0, ceil(O x coverage / 10000) - H).
    function need(uint256 obligation, uint256 covBps, uint256 h) internal pure returns (uint256) {
        uint256 required = ceilDiv(obligation * covBps, 10000);
        return required > h ? required - h : 0;
    }

    /// Coverage in basis points, saturated to uint32; U32_MAX when nothing is owed.
    function coverageBps(uint256 h, uint256 allocated, uint256 obligation) internal pure returns (uint32) {
        if (obligation == 0) return U32_MAX;
        uint256 bps = ((h + allocated) * 10000) / obligation;
        return bps > U32_MAX ? U32_MAX : uint32(bps);
    }

    /// Peak-guarantee check input: max over k = 1..n-1 of k x max(0, ceil(c(n-k)cov/10000) - minCover).
    function peakNeed(uint256 n, uint256 c, uint256 coverage, uint256 minCover) internal pure returns (uint256 best) {
        for (uint256 k = 1; k < n; ++k) {
            uint256 per = need(c * (n - k), coverage, minCover);
            uint256 total = k * per;
            if (total > best) best = total;
        }
    }

    /// Completed-circle pooled share: floor(poolLeft x weight / denom); 0 when denom is 0.
    function pooledShare(uint256 poolLeft, uint256 weight, uint256 denom) internal pure returns (uint256) {
        if (denom == 0) return 0;
        return (poolLeft * weight) / denom;
    }

    /// Top-up gate update (SPEC.md:113): max(0, (v - D) - (amount - fill)) + (D - fill).
    function shortByAfterTopUp(uint256 v, uint256 deficit, uint256 amount, uint256 fill)
        internal
        pure
        returns (uint256)
    {
        uint256 base = v - deficit;
        uint256 added = amount - fill;
        return (base > added ? base - added : 0) + (deficit - fill);
    }

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
