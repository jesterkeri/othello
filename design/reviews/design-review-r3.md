# Othello design review, round 3 (adversarial, design-only)

Scope: SPEC.md v4, othello/SYSTEM.md (r3), othello/FLOWS.md (r3), reviews r1 and r2. No code exists. "Confirmed" means the case was traced by hand and in a scratch model of the r3 rules exactly as written (join, contribute, release_pot with the option-B gate and k×c escrow, §6 waterfall with forfeit-vs-shortfall, top_up_reserve with `R += amount − fill`, turn-order allocation, `next_gate_short_by`, §7 withdraw). Every scenario kept I3 (vault = R − L + E + held − W, plus dust) true after every step; the r3 top-up accounting conserves funds. The holes are in what the new on-chain Paused field means and when it is refreshed, and in one invariant the design claims on a path where its own rule breaks it.

Governing assumption applied: the r3 fixes were attacked first (T1-T6), then every r2 finding re-checked (table below). Demo parameters are the r3 demo circle (n=5, c=50, g=35, R=175, cov 130%, warn 110%, haircut 20%, pool discount 20%, min_stock_cover 120, 1.1 token each at wrapper = share = 150, so H = 132 and conservative sale 120/token) unless stated.

---

## CRITICAL

None.

---

## MAJOR

```
[MAJOR] S_next is computed from stored rounds_paid, so the on-chain Paused flag is raised right after every payout in a healthy circle
SYSTEM.md:§5 update_coverage ("S_next is the gate sum with the current round's recipient treated as received"), §5 release_pot ("after paying, recomputes next_gate_short_by for the new round"), §4 Circle.next_gate_short_by, §8 I18; FLOWS.md:§5 row 7 (precondition "not Paused"), §7 D7, §8 "Payout gate: reserve" banner
What a user or judge sees: demo step 4 pays m0; the Circle page immediately shows "Payouts paused. The next payout needs 256 USDC of reserve and 175 remains. Top up 81 USDC" on a circle that has lost nothing. Under FLOWS row 7 the Release pot affordance is disabled while Paused. The banner clears only after everyone has paid round 1 and someone calls update_coverage, or after the default in step 5 (the defaulter drops out of the sum). The same banner reappears after the round-1 payout ("needs 126, 107 remains, top up 19").
Why: "the gate sum" is defined in the payout gate, where every non-defaulted seat has already paid, so O_i = c × (n − round − 1) for all. update_coverage and release_pot compute S_next mid-round, when the stored rounds_paid of unpaid members (and of the recipient) is one lower, so O_i is c higher and need_i is ceil(c × cov) = 65 higher per member than the gate will see. The r2 fix text spelled the projection out ("at release everyone non-defaulted will have rounds_paid = round + 1"); r3 dropped that sentence. A builder who follows the derived-values block literally gets the wrong number; a builder who projects gets the right one. Nothing in the document decides.
Reproduce: demo circle, round 0 released (A = 128). Literal: S_next = need_0(O 200 → 260 − 132 = 128) + need_1(O 200 → 128) = 256 > 175 → next_gate_short_by = 81. Projected: O = 150 each → 63 + 63 = 126 ≤ 175 → 0. After round 1 (m0 defaulted, avail 107): literal 63 + 63 = 126 → 19; projected O = 100 → 0 + 0 → 0.
Fix: one sentence in §5: "S_next uses O_i = c × (n − round − 1) for every received, non-defaulted member and for the recipient (the values the gate will see once every seat has paid), not stored rounds_paid." Add the "no false Paused after a healthy payout" case to the I18 test.
Confidence: confirmed that the text admits the literal reading and that it breaks the demo; plausible that a builder takes it
```

```
[MAJOR] I2's Σ Member.allocated = reserve_allocated clause is false after release_pot (never writes Member.allocated) and after declare_default during Repricing when the cap bites
SYSTEM.md:§5 release_pot effect ("reserve_allocated = gate sum", nothing about Member.allocated or last_coverage_bps), §5 declare_default Repricing branch ("reserve_allocated = min(reserve_allocated − allocated_d, R − L), allocated_d = 0, others untouched"), §8 I2 ("Σ Member.allocated = Circle.reserve_allocated after every instruction ... incl. declare_default during Repricing"); FLOWS.md:§6 J2 happy path ("Tunde now owes 150 USDC over 3 rounds, covered 130%")
What a user or judge sees: (1) demo step 4: Guarantee panel "Allocated 128" while m0's row reads reserve cover 0 and coverage n/a (last_coverage_bps still u32::MAX from O = 0) until someone calls update_coverage; the J2 success line "covered 130%" cannot be printed from account data. (2) During the split window a default whose liquidation returns little leaves m1's Position at reserve cover 63 while the panel says Allocated 51; the I2 property test the design says runs on this path fails.
Why: (1) release_pot passes all Member accounts writable but its effect column only sets the circle-level sum; the per-member figures it depends on (need_i, which it just computed) are not written. (2) The Repricing branch subtracts only the defaulter's allocation and caps the circle-level figure; when the loss pushes R − L below the surviving allocations, the survivors' stored `allocated` (which cannot be recomputed without H) no longer sum to the capped total. The branch has the information to fix it: walk survivors in turn order and cap each stored allocated_i by the remaining capped total.
Reproduce: (1) demo round 0: A = 128, Member.allocated = [0,0,0,0,0]. (2) demo rounds 0, 1 released (allocated [63,63,0,0,0], A = 126). Admin stamps Scheduled (Repricing) and re-sets wrapper to 30 (conservative 24). m0 misses round 2: O = 150, sells 1.1 → 26, shortfall 124, loss 124, R − L = 51. Branch: A = min(126 − 63, 51) = 51; m1.allocated stays 63. Σ = 63 ≠ 51. (Needs a wrapper below ~43 to bite in the demo circle; a property test with random prices hits it.)
Fix: release_pot effect: "for every member in the sum, allocated_i = need_i and last_coverage_bps_i = (H_i + need_i)·1e4 / O_i; others allocated_i = 0". Repricing branch: "then for survivors in turn order, allocated_i = min(allocated_i, remaining), remaining −= allocated_i, so Σ allocated_i = reserve_allocated". Keep I2 wording.
Confidence: confirmed
```

```
[MAJOR] next_gate_short_by is stale after add_stock and set_prices, top_up_reserve's recompute needs inputs it does not take, and nothing says the field can lag; FLOWS gates the Release pot affordance and promises a recompute on it
SYSTEM.md:§5 add_stock ("stock_raw += raw" only), §5 top_up_reserve ("then recompute next_gate_short_by", preconditions "Active" only, codes insufficient_balance / already_defaulted), §5 set_prices (per feed, touches no circle), §5 declare_default Repricing branch ("next_gate_short_by += shortfall − loss"), §5 gate paragraph ("Paused is defined on-chain as next_gate_short_by > 0; the UI never computes it"), §8 I18; FLOWS.md:§5 row 7 (precondition "not Paused"), row 11 ("raw += amount, coverage recomputed"), row 10, §8 Position success ("Coverage now {pct}%")
What a user or judge sees: (1) the cure the coverage_too_low copy asks for does not clear the state it caused: the recipient locks more stock, the banner still says "Payouts paused ... top up 39", the Position still shows the old coverage, and (per row 7) Release pot is disabled although the gate now passes; only an unrelated "Update coverage" click fixes the display. (2) After a price fall the page shows no Paused banner while the gate refuses (safe direction, but unstated). (3) A top-up during the split window (Repricing) either refuses with a code not in the table or computes H from a price the program refuses everywhere else, depending on the builder.
Why: the field is refreshed only by update_coverage, release_pot, declare_default and top_up_reserve. add_stock changes H_r and does not recompute (and could not without all Member accounts and a fresh price). set_prices cannot touch circles. top_up_reserve's "recompute" needs S_next, which needs H for every member, which needs all n Member accounts plus a fresh, non-repricing feed; none of that is in its row. The Repricing branch of declare_default only adds ΔD and ignores the loss and the removed member. The known-limits list allows staleness only if stated; it is not stated anywhere in SYSTEM or FLOWS, and I18's "⇔" reads as live.
Reproduce: demo circle, round 0 released. Prices fall to wrapper = share = 100 (H = 88). Everyone pays round 1; update_coverage → next_gate_short_by = (107 + 107) − 175 = 39. release_pot → coverage_too_low{needed 214, remaining 175, short_by 39, recipient_gap 107, others_need 107}. m1 add_stock(2 tokens) → H_1 = 248, need_1 = 0, S = 107 ≤ 175: the gate passes; the field still reads 39 → Paused, Release pot disabled per row 7.
Fix: (a) state in §5 and FLOWS: "next_gate_short_by is as of the last update_coverage / release_pot / declare_default / top_up; add_stock and price changes do not refresh it; the UI shows the last-checked age next to Paused and never disables Release pot on it (the program refuses with numbers)". Drop "not Paused" from row 7's precondition and "coverage recomputed" from row 11 (or make add_stock take all Member accounts and recompute like update_coverage). (b) top_up_reserve needs no H: with v = old field, D = old deficit, `next_gate_short_by = max(0, (v − D) − (amount − fill)) + (D − fill)` is exactly the recomputed value for unchanged prices (verified algebraically and by 2,000 random cases). (c) Mark the Repricing-branch figure as approximate until update_coverage.
Confidence: confirmed
```

---

## MINOR

```
[MINOR] Paused with an escrow deficit is shown while release_pot succeeds, with a banner that reads "needs 0 of reserve and 0 remains"; the escrow-short refusal under-asks when the reserve also needs money
SYSTEM.md:§5 update_coverage (next_gate_short_by = max(0, S_next − (R − L)) + escrow_deficit), §5 release_pot (gate does not read escrow_deficit; round_not_funded payload has no S), §8 I18; FLOWS.md:§2.5 "Paused: payouts stopped because the reserve can't cover the next one", §8 rows "Payout gate: reserve" and "Round not funded: escrow short"
What a user or judge sees: after a deep default (deficit 8) where the survivors hold enough stock to need no reserve, rounds 1-3 release fine while the page says "Payouts paused. The next payout needs 0 USDC of reserve and 0 remains. Top up 8 USDC"; round 4 then refuses round_not_funded (escrow 42 < 50). Conversely when both D > 0 and S > 0, the escrow-short row says "tops up {deficit}" while the true cure is S + D (the Paused banner's number); two banners with different figures.
Why: D > 0 implies R − L = 0, so the gate passes exactly when every survivor's need is 0. The field then equals D and Paused is defined on it. The pause is real in the sense that the circle will stop when escrow runs dry, but the vocabulary and the reserve-banner copy describe a different cause. round_not_funded has no S to name the whole cure.
Reproduce: demo circle, m1-m4 hold 2.0 tokens (H 240). Round 0 released. Prices crash to 20: m0 misses round 1, sells 1.1 → 17, shortfall 183, loss 175, D = 8, E = 192. Prices recover; update_coverage → field = 0 + 8. Rounds 1-3 release (S = 0 ≤ 0), field stays 8; round 4: E = 42 < 50 → round_not_funded{escrow 42, escrow_needed 50, escrow_deficit 8}.
Fix: FLOWS 2.5: "Paused: the next payout can't be released or a defaulter's prepaid contributions will run short"; when needed = 0 the banner uses the escrow-short wording ("{name}'s prepaid contributions are {D} short; the first {D} of any top-up fills that and is not returned"). Add `short_by = next_gate_short_by` to the round_not_funded payload so the escrow-short row can print the whole cure.
Confidence: confirmed
```

```
[MINOR] I14 double-counts the deficit and contradicts I18
SYSTEM.md:§8 I14 ("top-ups ≥ deficit + the next gate's short_by"), I18 ("a top-up of exactly short_by makes the next gate pass"), §5 gate payload (short_by = S − avail + escrow_deficit)
What a user or judge sees: a G3 test written from I14 tops up 2×D more than needed and proves nothing about the boundary; I18's exact-amount claim is the one that matters and I14 says a different number.
Why: short_by already includes the deficit (the fill goes first). Two-defaulter case: D = 110, S = 10, avail 0 → short_by 120; I14 asks for 230.
Reproduce: rounds 0-1 pay m0, m1 (g 30); price 25; both miss round 2 → L 150, D 110, E 190; price recovers (H 120); update_coverage → short_by = 10 + 110 = 120. Top up 120: fill 110, avail 10, round 2 releases (need 10). Circle completes; withdraw [0, 0, 7, 1, 1] of pool_left 10.
Fix: I14: "then a top-up of next_gate_short_by (which includes the deficit) lets the circle complete".
Confidence: confirmed
```

```
[MINOR] FLOWS numbers lag r3: J3 "Reserve free: 102" assumes g = 30; J4 and the split lab use $1,000/$100 and raw 1.00 while the demo is 150/15 and raw 1.1; the coverage_too_low row prints fields the payload does not carry; Healthy threshold is 125% in FLOWS and coverage_bps (130%) in SYSTEM
FLOWS.md:§6 J3 ("Reserve free: 102 USDC", "next payout needs 20"), §3 J4 ("$1,000→$100"), §6 J4 ("Raw 1.00 ... Share price 100 ... 1,000 USDC"), §8 row "Payout gate: coverage" ({H}, {min}), §2.5 Healthy ≥125%; SYSTEM.md:§5 demo block, §5 gate payload, §4 coverage_bps/warn_bps
What a user or judge sees: fixtures copied from J3 disagree with the program by 35 USDC (free is 175 − 39 − need_0, i.e. 117 at Kemi's sale price or 136 once H is back to 132, never 102); the split lab copy shows a stock the demo circle does not hold; the coverage refusal cannot print {H} and {min} from `{needed, remaining, short_by, recipient_gap, others_need, escrow_deficit}` without an extra quote_valuation call; a capped member at 127% is Healthy by FLOWS and Warning by SYSTEM.
Why: J3 was fixed for r2's g = 30 and not re-run for g = 35; J4 kept SPEC §9's illustrative prices; r3 rewrote the payload without the two figures the copy uses; SPEC §5's 125% was never mapped to a circle parameter.
Reproduce: Kemi (turn 1) received round 1, misses round index 2, sale 111 at wrapper 127 (to match "sold for 112"): O 150, loss 39, R − L = 136, need_0 (O 100, H 111) = 19, free 117. Demo split: 1.1 raw × 10 × 15 = 165, not 1,000.
Fix: J3: "Reserve free: 117 USDC" (or restate the fixture); J4/split lab: "Raw 1.10. Multiplier 10. Share price 15 USDC. Othello values it at 165 USDC, unchanged; a naive vault thinks 16.50"; add `recipient_cover: H_r` to both gate payloads (min_stock_cover is on Circle); FLOWS 2.5: Healthy ≥ coverage target, Warning ≥ warn, else Critical.
Confidence: confirmed
```

```
[MINOR] Reproducibility: seven points two builders would still resolve differently
SYSTEM.md:§4-§7
What a user or judge sees: two implementations differ on what a defaulted member's row shows, on a possible panic, and on who pays when the recipient closed their USDC account.
Why: unstated, likely guess in brackets:
 1. last_coverage_bps for a defaulted member: O_d = c × (n − rounds_paid_d) stays > 0 (escrow keeps incrementing rounds_paid) and H_d is 0 or the surplus, so the formula prints ~0% Critical for someone whose obligations are prepaid. [computed; shows Critical]
 2. last_coverage_bps is u32 and (H + G) × 1e4 / O overflows for H ≥ ~2.1e5 USDC against O = 50; saturate to u32::MAX. [checked mul panics]
 3. "join creates the member's USDC ATA so release_pot never has to": a member can close an empty ATA after joining; release_pot then fails for that seat with a raw token error. [init_if_needed with the caller as payer, or a named refusal `recipient_account_missing`]
 4. next_gate_short_by after the last payout (Completed) and whether update_coverage may run at Completed. [0; refused circle_not_active]
 5. How the UI shows "used to prefund defaults": Σ fills is not stored; it equals deposits_total − reserve_total. [recomputed in the UI]
 6. release_pot / update_coverage validate that remaining_accounts[i].turn == i and .circle == circle. [assumed]
 7. touch_prices cadence during judging (one touch on Friday 21:00 covers 2 Oct 21:00 with 8 days; a Thursday touch does not). [Friday]
Reproduce: n/a
Fix: one line each in §4-§7 and the demo block.
Confidence: confirmed
```

---

## r2 findings resolved / not resolved

| r2 finding | Status | Residual |
|---|---|---|
| CRIT set_prices(Current) rebinds share price to the effective multiplier | Resolved (touch_prices; expected_multiplier_fixed verified on-chain; Current refused while a Scheduled stamp is pending; I17) | None found. Demo timeline walked: Scheduled before T → Repricing until T → touch after T fine → Current after T allowed and must name 10e9. Scheduled sent before UpdateMultiplier is refused by the expected check. Forgetting set_prices → Repricing after T, curable. No deadlock: Scheduled is never refused by the pending rule. |
| MAJOR declare_default during Repricing | Resolved (explicit branch, no H) | Σ allocated clause fails when the cap bites (MAJOR 2); ΔD-only update of next_gate_short_by is approximate (MAJOR 3) |
| MAJOR escrow_deficit invisible; short_by wrong; Lost rises on top-up | Resolved (payloads carry D; short_by = S − avail + D verified as the exact cure; round_not_funded payload; L untouched by fills) | Escrow-short copy under-asks when S > 0 (MINOR 1) |
| MAJOR gate cause predicate | Resolved (H_r < min AND S − need_r ≤ avail; exhaustive and exclusive) | Payload lacks H_r for the copy (MINOR 3) |
| MAJOR per-member allocation undefined | Resolved (turn order, allocated_i = min(need_i, remaining), Σ = A) | release_pot does not write it (MAJOR 2); Healthy threshold (MINOR 3) |
| MAJOR Paused has no on-chain source | Resolved (next_gate_short_by on Circle) | S_next projection (MAJOR 1); staleness unstated (MAJOR 3); D-only Paused (MINOR 1) |
| MAJOR top-up copy promises full return | Resolved (copy in J2 repair, J3, error rows) | none |
| MINOR forfeit vs booked loss | Resolved (min(shortfall, g + t)); weights only shrink, Σ usdc ≤ pool_left re-verified | none |
| MINOR defaulter's own top-up earns weight | Resolved (already_defaulted) | none |
| MINOR I14 / escrow term / D8 | Partly | I14 now double-counts D (MINOR 2); §7 and D8 correct |
| MINOR reproducibility (8 points) | Resolved (forfeited_total, stock_raw zeroed, touch script, Repricing branch, on-chain Paused, ATA at join, seed amounts, Completed state) | 7 new points (MINOR 4) |
| MINOR demo on the peak bound | Resolved (g = 35: peak 150 ≤ 175; with H = 132 needs are 128, 126, 0, 0) | none |
| MINOR dialog numbers | Partly (Paused variant labelled SPEC §7 and correct; J2 repair consistent) | J3 free figure stale for g = 35; J4 prices (MINOR 3) |
| MINOR free vs remaining; 3 missing rows; statechart note; max_price_age | Resolved (all 23 codes have rows; "remains" used; note rewritten; 8 days everywhere) | none |
| MINOR u128 mark, --max-len, stale judge view | Resolved | none |

## Checks that passed

- I3 held after every step in: SPEC §7 with top-up (withdraw [0, 18, 21, 18, 18], vault 0 at the end), two defaulters with a deficit and a 120 top-up (withdraw [0, 0, 7, 1, 1], 1 unit of dust), the r3 demo through default and split (withdraw [0, 26, 26, 26, 26] of 107, dust 3), the deficit-but-gate-passes case. The fill moves between fields, never out of the vault; pool_left = R − L + E equals the vault at Completed, so nothing is stranded but dust.
- Weights: Σ(g + t − f) = deposits_total − forfeited_total holds because top_ups and deposits_total both count the full amount; Σ usdc_i ≤ pool_left in every run; Σ weight > 0 at Completed (the last recipient cannot default). I11 holds since pool_left = deposits − fills − L.
- E + D = remaining defaulted obligations at all times (verified: 300 after two defaults of O = 150), so D = 0 ⇒ escrow covers every remaining round, Completed ⇒ D = E = 0, and D > 0 ⇒ R − L = 0.
- short_by = S − avail + D is exactly the top-up that makes the gate pass (fill first, remainder to R). Gate codes exhaustive and exclusive; coverage_too_low only when the recipient alone can fix it.
- Turn-order cap: A ≤ R − L by construction in update_coverage; the gate never uses the capped figure, so I1 is unaffected; reserve_free = 0 whenever Paused by reserve shortfall, consistent with the "remains" wording.
- Demo circle: H = 132 (FUND = EXEC = 165,000,000 base units before and after the split; multiplier 10e9 with share 15); join minimum 120 met; peak check 150 ≤ 175; round 0 need 128; default of m0 in round 1: sells all 1.1 → 132, shortfall 68, loss 68, E 200, D 0, not Paused (next need 63 ≤ 107), round 1 releases; after the split H unchanged. No demo step is refused by a rule, provided the split's Scheduled stamp is sent when no release_pot or update_coverage is needed before T (both refuse during Repricing).
- set_prices: expected_multiplier_fixed catches the Scheduled-before-UpdateMultiplier ordering mistake; a race across T lands as a refusal, never a wrong binding. No deadlock found.
- top_up_reserve refused for defaulted members; add_stock likewise. Withdraw order-independence unchanged (snapshot values).

## Vacuous assertions

1. I2 "Σ Member.allocated = Circle.reserve_allocated after every instruction, incl. declare_default during Repricing": false after release_pot and on the Repricing cap-bite path (MAJOR 2).
2. I18 "Paused ⇔ next_gate_short_by > 0" is a definition; the substantive claim (Paused ⇔ the gate would refuse) is false in both directions (MAJOR 1, MAJOR 3, MINOR 1).
3. I14 "top-ups ≥ deficit + the next gate's short_by": over-asks by D (MINOR 2).
4. §5 join_and_lock "so release_pot never has to" create the ATA: a member can close it (MINOR 4).
5. §5 declare_default "if the share price is fresh and not repricing, otherwise ...": freshness is one timestamp shared with the wrapper price, which the precondition already requires, so the "otherwise" branch is only Repricing; harmless but misleading.
6. §6 last line "UI shows Paused if the next payout's gate sum > available": superseded by next_gate_short_by (which also includes D); stale wording.
7. FLOWS row 7 precondition "recipient post-payout coverage ≥ target": still true by definition of G (carried from r2).

## Guarantees weakened relative to SPEC

- SPEC §3 "reserve_allocated = Σ Gᵢ": true only after update_coverage until release_pot writes Member.allocated (MAJOR 2).
- SPEC §7 "New payouts pause if the remaining guarantee reserve is insufficient": the on-chain flag is a last-recomputed snapshot that can lead (literal S_next, escrow-deficit-only) or lag (after add_stock or a price move) the gate (MAJOR 1, MAJOR 3, MINOR 1).
- SPEC §4 "losses shared pro rata": fills are shared through weights but the "Lost" figure (reserve_losses) understates the circle's total loss by Σ fills = deposits_total − reserve_total; the UI must label the difference or a judge will see Lost 150 and withdrawals summing to 0.
- SPEC §5 Healthy/Warning/Critical: reachable only when the cap bites, and the Healthy boundary is 125% in FLOWS and 130% in SYSTEM (MINOR 3).

## Deadline triage (Fri 25 Sep)

Block (a judge sees the wrong state in the 7-step demo or a stated invariant fails its own test):
- MAJOR 1: one sentence fixing S_next's O to c × (n − round − 1). Without it, whether the demo shows a false Paused banner depends on which builder reads the paragraph.
- MAJOR 2, release_pot half: one line so Member.allocated / last_coverage_bps are written at payout (the J2 success line and step 4's member table depend on it). The Repricing cap-bite half is a two-line loop; do it, it is the I2 test the design already lists.
- MAJOR 3 (a): state staleness, drop "not Paused" from FLOWS row 7 and "coverage recomputed" from row 11. Five minutes. (b) the closed-form top-up update removes the need for Member accounts and a fresh price in top_up_reserve; ten minutes.

Ship-with, stated in KNOWN-LIMITS or fixed if time allows:
- MINOR 1 (Paused wording with D only; round_not_funded short_by), MINOR 2 (I14 wording), MINOR 3 (FLOWS numbers, payload H_r, Healthy threshold), MINOR 4 (reproducibility lines).

## What could not be verified

- Whether Token-2022 `UpdateMultiplier` leaves `multiplier` at the old value after the effective timestamp (assumed, as r2; the pending-stamp rule and "Current after T" depend on effective = newMultiplier).
- CU for update_coverage's S_next (a second pass over 8 members) and for release_pot writing 8 Member accounts; gate 2 measures.
- NFR-4 (demo under 6 minutes): round 1's default needs 180 s of wall time plus the split's effective delay; not a design defect but tight.
- Whether the frontend's wallet-less simulation of release_pot is still used alongside next_gate_short_by (if so, the two can disagree in exactly the cases in MAJOR 3 and MINOR 1).
- Anything the r1 and r2 reviews listed as unverifiable (anchor/spl compatibility, deploy size, real xStock mint behaviour).

VERDICT: changes required
