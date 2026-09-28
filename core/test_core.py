"""Tests for the reference model, profile split and generator (ARB-DESIGN r9 sections A and 7).

    python3 -m unittest core/test_core.py -v
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import actions as A  # noqa: E402
import gen as G  # noqa: E402
import reference as R  # noqa: E402

U = G.UNIT
MEM = [1, 2, 3, 4, 5]
BAL = {m: 10**13 for m in MEM}


def _load(path):
    with open(path) as f:
        return json.load(f)


def _read(path, mode="r"):
    with open(path, mode) as f:
        return f.read()


def active(cls, **over):
    m = cls(G.default_params(**over), MEM, 1, dict(BAL), dict(BAL))
    for x in MEM:
        m.join_and_lock(x, G.START, 150 * U)
    m.activate(1, G.START)
    return m


def with_deficit(cls, d):
    """A state with an escrow deficit (unreachable in USDG-only circles; set directly to test the rule)."""
    m = active(cls)
    m.escrow_deficit = d
    m.next_gate_short_by = max(m.next_gate_short_by, d)
    return m


class ProfileSplit(unittest.TestCase):
    def test_common_model_has_no_top_up(self):
        self.assertFalse(hasattr(R.CommonModel, "top_up_reserve"))
        self.assertNotIn("topUpReserve", A.PROFILES["common-v1"]["actions"])

    def test_evm_top_up_takes_exactly_amount_and_expected_fill(self):
        params = list(inspect.signature(R.EvmUsdgModel.top_up_reserve).parameters)
        self.assertEqual(params, ["self", "caller", "now", "amount", "expected_fill"])
        self.assertEqual(A.schema("evm-usdg-v1", "topUpReserve"), [["amount", "uint256"], ["expectedFill", "uint256"]])

    def test_solana_top_up_takes_exactly_amount(self):
        params = list(inspect.signature(R.SolanaPythModel.top_up_reserve).parameters)
        self.assertEqual(params, ["self", "caller", "now", "amount"])
        self.assertEqual(A.schema("solana-pyth-v2", "topUpReserve"), [["amount", "uint256"]])
        m = active(R.SolanaPythModel)
        with self.assertRaises(TypeError):
            m.top_up_reserve(2, G.START, U, expected_fill=0)

    def test_solana_never_raises_fill_changed(self):
        for d in (0, 10 * U, 100 * U, 10**9 * U):
            m = with_deficit(R.SolanaPythModel, d)
            ev = m.top_up_reserve(2, G.START, 100 * U)
            self.assertEqual(ev["ReserveToppedUp"][2], min(d, 100 * U))

    def test_solana_top_up_matches_spec_113(self):
        # hand cases: deficit 0; deficit < amount; deficit > amount
        for d, amt in ((0, 40 * U), (30 * U, 100 * U), (500 * U, 100 * U)):
            m = with_deficit(R.SolanaPythModel, d)
            v, e0, r0, dep0 = m.next_gate_short_by, m.escrow, m.reserve_total, m.deposits_total
            fill = min(d, amt)
            m.top_up_reserve(3, G.START, amt)
            self.assertEqual(m.escrow, e0 + fill)
            self.assertEqual(m.escrow_deficit, d - fill)
            self.assertEqual(m.reserve_total, r0 + amt - fill)
            self.assertEqual(m.deposits_total, dep0 + amt)
            self.assertEqual(m.seats[2].top_ups, amt)
            self.assertEqual(m.next_gate_short_by, max(0, (v - d) - (amt - fill)) + (d - fill))

    def test_solana_top_up_error_order(self):
        m = R.SolanaPythModel(G.default_params(), MEM, 1, dict(BAL), dict(BAL))
        with self.assertRaises(R.Refusal) as e:
            m.top_up_reserve(2, G.START, 0)
        self.assertEqual(e.exception.name, "CircleNotActive")
        m = active(R.SolanaPythModel)
        with self.assertRaises(R.Refusal) as e:
            m.top_up_reserve(2, G.START, 0)
        self.assertEqual(e.exception.name, "InvalidParams")
        with self.assertRaises(R.Refusal) as e:
            m.top_up_reserve(2, G.START, 10**14)
        self.assertEqual(e.exception.name, "InsufficientBalance")
        m.defaulted_bitmap |= 1 << 1
        with self.assertRaises(R.Refusal) as e:
            m.top_up_reserve(2, G.START, 0)
        self.assertEqual(e.exception.name, "AlreadyDefaulted")

    def test_paired_scenario_differs_only_where_declared(self):
        # Same state: EVM with the matching fill and Solana leave identical circle and seat state.
        e = with_deficit(R.EvmUsdgModel, 30 * U)
        s = with_deficit(R.SolanaPythModel, 30 * U)
        e.top_up_reserve(3, G.START, 100 * U, 30 * U)
        s.top_up_reserve(3, G.START, 100 * U)
        self.assertEqual(e.snapshot()["circle"], s.snapshot()["circle"])
        self.assertEqual(e.snapshot()["seats"], s.snapshot()["seats"])
        # The deficit changes after the page read it: EVM refuses, Solana applies the new fill (AL11).
        e = with_deficit(R.EvmUsdgModel, 0)
        s = with_deficit(R.SolanaPythModel, 0)
        shown = 0
        for m in (e, s):
            m.escrow_deficit = 40 * U
            m.next_gate_short_by = max(m.next_gate_short_by, 40 * U)
        with self.assertRaises(R.Refusal) as err:
            e.top_up_reserve(3, G.START, 100 * U, shown)
        self.assertEqual((err.exception.name, err.exception.args_), ("TopUpFillChanged", (0, 40 * U)))
        ev = s.top_up_reserve(3, G.START, 100 * U)
        self.assertEqual(ev["ReserveToppedUp"][2], 40 * U)


class GeneratorBinding(unittest.TestCase):
    def test_each_generator_takes_only_its_model(self):
        p = G.default_params()
        for profile, cls in (("common-v1", R.EvmUsdgModel), ("common-v1", R.SolanaPythModel),
                             ("evm-usdg-v1", R.CommonModel), ("evm-usdg-v1", R.SolanaPythModel),
                             ("solana-pyth-v2", R.EvmUsdgModel), ("solana-pyth-v2", R.CommonModel)):
            with self.assertRaises(G.ProfileMismatch, msg=f"{profile} with {cls.__name__}"):
                G.Scenario(profile, cls, "x", p, MEM, 1)

    def test_common_generator_refuses_a_top_up_even_with_a_patched_model(self):
        class Patched(R.CommonModel):
            def top_up_reserve(self, caller, now, amount):
                return {}
        Patched.__name__ = "CommonModel"
        s = G.Scenario("common-v1", Patched, "x", G.default_params(), MEM, 1)
        with self.assertRaises(G.ProfileMismatch):
            s.call(2, "topUpReserve", 1)

    def test_listed_action_with_wrong_arity_refused(self):
        s = G.Scenario("evm-usdg-v1", R.EvmUsdgModel, "x", G.default_params(), MEM, 1)
        with self.assertRaises(G.ProfileMismatch):
            s.call(2, "topUpReserve", 1)
        with self.assertRaises(G.ProfileMismatch):
            s.call(2, "joinAndLock", 1, 2)

    def test_common_default_settlement_never_emitted(self):
        s = G.Scenario("common-v1", R.CommonModel, "x", G.default_params(), MEM, 1)
        G.full_join(s)
        G.pay_round(s)
        s.call(G.OUTSIDER, "releasePot", expect="ok")
        G.pay_round(s, skip=(1,))
        s.at(s.m.deadline + 61)
        s.call(G.OUTSIDER, "markDelinquent", 1, 0, expect="ok")
        with self.assertRaises(G.ProfileMismatch):
            s.call(G.OUTSIDER, "declareDefault", 0)

    def test_solana_profile_not_released(self):
        with self.assertRaises(G.ProfileMismatch):
            G.build("solana-pyth-v2", R.SolanaPythModel, write=False)


class Vectors(unittest.TestCase):
    def test_generation_is_deterministic_and_matches_committed_files(self):
        for profile in ("common-v1", "evm-usdg-v1"):
            _, files = G.build(profile, getattr(R, A.PROFILES[profile]["model"]), write=False)
            _, again = G.build(profile, getattr(R, A.PROFILES[profile]["model"]), write=False)
            self.assertEqual(files, again)
            d = os.path.join(G.OUT, profile)
            for name, data in files.items():
                self.assertEqual(_read(os.path.join(d, name), "rb"), data,
                                 f"{profile}/{name} is stale: run python3 core/gen.py")
            manifest = _read(os.path.join(d, "MANIFEST.sha256")).split("\n")
            for line in filter(None, manifest):
                h, name = line.split("  ")
                self.assertEqual(hashlib.sha256(_read(os.path.join(d, name), "rb")).hexdigest(), h)

    def test_every_vector_carries_its_ruleset_and_only_listed_actions(self):
        for profile in ("common-v1", "evm-usdg-v1"):
            d = os.path.join(G.OUT, profile)
            idx = _load(os.path.join(d, "index.json"))
            for name in idx["names"]:
                v = _load(os.path.join(d, name))
                self.assertEqual(v["ruleset"], profile)
                for st in v["steps"]:
                    spec = A.schema(profile, st["action"])
                    self.assertIsNotNone(spec, f"{name}: {st['action']}")
                    self.assertEqual(len(st["args"]), len(spec))
                    if profile == "common-v1":
                        self.assertNotEqual(st["action"], "topUpReserve")

    def test_refusals_leave_state_unchanged(self):
        for profile in ("common-v1", "evm-usdg-v1"):
            d = os.path.join(G.OUT, profile)
            idx = _load(os.path.join(d, "index.json"))
            for name in idx["names"]:
                v = _load(os.path.join(d, name))
                prev = v.get("initialState")
                for st in v["steps"]:
                    if "error" in st["outcome"]:
                        self.assertEqual(st["state"], prev, f"{name}: refusal changed state")
                    prev = st["state"]


class Rules(unittest.TestCase):
    def test_escrow_deficit_unreachable_first_default_bound(self):
        """Every shortfall is at most the defaulter's need, which the last gate reserved (ARB-FINDINGS F-1)."""
        m = active(R.EvmUsdgModel)
        for x in MEM:
            m.contribute(x, G.START)
        m.release_pot(9, G.START)
        for x in MEM[1:]:
            m.contribute(x, G.START)
        t = m.deadline + 61
        m.mark_delinquent(9, t, 1, 0)
        m.declare_default(9, t, 0)
        self.assertEqual(m.escrow_deficit, 0)
        self.assertLessEqual(m.reserve_losses, m.reserve_total)

    def test_peak_need_demo(self):
        self.assertEqual(R.CommonModel.peak_need(G.default_params()), 150 * U)


if __name__ == "__main__":
    unittest.main()
