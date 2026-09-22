# Proposal: Borrow Solo (admin-seeded pool)

Status: DRAFT r3 for the design session. Not spec. Written by the build session
on Joshua's ruling of 2026-09-22, which reverses the `Borrow solo` cut recorded
in `design/FRAME.md:38` and inherited by `SPEC.md:27`.

r4 answers Codex r3 (1 CRITICAL, 2 MAJOR, 1 MINOR); r3 answered r2 (3 CRITICAL,
1 MAJOR, 1 MINOR); r2 answered r1 (2 CRITICAL, 3 MAJOR, 1 MINOR). Sections 10 to
12 list what moved in each round.

The build session cannot amend `SPEC.md`, `INVARIANTS.md`, `ARCHITECTURE.md` or
the ADRs. This is the concrete shape so the design session and Codex can rule on
one draft rather than on an idea.

## 1. What it is

A **zero-coupon collateralised loan with a maturity.** One borrower locks
xStock and draws USDC against it from a pool the demo admin seeds. No interest,
no rotation, no turn order, no mutual coverage. The circle is unchanged and both
modes ship.

No interest is only defensible with a maturity: without one, a borrower draws
the pool to zero, keeps the collateral healthy and holds free liquidity for
ever. `due_at` is set at open and is immutable.

## 2. What it shares, and what it does not

Shares **gate 1's valuation and nothing else**: exact `floor(multiplier x 1e9)`
(ADR-001), the multiplier read off the real mint and selected on the Clock, the
`FUND`/`EXEC`/`H` arithmetic of SPEC section 4, and the mint allowlist
(ADR-012).

It is **its own risk gate**, not gate 1 reused. Debt, maturity, seizure and pool
solvency are new state with new failure modes, and r1 was wrong to imply
otherwise. It needs its own invariants, its own negative tests and its own
review.

It does show the core defect more sharply than the circle. NFLXx's real 10-for-1
split is a **liquidation event for a naive lender**: a reader that ignores
`newMultiplierEffectiveTimestamp` values the collateral at a tenth the instant
the split lands and seizes the stock of a borrower who is fine. The circle shows
the same bug as a refused payout.

## 3. Accounts

### 3.1 LoanTerms, immutable and versioned

```rust
#[account] pub struct LoanTerms {         // seeds ["loan_terms", solo_pool, version.to_le_bytes()]
  pub solo_pool: Pubkey, pub version: u16, pub bump: u8,
  pub haircut_bps: u16,                   // H = min(FUND,EXEC) x (10000 - haircut) / 10000
  pub ltv_bps: u16,                       // principal x 10000 <= H x ltv_bps
  pub liquidation_bps: u16,               // unhealthy when principal x 10000 > H x liquidation_bps
  pub grace_secs: i64,                    // cure window, and the post-maturity window
  pub term_secs: i64,                     // due_at = opened_at + term_secs
  pub max_price_age: i64,                 // freshness, as the circle
  pub min_principal: u64,
}
```

Written once by `init_loan_terms` and never mutated. Changing terms means a new
`version`, which cannot touch loans already open. Each `Loan` snapshots the
values it opened under, so a new version can never reprice an existing loan.

### 3.2 Loan

```rust
#[account] pub struct Loan {               // seeds ["loan", solo_pool, borrower, nonce.to_le_bytes()]
  pub borrower: Pubkey, pub solo_pool: Pubkey, pub nonce: u64, pub bump: u8,
  pub stock_mint: Pubkey, pub usdc_mint: Pubkey, pub price_feed: Pubkey,
  pub terms_version: u16,                  // which LoanTerms this opened under
  pub haircut_bps: u16, pub ltv_bps: u16, pub liquidation_bps: u16,   // snapshot
  pub grace_secs: i64, pub max_price_age: i64,                        // snapshot
  pub stock_raw: u64,                      // collateral still the borrower's
  pub principal: u64,                      // usdc still owed, 6-dp base units
  pub opened_at: i64, pub due_at: i64,     // due_at immutable after open
  // The margin call, bound to the price state it was observed at. A call is
  // only valid while BOTH still match, so any intervening price or epoch change
  // voids it and a fresh call starts a fresh grace.
  pub called_at: i64,                      // 0 when there is no live call
  pub called_price_updated_at: i64,        // feed.updated_at when the call was made
  pub called_multiplier_fixed: u64,        // effective multiplier when the call was made
  pub seized_raw: u64, pub written_off: u64,  // set once, at liquidation
  pub status: LoanStatus,                  // Open | Repaid | Liquidated
}
```

`price_feed` must be the PDA `["price", stock_mint]`; both solo vaults are
checked for owner and mint; `usdc_mint` and `stock_mint` must match the
`SoloPool`'s. `solo_pool.discount_bps <= haircut_bps`.

### 3.3 SoloPool, a separate pool with its own vaults

**Not `LiquidationPool`.** That account is the circle's counterparty:
`declare_default` moves its USDC into the circle vault and seized stock into its
stock vault (SPEC section 6), touching none of the counters below. Sharing it
would make S2 and S4 false the first time any circle defaulted. Separate
account, separate vaults, separate PDA namespace.

```rust
#[account] pub struct SoloPool {          // seeds ["solo_pool", usdc_mint, stock_mint]
  pub authority: Pubkey, pub bump: u8,
  pub usdc_mint: Pubkey, pub stock_mint: Pubkey,
  pub discount_bps: u16,                  // conservative sale price, as the circle's pool
  pub usdc_seeded: u64,                   // cumulative seeded by the admin
  pub drawn_total: u64,                   // cumulative out of the vault via open_loan
  pub repaid_total: u64,                  // cumulative into the vault via repay
  pub written_off_total: u64,             // cumulative debt extinguished by liquidation
  pub seized_raw_total: u64,              // cumulative raw stock the pool has taken
}
```

Vaults `solo_usdc_vault` and `solo_stock_vault` are PDAs of this account and are
never the circle's. No instruction in this proposal touches `LiquidationPool`,
and no circle instruction touches `SoloPool`.

## 4. Instruction surface

| Instruction | Signer | Preconditions | Effect | Refusals |
|---|---|---|---|---|
| `init_solo_pool(discount_bps)` | payer, becomes `authority` | the PDA for `["solo_pool", usdc_mint, stock_mint]` is empty; `stock_mint` is on the allowlist (ADR-012); `usdc_mint` is the circle's USDC mint; `0 <= discount_bps < 10000` | creates `SoloPool` and both vaults as PDAs of it, binds both mints, zeroes every counter | `invalid_params`, `mint_not_allowlisted` |
| `init_loan_terms(version, ...)` | admin | `solo_pool.authority`; terms slot for `version` empty; `0 < ltv_bps < liquidation_bps <= 10000`; `0 <= haircut_bps < 10000`; `solo_pool.discount_bps <= haircut_bps`; `grace_secs >= 30`; `term_secs >= 60`; `max_price_age > 0`; `min_principal > 0` | terms written, never mutated | `unauthorized`, `invalid_params` |
| `seed_solo_pool(amount)` | admin | `solo_pool.authority` | usdc -> solo usdc vault; `usdc_seeded += amount` | `unauthorized` |
| `open_loan(nonce, stock_raw, principal)` | borrower | mint allowlisted; price fresh; multiplier matches the stamp (D5); `principal >= min_principal`; `principal x 10000 <= H(stock_raw) x ltv_bps`; `solo_usdc_vault >= principal` | stock -> solo stock vault; usdc solo vault -> borrower; `due_at = now + term_secs`; `drawn_total += principal` | `collateral_below_minimum`, `principal_below_minimum`, `pool_insufficient`, `price_stale`, `multiplier_price_mismatch`, `multiplier_invalid`, `insufficient_balance` |
| `add_collateral(raw)` | borrower | Open; `raw > 0` | `stock_raw += raw`; then section 4.3 | `loan_not_open`, `invalid_params`, `insufficient_balance` |
| `repay(amount)` | anyone | Open; `0 < amount <= principal` | usdc -> solo vault; `principal -= amount`; `repaid_total += amount`; then section 4.3; at zero, status Repaid and the stock becomes claimable | `loan_not_open`, `invalid_params`, `insufficient_balance` |
| `mark_call()` | anyone | Open; price fresh; multiplier matches; `conservative > 0` | section 4.3. **Moves no tokens and touches neither `principal` nor `stock_raw`.** | `price_stale`, `multiplier_price_mismatch`, `conservative_price_unusable`, `loan_not_open` |
| `liquidate()` | anyone | section 4.2 | section 4.1 | `loan_not_open`, `loan_healthy`, `grace_not_elapsed`, `call_superseded`, `price_stale`, `multiplier_price_mismatch`, `conservative_price_unusable` |
| `close_loan()` | borrower | status Repaid or Liquidated; `stock_raw > 0` | transfers `stock_raw` from the solo stock vault to the borrower, then sets `stock_raw = 0`, which is the one-shot marker | `loan_still_open`, `nothing_to_claim` |
| `quote_loan(raw, principal)` | anyone, read only | mint + feed | `{mult_fixed, fund, exec, h, max_principal, health_bps, available_to_borrow}` | as `quote_valuation` |

Rounding follows SPEC section 4 without exception, **collateral down and
obligations up**, and no comparison divides:

```
H             = floor( min(FUND, EXEC) x (10000 - haircut_bps) / 10000 )
max_principal = floor( H x ltv_bps / 10000 )
healthy       iff principal x 10000 <= H x liquidation_bps          // u128, cross-multiplied
health_bps    = principal == 0 ? u32::MAX : sat_u32( u128(H) x 10000 / principal )
```

`health_bps` is **display only** and no decision reads it, exactly as the
circle's `last_coverage_bps`: every liquidation test cross-multiplies in u128
and never divides. `u32::MAX` means no debt and the UI renders it as "Nothing
owed", never as a percentage. It saturates rather than wrapping.

**`conservative` may be zero.** For a low-priced asset with a non-zero discount,
`floor(wrapper_price x (10000 - discount_bps) / 10000)` can be 0, which would
divide by zero in `seize_raw`. `open_loan`, `mark_call` and `liquidate` all
require `conservative > 0` and refuse `conservative_price_unusable` otherwise.
Checked at open as well, so a loan can never exist that could not be liquidated.

### 4.1 Liquidation, copied from SPEC section 6

Seizure is sized from the **non-scaled wrapper price only**, like the circle's
waterfall, so a scheduled multiplier change cannot move what a given number of
raw units is worth here. That is about the arithmetic, not about permission:
section 4.2 still refuses to liquidate at all unless `feed.priced_for_multiplier`
matches the effective multiplier, so D5 blocks liquidation during Repricing.
r3's prose said this "works during Repricing" and contradicted its own rule.
Staleness still applies. No USDC moves: the pool is the lender, so it does not
buy from itself.

```
conservative = floor( wrapper_price x (10000 - solo_pool.discount_bps) / 10000 )  // usdc per 1e8 raw
require conservative > 0 else conservative_price_unusable               // else the division below is undefined
seize_raw    = min(stock_raw, ceil( u128(principal) x 1e8 / conservative ))  // seize only what is owed
recovered    = floor( seize_raw x conservative / 1e8 )                  // exceeds the debt by < 1 raw unit's value
extinguished = min(principal, recovered)
written_off  = principal - extinguished                                 // the pool's realised loss

stock_raw          -= seize_raw          // the remainder stays the borrower's, claimed via close_loan
seized_raw          = seize_raw
principal           = 0
status              = Liquidated
written_off_total  += written_off
seized_raw_total   += seize_raw
```

The surplus is returned **in raw stock, never in USDC**. r1 mixed the two units,
which was Codex r1's MAJOR. The borrower's surplus is `stock_raw - seize_raw`
and it stays in the solo stock vault until `close_loan` moves it, which Codex r2
found r1 and r2 had referenced without ever defining: a partially liquidated
borrower's surplus was permanently trapped. The pool's excess recovery is under
one raw unit's conservative value, dust in the pool's favour exactly as SPEC
section 6 treats it.

**`close_loan` is the only path that returns stock to a borrower**, for both
Repaid and Liquidated. `repay` down to zero does not transfer stock; it sets
status Repaid and leaves the collateral claimable. One path, one shot: the
transfer sets `stock_raw = 0`, so a second call refuses `nothing_to_claim`. That
is also what keeps S4 exact, because the vault holds stock for every loan whose
claim has not been consumed.

### 4.2 When a loan is liquidatable

`liquidate` succeeds **iff all of**:

1. status is Open;
2. the price is fresh: `now - feed.updated_at <= max_price_age`;
3. `feed.priced_for_multiplier` equals the effective multiplier (D5, I13);
4. `conservative > 0`;

**and** either of:

- **undercollateralised**, all four: `called_at != 0`; `now > called_at + grace_secs`; the loan is **still unhealthy at this instant**; and the call is not superseded, meaning `feed.updated_at == called_price_updated_at` **and** the effective multiplier equals `called_multiplier_fixed`;
- **matured**: `now > due_at + grace_secs`, whatever the health.

**Why the call is bound to the price it was observed at.** r2 anchored the grace
on a bare timestamp, and Codex r2 showed that does not prove continuous
unhealthiness: a loan marked at price P1 can become healthy at P2 with nobody
calling, then unhealthy again at P3, and liquidation at P3 would reuse the P1
anchor and skip a fresh grace. Binding the call to `feed.updated_at` and to the
effective multiplier makes that impossible: **any** intervening price update or
epoch change voids the call, `liquidate` refuses `call_superseded`, and somebody
must call again and wait a fresh `grace_secs`.

The anchor therefore moves only on a real state change. `add_collateral` and
`repay` void a live call outright, since both can only improve health. There is
no action that resets the clock without either changing the price or curing the
loan.

Consequence worth naming: while a call is live, **any** price update voids it,
including a `touch_prices` that only moves `updated_at`. That delays liquidation
and never accelerates it, so it fails safe, but an operator refreshing prices on
a timer would keep cancelling calls. Recorded in section 7.

### 4.3 The margin call, and why a borrower cannot reset it

A call is `{called_at, called_price_updated_at, called_multiplier_fixed}`. It is
**live** when `called_at != 0`, and its **observation matches** when
`feed.updated_at == called_price_updated_at` and the effective multiplier equals
`called_multiplier_fixed`.

`mark_call()`, the only instruction that may set a call:

| loan | live call | observation | effect |
|---|---|---|---|
| healthy | either | either | clear all three fields |
| unhealthy | none | n/a | set `called_at = now`, record the observation |
| unhealthy | live | matches | **nothing at all.** `called_at` is not rewritten |
| unhealthy | live | differs | the old call is void; set `called_at = now` and record the new observation |

`repay` and `add_collateral`, after applying their effect:

| condition | effect on the call |
|---|---|
| price fresh, multiplier matches, and the loan is now healthy | clear all three fields |
| anything else, including a loan still unhealthy | **leave all three untouched** |

**Why this shape.** r3 let the borrower hold an undercollateralised loan open
for ever, and Codex r3 was right to call it a borrower-controlled delay rather
than a liveness limit. Two separate leaks: `mark_call` rewrote `called_at` every
time it was called, and `repay`/`add_collateral` voided a live call
unconditionally. Either way a borrower could repay one base unit a second before
grace expired and buy a whole fresh `grace_secs`, indefinitely, for almost
nothing.

Both are closed above. Calling `mark_call` at an unchanged price is now a no-op,
so repetition buys nothing. An action only clears the call by making the loan
**demonstrably healthy**, which is the cure, not a delay. `amount` and `raw` must
be positive, so a zero-value action cannot be used as a no-op that trips the
clearing path.

The clearing test needs a usable price, and if the price is stale or the
multiplier does not match, the call is **preserved** rather than cleared. That
fails safe in both directions: a preserved call cannot cause a wrongful
liquidation, because `liquidate` independently re-checks that the loan is still
unhealthy at that instant with a fresh price.

## 5. Invariants to add to INVARIANTS.md

| # | Invariant | Checked by |
|---|---|---|
| S1 | `principal x 10000 <= H x ltv_bps` immediately after `open_loan`, and after `add_collateral` | unit |
| S2 | **Cash conservation:** `solo_usdc_vault = usdc_seeded - drawn_total + repaid_total` after every instruction. Liquidation moves no USDC and so cannot appear here | test after every ix, including a circle default running in the same test |
| S3 | **Debt conservation:** `Sum(Loan.principal over Open) = drawn_total - repaid_total - written_off_total` | test after every ix |
| S4 | **Stock conservation:** `solo_stock_vault = Sum(Loan.stock_raw over every loan whose claim is unconsumed) + seized_raw_total` | test after every ix, including a circle default |
| S4b | **No crosstalk:** no solo instruction changes `LiquidationPool` or its vaults, and no circle instruction changes `SoloPool` or its vaults | test: run a circle default and a solo liquidation in one scenario and assert both accountings still hold |
| S5 | A loan is liquidatable **iff** every condition in section 4.2 holds. Each of stale price, mismatched multiplier, `conservative == 0`, unelapsed grace, healthy again at this instant, and a superseded call refuses separately | unit, one passing and one refusing case per clause |
| S6 | `seize_raw` is the smallest number of raw units whose conservative value covers the debt, capped at the collateral; `recovered` exceeds `extinguished` by less than one raw unit's conservative value; the borrower keeps `stock_raw - seize_raw` | unit, the I9 analogue |
| S7 | **A scheduled multiplier change never makes a healthy loan liquidatable at the wrong second.** NFLXx at 1763337299 and 1763337300, with the price stamped for the matching multiplier, leaves `health_bps` unchanged | unit with clock warp (the headline) |
| S8 | `repay` of exactly `principal` sets status Repaid, moves **no stock**, and creates exactly one claim; `close_loan` then returns exactly `stock_raw` once and refuses a second time. S2 and S3 hold throughout | unit |
| S9 | `due_at` never changes after `open_loan`, and a matured loan is liquidatable at any health | unit |
| S10 | `mark_call` changes nothing but the three call fields; it never moves tokens and never touches `principal` or `stock_raw` | unit (the `touch_prices` analogue, I17) |
| S11 | **A call does not survive the price it was made at.** Mark at P1, update the price, and `liquidate` refuses `call_superseded` however long the grace has run. Same for a multiplier epoch change | unit with clock warp |
| S12 | **Every borrower's surplus is claimable exactly once.** After a partial liquidation, `close_loan` returns `stock_raw - seize_raw` and a second call refuses; no path leaves stock unreachable in the vault | unit + scenario |
| S13 | **No borrower action extends the liquidation grace.** `mark_call` at an unchanged observation leaves `called_at` unchanged; a `repay` or `add_collateral` that leaves the loan unhealthy leaves all three call fields unchanged. A 1-unit repayment loop cannot postpone liquidation | unit: mark, warp to one second before grace, repay 1, warp one second, liquidate must succeed |

S7 is the solo mirror of I12 and is why the mode is worth building: it is I13's
epoch match doing its job for a single borrower.

## 6. What it does NOT add

No interest, no partial collateral release before full repayment, no open-market
liquidation (the pool is the only counterparty, as in the circle), no second
collateral asset, no reputation, no cross-loan netting, no lender deposits. Each
is already cut in `FRAME.md:38`.

## 7. Accepted limits, to be recorded in KNOWN-LIMITS by the design session

1. **The pool is admin-risk demo liquidity.** Seed capital is the demo admin's,
   there is no lender deposit and **no redemption promise to anyone**. The site
   must say so on the borrow place.
2. **"Available to borrow" means the current USDC vault balance and nothing
   else.** Seized stock is not cash and never counts toward it.
3. **Permissionless liquidation carries no caller reward**, so there is no
   reliable keeper. In the demo the admin triggers it. A bonus was considered
   and rejected for Tier 1: it needs its own term in S2 and S3, and the demo has
   one operator. Consequence: a loan can sit unhealthy past its grace until
   someone calls.
4. **A shared pool can be drawn to zero** by one borrower, and the next gets
   `pool_insufficient`.
5. **A live margin call is voided by any price update**, including a
   `touch_prices` that moves only `updated_at`. This fails safe, because it can
   only delay a liquidation and never bring one forward, but an operator
   refreshing prices on a timer would keep cancelling calls. The demo calls
   `touch_prices` once, at submission, and not while a call is live.
6. **Collateral is returned only by `close_loan`**, which the borrower signs.
   A borrower who never calls it leaves their own stock in the vault. Rent on
   the `Loan` account stays locked, as with `Member` in the circle.

## 8. Demo

Seed the pool. Borrower locks 1.1 NFLXx and draws against it. Schedule the real
10-for-1 split. A naive lender liquidates at the split second; Othello does not,
because `priced_for_multiplier` must match the effective multiplier before
`liquidate` will act, and H is unchanged across the boundary.

## 9. Sequencing

Gate 1 continues unaffected. Solo becomes its own gate after gate 1 and before
the circle gates, **conditional on this amendment being accepted**: it is newly
specced and therefore the riskier work, and it reuses gate 1's valuation while
that is still fresh. The circle gates keep the shape four review rounds
hardened.

## 10. What changed in r4, answering Codex r3

- **CRITICAL, borrower-controlled liquidation delay.** r3's call could be reset
  by the borrower two ways: `mark_call` rewrote `called_at` on every unhealthy
  call, and `repay` or `add_collateral` voided a live call unconditionally, so
  repaying one base unit just before grace expired bought a whole fresh window,
  indefinitely, for almost nothing. Section 4.3 now states the call as an
  explicit state machine: `mark_call` at an unchanged observation is a no-op, an
  action clears the call only when it leaves the loan **demonstrably healthy**,
  and `amount` and `raw` must be positive so a zero-value action cannot trip the
  clearing path. S13 pins it with the 1-unit repayment loop as the test.
- **MAJOR, no creation path.** `SoloPool` had no initialiser, so
  `seed_solo_pool` assumed an authority, mints, a discount and PDA vaults that
  nothing created. `init_solo_pool(discount_bps)` added, with mint binding, the
  allowlist check, the discount range and vault creation.
- **MAJOR, contradictory invariant.** S8 said full repayment "returns exactly
  `stock_raw`" while section 4.1 said only `close_loan` transfers stock. Both
  could not hold. S8 now asserts repayment creates exactly one claim and moves
  no stock, and that `close_loan` returns it exactly once.
- **MINOR, contradictory prose.** Section 4.1 claimed liquidation "works during
  Repricing", which section 4.2 correctly forbids. The wrapper price governs the
  seizure arithmetic; D5 still blocks the action. Prose amended, rule unchanged.

## 11. What changed in r3, answering Codex r2

- **CRITICAL, shared pool.** `LiquidationPool` is the circle's counterparty and
  `declare_default` moves its USDC and stock without touching any solo counter,
  so S2 and S4 were false the first time any circle defaulted. Replaced by a
  separate `SoloPool` with its own vaults and PDA namespace, plus S4b asserting
  no crosstalk in either direction.
- **CRITICAL, trapped surplus.** r1 and r2 both referenced a `close_loan` that
  was never defined, so a partially liquidated borrower's remaining stock was
  unreachable. `close_loan` is now specified and is the **only** path that
  returns stock, for Repaid and Liquidated alike, one-shot via `stock_raw = 0`.
  S12 covers it.
- **CRITICAL, the call did not prove continuous unhealthiness.** A loan marked
  at P1 could become healthy at P2 and unhealthy again at P3, and liquidation at
  P3 would reuse the P1 anchor. The call now records the `feed.updated_at` and
  effective multiplier it was observed at, and `liquidate` refuses
  `call_superseded` unless both still match. S11 covers it, and the consequence
  is recorded as limit 5.
- **MAJOR, division by zero.** `conservative` can floor to zero for a low-priced
  asset with a non-zero discount. Now required `> 0` in `open_loan`, `mark_call`
  and `liquidate`, refusing `conservative_price_unusable`, so a loan that could
  never be liquidated cannot be opened either.
- **MINOR, `health_bps`.** Defined as `principal == 0 ? u32::MAX : sat_u32(H x
  10000 / principal)`, display only, saturating, with the "Nothing owed"
  rendering rule. Every decision still cross-multiplies and never divides.

## 12. What changed in r2, answering Codex r1

- **CRITICAL, pool cash accounting.** r1's S2 counted written-off principal as
  if it returned cash. Replaced by three conservation equations, S2 cash, S3
  debt, S4 stock, with the pool counters they need. Liquidation is defined to
  move no USDC at all, which is what makes S2 exact.
- **CRITICAL, no maturity.** Added `term_secs`, an immutable `due_at`, and a
  matured branch in section 4.2. Named in section 1 as a zero-coupon loan,
  because no-interest is only defensible with one.
- **MAJOR, terms.** Added the versioned immutable `LoanTerms` account, snapshot
  into each `Loan`, `max_price_age` included, pool and nonce in the PDA seeds,
  and explicit binding of feed, vaults and both mints.
- **MAJOR, liquidation.** Section 4.1 now copies SPEC section 6's conservative
  price, `ceil` on `sell_raw`, floored `recovered` and the one-raw-unit bound,
  and returns surplus in raw stock rather than mixing units. S6 replaces r1's
  unmeaningful "never takes more than principal".
- **MAJOR, the false iff.** Section 4.2 states the full condition set including
  Open, freshness and multiplier match. A grace anchor added as a
  deterministic grace anchor that only a real health transition can move, with
  `mark_call` as the only instruction that sets it.
- **MINOR.** "Available to borrow" defined as the vault balance only; the
  admin-risk and no-redemption statements added to section 7; solo restated as
  its own risk gate in section 2, not gate 1 reused.
- **Keeper incentive**, raised in the closing note: addressed in section 7 item
  3 as an accepted limit with the reasoning for rejecting a bonus in Tier 1.
