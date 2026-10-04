"""Othello reference model: one circle as a pure state machine.

Written from ARB-DESIGN r9 (sha256 ca3b3c8c...8284, Codex SHIP) and SPEC.md sections 4 to 7,
independently of the Solidity and Rust code. Integers only, no floats.

Three profile classes (ARB-DESIGN section A):
  CommonModel      common-v1    no top-up method at all
  EvmUsdgModel     evm-usdg-v1  top_up_reserve(amount, expected_fill), TopUpFillChanged, EVM-I24
  SolanaPythModel  solana-pyth-v2  top_up_reserve(amount) exactly as SPEC.md:113; price rules arrive with P2

Every action either returns a dict of events or raises Refusal(name, args). A refusal leaves the
model untouched: each action validates first and mutates only after every check has passed.
"""

from __future__ import annotations

import copy

FORMING, ACTIVE, COMPLETED, CANCELLED = 0, 1, 2, 3
U32_MAX = 2**32 - 1
MAX_SEATS = 8

MAX_C = 10**12
MAX_G = 10**12
MAX_AMOUNT = 10**13  # join collateral, post-add collateral, post-add top-ups, quote, min_stock_cover
MAX_ROUND_SECS = 31_536_000
MAX_GRACE_SECS = 2_592_000


class Refusal(Exception):
    """A refused call: machine name plus its integer arguments, in signature order."""

    def __init__(self, name: str, *args: int):
        super().__init__(name, args)
        self.name = name
        self.args_ = tuple(int(a) for a in args)


# Canonical error signatures. The Solidity custom errors must match these exactly.
ERRORS = {
    "InvalidParams": [],
    "GuaranteeBelowPeakNeed": ["uint256", "uint256"],
    "CircleNotForming": [],
    "CircleNotActive": [],
    "NotAMember": [],
    "AlreadyJoined": [],
    "NotJoined": [],
    "CollateralBelowMinimum": ["uint256", "uint256"],
    "InsufficientBalance": ["uint256", "uint256"],
    "InsufficientAllowance": ["uint256", "uint256"],
    "Unauthorized": [],
    "NotAllJoined": [],
    "AlreadyDefaulted": [],
    "AlreadyContributed": [],
    "RoundNotFunded": ["uint8", "uint256", "uint256", "uint256", "uint256"],
    "CoverageTooLow": ["uint256"] * 7,
    "ReserveOvercommitted": ["uint256"] * 7,
    "GraceNotElapsed": ["uint256"],
    "SeatAlreadyPaid": [],
    "AlreadyMarked": [],
    "PrePayoutDefaultUnsupported": [],
    "NotMarked": [],
    "DefaultOutOfOrder": ["uint8"],
    "NotFinished": [],
    "AlreadyWithdrawn": [],
    "TopUpFillChanged": ["uint256", "uint256"],
    "TransferAmountMismatch": ["uint256", "uint256"],
}


def error_signature(name: str) -> str:
    return f"{name}({','.join(ERRORS[name])})"


def ceil_div(a: int, b: int) -> int:
    return -((-a) // b)


def sat_u32(x: int) -> int:
    return U32_MAX if x > U32_MAX else x


class Seat:
    __slots__ = ("collateral", "g", "top_ups", "forfeited", "rounds_paid", "allocated",
                 "last_coverage_bps", "delinquent_marks")

    def __init__(self):
        self.collateral = 0
        self.g = 0
        self.top_ups = 0
        self.forfeited = 0
        self.rounds_paid = 0
        self.allocated = 0
        self.last_coverage_bps = 0
        self.delinquent_marks = 0


CIRCLE_FIELDS = [
    "status", "round", "deadline", "paid_bitmap", "joined_bitmap", "withdrawn_bitmap",
    "received_bitmap", "defaulted_bitmap", "delinquent_bitmap", "reserve_total", "reserve_losses",
    "reserve_allocated", "escrow", "escrow_deficit", "withdrawn_from_reserve", "collateral_returned",
    "deposits_total", "forfeited_total", "next_gate_short_by", "held_contributions", "last_coverage_at",
]
SEAT_FIELDS = list(Seat.__slots__)


class Params:
    def __init__(self, n, c, g, min_stock_cover, haircut_bps, coverage_bps, warn_bps, round_secs,
                 grace_secs):
        self.n = n
        self.c = c
        self.g = g
        self.min_stock_cover = min_stock_cover
        self.haircut_bps = haircut_bps
        self.coverage_bps = coverage_bps
        self.warn_bps = warn_bps
        self.round_secs = round_secs
        self.grace_secs = grace_secs

    def as_dict(self):
        return dict(self.__dict__)


class CommonModel:
    """common-v1: every rule both chains share. No top-up method exists on this class."""

    PROFILE = "common-v1"

    # ---------------------------------------------------------------- construction
    def __init__(self, p: Params, members: list[int], creator: int, balances: dict[int, int],
                 allowances: dict[int, int]):
        """members: actor ids (non-zero ints). Raises Refusal like OthelloFactory.createCircle."""
        self._validate_create(p, members, creator)
        self.p = p
        self.members = list(members) + [0] * (MAX_SEATS - len(members))
        self.creator = creator
        self.status = FORMING
        self.round = 0
        self.deadline = 0
        self.paid_bitmap = 0
        self.joined_bitmap = 0
        self.withdrawn_bitmap = 0
        self.received_bitmap = 0
        self.defaulted_bitmap = 0
        self.delinquent_bitmap = 0
        self.reserve_total = 0
        self.reserve_losses = 0
        self.reserve_allocated = 0
        self.escrow = 0
        self.escrow_deficit = 0
        self.withdrawn_from_reserve = 0
        self.collateral_returned = 0
        self.deposits_total = 0
        self.forfeited_total = 0
        self.next_gate_short_by = 0
        self.held_contributions = 0
        self.last_coverage_at = 0
        self.seats = [Seat() for _ in range(MAX_SEATS)]
        # USDG ledger: member balances and allowances to the circle, the circle's own balance.
        self.balance = {m: int(balances.get(m, 0)) for m in members}
        self.allowance = {m: int(allowances.get(m, 0)) for m in members}
        self.circle_balance = 0

    @staticmethod
    def _validate_create(p: Params, members: list[int], creator: int):
        # ARB section 2 and 4.2: members.length == n first, then bounds, then creator, then peak.
        if len(members) != p.n:
            raise Refusal("InvalidParams")
        if not (3 <= p.n <= 8):
            raise Refusal("InvalidParams")
        if len(set(members)) != len(members) or any(m == 0 for m in members):
            raise Refusal("InvalidParams")
        if not (1 <= p.c <= MAX_C) or not (1 <= p.g <= MAX_G):
            raise Refusal("InvalidParams")
        if not (0 <= p.min_stock_cover <= MAX_AMOUNT):
            raise Refusal("InvalidParams")
        if not (0 <= p.haircut_bps < 10000):
            raise Refusal("InvalidParams")
        if not (10000 <= p.warn_bps < p.coverage_bps <= 30000):
            raise Refusal("InvalidParams")
        if not (60 <= p.round_secs <= MAX_ROUND_SECS) or not (30 <= p.grace_secs <= MAX_GRACE_SECS):
            raise Refusal("InvalidParams")
        if creator not in members:
            raise Refusal("InvalidParams")
        peak = CommonModel.peak_need(p)
        if p.n * p.g < peak:
            raise Refusal("GuaranteeBelowPeakNeed", peak, p.n * p.g)

    @staticmethod
    def peak_need(p: Params) -> int:
        best = 0
        for k in range(1, p.n):
            per = max(0, ceil_div(p.c * (p.n - k) * p.coverage_bps, 10000) - p.min_stock_cover)
            best = max(best, k * per)
        return best

    # ---------------------------------------------------------------- helpers
    def clone(self):
        return copy.deepcopy(self)

    def _bit(self, bitmap: int, t: int) -> bool:
        return (bitmap >> t) & 1 == 1

    def _seat_of(self, caller: int) -> int:
        for t in range(self.p.n):
            if self.members[t] == caller:
                return t
        return -1

    def _member(self, caller: int) -> int:
        t = self._seat_of(caller)
        if t < 0:
            raise Refusal("NotAMember")
        return t

    def h_of(self, collateral: int) -> int:
        return collateral * (10000 - self.p.haircut_bps) // 10000

    def _obligation(self, t: int) -> int:
        s = self.seats[t]
        return self.p.c * (self.p.n - s.rounds_paid) if self._bit(self.received_bitmap, t) else 0

    def _need(self, obligation: int, h: int) -> int:
        return max(0, ceil_div(obligation * self.p.coverage_bps, 10000) - h)

    def _check_pull(self, who: int, x: int):
        if self.balance[who] < x:
            raise Refusal("InsufficientBalance", x, self.balance[who])
        if self.allowance[who] < x:
            raise Refusal("InsufficientAllowance", x, self.allowance[who])

    def _pull(self, who: int, x: int):
        self.balance[who] -= x
        self.allowance[who] -= x
        self.circle_balance += x

    def _push(self, who: int, x: int):
        self.circle_balance -= x
        self.balance[who] += x

    def accounted(self) -> int:
        return (self.reserve_total - self.reserve_losses + self.escrow + self.held_contributions
                - self.withdrawn_from_reserve + sum(s.collateral for s in self.seats))

    def _s_next(self) -> int:
        """Gate sum the next payout will see once every seat has paid (SPEC update_coverage, r4)."""
        total = 0
        for t in range(self.p.n):
            if self._bit(self.defaulted_bitmap, t):
                continue
            if self._bit(self.received_bitmap, t) or t == self.round:
                o = self.p.c * (self.p.n - self.round - 1)
                total += self._need(o, self.h_of(self.seats[t].collateral))
        return total

    def _recompute_coverage(self, now: int):
        """update_coverage effects (SPEC section 5), also run by declareDefault in EVM."""
        remaining = self.reserve_total - self.reserve_losses
        alloc_sum = 0
        for t in range(self.p.n):
            s = self.seats[t]
            if self._bit(self.defaulted_bitmap, t):
                s.allocated = 0
                s.last_coverage_bps = U32_MAX
                continue
            o = self._obligation(t)
            h = self.h_of(s.collateral)
            need = self._need(o, h)
            s.allocated = min(need, remaining)
            remaining -= s.allocated
            alloc_sum += s.allocated
            s.last_coverage_bps = U32_MAX if o == 0 else sat_u32((h + s.allocated) * 10000 // o)
        self.reserve_allocated = alloc_sum
        avail = self.reserve_total - self.reserve_losses
        self.next_gate_short_by = max(0, self._s_next() - avail) + self.escrow_deficit
        self.last_coverage_at = now

    # ---------------------------------------------------------------- actions
    def join_and_lock(self, caller: int, now: int, amount: int):
        if self.status != FORMING:
            raise Refusal("CircleNotForming")
        t = self._member(caller)
        if self._bit(self.joined_bitmap, t):
            raise Refusal("AlreadyJoined")
        if not (1 <= amount <= MAX_AMOUNT):
            raise Refusal("InvalidParams")
        h = self.h_of(amount)
        if h < self.p.min_stock_cover:
            raise Refusal("CollateralBelowMinimum", h, self.p.min_stock_cover)
        x = amount + self.p.g
        self._check_pull(caller, x)
        s = self.seats[t]
        s.collateral = amount
        s.g = self.p.g
        self.joined_bitmap |= 1 << t
        self.reserve_total += self.p.g
        self.deposits_total += self.p.g
        self._pull(caller, x)
        return {"MemberJoined": [t, amount, self.p.g]}

    def leave_forming(self, caller: int, now: int):
        if self.status != FORMING:
            raise Refusal("CircleNotForming")
        t = self._member(caller)
        if not self._bit(self.joined_bitmap, t):
            raise Refusal("NotJoined")
        s = self.seats[t]
        x = s.collateral + s.g + s.top_ups
        self.reserve_total -= s.g + s.top_ups
        self.deposits_total -= s.g + s.top_ups
        self.seats[t] = Seat()
        self.joined_bitmap &= ~(1 << t)
        self._push(caller, x)
        return {"MemberLeftForming": [t, x]}

    def cancel_circle(self, caller: int, now: int):
        if self.status != FORMING:
            raise Refusal("CircleNotForming")
        if caller != self.creator:
            raise Refusal("Unauthorized")
        self.status = CANCELLED
        return {"CircleCancelled": []}

    def activate(self, caller: int, now: int):
        if self.status != FORMING:
            raise Refusal("CircleNotForming")
        if caller != self.creator:
            raise Refusal("Unauthorized")
        if self.joined_bitmap != (1 << self.p.n) - 1:
            raise Refusal("NotAllJoined")
        self.status = ACTIVE
        self.round = 0
        self.deadline = now + self.p.round_secs
        return {"CircleActivated": [self.deadline]}

    def contribute(self, caller: int, now: int):
        if self.status != ACTIVE:
            raise Refusal("CircleNotActive")
        t = self._member(caller)
        if self._bit(self.defaulted_bitmap, t):
            raise Refusal("AlreadyDefaulted")
        if self._bit(self.paid_bitmap, t):
            raise Refusal("AlreadyContributed")
        self._check_pull(caller, self.p.c)
        self.paid_bitmap |= 1 << t
        self.seats[t].rounds_paid += 1
        self.held_contributions += self.p.c
        self._pull(caller, self.p.c)
        return {"Contributed": [self.round, t]}

    def release_pot(self, caller: int, now: int):
        if self.status != ACTIVE:
            raise Refusal("CircleNotActive")
        n, c = self.p.n, self.p.c
        missing = 0
        k = 0
        for t in range(n):
            paid = self._bit(self.paid_bitmap, t)
            dflt = self._bit(self.defaulted_bitmap, t)
            if not paid and not dflt:
                missing += 1
            if dflt and not paid:
                k += 1
        if missing > 0 or self.escrow < k * c:
            raise Refusal("RoundNotFunded", missing, self.escrow, k * c, self.escrow_deficit,
                          self.next_gate_short_by)
        r = self.round
        # Gate: r treated as received; every received, non-defaulted member.
        gate_members = []
        needs = {}
        s_total = 0
        for t in range(n):
            if self._bit(self.defaulted_bitmap, t):
                continue
            if self._bit(self.received_bitmap, t) or t == r:
                o = c * (n - self.seats[t].rounds_paid)
                h = self.h_of(self.seats[t].collateral)
                needs[t] = (o, h, self._need(o, h))
                gate_members.append(t)
                s_total += needs[t][2]
        avail = self.reserve_total - self.reserve_losses
        if s_total > avail:
            need_r = needs[r][2]
            h_r = needs[r][1]
            payload = (s_total, avail, s_total - avail + self.escrow_deficit, need_r, s_total - need_r,
                       self.escrow_deficit, h_r)
            if h_r < self.p.min_stock_cover and s_total - need_r <= avail:
                raise Refusal("CoverageTooLow", *payload)
            raise Refusal("ReserveOvercommitted", *payload)
        # Effects.
        for t in range(n):
            if self._bit(self.defaulted_bitmap, t) and not self._bit(self.paid_bitmap, t):
                self.escrow -= c
                self.paid_bitmap |= 1 << t
                self.seats[t].rounds_paid += 1
        for t in range(n):
            s = self.seats[t]
            if t in needs:
                o, h, need = needs[t]
                s.allocated = need
                s.last_coverage_bps = U32_MAX if o == 0 else sat_u32((h + need) * 10000 // o)
            else:
                s.allocated = 0
        self.reserve_allocated = s_total
        self.received_bitmap |= 1 << r
        recipient = self.members[r]
        pot = n * c
        if r + 1 < n:
            self.round = r + 1
            self.deadline = now + self.p.round_secs
            self.paid_bitmap = 0
            self.delinquent_bitmap = 0
            self.held_contributions = 0
            self.next_gate_short_by = max(0, self._s_next() - avail) + self.escrow_deficit
        else:
            self.status = COMPLETED
            self.held_contributions = 0
            self.next_gate_short_by = 0
        self._push(recipient, pot)
        return {"PotReleased": [r, pot]}

    def update_coverage(self, caller: int, now: int):
        if self.status != ACTIVE:
            raise Refusal("CircleNotActive")
        self._recompute_coverage(now)
        return {"CoverageUpdated": [self.reserve_allocated, self.next_gate_short_by]}

    def mark_delinquent(self, caller: int, now: int, round_: int, turn: int):
        if self.status != ACTIVE:
            raise Refusal("CircleNotActive")
        if round_ != self.round or not (0 <= turn < self.p.n):
            raise Refusal("InvalidParams")
        opens = self.deadline + self.p.grace_secs
        if not now > opens:
            raise Refusal("GraceNotElapsed", opens)
        if self._bit(self.paid_bitmap, turn):
            raise Refusal("SeatAlreadyPaid")
        if self._bit(self.defaulted_bitmap, turn):
            raise Refusal("AlreadyDefaulted")
        if self._bit(self.delinquent_bitmap, turn):
            raise Refusal("AlreadyMarked")
        self.delinquent_bitmap |= 1 << turn
        self.seats[turn].delinquent_marks += 1
        return {"MemberMarkedDelinquent": [round_, turn, int(self._bit(self.received_bitmap, turn))]}

    def _default_checks(self, now: int, turn: int):
        if self.status != ACTIVE:
            raise Refusal("CircleNotActive")
        if not (0 <= turn < self.p.n):
            raise Refusal("InvalidParams")
        opens = self.deadline + self.p.grace_secs
        if not now > opens:
            raise Refusal("GraceNotElapsed", opens)
        if self._bit(self.paid_bitmap, turn):
            raise Refusal("SeatAlreadyPaid")
        if not self._bit(self.received_bitmap, turn):
            raise Refusal("PrePayoutDefaultUnsupported")
        if self._bit(self.defaulted_bitmap, turn):
            raise Refusal("AlreadyDefaulted")
        if not self._bit(self.delinquent_bitmap, turn):
            raise Refusal("NotMarked")
        for j in range(turn):
            if (self._bit(self.delinquent_bitmap, j) and self._bit(self.received_bitmap, j)
                    and not self._bit(self.paid_bitmap, j) and not self._bit(self.defaulted_bitmap, j)):
                raise Refusal("DefaultOutOfOrder", j)

    def declare_default(self, caller: int, now: int, turn: int):
        """In common-v1 only the refusals are shared; the settling effects are per profile."""
        self._default_checks(now, turn)
        return self._settle_default(now, turn)

    def _settle_default(self, now: int, turn: int):
        raise NotImplementedError("default settlement is profile-specific")

    def add_stock(self, caller: int, now: int, amount: int):
        t = self._seat_of(caller)
        forming_joined = self.status == FORMING and t >= 0 and self._bit(self.joined_bitmap, t)
        if not (self.status == ACTIVE or forming_joined):
            raise Refusal("CircleNotActive")
        t = self._member(caller)
        if self._bit(self.defaulted_bitmap, t):
            raise Refusal("AlreadyDefaulted")
        s = self.seats[t]
        if amount < 1 or s.collateral + amount > MAX_AMOUNT:
            raise Refusal("InvalidParams")
        self._check_pull(caller, amount)
        s.collateral += amount
        self._pull(caller, amount)
        return {"StockAdded": [t, amount]}

    def withdraw(self, caller: int, now: int):
        if self.status not in (COMPLETED, CANCELLED):
            raise Refusal("NotFinished")
        t = self._member(caller)
        if self.status == CANCELLED and not self._bit(self.joined_bitmap, t):
            raise Refusal("NotJoined")
        if self._bit(self.withdrawn_bitmap, t):
            raise Refusal("AlreadyWithdrawn")
        s = self.seats[t]
        self.withdrawn_bitmap |= 1 << t
        collateral_part = s.collateral
        if self.status == CANCELLED:
            pooled_part = s.g + s.top_ups
        else:
            pool_left = self.reserve_total - self.reserve_losses + self.escrow
            weight = s.g + s.top_ups - s.forfeited
            denom = self.deposits_total - self.forfeited_total
            pooled_part = pool_left * weight // denom if denom > 0 else 0
        self.withdrawn_from_reserve += pooled_part
        self.collateral_returned += collateral_part
        s.collateral = 0
        self._push(caller, collateral_part + pooled_part)
        return {"Withdrawn": [t, collateral_part, pooled_part]}

    def quote(self, caller: int, now: int, amount: int):
        if amount > MAX_AMOUNT:
            raise Refusal("InvalidParams")
        return {"Quote": [amount, self.h_of(amount)]}

    # ---------------------------------------------------------------- harness (token-level)
    def usdg_approve(self, caller: int, now: int, amount: int):
        self.allowance[caller] = amount
        return {}

    def usdg_send_to_circle(self, caller: int, now: int, amount: int):
        if self.balance[caller] < amount:
            raise Refusal("InsufficientBalance", amount, self.balance[caller])
        self.balance[caller] -= amount
        self.circle_balance += amount
        return {}

    # ---------------------------------------------------------------- snapshot
    def snapshot(self) -> dict:
        return {
            "circle": {f: getattr(self, f) for f in CIRCLE_FIELDS},
            "seats": [{f: getattr(self.seats[t], f) for f in SEAT_FIELDS} for t in range(MAX_SEATS)],
            "balances": {"circle": self.circle_balance,
                         "members": [self.balance[m] for m in self.members[: self.p.n]]},
            "allowances": [self.allowance[m] for m in self.members[: self.p.n]],
        }


class EvmUsdgModel(CommonModel):
    """evm-usdg-v1: USDG collateral seized 1:1 inside the circle; consent-bound top-up (EVM-I24)."""

    PROFILE = "evm-usdg-v1"

    def _settle_default(self, now: int, d: int):
        # ARB section 3.4, exact; no token moves.
        s = self.seats[d]
        o = self.p.c * (self.p.n - s.rounds_paid)
        seized = min(s.collateral, o)
        s.collateral -= seized
        funded = seized
        shortfall = o - funded
        loss = min(shortfall, self.reserve_total - self.reserve_losses)
        self.reserve_losses += loss
        self.escrow += funded + loss
        self.escrow_deficit += shortfall - loss
        new_forfeited = min(shortfall, s.g + s.top_ups)
        self.forfeited_total += new_forfeited - s.forfeited
        s.forfeited = new_forfeited
        self.defaulted_bitmap |= 1 << d
        s.allocated = 0
        self._recompute_coverage(now)
        return {"DefaultDeclared": [d, o, seized, loss, shortfall - loss]}

    def top_up_reserve(self, caller: int, now: int, amount: int, expected_fill: int):
        if self.status != ACTIVE:
            raise Refusal("CircleNotActive")
        t = self._member(caller)
        if self._bit(self.defaulted_bitmap, t):
            raise Refusal("AlreadyDefaulted")
        s = self.seats[t]
        if amount < 1 or s.top_ups + amount > MAX_AMOUNT:
            raise Refusal("InvalidParams")
        fill = min(self.escrow_deficit, amount)
        if fill != expected_fill:
            raise Refusal("TopUpFillChanged", expected_fill, fill)
        self._check_pull(caller, amount)
        self._apply_top_up(s, amount, fill)
        self._pull(caller, amount)
        return {"ReserveToppedUp": [t, amount, fill]}

    def _apply_top_up(self, s: Seat, amount: int, fill: int):
        v, deficit = self.next_gate_short_by, self.escrow_deficit
        self.escrow += fill
        self.escrow_deficit -= fill
        self.reserve_total += amount - fill
        s.top_ups += amount
        self.deposits_total += amount
        self.next_gate_short_by = max(0, (v - deficit) - (amount - fill)) + (deficit - fill)


class SolanaPythModel(CommonModel):
    """solana-pyth-v2: today's one-argument top-up (SPEC.md:113). Price, multiplier-guard and pool-sale
    rules (P1) are added in P2; until then this profile's generator emits no vectors."""

    PROFILE = "solana-pyth-v2"

    def top_up_reserve(self, caller: int, now: int, amount: int):
        # SPEC errors in order: circle_not_active, already_defaulted, invalid_params (zero),
        # insufficient_balance. Membership is enforced by the Solana account model.
        if self.status != ACTIVE:
            raise Refusal("CircleNotActive")
        t = self._member(caller)
        if self._bit(self.defaulted_bitmap, t):
            raise Refusal("AlreadyDefaulted")
        if amount < 1:
            raise Refusal("InvalidParams")
        if self.balance[caller] < amount:
            raise Refusal("InsufficientBalance", amount, self.balance[caller])
        fill = min(self.escrow_deficit, amount)
        s = self.seats[t]
        EvmUsdgModel._apply_top_up(self, s, amount, fill)
        self.balance[caller] -= amount
        self.circle_balance += amount
        return {"ReserveToppedUp": [t, amount, fill]}


PROFILE_MODELS = {
    "common-v1": CommonModel,
    "evm-usdg-v1": EvmUsdgModel,
    "solana-pyth-v2": SolanaPythModel,
}
