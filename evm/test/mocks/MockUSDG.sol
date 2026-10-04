// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Real-behaviour USDG stand-in: plain ERC20, 6 decimals, exact transfers, finite allowances.
contract MockUSDG is ERC20 {
    constructor() ERC20("Global Dollar", "USDG") {}

    function decimals() public pure virtual override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Charges a 1% fee on every transfer: the recipient receives less than the amount (ARB section 3.2).
contract FeeOnTransferUSDG is MockUSDG {
    bool public feeOff;

    function setFeeOff(bool off) external {
        feeOff = off;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!feeOff && from != address(0) && to != address(0) && value >= 100) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// Short-pays outbound: when `shortOn` is set, a transfer moves one unit less than asked but returns true.
contract ShortPayUSDG is MockUSDG {
    bool public shortOn;

    function setShort(bool on) external {
        shortOn = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (shortOn && from != address(0) && to != address(0) && value > 0) {
            super._update(from, to, value - 1);
        } else {
            super._update(from, to, value);
        }
    }
}

/// Over-debits outbound: when on, the sender loses one unit more than the amount; the recipient gets the amount.
contract OverdebitUSDG is MockUSDG {
    bool public overOn;

    function setOver(bool on) external {
        overOn = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (overOn && from != address(0) && to != address(0) && value > 0) {
            super._update(from, to, value);
            super._update(from, address(0xDEAD), 1);
        } else {
            super._update(from, to, value);
        }
    }
}

/// Re-enters a configured target during transfers.
contract ReentrantUSDG is MockUSDG {
    address public target;
    bytes public payload;
    bool public lastReentryOk = true;
    bytes public lastReentryData;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && from != address(0) && to != address(0)) {
            address t = target;
            target = address(0);
            (lastReentryOk, lastReentryData) = t.call(payload);
        }
    }
}

/// Wrong decimals: the factory must refuse it.
contract EightDecimals is MockUSDG {
    function decimals() public pure override returns (uint8) {
        return 8;
    }
}
