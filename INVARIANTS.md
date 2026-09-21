# Invariants

Canonical. Each must have the named test before its gate closes. A test that cannot fail when the property is removed is a finding (mutation-check I1, I2, I3, I5, I12).

| # | Invariant | Checked by |
|---|---|---|
| I1 | `release_pot` succeeds **iff** Σ need_i ≤ reserve_total − reserve_losses, and refuses otherwise with the numbers. (Per-member `(H+G)·1e4 ≥ O·cov` follows.) | unit: one passing and one refusing case per code + property test |
| I2 | `reserve_allocated ≤ reserve_total − reserve_losses` and `Σ Member.allocated = Circle.reserve_allocated` after every instruction | property test after every ix, incl. declare_default during Repricing |
| I3 | usdc vault balance = `reserve_total − reserve_losses + escrow + held_contributions − withdrawn_usdc` (+ dust) | test after every ix in the scenario suite |
| I4 | stock vault balance = Σ member.stock_raw | same |
| I5 | `mult_fixed = floor(true_value × 1e9)` exactly; vectors 1002664207, 1003269012; NaN/Inf/negative rejected | unit (gate 1) |
| I6 | Pot released only when every seat is paid or escrow-covered | unit |
| I7 | `declare_default` only when `clock.unix_timestamp > deadline + grace`, and a seat is never defaultable less than `round_secs + grace` after its round opened | unit with Clock warp, incl. a late `release_pot` |
| I8 | No instruction moves a member's tokens on the admin's signature alone | review + negative test per admin ix |
| I9 | Seized stock value at the conservative price ≤ O + one raw unit | unit |
| I10 | Each member receives the pot exactly once; exactly n payouts per circle | unit |
| I11 | Σ withdrawals ≤ Σ deposits − reserve_losses | scenario test |
| I12 | 10-for-1 split with price updated for multiplier 10: H unchanged within 1 base unit | unit (gate 1) |
| I13 | Price stamped for a different multiplier than the effective one: `release_pot`, `update_coverage`, `join_and_lock` refuse; `declare_default` still works | unit |
| I14 | Escrow deficit is curable: default with shortfall > reserve, then a top-up of `next_gate_short_by` (which already includes the deficit) lets the circle complete | scenario test (G3) |
| I15 | A defaulter's withdraw weight excludes what their own default consumed | unit (G3) |
| I16 | Withdraw order does not change any member's amount | property test over permutations (G2) |
| I17 | `set_prices` never binds a share price to a multiplier the script did not name; `touch_prices` never changes prices or stamp | unit (G1): Scheduled stamp then Current with old share price before T → refused |
| I18 | Paused ⇔ `next_gate_short_by > 0`; a top-up of exactly `short_by` makes the next gate pass (if the round is funded); **no Paused after a healthy payout** (demo circle, every round) | scenario test (G3) |

