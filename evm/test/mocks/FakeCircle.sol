// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// A lookalike that claims the official factory but was never registered by it (adapter trust test).
contract FakeCircle {
    address public immutable factory;

    constructor(address f) {
        factory = f;
    }
}
