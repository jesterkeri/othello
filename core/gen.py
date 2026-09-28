"""Trace-vector generator (ARB-DESIGN r9 section A).

    python3 core/gen.py            # writes core/vectors/v1/<profile>/*.json, index.json, ACTIONS.json, MANIFEST.sha256

Each generator is bound to exactly one model class and refuses any other. Every step records the call, the
outcome (success, or the exact error name, signature and arguments) and the full state and balances after it.
Hand-written spec cases come first, then seeded random sequences. Deterministic: same code, same bytes.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import actions as A  # noqa: E402
import reference as R  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors", "v1")
START = 1_800_000_000
UNIT = 1_000_000  # 1 USDG


class ProfileMismatch(Exception):
    pass


def default_params(**over):
    base = dict(n=5, c=50 * UNIT, g=35 * UNIT, min_stock_cover=120 * UNIT, haircut_bps=2000,
                coverage_bps=13000, warn_bps=11000, round_secs=120, grace_secs=60)
    base.update(over)
    return R.Params(**base)


def flat_state(m: R.CommonModel) -> dict:
    snap = m.snapshot()
    return {
        "circle": [snap["circle"][f] for f in R.CIRCLE_FIELDS],
        "seats": [snap["seats"][t][f] for t in range(R.MAX_SEATS) for f in R.SEAT_FIELDS],
        "balances": [snap["balances"]["circle"]] + snap["balances"]["members"],
        "allowances": snap["allowances"],
    }


class Scenario:
    """Runs calls against one profile's model and records every step."""

    def __init__(self, profile: str, model_cls, name: str, p: R.Params, members, creator, balances=None,
                 allowances=None, note=""):
        expected = A.PROFILES[profile]["model"]
        if model_cls.__name__ != expected:
            raise ProfileMismatch(f"{profile} generator takes {expected}, not {model_cls.__name__}")
        self.profile, self.name, self.note = profile, name, note
        self.p, self.members, self.creator = p, list(members), creator
        self.balances = balances or {m: 10_000_000 * UNIT for m in members}
        self.allowances = allowances or {m: 10_000_000 * UNIT for m in members}
        self.t = START
        self.steps = []
        self.create_error = None
        try:
            self.m = model_cls(p, self.members, creator, self.balances, self.allowances)
        except R.Refusal as e:
            self.m = None
            self.create_error = self._err(e)

    @staticmethod
    def _err(e: R.Refusal):
        return {"error": e.name, "sig": R.error_signature(e.name), "args": list(e.args_)}

    def at(self, t: int):
        assert t >= self.t
        self.t = t
        return self

    def wait(self, secs: int):
        self.t += secs
        return self

    def call(self, caller: int, action: str, *args, expect=None):
        """Apply one call. `expect` is None (either), "ok", or an error name the call must produce."""
        spec = A.schema(self.profile, action)
        if spec is None:
            raise ProfileMismatch(f"{action} is not in {self.profile}")
        if len(args) != len(spec):
            raise ProfileMismatch(f"{action} takes {[a[0] for a in spec]}, got {len(args)} args")
        succ = A.PROFILES[self.profile]["actions"].get(action, {}).get("successAllowed", True)
        trial = self.m.clone()
        method = getattr(trial, A.METHOD[action])
        returns = None
        try:
            ev = method(caller, self.t, *args)
            if not succ:
                raise ProfileMismatch(f"{action} may not succeed in {self.profile}")
            outcome = {"ok": True}
            if action == "quote":
                returns = ev["Quote"]
            self.m = trial
        except R.Refusal as e:
            outcome = self._err(e)
        except NotImplementedError:
            raise ProfileMismatch(f"{action} settlement is not in {self.profile}")
        got = "ok" if outcome.get("ok") else outcome["error"]
        if expect is not None and got != expect:
            raise AssertionError(f"{self.name}: {action}{args} by {caller} at {self.t}: expected {expect}, got {outcome}")
        # INV-C1/C2 in the model itself: accounted never exceeds the ledger balance.
        assert self.m.circle_balance >= self.m.accounted(), (self.name, action)
        step = {"t": self.t, "caller": caller, "action": action, "args": list(args), "outcome": outcome,
                "state": flat_state(self.m)}
        if returns is not None:
            step["returns"] = returns
        self.steps.append(step)
        return outcome

    def vector(self) -> dict:
        v = {
            "ruleset": self.profile,
            "name": self.name,
            "note": self.note,
            "params": self.p.as_dict(),
            "members": self.members,
            "creator": self.creator,
            "start": START,
            "balances": [self.balances[m] for m in self.members],
            "allowances": [self.allowances[m] for m in self.members],
        }
        if self.create_error:
            v["create"] = self.create_error
            v["steps"] = []
        else:
            v["create"] = {"ok": True}
            v["initialState"] = flat_state(self.m.__class__(self.p, self.members, self.creator,
                                                            self.balances, self.allowances))
            v["steps"] = self.steps
        return v


# ---------------------------------------------------------------------- shared helpers
MEM5 = [1, 2, 3, 4, 5]
OUTSIDER = 99


def full_join(s: Scenario, amount=150 * UNIT):
    for m in s.members:
        s.call(m, "joinAndLock", amount, expect="ok")
    s.call(s.creator, "activate", expect="ok")


def pay_round(s: Scenario, skip=()):
    for m in s.members:
        if m not in skip:
            s.call(m, "contribute", expect="ok")


# ---------------------------------------------------------------------- common-v1 hand cases
def common_cases(profile, cls):
    out = []

    def sc(name, note="", p=None, members=MEM5, creator=1, **kw):
        s = Scenario(profile, cls, name, p or default_params(), members, creator, note=note, **kw)
        out.append(s)
        return s

    # createCircle: members.length == n first; bounds; creator; peak.
    for n_, ms in ((3, [1, 2]), (3, [1, 2, 3, 4]), (8, list(range(1, 8))), (8, list(range(1, 10)))):
        sc(f"create-members-length-n{n_}-{len(ms)}", "members.length must equal n",
           p=default_params(n=n_, g=200 * UNIT), members=ms)
    sc("create-n-too-small", p=default_params(n=2), members=[1, 2])
    sc("create-n-too-large", p=default_params(n=9), members=list(range(1, 10)))
    sc("create-duplicate-member", members=[1, 2, 3, 4, 4])
    sc("create-zero-member", members=[1, 2, 3, 4, 0])
    sc("create-creator-not-member", creator=OUTSIDER)
    sc("create-c-zero", p=default_params(c=0))
    sc("create-c-max", p=default_params(c=10**12, g=10**12, min_stock_cover=10**13))
    sc("create-c-max-plus-one", p=default_params(c=10**12 + 1))
    sc("create-g-max-plus-one", p=default_params(g=10**12 + 1))
    sc("create-min-cover-max-plus-one", p=default_params(min_stock_cover=10**13 + 1))
    sc("create-haircut-10000", p=default_params(haircut_bps=10000))
    sc("create-warn-equals-coverage", p=default_params(warn_bps=13000))
    sc("create-warn-below-10000", p=default_params(warn_bps=9999))
    sc("create-coverage-above-30000", p=default_params(coverage_bps=30001))
    sc("create-coverage-30000", p=default_params(coverage_bps=30000, g=100 * UNIT))
    sc("create-round-59", p=default_params(round_secs=59))
    sc("create-round-max-plus-one", p=default_params(round_secs=31_536_001))
    sc("create-grace-29", p=default_params(grace_secs=29))
    sc("create-grace-max-plus-one", p=default_params(grace_secs=2_592_001))
    sc("create-peak-need-fails", "demo params need 150; 5 x 29 = 145", p=default_params(g=29 * UNIT))
    sc("create-peak-need-exact", "5 x 30 = 150 = peak", p=default_params(g=30 * UNIT))
    sc("create-peak-need-minus-one", "n x g = peak - 1 = 15 refuses (peak 16)",
       p=default_params(n=3, c=7, g=5, min_stock_cover=0, coverage_bps=10001, warn_bps=10000), members=[1, 2, 3])

    # Healthy circle: every round paid, five payouts, everyone withdraws.
    s = sc("healthy-circle-completes", "demo circle; no Paused after a healthy payout (I18)")
    full_join(s)
    for r in range(5):
        pay_round(s)
        s.call(OUTSIDER, "updateCoverage", expect="ok")
        s.call(OUTSIDER, "releasePot", expect="ok")
        s.wait(30)
    for m in MEM5:
        s.call(m, "withdraw", expect="ok")
    s.call(1, "withdraw", expect="AlreadyWithdrawn")

    # joinAndLock refusals, each in order.
    s = sc("join-refusals")
    s.call(OUTSIDER, "joinAndLock", 150 * UNIT, expect="NotAMember")
    s.call(1, "joinAndLock", 0, expect="InvalidParams")
    s.call(1, "joinAndLock", 10**13 + 1, expect="InvalidParams")
    s.call(1, "joinAndLock", 149_999_999, expect="CollateralBelowMinimum")  # H = 119.999999 < 120
    s.call(1, "joinAndLock", 150 * UNIT, expect="ok")                       # H = 120 exactly
    s.call(1, "joinAndLock", 150 * UNIT, expect="AlreadyJoined")
    s.call(2, "usdgApprove", 184 * UNIT)
    s.call(2, "joinAndLock", 150 * UNIT, expect="InsufficientAllowance")    # needs 185
    s.call(2, "usdgApprove", 185 * UNIT)
    s.call(2, "joinAndLock", 150 * UNIT, expect="ok")
    s.call(3, "joinAndLock", 10**13, expect="InsufficientBalance")
    s = sc("join-balance-before-allowance", "two failing checks: the earlier one's error",
           balances={1: 10 * UNIT, 2: 10**9, 3: 10**9, 4: 10**9, 5: 10**9},
           allowances={1: 0, 2: 10**9, 3: 10**9, 4: 10**9, 5: 10**9})
    s.call(1, "joinAndLock", 150 * UNIT, expect="InsufficientBalance")
    s = sc("join-status-before-member")
    s.call(1, "cancelCircle", expect="ok")
    s.call(OUTSIDER, "joinAndLock", 150 * UNIT, expect="CircleNotForming")

    # leave, rejoin, cancel, withdraw pays once.
    s = sc("leave-rejoin-cancel-withdraw-once", "double-claim prevention (4.4)")
    s.call(1, "joinAndLock", 150 * UNIT, expect="ok")
    s.call(2, "joinAndLock", 200 * UNIT, expect="ok")
    s.call(2, "addStock", 25 * UNIT, expect="ok")
    s.call(3, "leaveForming", expect="NotJoined")
    s.call(OUTSIDER, "leaveForming", expect="NotAMember")
    s.call(2, "leaveForming", expect="ok")
    s.call(2, "leaveForming", expect="NotJoined")
    s.call(2, "joinAndLock", 160 * UNIT, expect="ok")
    s.call(2, "cancelCircle", expect="Unauthorized")
    s.call(1, "activate", expect="NotAllJoined")
    s.call(1, "withdraw", expect="NotFinished")
    s.call(1, "cancelCircle", expect="ok")
    s.call(1, "cancelCircle", expect="CircleNotForming")
    s.call(1, "activate", expect="CircleNotForming")
    s.call(1, "leaveForming", expect="CircleNotForming")
    s.call(3, "withdraw", expect="NotJoined")
    s.call(OUTSIDER, "withdraw", expect="NotAMember")
    s.call(2, "withdraw", expect="ok")
    s.call(2, "withdraw", expect="AlreadyWithdrawn")
    s.call(1, "withdraw", expect="ok")

    # activate order; addStock in Forming needs a joined seat.
    s = sc("activate-and-addstock-forming")
    s.call(2, "addStock", 5 * UNIT, expect="CircleNotActive")
    s.call(OUTSIDER, "addStock", 5 * UNIT, expect="CircleNotActive")
    for m in MEM5:
        s.call(m, "joinAndLock", 150 * UNIT, expect="ok")
    s.call(2, "activate", expect="Unauthorized")
    s.call(2, "addStock", 0, expect="InvalidParams")
    s.call(2, "addStock", 10**13 - 150 * UNIT + 1, expect="InvalidParams")
    s.call(2, "addStock", 10 * UNIT, expect="ok")
    s.call(1, "activate", expect="ok")
    s.call(OUTSIDER, "addStock", 1, expect="NotAMember")
    s.call(1, "joinAndLock", 150 * UNIT, expect="CircleNotForming")

    # contribute, release refusals and the grace boundary.
    s = sc("contribute-release-grace", "grace is strict: now == deadline + grace refuses")
    full_join(s)
    s.call(OUTSIDER, "contribute", expect="NotAMember")
    s.call(1, "contribute", expect="ok")
    s.call(1, "contribute", expect="AlreadyContributed")
    s.call(OUTSIDER, "releasePot", expect="RoundNotFunded")
    deadline = s.m.deadline
    s.at(deadline + 60)
    s.call(OUTSIDER, "markDelinquent", 0, 2, expect="GraceNotElapsed")
    s.call(OUTSIDER, "declareDefault", 1, expect="GraceNotElapsed")
    s.at(deadline + 61)
    s.call(OUTSIDER, "markDelinquent", 0, 0, expect="SeatAlreadyPaid")
    s.call(OUTSIDER, "markDelinquent", 1, 2, expect="InvalidParams")
    s.call(OUTSIDER, "markDelinquent", 0, 5, expect="InvalidParams")
    s.call(OUTSIDER, "markDelinquent", 0, 2, expect="ok")
    s.call(OUTSIDER, "markDelinquent", 0, 2, expect="AlreadyMarked")
    s.call(OUTSIDER, "declareDefault", 5, expect="InvalidParams")
    s.call(OUTSIDER, "declareDefault", 0, expect="SeatAlreadyPaid")
    s.call(OUTSIDER, "declareDefault", 2, expect="PrePayoutDefaultUnsupported")
    s.call(OUTSIDER, "declareDefault", 3, expect="PrePayoutDefaultUnsupported")
    # late payment is a cure; the mark and its count stay
    for m in (2, 3, 4, 5):
        s.call(m, "contribute", expect="ok")
    s.call(OUTSIDER, "releasePot", expect="ok")
    s.call(OUTSIDER, "quote", 10**13, expect="ok")
    s.call(OUTSIDER, "quote", 10**13 + 1, expect="InvalidParams")
    s.call(OUTSIDER, "withdraw", expect="NotFinished")

    # Post-payout late member: marks and the not-marked refusal (shared); settlement is profile-specific.
    s = sc("post-payout-marks", "declareDefault refusals shared by both chains")
    full_join(s)
    pay_round(s)
    s.call(OUTSIDER, "releasePot", expect="ok")          # member 1 (turn 0) received
    pay_round(s, skip=(1,))
    s.at(s.m.deadline + 61)
    s.call(OUTSIDER, "declareDefault", 0, expect="NotMarked")
    s.call(OUTSIDER, "markDelinquent", 1, 0, expect="ok")
    s.call(1, "contribute", expect="ok")                  # late cure after the mark
    s.call(OUTSIDER, "declareDefault", 0, expect="SeatAlreadyPaid")
    s.call(OUTSIDER, "releasePot", expect="ok")          # next round clears the bit, keeps the count
    s.call(OUTSIDER, "cancelCircle", expect="CircleNotForming")

    # Surplus: direct USDG sent to the circle is never counted.
    s = sc("surplus-is-locked", "AL9: unsolicited USDG changes no accounted value and no payout")
    full_join(s)
    s.call(3, "usdgSendToCircle", 7 * UNIT)
    for r in range(5):
        pay_round(s)
        s.call(OUTSIDER, "releasePot", expect="ok")
    for m in MEM5:
        s.call(m, "withdraw", expect="ok")

    # n = 3 and n = 8 circles, full life.
    for n_ in (3, 8):
        ms = list(range(1, n_ + 1))
        p = default_params(n=n_, g=400 * UNIT)
        s = sc(f"full-life-n{n_}", p=p, members=ms)
        full_join(s)
        for r in range(n_):
            pay_round(s)
            s.call(OUTSIDER, "releasePot", expect="ok")
        for m in ms:
            s.call(m, "withdraw", expect="ok")

    return out


# ---------------------------------------------------------------------- evm-usdg-v1 hand cases
def evm_cases(profile, cls):
    out = common_cases(profile, cls)

    def sc(name, note="", p=None, members=MEM5, creator=1, **kw):
        s = Scenario(profile, cls, name, p or default_params(), members, creator, note=note, **kw)
        out.append(s)
        return s

    def default_turn(s, turn):
        s.at(max(s.t, s.m.deadline + s.p.grace_secs + 1))
        s.call(OUTSIDER, "markDelinquent", s.m.round, turn, expect="ok")
        s.call(OUTSIDER, "declareDefault", turn, expect="ok")

    # Partial seizure: collateral 150 < O = 200; seized exactly min(collateral, O); circle completes.
    s = sc("default-partial-seizure", "3.4 exact: seized = min(collateral, O); forfeited = min(shortfall, g)")
    full_join(s)
    pay_round(s)
    s.call(OUTSIDER, "releasePot", expect="ok")
    pay_round(s, skip=(1,))
    default_turn(s, 0)
    s.call(OUTSIDER, "declareDefault", 0, expect="AlreadyDefaulted")
    s.call(1, "contribute", expect="AlreadyDefaulted")
    s.call(1, "addStock", UNIT, expect="AlreadyDefaulted")
    s.call(1, "topUpReserve", UNIT, 0, expect="AlreadyDefaulted")
    s.call(OUTSIDER, "releasePot", expect="ok")
    for r in range(3):
        pay_round(s, skip=(1,))
        s.call(OUTSIDER, "releasePot", expect="ok")
    for m in MEM5:
        s.call(m, "withdraw", expect="ok")

    # Full seizure with added collateral: defaulter keeps collateral - O (EVM-I11b).
    s = sc("default-full-seizure-addstock", "EVM-I11b: collateralPart = joined + added - seized")
    full_join(s, amount=400 * UNIT)
    s.call(3, "addStock", 33 * UNIT, expect="ok")
    pay_round(s)
    s.call(OUTSIDER, "releasePot", expect="ok")
    pay_round(s)
    s.call(OUTSIDER, "releasePot", expect="ok")
    pay_round(s, skip=(2,))
    default_turn(s, 1)
    s.call(OUTSIDER, "releasePot", expect="ok")
    for r in range(2):
        pay_round(s, skip=(2,))
        s.call(OUTSIDER, "releasePot", expect="ok")
    for m in MEM5:
        s.call(m, "withdraw", expect="ok")

    # Queue: two marked post-payout seats; the higher one first refuses; lower then higher settles.
    for order in ("lower-caller-first", "higher-caller-tries-first"):
        s = sc(f"queue-{order}", "P1 I23: final balances do not depend on who calls first")
        full_join(s)
        for r in range(2):
            pay_round(s)
            s.call(OUTSIDER, "releasePot", expect="ok")
        pay_round(s, skip=(1, 2))
        s.at(s.m.deadline + s.p.grace_secs + 1)
        s.call(OUTSIDER, "markDelinquent", 2, 1, expect="ok")
        s.call(OUTSIDER, "markDelinquent", 2, 0, expect="ok")
        if order == "higher-caller-tries-first":
            s.call(4, "declareDefault", 1, expect="DefaultOutOfOrder")
            s.call(5, "declareDefault", 0, expect="ok")
            s.call(4, "declareDefault", 1, expect="ok")
        else:
            s.call(OUTSIDER, "declareDefault", 0, expect="ok")
            s.call(OUTSIDER, "declareDefault", 1, expect="ok")
        s.call(OUTSIDER, "releasePot", expect="ok")
        for r in range(2):
            pay_round(s, skip=(1, 2))
            s.call(OUTSIDER, "releasePot", expect="ok")
        for m in MEM5:
            s.call(m, "withdraw", expect="ok")

    # Top-up refusals in order, the consent check, and a successful reserve top-up with fill 0.
    s = sc("topup-refusals-and-consent", "EVM-I24: expectedFill must equal min(escrowDeficit, amount)",
           balances={1: 10**12, 2: 3 * 10**13, 3: 10**12, 4: 10**12, 5: 10**12},
           allowances={1: 10**12, 2: 3 * 10**13, 3: 10**12, 4: 10**12, 5: 10**12})
    s.call(2, "topUpReserve", UNIT, 0, expect="CircleNotActive")
    full_join(s)
    s.call(OUTSIDER, "topUpReserve", UNIT, 0, expect="NotAMember")
    s.call(2, "topUpReserve", 0, 0, expect="InvalidParams")
    s.call(2, "topUpReserve", 10**13 + 1, 0, expect="InvalidParams")
    s.call(2, "topUpReserve", 5 * UNIT, 1, expect="TopUpFillChanged")
    s.call(2, "topUpReserve", 5 * UNIT, 5 * UNIT, expect="TopUpFillChanged")
    s.call(1, "topUpReserve", 10**12, 0, expect="InsufficientBalance")
    s.call(4, "usdgApprove", 3 * UNIT)
    s.call(4, "topUpReserve", 5 * UNIT, 0, expect="InsufficientAllowance")
    s.call(4, "usdgApprove", 10**12)
    s.call(2, "topUpReserve", 5 * UNIT, 0, expect="ok")
    s.call(2, "topUpReserve", 10**13 - 5 * UNIT, 0, expect="ok")
    s.call(2, "topUpReserve", 1, 0, expect="InvalidParams")
    for r in range(5):
        pay_round(s)
        s.call(OUTSIDER, "releasePot", expect="ok")
    s.call(2, "topUpReserve", UNIT, 0, expect="CircleNotActive")
    for m in MEM5:
        s.call(m, "withdraw", expect="ok")

    return out


# ---------------------------------------------------------------------- seeded random sequences
def random_sequences(profile, cls, count, seed):
    """Round-based random circles: some members skip rounds, get marked and defaulted (in or out of queue
    order), paused gates are cured by top-ups, plus random noise calls from members and an outsider."""
    rng = random.Random(seed)
    out = []
    evm = profile == "evm-usdg-v1"
    i = 0
    while len(out) < count:
        i += 1
        n_ = rng.randint(3, 8)
        c = rng.choice([1, 7, 100, 50 * UNIT, 123_456_789, 10**9])
        haircut = rng.choice([0, 1, 2000, 5000, 9999])
        cov = rng.choice([10001, 13000, 20000, 30000])
        min_cover = rng.choice([0, 1, c, 3 * c])
        p = default_params(n=n_, c=c, g=1, min_stock_cover=min_cover, haircut_bps=haircut, coverage_bps=cov,
                           warn_bps=rng.choice([10000, cov - 1]), round_secs=rng.choice([60, 3600]),
                           grace_secs=rng.choice([30, 600]))
        p.g = max(1, R.ceil_div(R.CommonModel.peak_need(p), n_) + rng.choice([0, 0, 1, c]))
        least = 1
        while R.CommonModel.h_of(type("X", (), {"p": p})(), least) < min_cover:
            least = max(least + 1, (min_cover * 10000) // (10000 - haircut))
        if p.g > 10**12 or least + 10 * c > 10**13:
            continue
        members = list(range(1, n_ + 1))
        s = Scenario(profile, cls, f"random-{len(out):03d}", p, members, rng.choice(members),
                     note=f"seed {seed:#x}, draw {i}")
        if s.m is None:
            continue
        out.append(s)

        def noise():
            if rng.random() < 0.25:
                who = rng.choice(members + [OUTSIDER])
                act = rng.choice(["contribute", "releasePot", "updateCoverage", "withdraw", "leaveForming",
                                  "activate", "cancelCircle", "quote", "addStock", "joinAndLock"])
                args = {"quote": (rng.choice([0, c, 10**13, 10**13 + 1]),), "addStock": (rng.choice([1, c]),),
                        "joinAndLock": (least,)}.get(act, ())
                s.call(who, act, *args)

        # Forming: members join (some leave and rejoin), maybe add collateral; creator activates.
        for t in range(n_):
            s.call(members[t], "joinAndLock", least + rng.choice([0, 0, 1, c, 10 * c]))
            noise()
            if rng.random() < 0.1:
                s.call(members[t], "leaveForming")
                s.call(members[t], "joinAndLock", least + rng.choice([0, c]))
        if rng.random() < 0.08:
            s.call(s.creator, "cancelCircle")
        else:
            s.call(s.creator, "activate")
        # Active: round by round.
        guard = 0
        while s.m.status == R.ACTIVE and guard < 3 * n_:
            guard += 1
            m = s.m
            skip = {t for t in range(n_) if rng.random() < 0.2}
            for t in rng.sample(range(n_), n_):
                if t not in skip:
                    s.call(members[t], "contribute")
                    noise()
            if rng.random() < 0.3:
                s.call(rng.choice(members), "addStock", rng.choice([1, c]))
            if skip:
                s.at(max(s.t, s.m.deadline + p.grace_secs + rng.choice([0, 1, 1, 50])))
                for t in sorted(skip, reverse=rng.random() < 0.5):
                    s.call(OUTSIDER, "markDelinquent", s.m.round, t)
                order = sorted(skip, reverse=rng.random() < 0.3)
                for t in order:
                    if evm:
                        s.call(rng.choice(members + [OUTSIDER]), "declareDefault", t)
                    else:
                        # common-v1: only refusals are shared; a default that would settle ends the sequence
                        trial = s.m.clone()
                        try:
                            trial._default_checks(s.t, t)
                        except R.Refusal:
                            s.call(OUTSIDER, "declareDefault", t)
                for t in skip:
                    if rng.random() < 0.5:
                        s.call(members[t], "contribute")
                if not evm and any(not s.m._bit(s.m.paid_bitmap, t) for t in range(n_)):
                    break
            res = s.call(rng.choice(members + [OUTSIDER]), "releasePot")
            if not res.get("ok") and res.get("error") == "ReserveOvercommitted" and evm:
                s.call(OUTSIDER, "updateCoverage")
                sb = s.m.next_gate_short_by
                payers = [members[t] for t in range(n_) if not s.m._bit(s.m.defaulted_bitmap, t)]
                amt = sb + rng.choice([0, 0, 1, c])
                if amt >= 1:
                    s.call(rng.choice(payers), "topUpReserve", amt, min(s.m.escrow_deficit, amt))
                s.call(OUTSIDER, "releasePot")
            s.wait(rng.choice([1, 10]))
        for t in rng.sample(range(n_), n_):
            s.call(members[t], "withdraw")
        s.call(members[0], "withdraw")
    return out


# ---------------------------------------------------------------------- output
def canonical(obj) -> bytes:
    return (json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n").encode()


def build(profile: str, cls, write=True):
    if A.PROFILES[profile].get("released", True) is False:
        raise ProfileMismatch(f"{profile} is not released (P2 adds its price rules)")
    cases = common_cases(profile, cls) if profile == "common-v1" else evm_cases(profile, cls)
    cases += random_sequences(profile, cls, count=40, seed=0x0DE11 if profile == "common-v1" else 0xE7E7)
    d = os.path.join(OUT, profile)
    files = {}
    for i, s in enumerate(cases):
        files[f"{i:03d}-{s.name}.json"] = canonical(s.vector())
    actions_json = canonical({"profile": profile, "model": A.PROFILES[profile]["model"],
                              "actions": A.PROFILES[profile]["actions"], "harness": A.HARNESS,
                              "errors": {k: R.error_signature(k) for k in R.ERRORS},
                              "circleFields": R.CIRCLE_FIELDS, "seatFields": R.SEAT_FIELDS})
    index = {"profile": profile, "names": list(files.keys()),
             "sha256": ["0x" + hashlib.sha256(v).hexdigest() for v in files.values()]}
    all_files = dict(files)
    all_files["ACTIONS.json"] = actions_json
    all_files["index.json"] = canonical(index)
    if write:
        os.makedirs(d, exist_ok=True)
        for old in os.listdir(d):
            os.remove(os.path.join(d, old))
        for k, v in all_files.items():
            with open(os.path.join(d, k), "wb") as f:
                f.write(v)
        manifest = "".join(f"{hashlib.sha256(v).hexdigest()}  {k}\n" for k, v in sorted(all_files.items()))
        with open(os.path.join(d, "MANIFEST.sha256"), "w") as f:
            f.write(manifest)
    return cases, all_files


def main():
    for profile in ("common-v1", "evm-usdg-v1"):
        cases, files = build(profile, getattr(R, A.PROFILES[profile]["model"]))
        steps = sum(len(s.steps) for s in cases)
        print(f"{profile}: {len(cases)} vectors, {steps} steps")


if __name__ == "__main__":
    main()
