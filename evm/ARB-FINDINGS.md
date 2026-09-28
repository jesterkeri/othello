# Findings while building ARB-DESIGN r9 (for the code review)

Design: `othello-design/arb/ARB-DESIGN.md` r9, sha256 `ca3b3c8c…8284`, Codex SHIP
(`reviews/arb-design-review-r8.md`). These are places where building the design showed something the
design text did not say. None changes a rule; each is stated here so the reviewer can check it.

## F-1. An escrow deficit cannot arise in a USDG-only circle

**Claim.** With USDG collateral valued 1:1, `escrowDeficit` stays 0 in every reachable state.

**Why.** At a default, `shortfall = O − seized = O − min(collateral, O) ≤ O − H` because `H ≤ collateral`.
And `need = ceil(O × coverage / 10000) − H ≥ O − H` because `coverage ≥ 10000`. So every shortfall is at
most the defaulter's `need`. The last successful gate (release) required `Σ need ≤ R − L` over every
received, non-defaulted member, with the same `O` the default will use: a member who received in round
`r` has `roundsPaid = r + 1` at that release, and at a default in round `r + 1` still has `r + 1`. A
member's `H` never falls: collateral only grows (`addStock`) until that member's own seizure. So the
losses of any set of defaults are covered by the reserve the gate already required, and
`loss = min(shortfall, R − L) = shortfall` every time.

**Evidence.**
- 20,000 random circles (n 3–8, mixed parameters, members skipping rounds, defaults in and out of queue
  order, pauses cured by top-ups): 2,843 paused gates, **0** deficits, **0** `CoverageTooLow`.
- Foundry invariant `invariant_no_escrow_deficit`: 256 runs × 200 calls, holds.
- `core/test_core.py::Rules::test_escrow_deficit_unreachable_first_default_bound`.

**Consequences.**
- The design's §7.1 row "deficit top-up disclosure" (reserve exhausted by a default, deficit > 0, a member
  tops up) cannot be produced by a real sequence. The code path is still built and tested with the
  deficit **forced** into storage (`test/OthelloCircle.t.sol`: `test_topup_refuses_when_deficit_rose_after_read`,
  `..._cleared_first`, `..._applies_exact_fill`, `..._fill_smaller_than_deficit`). The same holds for
  §7.1 top-up consent case (a), "an intervening `declareDefault` raises the deficit".
- For a user this is good news: on Robinhood today, a top-up never pays for someone else's missed payment;
  the §6 subsidy sentence will not show (`fill` is always 0). It stays in the contract and the copy
  because C1 (price-backed collateral) makes deficits reachable again.
- Paused (`ReserveOvercommitted`) **is** reachable: a default uses up reserve that the *next* recipient's
  need was counting on. A top-up of exactly `nextGateShortBy` cures it (vectors include one).

## F-2. `CoverageTooLow` cannot be raised with USDG collateral

It needs the recipient's `H < minStockCover`. Every recipient joined with `H ≥ minStockCover`, has never
received, so has never defaulted, so their collateral never fell. The branch is kept (it is the SPEC
rule) and listed as mutation M37, an expected survivor because it is unreachable.

## F-3. `common-v1` carries `declareDefault` refusals only

The design puts "the queue" in `common-v1` and "internal seizure" in `evm-usdg-v1`. A successful default's
state change is chain-specific (EVM seizes USDG in place; Solana sells stock through a pool), so a
`common-v1` vector never contains a successful `declareDefault`: `ACTIONS.json` marks it
`successAllowed: false`, the generator refuses to emit one, and `CommonModel` has no settlement. Its
refusals (grace, pre-payout, not marked, out of order) are shared and replayed.

## F-4. Zero-amount outbound transfers are skipped

`_push(to, 0)` returns without calling USDG. Only `withdraw` can have a zero total (a defaulter whose
collateral was fully seized and whose pooled weight is 0). Skipping it changes no state and no balance;
calling USDG with 0 would add an external call for nothing.

## F-5. `addStock` refusal order for a non-member in Forming

The design's first check is "status Forming-and-joined or Active (`CircleNotActive`)". Read literally, a
non-member calling `addStock` while Forming gets `CircleNotActive` (not joined), while in Active they get
`NotAMember`. Built literally, in both the model and the contract.

## F-6. Surplus sent before or during a circle

Replay and unit tests confirm unsolicited USDG is never counted, paid or swept (AL9). The page must say so
before anyone sends (design §3.3 copy).
