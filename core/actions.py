"""Per-profile action lists (ARB-DESIGN r9 section A, "Action lists (r7)").

The single source for core/vectors/v1/<profile>/ACTIONS.json. Each action lists its exact argument names
and Solidity types and the errors it may return. The generator refuses any call outside its profile's
list, or with other arguments. `successAllowed: false` marks an action whose refusals are shared by the
profile but whose settling effects are chain-specific (common-v1 declareDefault: EVM seizes internally,
Solana sells through a pool).
"""

from __future__ import annotations

U = "uint256"
U8 = "uint8"

_COMMON = {
    "joinAndLock": {"args": [["amount", U]],
                    "errors": ["CircleNotForming", "NotAMember", "AlreadyJoined", "InvalidParams",
                               "CollateralBelowMinimum", "InsufficientBalance", "InsufficientAllowance"]},
    "leaveForming": {"args": [], "errors": ["CircleNotForming", "NotAMember", "NotJoined"]},
    "cancelCircle": {"args": [], "errors": ["CircleNotForming", "Unauthorized"]},
    "activate": {"args": [], "errors": ["CircleNotForming", "Unauthorized", "NotAllJoined"]},
    "contribute": {"args": [], "errors": ["CircleNotActive", "NotAMember", "AlreadyDefaulted",
                                          "AlreadyContributed", "InsufficientBalance",
                                          "InsufficientAllowance"]},
    "releasePot": {"args": [], "errors": ["CircleNotActive", "RoundNotFunded", "CoverageTooLow",
                                          "ReserveOvercommitted"]},
    "updateCoverage": {"args": [], "errors": ["CircleNotActive"]},
    "markDelinquent": {"args": [["round", U8], ["turn", U8]],
                       "errors": ["CircleNotActive", "InvalidParams", "GraceNotElapsed", "SeatAlreadyPaid",
                                  "AlreadyDefaulted", "AlreadyMarked"]},
    "declareDefault": {"args": [["turn", U8]],
                       "errors": ["CircleNotActive", "InvalidParams", "GraceNotElapsed", "SeatAlreadyPaid",
                                  "PrePayoutDefaultUnsupported", "AlreadyDefaulted", "NotMarked",
                                  "DefaultOutOfOrder"]},
    "addStock": {"args": [["amount", U]],
                 "errors": ["CircleNotActive", "NotAMember", "AlreadyDefaulted", "InvalidParams",
                            "InsufficientBalance", "InsufficientAllowance"]},
    "withdraw": {"args": [], "errors": ["NotFinished", "NotAMember", "NotJoined", "AlreadyWithdrawn"]},
    "quote": {"args": [["amount", U]], "errors": ["InvalidParams"], "view": True},
}

# Token-level steps a vector may take (not circle actions): approve the circle, send USDG to it directly.
HARNESS = {
    "usdgApprove": {"args": [["amount", U]]},
    "usdgSendToCircle": {"args": [["amount", U]]},
}

PROFILES = {
    "common-v1": {
        "model": "CommonModel",
        "actions": {**_COMMON, "declareDefault": {**_COMMON["declareDefault"], "successAllowed": False}},
    },
    "evm-usdg-v1": {
        "model": "EvmUsdgModel",
        "actions": {
            **_COMMON,
            "topUpReserve": {"args": [["amount", U], ["expectedFill", U]],
                             "errors": ["CircleNotActive", "NotAMember", "AlreadyDefaulted", "InvalidParams",
                                        "TopUpFillChanged", "InsufficientBalance", "InsufficientAllowance"]},
        },
    },
    "solana-pyth-v2": {
        "model": "SolanaPythModel",
        "released": False,  # no vectors until P2 adds the price rules
        "actions": {
            **_COMMON,
            "topUpReserve": {"args": [["amount", U]],
                             "errors": ["CircleNotActive", "NotAMember", "AlreadyDefaulted", "InvalidParams",
                                        "InsufficientBalance"]},
        },
    },
}

# camelCase action name -> reference-model method name
METHOD = {
    "joinAndLock": "join_and_lock", "leaveForming": "leave_forming", "cancelCircle": "cancel_circle",
    "activate": "activate", "contribute": "contribute", "releasePot": "release_pot",
    "updateCoverage": "update_coverage", "markDelinquent": "mark_delinquent",
    "declareDefault": "declare_default", "addStock": "add_stock", "withdraw": "withdraw", "quote": "quote",
    "topUpReserve": "top_up_reserve", "usdgApprove": "usdg_approve", "usdgSendToCircle": "usdg_send_to_circle",
}


def schema(profile: str, action: str):
    """Argument schema for `action` in `profile`, or None if the profile does not list it."""
    spec = PROFILES[profile]["actions"].get(action) or HARNESS.get(action)
    return None if spec is None else spec["args"]
