# Proposal: Borrow Solo (admin-seeded pool)

Status: DRAFT r2 for the design session. Not spec. Written by the build session
on Joshua's ruling of 2026-09-22, which reverses the `Borrow solo` cut recorded
in `design/FRAME.md:38` and inherited by `SPEC.md:27`.

r2 answers Codex r1 (2 CRITICAL, 3 MAJOR, 1 MINOR). Section 10 lists what moved.

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
#[account] pub struct LoanTerms {         // seeds ["loan_terms", pool, version.to_le_bytes()]
  pub pool: Pubkey, pub version: u16, pub bump: u8,
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
#[account] pub struct Loan {               // seeds ["loan", pool, borrower, nonce.to_le_bytes()]
  pub borrower: Pubkey, pub pool: Pubkey, pub nonce: u64, pub bump: u8,
  pub stock_mint: Pubkey, pub usdc_mint: Pubkey, pub price_feed: Pubkey,
  pub terms_version: u16,                  // which LoanTerms this opened under
  pub haircut_bps: u16, pub ltv_bps: u16, pub liquidation_bps: u16,   // snapshot
  pub grace_secs: i64, pub max_price_age: i64,                        // snapshot
  pub stock_raw: u64,                      // collateral still the borrower's
  pub principal: u64,                      // usdc still owed, 6-dp base units
  pub opened_at: i64, pub due_at: i64,     // due_at immutable after open
  pub unhealthy_since: i64,                // 0 when healthy; the liquidation-grace anchor
  pub seized_raw: u64, pub written_off: u64,  // set once, at liquidation
  pub status: LoanStatus,                  // Open | Repaid | Liquidated
}
```

`price_feed` must be the PDA `["price", stock_mint]`; both pool vaults are
checked for owner and mint; `usdc_mint` and `stock_mint` must match the pool's.

### 3.3 Pool counters (added to LiquidationPool)

```rust
pub usdc_seeded: u64,        // cumulative seeded by the admin
pub drawn_total: u64,        // cumulative out of the vault via open_loan
pub repaid_total: u64,       // cumulative into the vault via repay
pub written_off_total: u64,  // cumulative debt extinguished by liquidation
pub seized_raw_total: u64,   // cumulative raw stock the pool has taken
```

## 4. Instruction surface

| Instruction | Signer | Preconditions | Effect | Refusals |
|---|---|---|---|---|
| `init_loan_terms(version, ...)` | admin | `pool.authority`; terms slot for `version` empty; `0 < ltv_bps < liquidation_bps <= 10000`; `0 <= haircut_bps < 10000`; `pool.discount_bps <= haircut_bps`; `grace_secs >= 30`; `term_secs >= 60`; `max_price_age > 0`; `min_principal > 0` | terms written, never mutated | `unauthorized`, `invalid_params` |
| `seed_pool(amount)` | admin | `pool.authority` | usdc -> pool vault; `usdc_seeded += amount` | `unauthorized` |
| `open_loan(nonce, stock_raw, principal)` | borrower | mint allowlisted; price fresh; multiplier matches the stamp (D5); `principal >= min_principal`; `principal x 10000 <= H(stock_raw) x ltv_bps`; `pool_usdc_vault >= principal` | stock -> pool stock vault; usdc pool -> borrower; `due_at = now + term_secs`; `drawn_total += principal` | `collateral_below_minimum`, `principal_below_minimum`, `pool_insufficient`, `price_stale`, `multiplier_price_mismatch`, `multiplier_invalid`, `insufficient_balance` |
| `add_collateral(raw)` | borrower | Open | `stock_raw += raw`; clears `unhealthy_since` if healthy and prices are usable | `loan_not_open`, `insufficient_balance` |
| `repay(amount)` | anyone | Open; `amount <= principal` | usdc -> pool vault; `principal -= amount`; `repaid_total += amount`; clears `unhealthy_since` if healthy; at zero, all `stock_raw` returns and status Repaid | `loan_not_open`, `insufficient_balance` |
| `mark_call()` | anyone | Open; price fresh; multiplier matches | sets `unhealthy_since = now` if unhealthy and it is 0; clears it to 0 if healthy. **Nothing else.** | `price_stale`, `multiplier_price_mismatch`, `loan_not_open` |
| `liquidate()` | anyone | section 4.2 | section 4.1 | `loan_not_open`, `loan_healthy`, `grace_not_elapsed`, `price_stale`, `multiplier_price_mismatch` |
| `quote_loan(raw, principal)` | anyone, read only | mint + feed | `{mult_fixed, fund, exec, h, max_principal, health_bps, available_to_borrow}` | as `quote_valuation` |

Rounding follows SPEC section 4 without exception, **collateral down and
obligations up**, and no comparison divides:

```
H            = floor( min(FUND, EXEC) x (10000 - haircut_bps) / 10000 )
max_principal= floor( H x ltv_bps / 10000 )
healthy      iff principal x 10000 <= H x liquidation_bps          // u128, cross-multiplied
```

### 4.1 Liquidation, copied from SPEC section 6

Uses the **non-scaled wrapper price only**, like the circle's waterfall, so it
works during Repricing. Staleness still applies. No USDC moves: the pool is the
lender, so it does not buy from itself.

```
conservative = wrapper_price x (10000 - pool.discount_bps) / 10000      // usdc per 1e8 raw
seize_raw    = min(stock_raw, ceil( u128(principal) x 1e8 / conservative ))  // seize only what is owed
recovered    = floor( seize_raw x conservative / 1e8 )                  // exceeds the debt by < 1 raw unit's value
extinguished = min(principal, recovered)
written_off  = principal - extinguished                                 // the pool's realised loss

stock_raw          -= seize_raw          // the remainder stays the borrower's, returned as STOCK
seized_raw          = seize_raw
principal           = 0
status              = Liquidated
written_off_total  += written_off
seized_raw_total   += seize_raw
```

The surplus is returned **in raw stock, never in USDC**. r1 mixed the two units
and that was the substance of Codex's MAJOR; the borrower's surplus is
`stock_raw - seize_raw`, claimable by `close_loan`, and the pool's excess
recovery is under one raw unit's conservative value, which is dust in the pool's
favour exactly as SPEC section 6 treats it.

### 4.2 When a loan is liquidatable

`liquidate` succeeds **iff all of**: status is Open; the price is fresh
(`now - feed.updated_at <= max_price_age`); `feed.priced_for_multiplier` equals
the effective multiplier (D5, I13); **and** either

- **undercollateralised**: `unhealthy_since != 0`, `now > unhealthy_since + grace_secs`, **and** the loan is still unhealthy at this instant, or
- **matured**: `now > due_at + grace_secs`, whatever the health.

`unhealthy_since` is the deterministic grace anchor and moves only in
`mark_call`, `add_collateral` and `repay`, and only on the actual health
transition. It cannot be reset by a trivial action, because clearing it requires
the loan to be genuinely healthy again. The cure is `add_collateral` or `repay`.

## 5. Invariants to add to INVARIANTS.md

| # | Invariant | Checked by |
|---|---|---|
| S1 | `principal x 10000 <= H x ltv_bps` immediately after `open_loan`, and after `add_collateral` | unit |
| S2 | **Cash conservation:** `pool_usdc_vault = usdc_seeded - drawn_total + repaid_total` after every instruction. Liquidation moves no USDC and so cannot appear here | test after every ix |
| S3 | **Debt conservation:** `Sum(Loan.principal over Open) = drawn_total - repaid_total - written_off_total` | test after every ix |
| S4 | **Stock conservation:** `pool_stock_vault = Sum(Loan.stock_raw over Open and Liquidated-unclaimed) + seized_raw_total` | test after every ix |
| S5 | A loan is liquidatable **iff** every condition in section 4.2 holds. Stale prices, a mismatched multiplier, an unelapsed grace and a loan healthy again at the instant of the call each refuse | unit, one passing and one refusing case per clause |
| S6 | `seize_raw` is the smallest number of raw units whose conservative value covers the debt, capped at the collateral; `recovered` exceeds `extinguished` by less than one raw unit's conservative value; the borrower keeps `stock_raw - seize_raw` | unit, the I9 analogue |
| S7 | **A scheduled multiplier change never makes a healthy loan liquidatable at the wrong second.** NFLXx at 1763337299 and 1763337300, with the price stamped for the matching multiplier, leaves `health_bps` unchanged | unit with clock warp (the headline) |
| S8 | `repay` of exactly `principal` returns exactly `stock_raw` and leaves S2 and S3 true | unit |
| S9 | `due_at` never changes after `open_loan`, and a matured loan is liquidatable at any health | unit |
| S10 | `mark_call` changes nothing but `unhealthy_since`; it never moves tokens and never touches `principal` or `stock_raw` | unit (the `touch_prices` analogue, I17) |

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

## 10. What changed from r1

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
  Open, freshness and multiplier match. `unhealthy_since` added as a
  deterministic grace anchor that only a real health transition can move, with
  `mark_call` as the only instruction that sets it.
- **MINOR.** "Available to borrow" defined as the vault balance only; the
  admin-risk and no-redemption statements added to section 7; solo restated as
  its own risk gate in section 2, not gate 1 reused.
- **Keeper incentive**, raised in the closing note: addressed in section 7 item
  3 as an accepted limit with the reasoning for rejecting a bonus in Tier 1.
