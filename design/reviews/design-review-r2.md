# Othello design review, round 2 (adversarial, design-only)

Scope: SPEC.md v4, othello/SYSTEM.md (r2), othello/FLOWS.md (revised), othello-design-review-r1.md. No code exists. "Confirmed" means the case was traced by hand and with a scratch model of the r2 rules exactly as written (contribute, release_pot with the option-B gate and k×c escrow, the §6 waterfall with `forfeited` and `escrow_deficit`, top_up_reserve with the fill, §7 withdraw with snapshot values). Every scenario below kept I3 (vault = R − L + E + held − W) true after every step, so the accounting itself conserves funds; the holes are in what the fixes report, what they leave undefined, and one path where two fixes contradict each other.

Governing assumption applied: the r2 fixes were attacked first. All demo parameters are the r2 demo circle (n=5, c=50, g=30, R=150, cov 130%, haircut 20%, pool discount 20%, min_stock_cover 120) with each member holding stock worth 150 (H=120, conservative sale 120) unless stated.

---

## CRITICAL

```
[CRITICAL] set_prices(Current) from the keep-prices cron rebinds whatever share price is on the feed to whatever multiplier is effective now, so the epoch check passes on a 10x wrong valuation during the split demo
SYSTEM.md:§5 set_prices ("stamp = Current → effective multiplier now ... no off-chain decode ever produces this value"), §5 Demo circle ("scripts/keep-prices.ts re-sends set_prices(Current) every 5 minutes during the demo"), §8 I12/I13; FLOWS.md:§3 J4, §6 J4 repair, D5
What a user or judge sees: in demo step 7 the split lab shows Othello valuing 1 AAPLx at 10,000 USDC after the 10-for-1 split (or at 100 USDC before it), the program releases pots against phantom collateral (or refuses with coverage_too_low), and the "value preserved" claim is false on screen. Which one depends on which 5-minute tick fires first.
Why: r2 fixed the multiplier side of D5 (the program stamps priced_for_multiplier from the mint) but the share price is still an off-chain input, and stamp = Current tells the program "the prices I am passing belong to the multiplier effective now". The program cannot check that. The demo sequence in FLOWS J4 is: schedule split (1→10 at T), set prices with stamp = Scheduled (share 100, priced_for 10), wait for T, recheck. keep-prices.ts runs every 5 minutes with stamp = Current. If it fires between the Scheduled stamp and T with its own constants (share 1,000), the feed becomes {share 1,000, priced_for 1}: correct by accident but the "Repricing" step of J4 disappears, then at T the mint flips to 10 and the circle is Repricing until a human intervenes. If instead it re-reads the feed and re-sends {share 100} with Current before T, the feed becomes {share 100, priced_for 1}: FUND = 100, H = 80 < 120, every gate refuses coverage_too_low. If it fires after T with share 1,000 and Current: {share 1,000, priced_for 10}, FUND = 10,000, H = 8,000, exactly SPEC §1's double-count, accepted by the program as "matching". The design says the multiplier "is never produced off-chain"; the pairing of price to multiplier still is, and Current blesses any pairing.
Reproduce: raw 1e8 (1 token), mult 1, share 1,000, wrapper 1,000: FUND = EXEC = 1,000, H = 800. Admin: UpdateMultiplier(10, T = now+300); set_prices(1,000, 100, Scheduled). At now+240 keep-prices sends set_prices(1,000, 1,000, Current) (its constants) → priced_for = 1, share 1,000. At T mint effective = 10 ≠ 1 → Repricing; keep-prices at now+540 sends (1,000, 1,000, Current) → priced_for = 10, share 1,000 → FUND = floor(1e8 × 1e10 × 1e9 / 1e17) = 10,000 USDC. Gate passes on 10x collateral; split lab prints 10,000.
Fix: (1) add `touch_prices` (admin, only `updated_at = now`, no price or stamp change) and make keep-prices call that, never set_prices. (2) make set_prices take `expected_multiplier_fixed: u64` and refuse `multiplier_price_mismatch` unless it equals the value the stamp would write, so the admin script explicitly binds prices to a multiplier and the program verifies the binding. (3) state in §5 that set_prices(Current) is refused while feed.priced_for_multiplier equals the mint's scheduled newMultiplier and the effective timestamp is in the future (a Scheduled stamp is pending). Add a G1 test: Scheduled stamp, then Current with the old share price before T → refused.
Confidence: confirmed (the hazard and the numbers); plausible (which branch the script takes, since the design does not say what keep-prices sends)
```

---

## MAJOR

```
[MAJOR] declare_default during Repricing must recompute allocations but cannot compute H; both readings break an r2 invariant
SYSTEM.md:§5 declare_default ("wrapper price fresh" only; "then allocations recomputed capped as in update_coverage"), §6 ("Liquidation uses the non-scaled wrapper price only, so it works during Repricing"), §8 I2 ("holds by construction"), I13 ("declare_default still works"); FLOWS.md:D5
What a user or judge sees: G3's I13 test either fails on a checked-arithmetic error inside declare_default, or passes while I2 is false and the reserve panel shows Allocated 140 of a 70 reserve, or the default is settled using a price the program has just refused to use for anything else.
Why: the r2 cap is "reserve_allocated = min(Σ need, R − L)" and need_i requires H_i = min(FUND, EXEC) × (1 − haircut). FUND needs the share price bound to the effective multiplier, which by D5 is exactly what Repricing says it does not have. declare_default's precondition only checks the wrapper price. A builder has three choices, none written down: (a) skip the recompute: reserve_allocated keeps its pre-default value while reserve_losses rises, so A > R − L and I2's "by construction" claim is false (the SPEC §7 example gives A = 140 against R − L = 70); (b) compute FUND with the mismatched price: the number is wrong in the direction the design forbids; (c) compute with EXEC only: H is overstated (min dropped), need understated. update_coverage refuses in the same state, so nothing repairs (a) until prices match.
Reproduce: SPEC §7 through r2: round 0 pays m0, A = 140. Admin stamps Scheduled for the split (Repricing begins). m0 misses round 1; declare_default(0): loss 80, L = 80, R − L = 70. Reading (a): A stays 140 > 70. I2 violated; reserve_free = 150 − 80 − 140 underflows in checked math on the next read.
Fix: one sentence in §5/§6: "During Repricing or with a stale share price, declare_default does not recompute H; it sets reserve_allocated = min(reserve_allocated − allocated_d, R − L), sets allocated_d = 0, leaves other members' allocated untouched and does not stamp last_coverage_at." Reword I2 to "holds after every instruction" (not "by construction") and add this path to the I13 test.
Confidence: confirmed
```

```
[MAJOR] escrow_deficit is invisible to every refusal and every screen; the stated top-up amount is wrong, the stuck round says "remind them", and Lost rises when someone tops up
SYSTEM.md:§5 release_pot ("escrow ≥ k×c" → round_not_funded; reserve_overcommitted{needed, available, short_by = S − avail}), §5 top_up_reserve (fill → reserve_losses), §4 Circle.escrow_deficit; FLOWS.md:§8 rows "Round not funded" ("{k} contributions still missing. Wait, or remind them") and "Payout gate: reserve" ("Top up {need−free} USDC"), §6 J3 ("Any member can top up 33 USDC to resume"), §5 row 10
What a user or judge sees: (1) "Payouts paused. The next payout needs 75 USDC of reserve, 0 is free. Top up 75 USDC." A member tops up 75 and the banner now reads "needs 75, 45 is free. Top up 30." Round 1 of the review flagged exactly this experience ("members top up, and nothing changes"); it is now off by the deficit instead of by everything. (2) When the gate passes but escrow runs dry, release_pot refuses round_not_funded and the UI says "1 contribution still missing. Wait, or remind them." The missing seat is the defaulter's; they cannot contribute (already_defaulted); the only cure is a 30 USDC top-up that no screen names. (3) The Guarantee panel's "Lost" figure rises from 150 to 180 when a member tops up 30, because the fill is booked as reserve_losses.
Why: r2 CRIT-1 fix stores the deficit and lets top_up fill it, but neither gate refusal carries it, round_not_funded has no payload, and the FLOWS copy was not updated. Note the invariant: escrow_deficit > 0 implies R − L = 0 (the loss was capped at the whole reserve, and every top-up fills the deficit first), so the gate can pass with a deficit only when every received member's need is 0. That is the path to (2).
Reproduce: (1) round 0 pays m0; price falls so every holding is worth 25 (H = 20, sale 20); m0 misses round 1; declare_default: O 200, recovered 20, shortfall 180, loss 150, D = 30, E = 170, R − L = 0. Prices recover for the rest (H = 120). release_pot: m1 need 75 > 0 → reserve_overcommitted{75, 0, short_by 75}. top_up(75): fill 30, L = 180, avail 45 → still refused {75, 45, 30}. Needs 105 total. (2) same default, but the others hold enough stock that need = 0: rounds 1-3 release (E 170 → 120 → 70 → 20); round 4: E 20 < 50 → round_not_funded, D = 30. (3) L: 150 → 180 on the 30 top-up.
Fix: add escrow_deficit to both gate payloads and make short_by = S − avail + escrow_deficit; give round_not_funded a payload {missing_seats, escrow, escrow_needed, escrow_deficit} and a second copy row: "Round can't be released: {name}'s prepaid contributions ran {deficit} USDC short. Any member can top up {deficit} USDC." Update FLOWS row 10 and J3 to show the deficit. Either relabel "Lost" as "Lost or used to prefund defaults", or account the fill as R += amount − fill, E += fill (R − Σ(g+t) then differs by the fills; weights unaffected) so Lost does not move on a top-up.
Confidence: confirmed
```

```
[MAJOR] Option-B gate names coverage_too_low ("lock more stock to release his pot") when the recipient's stock cannot release anything because other members' needs alone exceed the reserve
SYSTEM.md:§5 Payout gate step 3 ("coverage_too_low ... iff H_r < min_stock_cover; copy leads with lock more stock"); FLOWS.md:§6 J2 repair ("Tunde can lock more stock to release his pot"), §8 row "Payout gate: coverage"
What a user or judge sees: the recipient locks more stock, the refusal changes to reserve_overcommitted, and the pot still does not release. The cause named was wrong and the action named was wasted.
Why: H_r < min_stock_cover says the recipient's own stock has fallen; it does not say the recipient's gap is the reason the gate fails. The recipient can fix the gate alone iff S − need_r ≤ avail. When that is false the true cause is the reserve, whatever the recipient's H is. The two codes are exhaustive and exclusive as written, but exclusive on the wrong predicate.
Reproduce: m2 joined with stock worth 300 (H 240), others 150. Round 0 pays m0; m0 misses round 1: loss 80, avail 70, E 200. m1 has locked enough to pass round 1 (H 125, need 70 ≤ 70). Price then falls 58%: m1 H 50, m2 H 100, m3/m4 H 50. Round 2 funded, recipient m2: O_1 = O_2 = 100; need_1 = 130 − 50 = 80, need_2 = 130 − 100 = 30; S = 110 > 70. H_2 = 100 < 120 → coverage_too_low{100, 120, short_by 40}, copy "m2 can lock more stock to release his pot". m2 locks unlimited stock: need_2 = 0, S = 80 > 70 → reserve_overcommitted{80, 70, short_by 10}. Only a top-up (or m1 adding stock, which no copy suggests) releases the pot.
Fix: step 3 becomes `coverage_too_low` iff H_r < min_stock_cover AND (S − need_r) ≤ avail; otherwise `reserve_overcommitted`. Add `recipient_gap: need_r` and `others_need: S − need_r` to both payloads so the UI can say "m2 can lock {x} more of cover, or any member can top up {y}" with correct x and y. Update I1's test to include this case.
Confidence: confirmed
```

```
[MAJOR] Under the cap, per-member `allocated` and `last_coverage_bps` are undefined, so Position shows every member at exactly 130% while the reserve is empty; warn_bps and the Healthy/Warning/Critical states can never trigger
SYSTEM.md:§4 Member.allocated ("G_i, last recompute"), last_coverage_bps, need_i formula, §5 update_coverage ("reserve_allocated = min(Σ need, R − L)"), §5 param ranges (warn_bps only validated); FLOWS.md:§2.5 "Healthy / Warning / Critical", §8 Position success "Coverage now {pct}%"; SPEC.md:§5
What a user or judge sees: after a default that empties the reserve, every remaining recipient's Position reads "Coverage 130%, Healthy, reserve cover 90 USDC" while the Guarantee panel reads "Free 0, Allocated 40". A judge who asks "what does Critical look like" cannot be shown it: with G_i = need_i, (H_i + G_i)/O_i ≥ coverage_bps by construction, so Warning and Critical are unreachable and warn_bps is a parameter nothing reads.
Why: r2 caps the circle-level sum but says nothing about how the cap is distributed to Member.allocated. Two builders: (a) allocated_i = need_i (uncapped): Σ allocated_i ≠ reserve_allocated, coverage always ≥ target; (b) scale or allocate greedily: coverage falls below target for some member, but which one is a policy choice the design never makes. The SPEC §5 thresholds only mean something under (b).
Reproduce: round-1 CRIT-2 case through r2: rounds 0 and 1 pay m0, m1 (A 150). Price falls to 50 per holding (H 40); m0 misses round 2; declare_default: O 150, recovered 40, loss 110, R − L = 40, E 150. Recompute: m1 O 100, need 90; S 90 > 40 → A = 40. (a): m1.allocated 90, coverage (40 + 90)/100 = 130% Healthy. (b): m1.allocated 40, coverage 80% Critical.
Fix: state the distribution: allocate in turn order (earliest recipient first) until the reserve is exhausted, allocated_i = min(need_i, remaining), and last_coverage_bps = (H_i + allocated_i) × 1e4 / O_i. Then Σ allocated_i = reserve_allocated, Warning/Critical are reachable, and the demo can show one. Add "Σ Member.allocated = Circle.reserve_allocated" to I2.
Confidence: confirmed
```

```
[MAJOR] "Paused" has no on-chain source: CoverageUpdated.reserve_short_by is 0 immediately after the SPEC §7 default, and the gate can only be evaluated once the round is fully funded
SYSTEM.md:§5 update_coverage ("emits CoverageUpdated{... reserve_short_by = max(0, Σ need − (R − L))}"), §6 last line ("UI shows Paused if the next payout's gate sum > available"), §5 release_pot check order (round_not_funded before gate); FLOWS.md:§6 J3 ("If the next payout now fails the gate: Payouts are paused ..."), §7 statechart, §5 row 9 ("Circle: active or paused"); SYSTEM.md:§12 G3 done-criterion
What a user or judge sees: demo step 6 ("recompute capacity") ends with no Paused banner. Right after m0's default nothing is allocated (no received non-defaulted member exists), reserve_short_by = 0, and the circle looks healthy. The banner can only appear after m1-m4 have paid 200 USDC into round 1 and someone simulates release_pot. Members pay into a round that cannot release, then see Paused.
Why: the emitted figure uses current O_i; the gate uses post-payout O_i for the current recipient plus the others. "Next payout's gate sum" is computable now (at release everyone non-defaulted will have rounds_paid = round + 1, so O_i = c × (n − round − 1) for each received member and for the recipient) but nothing computes or stores it, and a viewer with no wallet (J0) reads accounts, not events. The builder will either duplicate the valuation in the frontend (the thing the design said would make the moat "frontend-only") or run a wallet-less simulation, neither stated.
Reproduce: SPEC §7: after declare_default(0), received non-defaulted = {} → Σ need = 0, reserve_short_by = 0, A = 0. Prospective: recipient m1 with O = 150 → need 75 > 70. Only visible after the round funds.
Fix: in update_coverage and declare_default compute `next_gate_short_by = max(0, S_next − (R − L)) + escrow_deficit` with S_next as above, store it on Circle, and define Paused as next_gate_short_by > 0. release_pot recomputes it for the new round. State that the UI derives Paused from that field, and let the Default place show "Payouts are paused. The next payout needs {S_next}, {R − L} is free" from account data.
Confidence: confirmed
```

```
[MAJOR] Top-up copy promises "returned when the circle ends"; a top-up that fills an escrow deficit is never returned, and after any loss only a fraction is
FLOWS.md:§6 J2 repair ("any member can add 56 USDC to the reserve, returned when the circle ends"), §8 Join helper ("Both come back when the circle ends"), §5 row 10; SYSTEM.md:§5 top_up_reserve, §7 withdraw
What a user or judge sees: m1 tops up 30 to cure a deficit, the circle completes, m1 withdraws 0 USDC. Or: m2 tops up 5 in the SPEC §7 case and gets 21 of 35 back (60%), having been told the 5 would be returned.
Why: a top-up adds to weight but the pool it is paid from is R − L, and the fill is booked as a loss. When R − L = 0 after the fill, the top-up is a donation to the defaulter's future recipients. This is economically correct (it is what "the reserve covers the shortfall" means) but the copy says the opposite, and it is the one action the Paused state asks a user to take with money.
Reproduce: deficit case above: m1 tops up 30, D → 0, L 180, R 180, pool_left 0, everyone withdraws 0. SPEC §7 + top-up 5 by m2: pool_left 75, weights [0, 30, 35, 30, 30], m2 gets floor(75 × 35/125) = 21.
Fix: copy: "Top-ups join the shared reserve. What is not used to cover defaults comes back pro rata when the circle ends." When escrow_deficit > 0, the Default place says "The first {deficit} USDC of any top-up prepays {name}'s missed contributions and is not returned."
Confidence: confirmed
```

---

## MINOR

```
[MINOR] Forfeit is measured against the booked loss, not the shortfall, so a defaulter whose default caused a deficit keeps withdraw weight that honest fills paid for
SYSTEM.md:§6 ("forfeited_d += min(loss, guarantee_d + top_ups_d − forfeited_d)"), §7 weight_i, §8 I15
What a user or judge sees: the second defaulter withdraws a positive amount from a pool that only exists because an honest member topped up their deficit.
Why: loss is capped at what the reserve holds at that instant. When an earlier loss has already drained the reserve below the defaulter's own deposit, loss < g_d and forfeited_d < g_d, although the default's shortfall exceeded g_d many times over and was later filled by others.
Reproduce: rounds 0-1 pay m0, m1. Price falls to 25 per holding. m0 and m1 miss round 2. default(0): loss 130, R − L = 20, f_0 = 30. default(1): shortfall 130, loss 20, D = 110, f_1 = 20, weight_1 = 10. m2 tops up 500 (fill 110). Circle completes; pool_left 390, weights [0, 10, 530, 30, 30]; m1 withdraws 6.
Fix: forfeited_d = min(shortfall, guarantee_d + top_ups_d). Weights only shrink, so Σ usdc_i ≤ pool_left still holds.
Confidence: confirmed
```

```
[MINOR] A defaulted member's own later top-up earns withdraw weight, so they claw back part of other members' money
SYSTEM.md:§5 top_up_reserve (signer "member", no defaulted check), §7 weight_i
What a user or judge sees: the defaulter tops up 30 to cure their own deficit and withdraws 10 at the end, out of a pool funded by m1's 75.
Why: top_ups_d increases weight; forfeited_d is not touched by the fill.
Reproduce: deficit case: m0 (defaulted) tops up 30 (fill 30), m1 tops up 75, circle completes; pool_left 75, weights [30, 105, 30, 30, 30], m0 gets 10.
Fix: in top_up_reserve, if the signer is defaulted: forfeited += amount (their top-up never becomes weight). Or refuse `already_defaulted` and say so in FLOWS.
Confidence: confirmed
```

```
[MINOR] I14 as stated does not complete the circle; "escrow normally 0 at completion" is "always 0" and the + escrow term is dead; FLOWS still promises an escrow remainder
SYSTEM.md:§8 I14 ("top-ups ≥ deficit, then the circle completes"), §7 ("escrow normally 0 at completion"); FLOWS.md:D8 ("escrow remainder to the reserve pro rata", "minus still-allocated"), §5 row 12 ("escrow remainder")
What a user or judge sees: a G3 test written from I14 with top-up = deficit stays refused (reserve_overcommitted); a withdraw line item that is always 0; D8 describing a formula SYSTEM does not use.
Why: after the fill, avail = top-ups − deficit, and the gate still needs Σ need ≤ avail (deficit case: 30 + 75 = 105, not 30) unless every need is 0. Escrow is exactly Σ O_d − D at all times and release refuses when it cannot pay k×c, so Completed implies D = 0 and E = 0.
Reproduce: deficit case with H = 120 for the rest: top-up 30 → avail 0 < 75.
Fix: I14: "top-ups ≥ deficit + Σ need of the next gate". §7: "escrow is 0 at Completed (release refuses otherwise); the term is kept only for the invariant". D8 and row 12: "unused guarantee and top-ups pro rata by (guarantee + top-ups − forfeited)".
Confidence: confirmed
```

```
[MINOR] Reproducibility: eight points two builders would still resolve differently
SYSTEM.md:§5-§7
What a user or judge sees: two implementations differ on withdraw amounts, on whether a round can be released by a stranger, and on demo fixtures.
Why: unstated, likely guess in brackets:
 1. withdraw's Σ weight: all n Member accounts as remaining_accounts, or a stored total. Since Σ(g + t) = reserve_total, Σ weight = reserve_total − Σ forfeited; a `Circle.forfeited_total` field avoids passing 8 accounts. [pass all accounts]
 2. Whether withdraw zeroes stock_raw_i and guarantee_i; I4 (stock vault = Σ stock_raw) is false after the first withdraw otherwise. [not zeroed; I4 fails]
 3. What keep-prices.ts sends (its constants vs the feed's current values; which stamp) and whether it runs across the split (CRITICAL above). [constants, Current, yes]
 4. declare_default's recompute during Repricing (MAJOR above). [skip]
 5. How the UI derives Paused with no wallet (MAJOR above). [frontend valuation]
 6. release_pot is anyone-callable and pays "pot n×c → recipient": the recipient's USDC token account must exist; init_if_needed with the caller as payer, or refuse. [assume ATA exists from join]
 7. Demo seed: how much stock each member locks and at what wrapper/share price. SPEC §9's split example prices the share at $1,000 (H = 800 per token), the demo circle's min cover is 120; the seed must reconcile these (e.g. 0.15 token, or a mock price of 150 with the split shown at 150 → 15). Joining must happen before the split is scheduled (join refuses during Repricing). [unspecified]
 8. paid_bitmap, round and reserve_allocated at Completed. [left as is; harmless]
Reproduce: n/a
Fix: one line each in §5/§7 and the demo block.
Confidence: confirmed
```

```
[MINOR] Demo circle sits exactly on the peak bound: one base unit of H below 120 for any member at round 2 pauses the circle
SYSTEM.md:§5 peak-guarantee check ("peak 150 ≤ 5 × 30"), Demo circle block
What a user or judge sees: the demo's round 2 release refuses reserve_overcommitted{152, 150, 2} because a price re-send or a floor in FUND moved H from 120 to 119.
Why: the check reproduces SPEC §3 (140, 150, 30, 0) and passes with equality; at k = 2, S = 2 × (195 − H). With H = 119, S = 152 > 150. The bound assumes every member's H = min_stock_cover exactly, which is also the seed's likely choice. Members with more stock only lower need (safe); a price fall is the accepted risk; but zero slack is a choice.
Reproduce: 2 × (ceil(150 × 1.3) − 119) = 152.
Fix: seed with g = 35 or min_stock_cover 125 (peak 140), or lock 10% more stock than the minimum in the seed script. Keep the equality case as the unit test.
Confidence: confirmed
```

```
[MINOR] FLOWS dialog and error-table numbers do not follow from the r2 rules
FLOWS.md:§6 J3 ("Reserve free: 42 USDC", "needs 75 USDC of reserve and 42 is free ... top up 33"), J2 repair ("95 ... 120 minimum ... 56 short"), §8 row "Payout gate: coverage" ("{name} would be covered {pct}%, the circle needs {target}%")
What a user or judge sees: fixtures copied from the dialog disagree with the program by 60 USDC; a refusal row that prints a percentage the payload does not contain and that can never be below target.
Why: Kemi (turn 1, received round 1, misses round 3 of 5): O = 150, recovered 112, loss 38, R − L = 112; the only other recipient (turn 2) has already paid round 3 so O = 100, need 10, A = 10, reserve free = 102, not 42; the next payout needs S = 20, so it is not paused and "top up 33" has no source. Tunde's "56 short" requires the round-1 recipient's H to be 89, which nothing in the dialog says. The coverage row's {pct} < {target} cannot occur with G = need (see the allocation finding); the r2 payload is {recipient_stock_cover, minimum, short_by}.
Reproduce: scratch model, Kemi case: after default S_now = 10, A = 10, free = 102; release round 3: S = 20 ≤ 112, paid.
Fix: J3: "Reserve free: 102 USDC" and drop the paused branch, or move the paused branch to a second dialog with the SPEC §7 numbers (loss 80, needs 75, 70 free, top up 5). J2 repair: add "Kemi's cover is also down to 89". §8 row: "Can't release {name}'s pot. Their locked stock counts for {H} USDC of cover, below the {min} minimum, and the reserve is {short_by} short."
Confidence: confirmed
```

```
[MINOR] Two things called "free" on one screen disagree; three refusal codes still have no copy; three stale FLOWS statements
SYSTEM.md:§5 reserve_overcommitted{available = R − L}, §4 reserve_free = R − L − A; FLOWS.md:§8 ("{free} is free"), §8 table, §7 ("Every state has an exit"), D6 (max_price_age 600 vs SYSTEM demo 1,800 vs struct comment 600), §5 row 10
What a user or judge sees: banner "needs 90, 40 is free" beside a Guarantee panel reading "Free 0, Allocated 40"; raw Anchor names for circle_not_active, already_withdrawn, unauthorized; a statechart note that contradicts SYSTEM §7's accepted no-exit limit; a stale banner threshold that differs by 3x between documents.
Why: after a loss the capped A equals R − L, so reserve_free = 0 while the gate's `available` is R − L. FLOWS' round-1 additions covered eight codes but not these three. "Every state has an exit" was flagged in round 1 and is unchanged.
Reproduce: CRIT-2 case: A = 40 = R − L; free 0; gate available 40.
Fix: name the gate field `remaining` in copy ("40 remains in the reserve") and keep "free" for R − L − A; add the three rows; change the statechart note to "Every UI state has an exit; an Active circle whose gate cannot pass has none (SYSTEM §7)"; pick one max_price_age.
Confidence: confirmed
```

```
[MINOR] §6 still does not mark O × 1e8 as u128; --max-len is still absent from SYSTEM; keep-prices "during the demo" leaves the judge's view stale afterwards
SYSTEM.md:§6 (sell_raw = ceil(O × 1e8 / conservative)), §10, §5 Demo circle
What a user or judge sees: an overflow for O ≥ 1.85e11 base units if a builder types the line as u64; a first deploy that does not fit in 2.5 SOL; "Prices are 2 days old" on the demo URL the judge opens.
Why: round-1 MINOR items partly carried over. NFR-1 says u128 everywhere; §6 is the one place a builder copies from. The cron is scoped to "during the demo"; J0 is the primary judge path and judging happens after.
Reproduce: n/a
Fix: mark the line `u128`; add `--max-len` to §10's mitigation sentence; run keep-prices (as touch_prices) for the judging week or raise the demo circle's max_price_age to 7 days and show the age.
Confidence: confirmed
```

---

## Round-1 findings resolved / not resolved

| Round-1 finding | Status | Residual |
|---|---|---|
| CRIT escrow deficit stuck state | Resolved (escrow_deficit + fill) | Deficit invisible in refusals/copy; short_by wrong; top-up copy wrong (MAJOR ×2 above) |
| CRIT recompute when Σ need > R − L | Resolved (cap outside gate) | Per-member distribution undefined; declare_default during Repricing (MAJOR ×2 above) |
| MAJOR gate split unreachable | Resolved (option B) | Wrong predicate for cause (MAJOR above) |
| MAJOR withdraw vs I3 | Resolved (withdrawn_usdc, snapshot) | Σ weight source and stock_raw zeroing unstated (MINOR) |
| MAJOR defaulter refunded pro rata | Resolved (forfeited) | Forfeit vs shortfall; defaulter's own top-up (MINOR ×2) |
| MAJOR next-round deadline | Resolved (now + round_secs, I7) | none |
| MAJOR contribute deadline | Resolved (no time check; FLOWS statechart updated) | none; no race found (contribute and declare_default both require the seat unpaid; whichever lands first wins, the other refuses cleanly; a contribute that lands after release_pot pays the new round, which the member owes anyway) |
| MAJOR no exit from Active | Resolved as accepted limit + peak check | FLOWS "Every state has an exit" unchanged (MINOR) |
| MAJOR oracle epoch off-by-one | Resolved for the multiplier (stamping) | Price-to-multiplier pairing unverified; keep-prices (CRITICAL above) |
| MAJOR escrow per seat | Resolved (k×c, rounds_paid++, remaining_accounts) | none |
| MAJOR coverage-based default | Resolved (cut and stated; FLOWS D5 updated) | none |
| MAJOR reproducibility (11 points) | 10 of 11 resolved | point 11 (state at Completed) still open; 8 new points (MINOR above) |
| MINOR recovered above O | Resolved | none |
| MINOR escrow_left vacuous | Not resolved | "normally 0" → always 0; FLOWS D8/row 12 unchanged |
| MINOR I1 tautological | Resolved (iff form) | none |
| MINOR demo params | Resolved (demo block) | max_price_age 600/1,800 conflict; zero slack; seed amounts/prices missing |
| MINOR dialog numbers | Partly (150 owed, 3 contributions, 130%) | 42 free / 75 needed / 33 top-up still wrong |
| MINOR missing refusal copy | Partly (8 rows added) | circle_not_active, already_withdrawn, unauthorized |
| MINOR degenerate inputs | Resolved (ranges, prices > 0, u32::MAX) | u128 mark in §6 |
| MINOR discount ≤ haircut | Resolved | none |
| MINOR rent / --max-len | Partly (Circle figure fixed) | --max-len not in SYSTEM |
| MINOR stale banner for judge | Partly (cron + 1,800 s) | cron scoped to the demo; and the cron is the CRITICAL |

## Checks that passed

- I3 held after every step in every scenario above (SPEC §7 with top-up, two defaulters, deficit with and without cure, defaulter top-up). The loss and the fill move between accounting fields, never out of the vault.
- I2 holds after every instruction except the declare_default-during-Repricing path (MAJOR above). reserve_losses never exceeds reserve_total: the loss is capped at R − L and every fill is matched by an equal R increase.
- Withdraw is order-independent (all 120 permutations of the SPEC §7 case give [0, 18, 21, 18, 18]); Σ usdc_i ≤ pool_left with ≤ 1 unit of dust; no residual escrow_deficit or escrow at Completed (Completed implies both are 0).
- Two defaulters in the same round: escrow 300 pays 2×50 per round, honest members withdraw 30 each, defaulters 0.
- Peak check reproduces (140, 150, 30, 0) and does not block the demo circle.
- set_prices stamping: no deadlock. Current and Scheduled coincide once the effective timestamp has passed (Token-2022 does not move newMultiplier back into multiplier); a second scheduled update after a stamp causes Repricing, curable by another set_prices. Repricing is always curable by the admin.
- contribute without a time check: no race and no way to pay a released round (paid_bitmap resets; a late-landing tx pays the next round).
- Gate option B is exhaustive and exclusive (iff/else); the problem is the predicate, not the coverage.

## Vacuous assertions

1. I2 "holds by construction": false on the declare_default-during-Repricing path.
2. "escrow normally 0 at completion" and the `+ escrow` term in pool_left: always 0; dead term.
3. I14 as worded (top-ups ≥ deficit → completes): insufficient without Σ need.
4. `warn_bps` and Healthy / Warning / Critical: unreachable while allocated_i = need_i.
5. `CoverageUpdated.reserve_short_by` as a Paused signal: 0 immediately after the SPEC §7 default.
6. "no off-chain decode ever produces this value": true of the multiplier, but set_prices(Current) still accepts any share price as belonging to it.
7. FLOWS "Every state has an exit": still contradicts SYSTEM §7.
8. FLOWS trace row 7 precondition "recipient post-payout coverage ≥ target": true by definition of G, tests nothing.

## Guarantees weakened relative to SPEC

- SPEC §1 "never multiply by the multiplier again" / §9 "correct value unchanged": violated by the demo's own price cron unless set_prices is hardened (CRITICAL).
- SPEC §5 Healthy / Warning / Critical: not observable under the r2 cap as written.
- SPEC §7 "New payouts pause ... until members top it up": the top-up amount shown is short by the escrow deficit, and the pause is not visible until the round is funded.
- SPEC §4 "losses shared pro rata": a defaulter retains weight in two edge cases (forfeit vs shortfall; own top-up).
- SPEC §4 "Unused returned pro rata": FLOWS copy promises full return of top-ups.

## Deadline triage (Fri 25 Sep)

Block (the demo or a judge's question breaks without them):
- set_prices / keep-prices pairing (CRITICAL): add `touch_prices` and the expected-multiplier argument; 30 minutes and it removes the single way the split demo shows the wrong number.
- declare_default during Repricing (MAJOR): one sentence; G3's I13 test will hit it.
- escrow_deficit in payloads and copy, short_by includes the deficit, round_not_funded payload (MAJOR): a few lines; the Paused flow is demo step 6.
- Gate cause predicate (MAJOR): one condition.
- Per-member allocation under the cap (MAJOR): one rule; also the only way to show Critical.

Ship-with, stated in KNOWN-LIMITS or fixed if time allows:
- Paused derivation (use a wallet-less simulation of release_pot in the UI if the on-chain field is not added; say so).
- Top-up copy (copy only; do it).
- Forfeit vs shortfall and defaulter top-up (small; or state "a defaulter's later top-up is treated like anyone's").
- I14 wording, escrow term, D8, dialog numbers, missing rows, free/remaining naming, max_price_age, u128 mark, --max-len, demo slack and seed amounts.

## What could not be verified

- Token-2022 `UpdateMultiplier` behaviour when a second update is scheduled before the first activates, and whether the ix rejects non-finite or non-positive multipliers (affects only the "set_prices never deadlocks" check).
- CU for the extra prospective-gate computation and for passing 8 Member accounts to withdraw (bounded by n ≤ 8; gate 2 measures).
- What scripts/keep-prices.ts actually sends (the CRITICAL's branch), since only its cadence and stamp are specified.
- Whether a wallet-less `simulateTransaction` of release_pot is acceptable to the builder as the Paused source for J0.
- Anything the round-1 review listed as unverifiable (anchor/spl compatibility, deploy size, real xStock mint).

VERDICT: changes required
