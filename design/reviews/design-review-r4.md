# Othello design review, round 4 (adversarial, design-only)

Scope: SPEC.md v4, othello/SYSTEM.md (r4), othello/FLOWS.md (r4), reviews r1-r3. No code exists. "Confirmed" means the case was traced by hand and in a scratch model of the r4 rules exactly as written (join, contribute, release_pot with the option-B gate, per-member writes and the projected S_next, update_coverage with turn-order cap and projected S_next, §6 waterfall with both declare_default branches, closed-form top_up_reserve, §7 withdraw). The model kept I2 (A ≤ R − L and Σ allocated = A) and I3 (vault = R − L + E + held − W + dust) true after every step in 1,777 random circles (3-8 members, random prices 20-300, random defaults in both branches, random top-ups, 200 steps each; 1,746 completed, withdrawals never exceeded pool_left). The closed-form top-up matched a full recompute in 4,000 of 4,000 cases (3,617 of them Paused, 1,209 with an escrow deficit), and a top-up of exactly `next_gate_short_by` made the next gate pass every time.

Governing assumption applied: the r4 changes were attacked first, then every r3 finding re-checked (table at the end). Parameters are the r4 demo circle (n=5, c=50, g=35, R=175, cov 130%, warn 110%, haircut 20%, pool discount 20%, min_stock_cover 120, 1.1 token each at wrapper = share = 150, so H = 132 and conservative sale 120/token) unless stated.

---

## CRITICAL

None.

---

## MAJOR

None.

---

## MINOR

```
[MINOR] release_pot's per-member coverage write divides by O_i, which is 0 for every member in the gate sum at the final payout
SYSTEM.md:§5 release_pot effect ("last_coverage_bps_i = sat_u32((H_i + need_i)·1e4 / O_i)"), §4 Member.last_coverage_bps comment ("u32::MAX when O_i = 0"), §8 I10
What a user or judge sees: nothing in the 7-step demo (it stops before round 5). In the G2 scenario test the fifth release_pot panics (or, with checked_div, returns an error) and the circle never reaches Completed, so I10 fails and nobody can withdraw.
Why: at round n − 1 the gate sum uses O_i = c × (n − round − 1) = 0 for every received, non-defaulted member and the recipient; need_i = 0 and S = 0 so the gate passes, but the row's formula for last_coverage_bps has no O = 0 guard. The guard exists only as a comment on the field in §4 and inside update_coverage's row; a builder who writes release_pot from its own row divides by zero. The same expression at round n − 2 has O = c > 0 and is fine.
Reproduce: demo circle, rounds 0-3 released, m0 defaulted in round 1. Round 4: gate members m1..m4 (m0 excluded), O = 50 × (5 − 4 − 1) = 0 each, need 0, S = 0 ≤ 107. Write: (132 + 0) × 1e4 / 0.
Fix: in the release_pot row, write `last_coverage_bps_i = O_i > 0 ? sat_u32(...) : u32::MAX` (or name one shared helper `coverage_bps(H, G, O)` used by both rows and define it once in §4).
Confidence: confirmed
```

```
[MINOR] How the UI prints a coverage of u32::MAX is unspecified; demo step 3 shows coverage for five members who owe nothing
FLOWS.md:§8 Position success "Coverage now {pct}%", §4 [Position] "coverage", §5 row 8; SYSTEM.md:§4 last_coverage_bps ("u32::MAX when O_i = 0 or member is defaulted")
What a user or judge sees: in step 3 (before any payout, O = 0 for everyone) and on any defaulted or not-yet-received row, a literal rendering of the field prints "Coverage 42,949,672.95%" or "∞%" and the Healthy badge; a judge asks what it means.
Why: r4 fixed the on-chain value (saturating, MAX for O = 0 and for defaulted) but no FLOWS row or copy cell says what the sentinel renders as, and the Healthy/Warning/Critical rule in 2.5 ("coverage ≥ target") classifies MAX as Healthy. Two builders print two different things.
Reproduce: demo circle after activate, before round 0 release: every member has O = 0, last_coverage_bps = u32::MAX.
Fix: one line in FLOWS 2.5 or §8: "O = 0 (not yet received) renders 'Nothing owed yet'; defaulted renders 'Prepaid'; the Healthy/Warning/Critical badge is shown only when O > 0."
Confidence: plausible (a builder may well handle it; the document does not decide)
```

```
[MINOR] FLOWS residue: J3's r4 numbers do not follow from its own sentence, §3 J4 still says $1,000 → $100, and the Position success line contradicts row 11
FLOWS.md:§6 J3 ("Her stock sold for 112 USDC. The reserve covered 38 USDC ... Reserve free: 117 USDC" and "(next payout needs 20, not paused)"), §3 J4 ("sets share price $1,000→$100"), §8 Position success "Coverage now {pct}%", §5 row 11 ("coverage and Paused refresh on the next Update coverage")
What a user or judge sees: (1) a builder who uses J3 as a G3 fixture asserts 117 and 20 and gets 119 and 36. (2) The §3 journey text names a stock the demo circle never holds; §6 is correct (1.10 / 15 / 165 / 16.50). (3) After "Lock more stock" the Position toast says "Coverage now {pct}%" while the on-chain figure is stale by design (row 11), so the toast prints the pre-stock number.
Why: (1) with "sold for 112" the sale price is ≈101.8/token, so the survivors' H is 112 (not 111), loss is 38 (as written), R − L = 137, the other recipient's need at O = 100 is 18, free = 119; the next gate sums two members (that recipient plus the new one) at 18 each = 36. "117" came from r3's own approximation (loss 39, H 111) and was pasted rather than re-derived; "20" counts one member. (2) §3 was not updated with §6. (3) The success cell predates the r4 staleness rule.
Reproduce: model run: Kemi turn 1, rounds 0-1 released, price 127.28, m0/m2/m3/m4 pay round 2, declare_default(1): O 150, sold 112.006, loss 37.994, A 17.99, free 119.01, S_next 35.99, short 0.
Fix: J3: "Reserve free: 119 USDC" and "(next payout needs 36 of reserve, 137 remains, not paused)" (or drop the parenthetical numbers); §3 J4: "$150 → $15"; Position success after Lock more stock: "Stock locked. Update coverage to see the new figure" (or compute the preview client-side from quote_valuation and label it "preview").
Confidence: confirmed
```

```
[MINOR] Reproducibility residue: five points two builders would still resolve differently
SYSTEM.md:§5 release_pot, §5 declare_default Repricing branch, §5 top_up_reserve, §4 Member
What a user or judge sees: two implementations differ on a defaulted row's coverage during the split window, on a possible underflow, and on which round S_next is computed for after a payout.
Why: unstated, with the likely guess in brackets:
 1. "after paying, recomputes next_gate_short_by for the new round": with `round` already advanced (so the recipient in S_next is members[round + 1] and O = c × (n − round − 2) relative to the round just paid). Computing it before the increment reproduces the gate sum just checked, which is always ≤ avail and so never Paused. In the demo both give 0; after a price fall they differ. [after the increment; the model does this]
 2. Repricing branch of declare_default: `last_coverage_bps_d` is not set to u32::MAX (the non-Repricing branch gets it from "recompute exactly as update_coverage"); the defaulted row keeps its pre-default 130% Healthy until the next update_coverage. [set MAX and allocated_d = 0 in both branches]
 3. top_up_reserve's `v − D`: v ≥ D holds by construction (every writer of the field adds D or ΔD), but a builder should still use saturating_sub; the row does not say so. [saturating]
 4. release_pot's remaining_accounts: the validation stated on update_coverage (`.circle == circle`, `.turn == index`) plus `len == n` and the Anchor owner/discriminator check via `Account::<Member>::try_from` are not repeated on release_pot, which is the instruction that moves money. [same validation, len == n]
 5. Member.last_coverage_bps and allocated initial values at join (u32::MAX and 0), so a Position opened before the first update_coverage does not show 0% Critical. [MAX, 0]
Reproduce: n/a
Fix: one clause each in §5 (release_pot, declare_default, top_up_reserve) and §4 (join initial values).
Confidence: confirmed that the text is silent; plausible that it matters
```

---

## Attacks on the r4 changes (all passed unless listed above)

| r4 change | Attack | Result |
|---|---|---|
| S_next uses O_i = c × (n − round − 1) | False Paused after every healthy demo payout (r3 MAJOR 1); false Paused before round 0; Paused mid-round while a received member has not yet paid | After round 0: S_next = 63 + 63 = 126 ≤ 175 → 0. After round 1 with m0 defaulted (R − L = 107): 0 + 0 → 0. Before round 0: 128 ≤ 175 → 0. Mid-round unpaid member: included with the projected O, correct. Last round: O = 0, need 0, no division in S_next. **No false Paused in the demo, any round** (I18 clause holds). |
| release_pot writes allocated_i = need_i, last_coverage_bps | Σ allocated ≠ reserve_allocated; J2 "covered 130%" not printable; recipient's row after payout | Σ need_i = S = reserve_allocated by construction. Round 0: m0 allocated 128, (132 + 128)·1e4/200 = 13000 → "130%" printable; round 1: m1 63, (132 + 63)/150 = 130%. Others written 0. Division by zero only at the final round (MINOR 1). |
| init_if_needed on the recipient ATA, caller pays | Recipient closes ATA after joining; USDC is SPL Token (not 2022) so the ATA program path is standard | Caller pays ~0.002 SOL rent; acceptable for "anyone". No refusal path needed. CU cost of the CPI unverified (see below). |
| Repricing branch re-caps survivors in turn order | r3 MAJOR 2 case: rounds 0-1 released (alloc [63, 63]), wrapper 30 during Repricing, m0 misses round 2 | O 150, sells 1.1 → 26.4, loss 123.6, R − L = 51.4; alloc → [0, 51.4, 0, 0, 0], A = 51.4 = Σ. I2 holds. `short` stays 0 (approximate, stated); after prices return and update_coverage runs, true short is 0 (m1's O is 100 → need 0). |
| top_up_reserve closed form | Compared with a full recompute after the top-up, across D > 0 and D = 0, amount < D, = D, > D, amount = short_by | Identical in 4,000 of 4,000 cases. Algebraically: for v ≥ D the field becomes max(0, v − amount) in every case, i.e. each top-up unit reduces the short by one. A top-up of exactly short_by always let the next funded round release. |
| Paused staleness stated; Release pot never disabled | r3 MAJOR 3 case: price 100, update_coverage → short 39; m1 add_stock(2) makes the gate pass while the field reads 39 | Field stays 39 (stated as of last check), button enabled, program pays and rewrites the field to 0. Safe. The opposite direction (price fall, field 0, gate refuses) shows no banner until the refusal, which names the numbers. Stated in §5 and FLOWS 2.5/row 7/row 11. |
| Payloads: recipient_cover, round_not_funded.short_by | coverage_too_low copy needs H_r and min; escrow-short copy needs the whole cure | Both printable from the payload plus Circle.min_stock_cover. round_not_funded.short_by is the stale field, stated. |
| last_coverage_bps saturating, MAX for defaulted | H = 1e6 USDC vs O = 50 | Saturates; no panic. Rendering unspecified (MINOR 2). |
| update_coverage refused at Completed | Split lab "Recheck" after the circle completes | Refused `circle_not_active`; FLOWS row 8 precondition "circle Active" agrees. The demo never completes, so no judge sees it. |
| FLOWS numbers | 117 free; split lab 1.10 / 15 / 165 / 16.50; Healthy ≥ target | Split lab correct: FUND = 1.1 × 10 × 15 = 165, EXEC = 1.1 × 150 = 165, H = 132 before and after; naive raw × share = 16.50. Healthy/Warning/Critical now tied to coverage_bps/warn_bps; 130% is Healthy. J3's 117/20 do not follow from its own sentence (MINOR 3). |
| I14, I18 wording | I14 double-count; I18 "no Paused after a healthy payout" | I14 now asks for exactly next_gate_short_by (which includes D): two-defaulter case D 110, S 10, avail 0 → 120, and 120 completes the circle in the model. I18 holds in the demo every round (table row 1). |

**SPEC §7 halt example (G3 test):** g = 30, H = 120, round 0 released, m0 misses round 1: O 200, sold 120, loss 80, R − L = 70, E 200, D 0. release_pot(round 1) → `reserve_overcommitted{needed 75, remaining 70, short_by 5, recipient_gap 75, others_need 0, escrow_deficit 0, recipient_cover 120}`; m1 tops up 5 → field 0 → release pays. Matches the FLOWS Paused variant word for word.

**Seven-step demo, the numbers a judge sees (model, r4 rules):**

| Step | On screen | Value |
|---|---|---|
| 3 | raw / multiplier / prices / H per member | 1.10 / 1.0 / 150, 150 / 132 (≥ 120 minimum); coverage: O = 0 (render per MINOR 2) |
| 4 | round 0 released to m0; Guarantee panel | pot 250; allocated 128, free 47, lost 0; m0 owes 200 over 4 rounds, coverage 130% |
| 5 | m0 misses round 1; default declared after 180 s | O 200, sold 132 (all 1.1), shortfall 68, reserve loss 68 (35 of it m0's own deposit), escrow 200, deficit 0 |
| 6 | recompute capacity | R − L 107, allocated 0, free 107, next gate needs 63 → not Paused; round 1 releases to m1 (allocated 63, free 44, escrow 150) |
| 7 | split (newMultiplier 10, share 15, Scheduled stamp) | H 132 before and after; split lab 165 vs 16.50; Repricing between the stamp and T (release/update refuse, default still works) |

No number in this table is wrong under the r4 rules, and no step is refused by a rule provided the Scheduled stamp is sent when no release_pot or update_coverage is needed before T.

---

## r3 findings resolved / not resolved

| r3 finding | Status | Residual |
|---|---|---|
| MAJOR 1 S_next from stored rounds_paid (false Paused after every payout) | Resolved (O_i = c × (n − round − 1), "never stored rounds_paid"; I18 gained the "no Paused after a healthy payout" clause) | Which `round` release_pot uses after the increment is implied, not stated (MINOR 4.1) |
| MAJOR 2 Σ Member.allocated ≠ reserve_allocated after release_pot / Repricing cap-bite | Resolved (release_pot writes allocated_i = need_i and last_coverage_bps; Repricing branch re-caps survivors in turn order; both verified in the model, I2 held in every fuzz run) | last_coverage_bps division by zero at the final round (MINOR 1); defaulted row's coverage in the Repricing branch (MINOR 4.2) |
| MAJOR 3 next_gate_short_by stale after add_stock / set_prices; top_up recompute needs inputs it lacks; FLOWS disables Release pot | Resolved (staleness stated in §5 and FLOWS 2.5 / row 7 / row 11; closed-form top-up verified exact for unchanged prices; Repricing branch marked approximate) | Position success toast still says "Coverage now {pct}%" after Lock more stock (MINOR 3) |
| MINOR 1 Paused with deficit only; escrow-short copy under-asks | Resolved (2.5 wording; reserve banner falls back to escrow-short wording when needed = 0; round_not_funded carries short_by) | none |
| MINOR 2 I14 double-counts D | Resolved | none |
| MINOR 3 FLOWS numbers (117, split lab, payload H_r, Healthy 125%) | Partly | J3's 117 was adopted but does not follow from "covered 38 / sold 112" (119, and next need is 36 not 20); §3 J4 still $1,000 → $100 (MINOR 3) |
| MINOR 4 reproducibility (7 points) | Resolved (1 MAX for defaulted; 2 saturating; 3 init_if_needed; 4 Completed rules; 5 UI computes fills; 6 validation on update_coverage; 7 Friday touch) | Point 6 not repeated on release_pot (MINOR 4.4) |

## Checks that passed

- I3 held after every instruction in 1,777 random circles, including defaults in both branches, deficits, top-ups that fill deficits, and price moves. At Completed, pool_left = R − L + E equalled the vault minus dust, and Σ withdrawals ≤ pool_left in every run (demo: [0, 26.75, 26.75, 26.75, 26.75] of 107).
- I2 (A ≤ R − L, Σ allocated = A) held after every instruction, including the r3 cap-bite case.
- Closed-form top_up_reserve is exact (4,000 cases) and a top-up of exactly short_by cures the next funded round every time.
- E + D = remaining defaulted obligations throughout; Completed ⇒ D = E = 0 (a deficit refuses the last round as round_not_funded, so no circle completes with money owed).
- Gate codes exhaustive and exclusive; coverage_too_low only when the recipient alone can fix it.
- Demo circle: peak 150 ≤ 175; round 0 need 128 (47 of slack); no Paused in any round; H = 132 across the split; SPEC §7 example reproduces with g = 30.
- set_prices / touch_prices rules unchanged from r3 and still deadlock-free on the demo timeline.

## Vacuous assertions

1. I1 "release_pot succeeds iff Σ need_i ≤ R − L": still ignores the other preconditions (funded, escrow ≥ k×c, fresh, not repricing); harmless, carried from r3.
2. I18 "Paused ⇔ next_gate_short_by > 0" is a definition; the substantive clause is now the third one ("no Paused after a healthy payout, demo circle, every round"), which holds.
3. §6 last line "UI shows Paused if the next payout's gate sum > available": stale wording (superseded by next_gate_short_by, which also includes D); cosmetic.
4. FLOWS statechart "Active → Paused: pay out refused": a refused release_pot mutates nothing; the on-chain flag is raised by update_coverage / release_pot / declare_default / top_up. The note under the chart says so; cosmetic.

## Guarantees weakened relative to SPEC (all stated, none new in r4)

- SPEC §7 "new payouts pause if the reserve is insufficient": the on-chain flag is a snapshot as of the last check; add_stock and price changes do not refresh it (stated in §5 and FLOWS).
- SPEC §5 coverage-based default: cut (accepted limit).
- SPEC §4 "losses shared pro rata": the Guarantee panel's Lost (reserve_losses) understates the circle's loss by Σ fills = deposits_total − reserve_total; SYSTEM says the UI computes "used to prefund defaults", FLOWS §8 has no copy cell for it (add one line: "Used to prefund defaults: {deposits_total − reserve_total}").
- SPEC §3 "reserve_allocated = Σ Gᵢ": now true after every instruction (r4).

## Deadline triage (Fri 25 Sep)

Nothing blocks. Before gate 2, ten minutes of edits:
- MINOR 1: the O = 0 guard in release_pot's row (or a single named helper). The G2 I10 test catches a miss, but writing it now saves a Codex round.
- MINOR 4.1-4.5: five clauses.

Before gate 4:
- MINOR 2: one rendering rule for coverage when O = 0 / defaulted.
- MINOR 3: J3 numbers (119 / 36 / 137, or drop them), §3 J4 prices, Position success toast; add the "used to prefund defaults" copy cell.

## What could not be verified

- CU for release_pot now that it writes n Member accounts, parses the mint TLV and may CPI to create an ATA; the ≤ 60k assumption predates the ATA path. Gate 2 measures.
- Whether Token-2022 `UpdateMultiplier` leaves `multiplier` at the old value after the effective timestamp (assumed since r2).
- anchor 1.1.x + spl-token-2022-interface 2.1.0 compatibility; deploy size vs devnet SOL.
- NFR-4 (demo under 6 minutes) with the default's 180 s plus the split's effective delay inside one round.
- Whether the frontend's wallet-less simulation of release_pot is still used next to next_gate_short_by (the two can disagree only in the stated stale cases).

VERDICT: implementation-ready
