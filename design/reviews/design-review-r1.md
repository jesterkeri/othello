# Othello design review, round 1 (adversarial, design-only)

Scope: SPEC.md v4, othello/design/SYSTEM.md, othello/design/FLOWS.md. No code exists; nothing was executed on-chain. "Confirmed" means the case was traced by hand (and with a scratch script) through the written rules. Paths are abbreviated: `SPEC`, `SYSTEM`, `FLOWS`.

Severity: CRITICAL = loss of funds, broken guarantee, or a wrong result a judge acts on. MAJOR = wrong behaviour on a reachable path, or a load-bearing builder guess. MINOR = hygiene.

Findings are ordered CRITICAL, MAJOR, MINOR. Claim numbers (C1..C12) from the brief are referenced in each block.

---

## CRITICAL

```
[CRITICAL] Escrow deficit is a permanent stuck state: top-ups cannot reach escrow, so the circle can never fund a later round, never Completes, and nobody can withdraw
SYSTEM.md:§6 (waterfall, "If shortfall > loss ... cannot complete without top-ups"), §5 release_pot precondition "(defaulted AND escrow >= c)", §5 top_up_reserve, §7 withdraw
What a user or judge sees: after one bad default the circle sits at "round_not_funded" forever. Every member's locked stock, every guarantee, every top-up and the current round's held contributions are unrecoverable. The UI says "Payouts paused ... top up", members top up, and nothing changes.
Why: loss = min(shortfall, reserve_total - reserve_losses). When the shortfall exceeds the whole remaining reserve, escrow = recovered + loss < O, i.e. escrow is short by (shortfall - loss). SYSTEM says "the circle cannot complete without top-ups", but top_up_reserve only does reserve_total += amount. No instruction ever moves reserve USDC into escrow, and release_pot demands escrow >= c for each defaulted seat. Once escrow < c, release_pot refuses forever; declare_default refuses (already_defaulted); cancel_circle needs Forming; withdraw needs Completed or Cancelled. No exit exists. (C3, C5, "stuck-funds state" check)
Reproduce: n=5, c=50, g=30 (R=150), haircut 20%, pool discount 20%. Round 0: m0 receives 250 (O_0=200, H=120, need=140 <= 150, passes). Price crashes so min(FUND,EXEC)=25 per holding (H=20, conservative sale value 20). m0 misses round 1. declare_default(0): O=200, sell all, recovered=20, shortfall=180, loss=min(180,150)=150, reserve_total-losses=0, escrow=20+150=170. Rounds 1..4 need 4 x 50 = 200 from escrow. Round 4: escrow=20 < 50 -> round_not_funded. No instruction can raise escrow. Circle bricked with m1..m4's stock, 150+ USDC of guarantees/top-ups and 200 USDC of held contributions inside.
Fix (minimal): in release_pot, for a defaulted seat with escrow < c, take the difference from the reserve as an additional loss (reserve_losses += c - escrow; escrow = 0 for that seat) provided the gate still passes with the reduced reserve; this makes top_up_reserve an actual cure. Alternative: record escrow_deficit at default and have top_up_reserve fill it first. Update I3 accordingly. Add a test: "default with shortfall > reserve, then top up, circle completes".
Confidence: confirmed
```

```
[CRITICAL] declare_default and update_coverage have no defined behaviour when Sum(need_i) > reserve_total - reserve_losses; the two obvious implementations both brick the circle
SYSTEM.md:§5 update_coverage ("recompute ... allocated for all"), §5 declare_default ("recompute allocations"), §6 last line, §8 I2 ("assertion in every mutating ix"), §4 reserve_free formula
What a user or judge sees: either (a) "Declare default" fails with an assertion error exactly in the scenario the product exists for, so the defaulter is never defaulted and the round never funds, or (b) the default succeeds, reserve_allocated exceeds the reserve, and every later instruction that computes reserve_free = reserve_total - reserve_losses - reserve_allocated underflows (checked arithmetic -> error) so update_coverage and release_pot fail forever. Both are permanent lock-ups.
Why: the loss booked by a default can exceed reserve_free and eat into other members' allocations (loss is capped at reserve_total - reserve_losses, not at reserve_free). Prices can also fall between payouts. In both cases Sum(need_i) over received non-defaulted members exceeds what is left. SYSTEM says allocations are recomputed from scratch in every mutating instruction and that I2 is asserted in every mutating instruction. Recompute-then-assert reverts; recompute-without-assert makes reserve_free negative. The design never says "cap" or "refuse". This is the same root as SPEC §3's "reject if the reserve would be overcommitted", which is only meaningful inside the payout gate, not in declare_default. (C1, C3)
Reproduce: n=5, c=50, g=30 (R=150), cov 130%, haircut 20%, discount 20%, each holding worth 150 (H=120). Round 0: m0 receives, need=140. Round 1: m1 receives, needs 75+75=150 <= 150 passes. Round 2: price falls so min(FUND,EXEC)=50 (H=40, conservative value 40). m0 misses; m1..m4 pay. declare_default(0): O_0=50x3=150, recovered=40, shortfall=110, loss=110, reserve_total-losses=40, escrow=150. Recompute: m1 received, rounds_paid=3, O_1=100, need_1=ceil(130)-40=90. Sum need = 90 > 40. Branch (a): assertion I2 fails, tx reverts, m0 can never be defaulted, round 2 never funds. Branch (b): reserve_allocated=90, reserve_free = 150-110-90 underflows.
Fix (minimal): outside release_pot, store reserve_allocated = min(Sum need_i, reserve_total - reserve_losses) and keep the uncapped Sum need_i only as an event/return value ("reserve_short_by"). release_pot compares the uncapped sum against reserve_total - reserve_losses (that is the gate). I2 then holds by construction and the design must say that "allocated" after a loss is a capped figure. Add the case above as a G3 test.
Confidence: confirmed
```

---

## MAJOR

```
[MAJOR] Payout gate step 3 and step 4 are the same inequality: reserve_overcommitted is unreachable, so "Paused" never appears and the SPEC §7 halt example is reported as the honest recipient's coverage problem
SYSTEM.md:§5 "Payout gate" steps 3-4; FLOWS.md:§7 statechart "Active -> Paused: pay out refused [reserve short]", §8 rows coverage_too_low / reserve_overcommitted; SYSTEM.md:§12 G3 done-criterion
What a user or judge sees: in the demo's step 6 (default -> recompute capacity) the payout is refused with "Can't pay out yet. {next recipient} would be covered 127%, the circle needs 130%. Add collateral or top up reserve", blaming the honest next recipient. The "Payouts paused. The next payout needs 75 USDC of reserve, 70 is free" banner, the Paused state and the Default place's "Payouts resumed" success never render. SPEC §7's required wording ("New payouts pause if the remaining guarantee reserve is insufficient") is not produced by the program.
Why: step 3 is need_r > (R - L) - (new_allocated - need_r). Add need_r to both sides: new_allocated > R - L, which is exactly step 4. Whichever branch is first wins; step 4 is dead. Verified on 10,000 random (R, needs) tuples: the two predicates never differ. The "both or neither" question in C1 is answered: they are always both true or both false. (C1, C4)
Reproduce: SPEC §7 numbers through SYSTEM §6: R=150, m0 defaults in round 1 with O=200, recovered 120, loss 80, R-L=70, escrow 200. Round 1 release_pot: received non-defaulted = {m1}, O_1=150, need_1=195-120=75, new_allocated=75. Step 3: 75 > 70 - 0 -> coverage_too_low{needed:75, free:70}. Step 4 never evaluated.
Fix (minimal): make the split about cause, not the same sum twice. Option A (one code): replace both with reserve_short{needed: Sum need, free: R-L, recipient_gap: need_r} and let the UI word it (Paused banner when reserve_losses > 0 or the round is funded). Option B (keep two codes, well defined): coverage_too_low iff H_r < min_stock_cover (the recipient's own stock fell below the join minimum: "lock more stock"); otherwise reserve_overcommitted ("top up"). Under B the halt example yields reserve_overcommitted and Paused, and the J2 repair (Tunde at 88%) still yields coverage_too_low if his H is below the minimum. Update G3's done-criterion to name the code.
Confidence: confirmed
```

```
[MAJOR] Withdraw formula and invariant I3 contradict each other; a builder must break one, and the natural choice makes payouts order-dependent
SYSTEM.md:§7 withdraw, §8 I3 ("usdc vault balance = reserve_total - reserve_losses + escrow + held_contributions (+ dust), test after every ix")
What a user or judge sees: either the last withdrawers receive less than the first (5 equal members with R=150 and no losses get 30, 24, 19, 15, 12 instead of 30 each, 50 USDC stranded as "dust"), or the I3 scenario test fails on the first withdraw and gets deleted or weakened.
Why: I3 must hold "after every ix". After a withdraw the vault shrinks, so to keep I3 the builder decrements reserve_total (and escrow). But share_i = floor(pool_left x (g_i+t_i) / Sum(g+t)) reads reserve_total for pool_left while Sum(g+t) is read from the Member accounts (unchanged), so every later share is computed against a shrunken numerator and the original denominator. If the builder instead leaves reserve_total alone, shares are correct but I3 is false after the first withdraw. (C8)
Reproduce: n=5, g=30, R=150, L=0, E=0, Completed. Decrementing implementation (reserve_total falls 150 -> 120 -> 96 -> 77 -> 62): m0 gets 150x30/150=30, m1 120x30/150=24, m2 96x30/150=19, m3 77x30/150=15, m4 62x30/150=12; total 100, 50 stranded. Non-decrementing implementation: all 30, but vault=120 while I3 RHS=150.
Fix (minimal): add Circle.withdrawn_usdc (and withdrawn_stock if wanted). I3 becomes vault = reserve_total - reserve_losses + escrow + held_contributions - withdrawn_usdc. share_i is computed from the immutable snapshot (reserve_total, reserve_losses, escrow), never from the decremented running balance. State that withdraw does not touch reserve_total.
Confidence: confirmed
```

```
[MAJOR] A defaulted member is refunded a pro-rata share of the reserve their own default consumed; honest members subsidise the defaulter
SYSTEM.md:§7 withdraw ("share_i = floor(pool_left x (guarantee_i + top_ups_i) / Sum)"), §6 waterfall (loss booked against the shared reserve only); SPEC.md:§4 "losses shared pro rata", §6 "Seize only what is owed"
What a user or judge sees: in the SPEC §7 example (R=150, m0 defaults, loss 80) every member including m0 gets 70x30/150 = 14 USDC back. m0, who caused the 80 loss, recovers 14 of their 30 guarantee; each honest member also loses 16. A judge who asks "so the defaulter gets their guarantee back?" gets "yes, part of it".
Why: the waterfall charges the shortfall to the pooled reserve without first exhausting the defaulter's own guarantee and top-ups. SPEC §4's "losses shared pro rata" was written for losses caused by others; SPEC §6's "seize only what is owed" lists "obligation, defined liquidation costs, any agreed penalty", and the defaulter's own guarantee is the first thing that is owed. The design as written makes an honest member's expected loss strictly higher than necessary and the defaulter's strictly lower. (C8)
Reproduce: as above. Correct: m0's 30 absorbs first, remaining 50 loss shared by four -> honest members get 17.5 each, m0 gets 0.
Fix (minimal): in declare_default, forfeit = min(loss, guarantee_d + top_ups_d); store Member.forfeited += forfeit. In withdraw, weight_i = guarantee_i + top_ups_i - forfeited_i and denominator = Sum weights. pool_left is unchanged (R - L + escrow_left), so Sum shares <= pool_left still holds and I11 is unaffected. Update FLOWS Join helper "Most you could lose: {g} USDC, only if others default" (still true) and the Default place copy.
Confidence: confirmed
```

```
[MAJOR] release_pot does not say how the next round's deadline is set; one plausible choice lets anyone default honest members for a round that opened already overdue
SYSTEM.md:§5 release_pot effect ("next round or Completed"), activate ("deadline = now + round_secs"); FLOWS.md:§5 row 7 ("next round opens")
What a user or judge sees: a funded round sits unreleased (nobody called release_pot; there is no keeper). Someone later calls release_pot and declare_default back to back; members who never had a chance to contribute to the new round are liquidated.
Why: activate specifies deadline = now + round_secs. release_pot specifies nothing. A builder keeping "rounds are on a fixed schedule" will write round_deadline += round_secs; with pull-based transitions that opens a round whose deadline + grace may already be in the past. Since release_pot and declare_default are anyone-callable, this is a griefing path with no cost to the attacker. (C9, griefing check)
Reproduce: round_secs=120, grace=60. Round 1 funded at t=0 (deadline was t=100). Nobody releases until t=400. Builder A: new deadline = 100+120 = 220; at t=400, 400 > 220+60, so declare_default(any received member) succeeds in the same bundle as release_pot. Builder B: new deadline = 400+120 = 520; safe.
Fix (minimal): state in §5: release_pot sets round_deadline = clock.now + round_secs, paid_bitmap = 0, held_contributions = 0. Add to I7: "a seat cannot be defaulted less than round_secs + grace after the round opened".
Confidence: confirmed (ambiguity); griefing path confirmed under choice A
```

```
[MAJOR] Contributions are refused after deadline + grace, so a late-but-willing payer has no cure, and a late pre-payout member locks the circle forever
SYSTEM.md:§5 contribute precondition "now <= deadline + grace", declare_default "received(turn)" / pre_payout_default_unsupported; FLOWS.md:§7 statechart "Overdue -> RoundOpen: late contribution before grace ends"
What a user or judge sees: (1) a received member who is one second past grace cannot pay even though nobody has declared a default; they sit in limbo until someone liquidates them, with no action available. (2) A member who has not received yet misses grace: contribute is refused, declare_default is refused (pre_payout_default_unsupported), the round can never reach "every seat paid", release_pot refuses forever, cancel is Forming-only, withdraw needs Completed. Permanent lock-up of all funds with zero economic reason.
Why: the deadline check on contribute serves no economic purpose in a pull-based design: declare_default already requires the seat to be unpaid, so a late contribution that lands before a default is simply a cure. The accepted limit "pre-payout default unsupported" is fine as a statement; SYSTEM's contribute deadline turns "unsupported" into "unrecoverable". (C9; the accepted limit's consequence, not the limit itself)
Reproduce: n=3, round 0 funded and paid to m0. Round 1: m2 (not yet received) is 61 s late with grace 60. contribute -> refused (now > deadline+grace). declare_default(2) -> pre_payout_default_unsupported. release_pot -> round_not_funded. Forever.
Fix (minimal): drop "now <= deadline + grace" from contribute (keep "Active, bit unpaid, not defaulted"). The Overdue state then reads "late contribution accepted until a default is declared". No race is created: contribute requires the seat unpaid and not defaulted; declare_default requires the seat unpaid; whichever lands first wins and the other refuses cleanly. Record the pre-payout lock-up in KNOWN-LIMITS if the deadline is kept.
Confidence: confirmed
```

```
[MAJOR] No exit from Active: a circle whose gate cannot pass and that nobody tops up holds everyone's funds forever, and the design does not state this as a limit
SYSTEM.md:§5 (only cancel_circle in Forming, withdraw in Completed/Cancelled), §6 ("the circle cannot complete without top-ups"); FLOWS.md:§7 "Every state has an exit"; SPEC.md:§7
What a user or judge sees: "Payouts paused ... Any member can top up 33 USDC to resume" and nobody does. Held contributions of the funded round, all guarantees and all stock are locked with no dissolve path. FLOWS' claim "every state has an exit" is true for the UI statechart but not for funds.
Why: Paused exits only via a successful release_pot. There is no unanimous-dissolve, no timeout-dissolve, no creator abort after activation. On devnet this is acceptable only if written down; today the design says the opposite ("Every state has an exit", "Rollback: none that matters on devnet"). Also reachable without any default: guarantee_per_member is a free create parameter with no check against the schedule's peak need, so a circle can activate, fund round 0 and never be able to pay it out. (stuck-funds check)
Reproduce: n=5, c=50, g=10 (R=50), H=120, cov 130%. Round 0 funded; need_0 = 140 > 50; refused; nobody tops up 90; held_contributions=250 locked.
Fix (minimal): (a) add to KNOWN-LIMITS: "An Active circle that cannot pass the gate and is not topped up never completes; funds stay locked (no dissolve in Tier 1)". (b) Cheap guard at create_circle: refuse invalid_params unless n x guarantee_per_member >= peak need computed from (n, contribution, coverage_bps, min_stock_cover) over the schedule (the SPEC §3 table computed on-chain, 8 iterations). (c) If time allows: `dissolve` callable when all non-defaulted members sign or after round_deadline + K x round_secs, which refunds held_contributions and moves to Completed.
Confidence: confirmed
```

```
[MAJOR] The oracle epoch match requires an off-chain script to reproduce the program's exact fixed-point decode; a one-unit disagreement is a permanent Repricing deadlock
SYSTEM.md:§4 PriceFeed.priced_for_multiplier ("fixed 1e9; D5"), §5 set_prices; FLOWS.md:D5; SPEC.md:Implementation note 1 (float x SCALE differs from exact decode, e.g. 1.0000003)
What a user or judge sees: after the split, the admin sets priced_for = 10 000 000 000 and the mint reports the same, fine. For the dividend rebase (1.0032690125398187) the admin script computes 1003269012 or 1003269013 depending on whether it used float multiply; if it differs by one from the program's exact decode, every payout, join, quote and update_coverage refuses multiplier_price_mismatch until the admin guesses the right integer. Nothing on-chain can resolve it.
Why: D5 compares two u64s for exact equality, one produced by the program's IEEE-754 decode and one typed in by a script. SPEC itself documents that the naive script computation is off by one in real cases. The design never says the admin script must use the same decoder, and set_prices does not read the mint. (C6)
Reproduce: mint multiplier bits for 1.0000003 -> program mult_fixed 1000000299; JS script `Math.floor(1.0000003 * 1e9)` -> 1000000300. Mismatch forever.
Fix (minimal): let set_prices read the mint and stamp priced_for_multiplier itself from the effective multiplier at that moment (admin passes only prices; the program binds them to whatever is effective now). For the "price set ahead of a scheduled split" demo, add an optional `priced_for_new: bool` that stamps the scheduled new_multiplier instead. Alternatively store the raw PodF64 bits (u64) and compare bits, which any script can copy from the account verbatim.
Confidence: confirmed (ambiguity) / plausible (that the script will use float)
```

```
[MAJOR] Escrow sufficiency is written per seat ("escrow >= c"), not cumulatively; with two defaulted seats it over-releases and underflows
SYSTEM.md:§5 release_pot precondition "for every seat: paid bit OR (defaulted AND escrow >= c)", effect "escrow pays defaulted seats"
What a user or judge sees: two defaulters, escrow = 1.5c. Each seat passes "escrow >= c" independently; the pot n x c is paid; escrow -= 2c underflows (checked math: the instruction errors forever; unchecked: I3 breaks and the vault is drained below its accounting). Either way the round can never be released.
Why: escrow is one pooled u64 for all defaulters, but the precondition is phrased per seat. The design also does not say whether rounds_paid advances for escrow-paid members (Member.rounds_paid's comment says "including escrow-paid", the release_pot row does not), which changes O_d for a defaulted member and whether all 8 Member accounts must be writable in release_pot. (C5, C10)
Reproduce: n=5, c=50, m0 and m1 both defaulted, escrow=75. Seat check passes twice. Pot 250 paid from held 150 + 75 escrow = 225 < 250 -> vault short by 25, or escrow underflow.
Fix (minimal): precondition "escrow >= k x c where k = popcount(defaulted_bitmap & ~paid_bitmap)"; effect "escrow -= k x c; for each such seat rounds_paid += 1 and paid bit set". State that release_pot takes all n Member accounts as writable remaining_accounts.
Confidence: confirmed
```

```
[MAJOR] SPEC §5's coverage-based default ("Critical past the cure window") does not exist in SYSTEM; FLOWS D5 and invariant I13 describe refusals of an instruction that was never designed
SPEC.md:§5 ("Default on missed contribution or critical past the cure window"); SYSTEM.md:§5 declare_default (only "seat unpaid"), §8 I13 ("payout and coverage refuse"); FLOWS.md:D5 ("coverage-based defaults refuse ... Executable value alone is never used to declare a coverage default"), §6 J4 repair
What a user or judge sees: a member whose coverage is Critical for weeks keeps paying and is never touched; the Critical badge has no consequence. FLOWS' "coverage defaults wait during Repricing" is a promise about nothing. If a judge asks "what happens when coverage is critical", the honest answer is "nothing until they miss a payment", which is weaker than SPEC §5.
Why: SYSTEM's only default trigger is a missed contribution. There is no cure window, no coverage threshold in declare_default, and no instruction that seizes collateral while it still covers the obligation. The three documents disagree, and I13's "coverage refuse" can only mean update_coverage refuses, which is true but not what D5 says. (C6, vacuous-assertion check, guarantees weakened)
Reproduce: n/a (absence). Member m0 received, H falls to 10% of O, keeps paying: no path to liquidation.
Fix (minimal): either cut it explicitly (add "coverage-based default" to FLOWS no-gos and SYSTEM non-goals, reword D5 and I13 to "update_coverage and release_pot refuse; declare_default still works") or specify it: declare_default(turn, reason=Coverage) allowed when last_coverage_bps < warn_bps... for cure_secs, requires fresh + matching price. Given the deadline, cut and state.
Confidence: confirmed
```

```
[MAJOR] Reproducibility: eleven load-bearing points two builders would resolve differently
SYSTEM.md:§4-§7
What a user or judge sees: two implementations of "the same" design differ on who gets defaulted, how much is withdrawn, and whether a default can be declared.
Why: the following are unstated. Likely guess in brackets. (C10)
 1. Next-round deadline after release_pot (see finding above). [deadline += round_secs, wrong]
 2. What update_coverage / declare_default do when Sum need > R - L (see CRITICAL 2). [assert I2 and revert]
 3. escrow check per seat vs cumulative; whether release_pot writes rounds_paid for escrow-paid members; whether all n Member accounts are remaining_accounts of release_pot and declare_default (recompute needs them). [per seat; not advanced; yes]
 4. Whether withdraw decrements reserve_total / escrow (see MAJOR above). [yes, breaks shares]
 5. `free` and `needed` in the two gate refusal codes: free-after-others vs reserve_free-before; needed = need_r vs Sum need vs the gap. [inconsistent between codes]
 6. Member.allocated and last_coverage_bps for a defaulted member and for a member with O_i = 0 (division by zero for coverage ratio). [0 / panic]
 7. Price freshness boundary: now - updated_at <= max_price_age or <. [<=]
 8. How join_and_lock learns `turn` (argument vs scan of members[]). [argument, trusted]
 9. Whether declare_default reverts when pool_usdc_vault < recovered, or caps recovered at the pool balance (raising the loss). [revert; default undeclarable until re-seeded]
 10. Parameter ranges behind invalid_params: coverage_bps >= 10000? warn_bps < coverage_bps? haircut_bps < 10000? pool.discount_bps <= haircut_bps? wrapper_price > 0? [none checked]
 11. What paid_bitmap / held_contributions / reserve_allocated look like at Completed and whether Member accounts are closed for rent. [not reset; not closed]
Reproduce: n/a
Fix (minimal): one line each in §5/§7 resolving the eleven points; most are already decided by the findings above.
Confidence: confirmed
```

---

## MINOR

```
[MINOR] "Recovered above O is impossible by construction" is false by up to one raw unit's value; the design then contradicts itself with "recovered_capped_at_O"
SYSTEM.md:§6 (sell_raw = ceil(...), recovered = floor(...), "Recovered above O is impossible by construction")
What a user or judge sees: nothing visible; a unit test written from the sentence fails.
Why: sell_raw = ceil(O x 1e8 / conservative) makes sell_raw x conservative / 1e8 >= O, so recovered = floor(...) is in [O, O + conservative/1e8). With wrapper 150 USDC (1.5e8 base per whole token) that is up to 1 USDC base unit above O; I9 already admits "+ one raw unit". (C3)
Reproduce: O=100, conservative=3 (base units per whole token, degenerate but legal): sell_raw = ceil(1e10/3) = 3333333334, recovered = floor(3333333334 x 3 / 1e8) = 100. Larger conservative/1e8 ratios give O+1.
Fix: delete the sentence; keep "recovered is capped at O when funding escrow; any excess is dust (I3)".
Confidence: confirmed
```

```
[MINOR] escrow_left at Completed is always zero, so "escrow_left returns to the reserve pot" is vacuous
SYSTEM.md:§7 withdraw; FLOWS.md:D8, §5 row 12 "escrow remainder"
What a user or judge sees: a withdraw line item that is always 0.
Why: escrow = min(recovered, O) + loss where loss = min(O - recovered, R - L). If loss = O - recovered, escrow = O exactly and O is exactly the sum of the remaining contributions the escrow must pay. If loss < O - recovered, escrow < O and the circle never Completes (CRITICAL 1). Neither branch leaves a positive remainder. (C8, vacuous check)
Reproduce: SPEC §7: escrow = 120 + 80 = 200 = 4 x 50. After round 4, escrow_left = 0.
Fix: remove the term, or keep it only if the escrow-deficit fix routes reserve top-ups through escrow (then a remainder can exist).
Confidence: confirmed
```

```
[MINOR] Invariant I1 is tautological given how G is computed; it cannot fail if the formula is typed correctly and does not test the gate
SYSTEM.md:§8 I1 ("after every successful release_pot, every received non-defaulted member has (H+G).1e4 >= O.coverage_bps"), §4 need_i, §5 gate step 5
What a user or judge sees: a green property test that would stay green with the gate deleted.
Why: G_i is set to need_i = max(0, ceil(O_i x cov / 1e4) - H_i), so H_i + G_i >= ceil(O_i x cov / 1e4) by definition, regardless of whether the reserve exists. The economic content is entirely in I2 (Sum G <= R - L) plus "release_pot refuses when it would not hold". (C1, vacuous check)
Reproduce: n/a
Fix: restate I1 as "release_pot succeeds iff Sum need_i <= reserve_total - reserve_losses, and refuses otherwise with the numbers"; keep the per-member inequality as a corollary. Add the negative test (gate refuses) to G2.
Confidence: confirmed
```

```
[MINOR] Demo circle parameters are unspecified; SYSTEM's default coverage_bps 12500 does not reproduce the SPEC §3 table that G2 must reproduce
SYSTEM.md:§4 coverage_bps "12500", §12 G2 ("peak-exposure table from SPEC 3 reproduced as a test"); SPEC.md:§3 (130% target); FLOWS.md:§2.5 "Healthy >= 125%"
What a user or judge sees: at 125% the table is G = 130 / 68+68 / 5+5+5 / 0, peak 136 and $28 per member, not 150 / $30; the demo's "$150 total, $30 per member" line and the §7 halt numbers (75 needed) only hold at 130%. Nowhere are contribution, guarantee, haircut, min_stock_cover, discount and coverage fixed for the demo circle.
Why: the SYSTEM O_i formula does reproduce SPEC's table exactly at 13000 bps (verified: 140 / 75+75 / 10x3 / 0), and SPEC's G column follows from its own formula. Only the parameter binding is missing. (C2)
Reproduce: see numbers above.
Fix: add a "Demo circle" block: n=5, c=50 USDC, g=30, haircut 2000, coverage 13000, warn 11000, min_stock_cover 120, discount 2000, round 120 s, grace 60 s, max_price_age 600. Change the struct comment to "e.g. 13000 on the demo circle".
Confidence: confirmed
```

```
[MINOR] FLOWS sample dialogs use numbers the SYSTEM formulas cannot produce
FLOWS.md:§6 J3 ("Kemi owed 100 ... her last 2 contributions will be paid"), J2 happy path ("owes 150 ... covered 143%")
What a user or judge sees: copy that contradicts the numbers on screen if the builder copies the dialog into fixtures.
Why: Kemi "hasn't paid round 3" of 5 (1-based). SYSTEM O = 50 x (5 - 2) = 150 and escrow pays rounds 3, 4, 5 (three contributions, including the missed one). J2: with H=120 and O=150 the post-payout coverage is 130% (G=75) or 125.3% at the 125% target; 143% needs H=214. (C11)
Reproduce: above.
Fix: J3 -> "Kemi owed 150 USDC ... her remaining 3 contributions"; J2 -> "covered 130%".
Confidence: confirmed
```

```
[MINOR] FLOWS §8 lacks copy for eight SYSTEM refusal codes and one declare_default outcome has no code at all; one CTA precondition disagrees
FLOWS.md:§8 table, §5 rows 4, 9, 11; SYSTEM.md:§5
What a user or judge sees: a raw Anchor error name for: invalid_params, not_all_joined (trace row 4 promises "refusal listing who"), circle_not_active, pre_payout_default_unsupported (row 9 lets anyone click Declare default on any missing seat), already_defaulted, not_finished, already_withdrawn, unauthorized. declare_default on a seat that is already paid has no code in SYSTEM. Trace row 11 allows Add collateral while "not Completed" (includes Cancelled); SYSTEM add_stock allows Active or Forming only. (C11)
Reproduce: click Declare default on a pre-payout member in the demo.
Fix: add rows (pre_payout_default_unsupported: "{name} hasn't received the pot yet. Othello can't default a member before their turn; wait for them or cancel the circle" ... note cancel is impossible after activation, see MAJOR "No exit"); add `seat_already_paid` to declare_default; align row 11 to "Forming or Active".
Confidence: confirmed
```

```
[MINOR] Unchecked degenerate inputs: division by zero and a u64 overflow in the waterfall
SYSTEM.md:§4 (last_coverage_bps), §5 set_prices / init_pool / create_circle, §6 (sell_raw = ceil(O x 1e8 / conservative))
What a user or judge sees: declare_default or update_coverage panics.
Why: conservative = 0 when wrapper_price = 0 or discount_bps = 10000 (admin can set both; nothing refuses). coverage ratio for a member with O_i = 0 divides by zero. O x 1e8 exceeds u64 for O >= 1.85e11 base units ($184,467); NFR-1 says checked u128 but §6 does not mark this line u128. The FUND bound is fine: 1e15 x 1e10 x 1e12 = 1e37 < 2^128. (C7)
Reproduce: set_prices(wrapper_price=0); declare_default -> divide by zero.
Fix: set_prices refuses zero prices; init_pool refuses discount_bps >= 10000; create_circle refuses haircut_bps >= 10000, coverage_bps < 10000, warn_bps >= coverage_bps; define last_coverage_bps = u32::MAX when O_i = 0; mark every product in §6 u128.
Confidence: confirmed
```

```
[MINOR] pool.discount_bps is not constrained by circle.haircut_bps, so H can exceed what liquidation actually returns
SYSTEM.md:§4 LiquidationPool.discount_bps, §6, §5 create_circle "mints/feed/pool match"
What a user or judge sees: a default whose reserve loss exceeds the allocated G even though the price never moved.
Why: H = min(FUND,EXEC) x (1 - haircut); liquidation returns EXEC x (1 - discount). If discount > haircut, every default loses (discount - haircut) x EXEC beyond what the gate provisioned; only the coverage margin above 100% absorbs it.
Reproduce: EXEC=150, haircut 20% (H=120), discount 30% (recovers 105), coverage 100% (G=30 at O=150): loss 45 > G 30.
Fix: create_circle refuses unless pool.discount_bps <= haircut_bps; say so in §5.
Confidence: confirmed
```

```
[MINOR] Rent arithmetic: per-byte rate and program figure are right; Circle omits the 128-byte header it says it includes; deploy headroom depends on an unstated --max-len
SYSTEM.md:§10
What a user or judge sees: nothing unless the deploy fails.
Why: 6,960 lamports/byte-2yr is correct (3,480/byte-year x 2). Circle: (8 + 620 + 128) x 6,960 = 0.00526 SOL, not 0.0045 (the 0.0045 is without the header). Member 0.00185 and token account 0.00204 are right. 300,000 x 6,960 = 2.088 SOL is right for a program data account exactly the size of the binary; `solana program deploy` without `--max-len` may reserve more (older CLI defaulted to 2x), which would double the locked SOL and make the first deploy impossible on 2.5 SOL. (C12)
Reproduce: above.
Fix: correct the Circle figure; add `--max-len` (equal to the binary size) to the deploy step in PREFLIGHT; measure the real binary in gate 1.
Confidence: confirmed (arithmetic) / plausible (CLI default)
```

```
[MINOR] Every state-changing transaction in the demo, including declare_default, requires set_prices within the previous 600 s; the judge's read-only view shows a permanent stale banner
SYSTEM.md:§4 max_price_age 600, §5 declare_default "price fresh"; FLOWS.md:J0, §8 "Prices are {age} old"
What a user or judge sees: opening the demo circle a day after the video shows "Prices are 23h old"; a judge who tries the flow with their own wallet cannot release or default without the admin.
Why: freshness is admin-fed; no keeper. Fine for the 6-minute demo, but J0 (zero-wallet judge view) is the primary judge path and it will look broken. (C6)
Reproduce: open the demo URL 1 h after the last set_prices.
Fix: a scheduled script or Vercel cron calling set_prices every 5 min for the demo week, or a longer max_price_age on the demo circle with the age shown.
Confidence: confirmed
```

---

## Checks that passed (so they are not silently assumed)

- SPEC §3 table is internally consistent at 130% and SYSTEM's O_i reproduces it (C2).
- SPEC §7 halt arithmetic is consistent (120 + 80 = 200 = O; 70 < 75) and SYSTEM §6 reproduces the numbers (C4); only the refusal code and Paused state are wrong (MAJOR above).
- I3 vault conservation holds through declare_default and release_pot as written (the loss moves between accounting fields, never out of the vault) (C3). It fails only at withdraw (MAJOR above).
- reserve_allocated is not double-counted with reserve_losses: a defaulted member is excluded from the recompute, so their G is released in the same instruction the loss is booked (C3).
- contribute (now <= deadline + grace) and declare_default (now > deadline + grace) are disjoint; no boundary race (C9).
- Valuation units are consistent (raw x mult x share_price / 1e17 and raw x wrapper / 1e8 both give USDC base units); FUND fits u128 for raw <= 1e15, mult <= 100, price <= 1e12 (C7).
- Rounding directions match SPEC §2 (FUND, H, share floor; need, sell_raw ceil).
- No anyone-callable instruction can move value to the caller; release_pot cannot fire early (all seats required); declare_default cannot target a paid seat; front-running add_stock or top_up with declare_default gains nothing because default has no coverage condition.
- Sum of withdrawals <= reserve_total - reserve_losses + escrow_left and stock returned <= stock locked (I11) holds under the snapshot formula.

## Vacuous assertions found

1. I1 (holds by definition of G; does not exercise the gate).
2. "escrow_left returns to the reserve pot" (escrow_left is identically 0 at Completed).
3. FLOWS D5 / I13 "coverage-based defaults refuse during Repricing" (no such instruction exists).
4. Gate step 4 (`reserve_overcommitted`) is unreachable, so every FLOWS state and copy that depends on it (Paused, "Payouts resumed") is asserted about nothing.
5. FLOWS "Every state has an exit" is true of the UI statechart and false of funds (Active has no exit without a successful payout).

## Guarantees weakened relative to SPEC

- SPEC §5 "default ... or critical past the cure window": not designed.
- SPEC §7 "New payouts pause if the remaining guarantee reserve is insufficient, until members top it up": the pause is reported as the next recipient's coverage failure, and when the loss exceeds the reserve a top-up cannot resume anything (escrow deficit).
- SPEC §6 "Seize only what is owed ... Return the surplus": surplus stock returns only at Completed, which the escrow-deficit case never reaches; and the defaulter's own guarantee is not treated as owed.
- SPEC §4 "Unused returned pro rata; losses shared pro rata": as designed the defaulter shares in the refund of the reserve they consumed.

## Deadline triage (Fri 25 Sep)

Block (the demo or a judge's question breaks without them):
- CRITICAL 1 (escrow deficit lock-up): one line in release_pot; cheap.
- CRITICAL 2 (recompute when Sum need > R - L): cap outside the gate; cheap, and G3's default test will hit it.
- MAJOR gate split (unreachable reserve_overcommitted): demo step 6 depends on Paused; choose option A or B; cheap.
- MAJOR withdraw/I3 contradiction: one field; cheap; G2's I11 test will otherwise be wrong.
- MAJOR next-round deadline: one sentence.
- MAJOR escrow per-seat vs cumulative and rounds_paid: two sentences.

Ship-with, stated in KNOWN-LIMITS:
- No exit from Active without a successful payout (add the create-time guarantee check if 30 minutes are free).
- Defaulter's pro-rata refund (fix is small; if not fixed, say "defaulter's guarantee is not forfeited in the prototype" on the Default place so a judge is not surprised).
- Coverage-based default cut (edit SPEC §5, FLOWS D5, I13 wording).
- Contribute deadline (either drop the check, 1 line, or document the pre-payout lock-up).
- priced_for_multiplier binding: at minimum make the demo script use the exact decoder; program-side stamping is better.
- All MINOR items.

## What could not be verified

- CU budgets (NFR-3), anchor 1.1.x / spl-token-2022-interface 2.1.0 compatibility, the Token-2022 `UpdateMultiplier` behaviour on devnet, and whether `StateWithExtensions` parsing fits: the design marks these ASSUMPTION and gate 1 measures them.
- The current `solana program deploy` default for `--max-len` (affects whether 2.5 SOL is enough for one deploy).
- Whether the FLOWS UX acceptance test would accept option A or B for the gate split; the design's own "three things most likely wrong" item 3 already flags the split as suspect, and this review shows it is not just suspect but unreachable.
- Anything about the real xStock mint, Pyth feed scaling, or issuer powers (out of scope).

VERDICT: changes required
