# Proposal: Borrow Solo (admin-seeded pool)

Status: DRAFT for the design session. Not spec. Written by the build session on
Joshua's ruling of 2026-09-22, which reverses the `Borrow solo` cut recorded in
`design/FRAME.md:38` and inherited by `SPEC.md:27`.

The build session cannot amend `SPEC.md`, `INVARIANTS.md`, `ARCHITECTURE.md` or
the ADRs. This is the concrete shape so that the design session and Codex can
rule on one draft instead of an idea.

## 1. What it is

One borrower locks xStock and draws USDC against it from a pool the demo admin
seeds. No rotation, no turn order, no mutual coverage. The circle is unchanged
and both modes ship.

## 2. Why it fits the hackathon claim better than it looks

Gate 1 is shared entirely. A solo loan is pure collateral valuation, so the
whole of T02 to T06 is reused with nothing added:

- exact `floor(multiplier x 1e9)` (ADR-001)
- the multiplier read off the real mint, selected on the Clock
- `FUND`, `EXEC`, `H` from SPEC section 4
- the mint allowlist (ADR-012)

It also demonstrates the core defect more sharply than the circle does. NFLXx's
real 10-for-1 split is a **liquidation event for a naive lender**: a reader that
ignores `newMultiplierEffectiveTimestamp` values the borrower's collateral at a
tenth the instant the split lands, and margin-calls a borrower who is fine. The
circle shows the same bug as a refused payout; solo shows it as someone losing
their stock. That is the more legible demo.

## 3. Accounts

Reuses `LiquidationPool` (SPEC section 4) as the capital source, which already
holds a USDC vault, a stock vault, an `authority` and `discount_bps`.

```rust
#[account] pub struct Loan {              // seeds ["loan", borrower, stock_mint]
  pub borrower: Pubkey, pub bump: u8,
  pub stock_mint: Pubkey, pub usdc_mint: Pubkey,
  pub price_feed: Pubkey, pub pool: Pubkey,
  pub stock_raw: u64,                     // collateral locked
  pub principal: u64,                     // usdc drawn, 6-dp base units
  pub opened_at: i64, pub last_touched_at: i64,
  pub haircut_bps: u16,                   // as the circle: H = min(FUND,EXEC) x (1 - haircut)
  pub ltv_bps: u16,                       // principal may not exceed H x ltv_bps / 10000
  pub liquidation_bps: u16,               // liquidatable when principal x 1e4 > H x liquidation_bps
  pub grace_secs: i64,
  pub status: LoanStatus,                 // Open | Repaid | Liquidated
}
```

No interest. Interest curves are cut in `FRAME.md:38` and adding them would
need an accrual model, a clock-driven balance and a second rounding direction.
The demo is about collateral valuation, not yield.

## 4. Instruction surface

| Instruction | Signer | Preconditions | Effect | Refusals |
|---|---|---|---|---|
| `init_loan_terms(haircut_bps, ltv_bps, liquidation_bps, grace_secs)` | admin | `pool.authority`; `ltv_bps < liquidation_bps <= 10000`; `pool.discount_bps <= haircut_bps` | terms stored on the pool | `unauthorized`, `invalid_params` |
| `open_loan(stock_raw, principal)` | borrower | mint on the allowlist; price fresh; not repricing; `principal x 1e4 <= H(stock_raw) x ltv_bps`; pool USDC >= principal | stock -> pool stock vault, USDC pool -> borrower | `collateral_below_minimum`, `pool_insufficient`, `price_stale`, `multiplier_price_mismatch`, `multiplier_invalid`, `insufficient_balance` |
| `add_collateral(raw)` | borrower | Open | `stock_raw += raw`; the cure for a margin call | `insufficient_balance`, `loan_not_open` |
| `repay(amount)` | anyone (pays the borrower's debt) | Open; `amount <= principal` | USDC -> pool vault; `principal -= amount`; at zero, stock returns and status Repaid | `loan_not_open`, `insufficient_balance` |
| `liquidate(  )` | anyone | Open; `principal x 1e4 > H x liquidation_bps`; `now > last_touched_at + grace_secs`; price fresh; not repricing | pool keeps the stock at the conservative price, `principal` written down, status Liquidated, any surplus returned to the borrower | `loan_healthy`, `grace_not_elapsed`, `price_stale`, `multiplier_price_mismatch` |
| `quote_loan(raw, principal)` | anyone, read only | mint + feed | returns `{mult_fixed, fund, exec, h, max_principal, health_bps}` | as `quote_valuation` |

Rounding follows SPEC section 4 without exception: **collateral rounds down,
obligations round up**. `H` floors; `max_principal = floor(H x ltv_bps / 1e4)`;
the liquidation test multiplies out and never divides.

## 5. Invariants to add to INVARIANTS.md

| # | Invariant | Checked by |
|---|---|---|
| S1 | `principal x 1e4 <= H x ltv_bps` immediately after `open_loan` and after `add_collateral` | unit |
| S2 | pool USDC vault balance = seeded - Sum(open principals) + Sum(repaid), never negative | test after every ix |
| S3 | pool stock vault balance = Sum(`Loan.stock_raw`) over Open loans + seized | test after every ix |
| S4 | a loan is liquidatable **iff** `principal x 1e4 > H x liquidation_bps` and the grace has elapsed | unit, one passing and one refusing case |
| S5 | liquidation returns any surplus above the debt at the conservative price to the borrower; the pool never takes more than `principal` | unit |
| S6 | **A scheduled multiplier change never makes a healthy loan liquidatable at the wrong second.** NFLXx at 1763337299 and 1763337300, with the price stamped for the matching multiplier, leaves health unchanged | unit with clock warp (this is the headline) |
| S7 | `repay` of exactly `principal` returns exactly `stock_raw` and leaves the pool whole | unit |

S6 is the solo mirror of I12 and the reason this mode is worth building: it is
I13's epoch match doing its job for a single borrower.

## 6. What it does NOT add

No interest, no partial-collateral release before full repayment, no
open-market liquidation (the pool is the only buyer, as in the circle), no
second collateral asset, no reputation, no cross-loan netting. Each of those is
already cut in `FRAME.md:38` and none is needed for the claim.

## 7. Open question for the design owner

Pool solvency. With one admin-seeded pool backing every loan, a borrower can
draw it to zero and the next borrower gets `pool_insufficient`. That is honest
for a demo and needs saying on the site. The alternative, per-loan escrow, means
the pool cannot be shared and the demo needs a seed per borrower. Recommend the
shared pool plus a visible "available to borrow" figure.

## 8. Sequencing proposed

Gate 1 is unaffected and continues. Solo lands as a new gate between gate 1 and
the circle gates, because it is newly specced and therefore the riskier work,
and because it reuses gate 1 directly while its design is still fresh. The
circle gates keep the shape four review rounds hardened.
