# SPEC: Othello (authoritative build spec)

Frozen by the design session 2026-09-21 after four adversarial review rounds (design/reviews/, final verdict implementation-ready).
**Authority order:** this file > INVARIANTS.md > ARCHITECTURE.md > adr/ > design/*.md (history) > ../SPEC.md v4 (economics source; where they differ, this file wins and the difference is recorded in KNOWN-LIMITS).
Nothing here is implementation code: struct layouts and formulas are specification.

## 1. Goals, non-goals

**Goals (FR)**
- FR-1 Create a circle naming 3-8 wallets, turn order, contribution, round length, grace, haircut, coverage target, guarantee per member, minimum stock cover.
- FR-2 A named member joins by locking stock and depositing the guarantee in one transaction.
- FR-3 Creator activates when all joined; cancels (full refund) while Forming.
- FR-4 Members contribute each round; anyone releases the pot when funded and the gate passes.
- FR-5 Anyone recomputes coverage (`update_coverage`).
- FR-6 Anyone declares a post-payout default after deadline + grace; the waterfall runs atomically.
- FR-7 Members add stock or top up the reserve at any time while Active.
- FR-8 After Completed or Cancelled, each member withdraws stock, unused guarantee and top-ups pro rata.
- FR-9 A read-only valuation quote shows raw, multiplier, both prices, both values, stock cover.
- FR-10 Demo admin sets prices and seeds the pool; a script schedules the mint's multiplier change.

**NFR (prioritised)**
1. NFR-1 Correctness of money maths: fixed-point only, rounding in the protocol's favour, checked u128. (functional correctness)
2. NFR-2 Every refusal carries the numbers the UI needs (needed vs have). (usability / interaction capability)
3. NFR-3 Every instruction fits in the default 200k CU with n = 8. ASSUMPTION, measured in gate 1 and gate 2.
4. NFR-4 Demo runs start to finish in under 6 minutes of wall time with 120 s rounds.

**Non-goals.** FRAME section 4 plus: multi-asset collateral (D1), open join (D3), cross-circle reputation (D9), keeper rewards, indexer.

---

## 4. Data (Anchor account layouts, specification only)

Units: `usdc` = 6-dp base units. `raw` = 8-dp stock base units. Prices = USDC base units per **1 whole token** (10^8 raw). Multiplier fixed = ×1e9.

```rust
#[account] pub struct Circle {            // seeds ["circle", creator, circle_id.to_le_bytes()]
  pub creator: Pubkey, pub circle_id: u64, pub bump: u8,
  pub stock_mint: Pubkey, pub usdc_mint: Pubkey, pub price_feed: Pubkey, pub pool: Pubkey,
  pub n: u8,                               // 3..=8
  pub members: [Pubkey; 8],                // index = turn (0-based); unused = default
  pub contribution: u64,                   // usdc per member per round
  pub round_secs: i64, pub grace_secs: i64,
  pub haircut_bps: u16,                    // e.g. 2000 = 20% off
  pub coverage_bps: u16,                   // 13000 on the demo circle (SPEC 3 table)
  pub warn_bps: u16,                       // 11000
  pub guarantee_per_member: u64,           // usdc
  pub min_stock_cover: u64,                // usdc, checked at join
  pub max_price_age: i64,                  // demo circle: 691_200 (8 days, covers judging to 2 Oct)
  pub status: CircleStatus,                // Forming | Active | Completed | Cancelled
  pub round: u8,                           // 0-based current round
  pub round_deadline: i64,
  pub paid_bitmap: u8,                     // contributions received this round
  pub joined_bitmap: u8, pub withdrawn_bitmap: u8, pub received_bitmap: u8, pub defaulted_bitmap: u8,
  pub reserve_total: u64, pub reserve_losses: u64, pub reserve_allocated: u64,
  pub escrow: u64,                         // replacement escrow (usdc)
  pub escrow_deficit: u64,                 // O not fundable at default time (r2, CRIT-1)
  pub withdrawn_usdc: u64,                 // cumulative paid out by withdraw (r2, I3)
  pub deposits_total: u64,                 // Σ guarantee + top-ups currently settled in the circle; a Forming unwind (leave_forming) reverses its own deposit (r5)
  pub forfeited_total: u64,                // Σ Member.forfeited (r3)
  pub next_gate_short_by: u64,             // > 0 means Paused (r3); see §5
  pub held_contributions: u64,             // this round's contributions not yet released
  pub last_coverage_at: i64,
}
#[account] pub struct Member {             // seeds ["member", circle, wallet]
  pub circle: Pubkey, pub wallet: Pubkey, pub turn: u8, pub bump: u8,
  pub stock_raw: u64, pub guarantee: u64, pub top_ups: u64,
  pub forfeited: u64,                      // own guarantee+top-ups consumed by own default (r2)
  pub rounds_paid: u8,                     // including escrow-paid
  pub allocated: u64,                      // G_i, last recompute; 0 once defaulted
  pub last_coverage_bps: u32,              // saturating; u32::MAX when O_i = 0 or member is defaulted (obligations prepaid). UI renders u32::MAX as "Nothing owed" (O = 0) or "Prepaid" (defaulted), never a percentage
}
#[account] pub struct PriceFeed {          // seeds ["price", stock_mint]
  pub authority: Pubkey, pub bump: u8,
  pub wrapper_price: u64,                  // NON-SCALED price of 1 whole raw token
  pub share_price: u64,                    // price of 1 underlying share
  pub priced_for_multiplier: u64,          // fixed 1e9; D5
  pub updated_at: i64,
}
#[account] pub struct LiquidationPool {    // seeds ["pool", usdc_mint, stock_mint]
  pub authority: Pubkey, pub bump: u8,
  pub discount_bps: u16,                   // conservative sale price = wrapper_price x (1 - discount)
}
```
Token accounts, all PDA-owned: `circle_stock_vault` (Token-2022), `circle_usdc_vault` (SPL), `pool_stock_vault`, `pool_usdc_vault`.

Derived, never stored as truth: `O_i`, `H_i`, required `G_i`, `reserve_free`.

```
O_i  = received_i ? contribution x (n - rounds_paid_i) : 0            // round UP (already integer)
FUND = floor( raw x mult_fixed x share_price / (1e9 x 1e8) )          // u128
EXEC = floor( raw x wrapper_price / 1e8 )
H_i  = floor( min(FUND, EXEC) x (10000 - haircut_bps) / 10000 )
need_i = max(0, ceil(O_i x coverage_bps / 10000) - H_i)                // G required
reserve_free = reserve_total - reserve_losses - reserve_allocated
```

## 5. Instruction surface

**Admin (r6).** "admin" is the program's upgrade authority. `init_price_feed` and `init_pool` require it as signer, read from the upgradeable loader's ProgramData account for this program; `set_prices`, `touch_prices` and `seed_pool` check the authority those two recorded (`feed.authority`, `pool.authority`). A program deployed immutable has no admin. No config account exists and none is needed: the deploy key is the root, so there is no window after deploy in which anyone else can claim a feed.

| Instruction | Signer / auth | Preconditions (on-chain checks) | Effect | Refusal codes |
|---|---|---|---|---|
| `create_circle(params, members[..n])` | creator (must be in members) | 3≤n≤8, unique wallets, mints/feed/pool match, **param ranges below**, **peak-guarantee check below** | Circle Forming | `invalid_params`, `guarantee_below_peak_need` |
| `join_and_lock(stock_raw)` | signer found by scanning `members[..n]` (turn = index; no turn argument); creates the member's USDC ATA if missing (member pays) so release_pot never has to | Forming, not joined, H(stock_raw) ≥ min_stock_cover, price fresh + not repricing | stock → vault, guarantee → vault, reserve_total += g, deposits_total += g | `not_a_member`, `circle_not_forming`, `collateral_below_minimum`, `insufficient_balance`, `price_stale`, `multiplier_price_mismatch`, `multiplier_invalid` |
| `cancel_circle` | creator | Forming | status Cancelled (refunds via withdraw) | `circle_not_forming` |
| `leave_forming` | a joined member, own seat only | Forming | stock_raw → member; guarantee + top_ups → member; joined bit cleared; reserve_total −= (g + t); deposits_total −= (g + t); Member PDA closed to the wallet (a clean rejoin is possible); withdrawn_usdc and withdrawn_bitmap unchanged; emits MemberLeftForming | `circle_not_forming` |
| `activate` | creator | Forming, joined_bitmap full | Active, round 0, deadline = now + round_secs | `not_all_joined` |
| `contribute` | member, not defaulted | Active, bit unpaid. **No time check (r2):** a late payment before a default is declared is a cure | usdc → vault, held += c, bit set, rounds_paid++ | `already_contributed`, `circle_not_active`, `already_defaulted`, `insufficient_balance` |
| `release_pot` | anyone; all n Member accounts passed as writable `remaining_accounts` in turn order | Active; every seat paid OR defaulted; `escrow ≥ k×c` where k = defaulted unpaid seats; price fresh; not repricing; **gate** | escrow −= k×c and each such seat: paid bit, rounds_paid++; **for every member in the gate sum `allocated_i = need_i`, `last_coverage_bps_i = O_i == 0 ? u32::MAX : sat_u32((H_i + need_i)·1e4 / O_i)`; all others `allocated_i = 0`** (r4, keeps Σ allocated = reserve_allocated); pot n×c → recipient (if the recipient's USDC ATA is missing, `init_if_needed` with the caller as payer); received bit; `reserve_allocated` = gate sum; **next round: `round_deadline = now + round_secs`, `paid_bitmap = 0`, `held_contributions = 0`**; or Completed after n payouts | `round_not_funded{missing_seats, escrow, escrow_needed, escrow_deficit, short_by: next_gate_short_by}`, `coverage_too_low`, `reserve_overcommitted`, `price_stale`, `multiplier_price_mismatch`; after paying, recomputes `next_gate_short_by` for the new round |
| `update_coverage` | anyone; all Member accounts writable (each validated: `.circle == circle`, `.turn == index`) | Active (refused `circle_not_active` at Completed; next_gate_short_by = 0 at Completed) | recompute H, need; **allocate in turn order, earliest recipient first: `allocated_i = min(need_i, remaining)`**, `reserve_allocated = Σ allocated_i` (≤ R − L by construction); `last_coverage_bps_i = (H_i + allocated_i)·1e4 / O_i` (u32::MAX when O_i = 0); `next_gate_short_by` = max(0, S_next − (R − L)) + escrow_deficit where **S_next uses `O_i = c × (n − round − 1)` for every received non-defaulted member and for the current recipient** (the values the gate will see once every seat has paid; never stored rounds_paid) (r4); last_coverage_at = now | `price_stale`, `multiplier_price_mismatch` |
| `declare_default(turn)` | anyone; all Member accounts writable | Active, now > deadline + grace, seat unpaid, received(turn), not defaulted, wrapper price fresh, pool USDC ≥ recovered | waterfall (section 6). Then: if the share price is fresh and not repricing, recompute exactly as update_coverage; **otherwise do not compute H: allocated_d = 0; `remaining = R − L`; for survivors in turn order `allocated_i = min(allocated_i, remaining)`, `remaining −= allocated_i`; `reserve_allocated = Σ allocated_i`; `next_gate_short_by += shortfall − loss` (approximate until the next update_coverage); last_coverage_at not stamped** (r4) | `grace_not_elapsed`, `seat_already_paid`, `pre_payout_default_unsupported`, `already_defaulted`, `price_stale`, `pool_insufficient` |
| `add_stock(raw)` | member, not defaulted | Forming (joined) or Active | stock_raw += raw | `insufficient_balance` |
| `top_up_reserve(amount)` | member, **not defaulted** | Active | fill = min(escrow_deficit, amount); **escrow += fill; escrow_deficit −= fill; reserve_total += amount − fill**; top_ups += amount; deposits_total += amount; then `next_gate_short_by = max(0, (v − D) − (amount − fill)) + (D − fill)` with v, D the old field and deficit (exact for unchanged prices; no H needed, r4) (r3: reserve_losses does not move on a top-up; the fill shows as "used to prefund defaults" = deposits_total − reserve_total, computed in the UI) | `insufficient_balance`, `already_defaulted` |
| `withdraw` | member | Completed or Cancelled, not withdrawn | section 7 | `not_finished`, `already_withdrawn` |
| `quote_valuation(raw)` | anyone, read-only | mint + feed | returns `{mult_fixed, fund, exec, h}` via return data | `multiplier_invalid`, `price_stale`, `multiplier_price_mismatch` |
| `init_price_feed`, `set_prices(wrapper, share, stamp, expected_multiplier_fixed)` | admin | authority; prices > 0; reads the mint; **`expected_multiplier_fixed` must equal the value the stamp would write** (the script states which multiplier the prices are for, the program verifies it); **`stamp = Current` refused while a Scheduled stamp is pending** (feed.priced_for = mint.newMultiplier and its effective time is in the future) | wrapper/share set; `priced_for_multiplier` stamped from the mint (`Current` → effective now, `Scheduled` → newMultiplier); updated_at = now | `unauthorized`, `invalid_params`, `multiplier_invalid`, `multiplier_price_mismatch` |
| `touch_prices` | admin | authority | **only** `updated_at = now`; prices and stamp untouched (r3: the refresh script calls this, never set_prices) | `unauthorized` |
| `init_pool(discount_bps)`, `seed_pool(amount)` | admin | authority; discount_bps < 10000; stock mint allowlisted; **USDC mint owned by classic SPL Token, never Token-2022** (r6: circles take the USDC mint from the pool's seeds, and a transfer-fee mint would make reserve_total larger than the vault, breaking I3); seed amount > 0 and ≤ the signer's balance | pool and both pool vaults created (associated token accounts of the pool PDA); pool vault funded from the signer's own USDC; emits PoolInitialized / PoolSeeded | `unauthorized`, `invalid_params`, `mint_not_allowed`, `insufficient_balance` |

Multiplier changes are made by the admin with Token-2022's own `UpdateMultiplier` from a script, not through Othello.

**Payout gate** (release_pot, recipient r = members[round]; r2 rewrite, option B):
1. Treat r as received after payout. For every received, non-defaulted member compute `need_i`. `S = Σ need_i`. `avail = reserve_total − reserve_losses`.
2. If `S ≤ avail`: set `reserve_allocated = S`, pay.
3. Else refuse. Both payloads carry `{needed: S, remaining: avail, short_by: S − avail + escrow_deficit, recipient_gap: need_r, others_need: S − need_r, escrow_deficit}` plus `recipient_cover: H_r`, so copy can name who can fix it and by how much (top-ups fill the escrow deficit first, hence `+ escrow_deficit`).
   - `coverage_too_low` **iff `H_r < min_stock_cover` AND `S − need_r ≤ avail`** (the recipient's own stock is below the join minimum and is the whole problem; copy leads with "lock more stock").
   - otherwise `reserve_overcommitted` (this is **Paused**; copy leads with "top up").

The gate is the only place the uncapped sum is compared. Everywhere else `reserve_allocated` is the capped, turn-order-distributed figure. **Paused** is defined on-chain as `next_gate_short_by > 0`; the UI never computes it. **It is as of the last update_coverage / release_pot / declare_default / top_up_reserve; add_stock and price changes do not refresh it.** The UI shows the last-checked age next to Paused and never disables Release pot on it: the program refuses with numbers if the gate fails (r4). Copy distinguishes **"free"** (R − L − reserve_allocated, the Guarantee panel) from **"remains"** (R − L, the gate's `remaining`).

**Parameter ranges (create_circle, `invalid_params`):** 3 ≤ n ≤ 8; contribution > 0; guarantee_per_member > 0; 0 ≤ haircut_bps < 10000; coverage_bps ≥ 10000; 10000 ≤ warn_bps < coverage_bps; round_secs ≥ 60; grace_secs ≥ 30; max_price_age > 0; `pool.discount_bps ≤ haircut_bps` (so H never exceeds what liquidation returns).

**Peak-guarantee check (create_circle, `guarantee_below_peak_need`):** for k = 1..n−1 (k recipients, everyone has paid k rounds): `need_k = k × max(0, ceil(c × (n−k) × coverage_bps / 10000) − min_stock_cover)`. Require `n × guarantee_per_member ≥ max_k need_k`. This is SPEC 3's table computed on-chain. Demo: n=5, c=50, cov 130%, min cover 120 → needs 140, 150, 30, 0 → peak 150 ≤ 5 × 30. ✓

**Price freshness:** fresh iff `now − updated_at ≤ max_price_age`.

**Demo circle (G5 seed script, r3):** n=5, c=50 USDC, **g=35 USDC** (reserve 175 vs peak need 150: 25 of slack so one base unit of price drift cannot pause the demo), haircut 2000, coverage 13000, warn 11000, min_stock_cover 120 USDC, pool discount 2000, round 120 s, grace 60 s, max_price_age 691,200 s (8 days, through judging on 2 Oct; the UI shows the age). Mock prices before the split: wrapper 150, share 150, multiplier 1.0. Each member locks **1.1 token** → EXEC = FUND = 165, H = 132. All members join **before** the split is scheduled (join refuses during Repricing). Split: script schedules newMultiplier 10.0, then `set_prices(wrapper 150, share 15, Scheduled, expected 10_000_000_000)`; after the effective time H is unchanged at 132. `scripts/touch-prices.ts` calls `touch_prices` only; run it at submission (Fri 21:00 Lagos), which covers judging to 2 Oct 21:00 with the 8-day window.

## 6. Default waterfall (declare_default, one instruction; r2)

```
d = defaulted member
O = contribution x (n - rounds_paid_d)                     // includes the missed round
conservative = wrapper_price x (10000 - pool.discount_bps) / 10000
sell_raw = min(stock_raw_d, ceil(u128(O) x 1e8 / conservative))  // u128; seize only what is owed (I9)
recovered = floor(sell_raw x conservative / 1e8)            // may exceed O by < 1 raw unit's value
require pool_usdc_vault >= recovered else pool_insufficient
stock: circle vault -> pool vault (sell_raw); usdc: pool vault -> circle vault (recovered)
funded_from_stock = min(O, recovered)                       // excess (< 1 raw unit) is vault dust
shortfall = O - funded_from_stock
loss = min(shortfall, reserve_total - reserve_losses)
reserve_losses += loss
escrow += funded_from_stock + loss
escrow_deficit += shortfall - loss                          // cured by top_up_reserve (section 5)
forfeited_d = min(shortfall, guarantee_d + top_ups_d)       // r3: measured against the shortfall, not the booked loss
forfeited_total += (new forfeited_d - old forfeited_d)
defaulted bit set; allocated_d = 0; stock_raw_d -= sell_raw (surplus returned at withdraw)
recompute allocations (capped); UI shows Paused if the next payout's gate sum > available
```

Liquidation uses the **non-scaled wrapper price only** (SPEC 1), so it works during Repricing. Staleness still applies.

**Coverage-based default (SPEC 5 "critical past the cure window") is cut** (r2). The only default trigger is a missed contribution. A member whose stock cover falls keeps paying and is not liquidated; the risk lands on the reserve at the next gate. Recorded in KNOWN-LIMITS; SPEC 5's sentence is superseded.

## 7. Withdraw (r2)

```
precondition: Completed or Cancelled, not withdrawn
if Cancelled: usdc_i = guarantee_i + top_ups_i; stock back
if Completed (snapshot values, never decremented by withdraw):
  pool_left = reserve_total - reserve_losses + escrow            // escrow is always 0 at Completed (release refuses otherwise); kept for I3
  weight_i  = guarantee_i + top_ups_i - forfeited_i
  usdc_i    = floor( pool_left x weight_i / (deposits_total - forfeited_total) )   // u128; no remaining_accounts needed
  stock back: stock_raw_i (after any seizure)
withdrawn_usdc += usdc_i; withdrawn bit set; stock_raw_i = 0 (keeps I4 true)
```
Withdraw never changes reserve_total, reserve_losses or escrow, so every member's share is order-independent. Rounding dust stays in the vault. Member accounts are not closed by `withdraw` in the prototype (rent stays locked; limit). The one exception is `leave_forming`, which closes the leaver's Member account so the same wallet can rejoin (r5). Circle fields at Completed (paid_bitmap, round, reserve_allocated) are left as they are.

**No exit from Active without a successful payout** (r2, accepted limit): an Active circle whose gate cannot pass and that nobody tops up never completes. The create-time peak check makes this unreachable without a default or a price fall. No `dissolve` instruction in Tier 1.

## 8. Invariants (copy; INVARIANTS.md is canonical)

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


## 9. User-facing copy and error contract (from design/FLOWS.md)

Anchor error names = the machine codes below (snake_case in copy, UpperCamel in Rust). Every refusal payload field named in section 5 is emitted as an event before the error returns, so the UI can print the numbers.

### Copy per place

| Place | Heading | Primary CTA | Secondary | Helper | Empty | Success |
|---|---|---|---|---|---|---|
| Landing | Savings circles where nobody has to trust anybody | Open demo circle | Create a circle | Lock tokenized stock as a promise. You still own it. You get it back when the circle ends. | | |
| Create | New circle | Create circle | Cancel | You'll name every member and the order they get paid. Each member confirms when they join. | Add at least 3 members | Circle created. Share each member's invite link. |
| Join | You're invited to {circle} | Join and lock | View circle | Turn {n} of {N}. {amount} USDC per round. You lock {stock} and put {g} USDC into the circle's shared reserve. Both come back when the circle ends. Most you could lose: {g} USDC, only if others default and their stock doesn't cover it. | | You're in. Until the circle starts, you can leave and take everything back. |
| Circle | Round {r} of {N} · {name}'s turn | Contribute / Release pot to {name} (context) | Update coverage | Coverage uses prices from {age} ago | Waiting for {k} members to join | Pot paid |
| Position | {name}'s position | Lock more stock | Back / Leave circle (while Forming) | Counted at the lower of its market price and its share price, minus a {haircut}% safety margin | Not joined yet | Stock locked. Update coverage to refresh your numbers. |
| Default | {name} defaulted in round {r} | Top up reserve | Back to circle | Their remaining contributions are prepaid from their stock and the reserve. | | Payouts resumed |
| Split lab | What a stock split does to your locked stock (muted: the handkerchief test) | Update coverage | Back | Same stock, same value. One vault believes the display. | No split yet. The demo admin can schedule one. | |

### Errors and refusals (machine codes become Anchor error names)

| Trigger | Plain language | Why (if actionable) | Next action | Container | Machine |
|---|---|---|---|---|---|
| Payout gate: coverage | Can't release {name}'s pot. Their locked stock counts for {recipient_cover} USDC of cover, below the {min} minimum, and the reserve is {short_by} short. | the recipient's stock is the whole gap | Lock more stock (or any member tops up {short_by}) | inline, refusal style | `coverage_too_low` · suggest `add_stock` / `top_up_reserve` |
| Payout gate: reserve | Payouts paused. The next payout needs {needed} USDC of reserve and {remaining} remains. (If needed is 0 and a deficit exists, use the escrow-short wording.) | | Top up {short_by} USDC (returned pro rata at the end, minus any default losses) | banner, refusal | `reserve_overcommitted` · suggest `top_up_reserve` |
| Round not funded | {k} contributions still missing | | Wait, or remind them | inline | `round_not_funded` |
| Round not funded: escrow short | Round can't be released: {name}'s prepaid contributions ran {deficit} USDC short. | | Any member tops up {short_by} USDC; the first {deficit} prepays {name}'s contributions and is not returned | banner | `round_not_funded` with escrow_deficit > 0 · suggest `top_up_reserve` |
| Circle not active | This circle isn't running right now ({status}) | | View circle | inline | `circle_not_active` |
| Already withdrawn | You've already withdrawn from this circle | | none | inline | `already_withdrawn` |
| Not demo admin | Only the demo admin can do this | | none | inline | `unauthorized` |
| Repricing | Repricing. Price and split disagree. | payouts wait | Admin sets price; recheck | banner, neutral | `multiplier_price_mismatch` · suggest `recheck` after price update |
| Stale price | Prices are {age} old | | Recheck after update | banner, neutral | `price_stale` |
| Bad multiplier | This stock's multiplier can't be read safely | NaN, negative or malformed | None: asset ineligible | banner, error | `multiplier_invalid` |
| Declare too early | Grace ends in {t} | | Wait | inline refusal | `grace_not_elapsed` |
| Not member / wrong wallet | This invite is for {addr}. You're connected as {addr2}. | | Switch wallet | inline | `not_a_member` |
| Already contributed | You've paid this round | | none (button hidden) | n/a | `already_contributed` |
| Low balance | You need {x} more {token} | | Get devnet tokens (faucet link) | inline | `insufficient_balance` |
| Below collateral minimum | You need stock worth {x} USDC of cover to join | | Add more stock | inline | `collateral_below_minimum` |
| Circle closed | This circle already started | | View circle | page | `circle_not_forming` |
| Seat already paid | {name} has paid this round, so there's nothing to default | | none | inline refusal | `seat_already_paid` |
| Pre-payout default | {name} hasn't had their turn yet. Othello can't default a member before their turn; they can still pay late. | | Remind them | inline refusal | `pre_payout_default_unsupported` |
| Already defaulted | {name}'s default is already settled | | View default | inline | `already_defaulted` |
| Pool short (demo) | The demo liquidation pool needs refilling before this default can settle | | Demo admin: seed pool | banner | `pool_insufficient` · suggest `seed_pool` |
| Not everyone joined | Waiting for {names} to join | | Share their invite links | inline refusal | `not_all_joined` |
| Guarantee too small | Each member's guarantee must be at least {x} USDC so the reserve covers the busiest round | peak need {peak} USDC | Raise the guarantee | inline, on the field | `guarantee_below_peak_need` |
| Invalid settings | {field} must be {rule} | | Fix the field | inline, on the field | `invalid_params` |
| Not finished | You can withdraw when the circle ends | | none | inline | `not_finished` |
| Wallet rejected | You cancelled in your wallet. Nothing was sent. | | Try again | toast, neutral | client only |
| Tx expired | That transaction didn't land. Nothing changed. | | Try again | toast | client only |
| Mainnet data unavailable | Live AAPLx data unavailable right now | | Retry | inline in Stock | client only |

Refusals (coverage, reserve, grace, repricing) use neutral styling with the numbers; only `multiplier_invalid`, tx failures and fetch failures use error styling.

---


## 9b. Corrections after the design review (2026-09-21, ADR-011, ADR-012)

These supersede anything above that conflicts.

1. **No invented stock data.** Gate 1 tests run against **real mainnet mint account bytes** saved as fixtures (`tests/fixtures/*.json`, fetched with `getAccountInfo` base64): AAPLx `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` and NFLXx `XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL`. Verified live 2026-09-21: AAPLx multiplier 1.0026642075893797 → newMultiplier 1.0032690125398187 at 1786149000; **NFLXx multiplier 1 → newMultiplier 10 at 1763337300 (a real 10-for-1 split, 2025-11-16)**. Its `multiplier` field still reads 1, so any reader that ignores the effective timestamp values NFLXx at a tenth. **SPYx `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` and NVDAx `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` are also fixtures** (added 2026-09-21 by the design owner, trust root in 9b.6): verified live 2026-09-21, SPYx multiplier 1.003909240011759 → newMultiplier 1.005714560286254 at 1781755200; NVDAx 1.0009180758490996 → 1.001701196801074 at 1789000200. All four are decimals 8.
2. **Jupiter price units (ADR-011).** The Jupiter token API `usdPrice` is **per UI (scaled) unit**, i.e. per share: NFLXx usdPrice 71.59 vs NFLX 71.79. The swap quote API is **per raw unit**: 0.01 raw NFLXx → 7.07 USDC. So the non-scaled wrapper price = swap-quote price per raw token, or `usdPrice × effective multiplier`. Never use `usdPrice` directly as `wrapper_price`. Applies to `ops/set-prices.ts` and `/api/live`.
3. **Collateral is identified by mint address (ADR-012).** A circle's `stock_mint` must be on a program-level allowlist of xStock mints. Symbols are never trusted (Jupiter returns five tokens named "NFLXx"; one is real). The UI shows company name, then `symbol · xStock by Backed`, then the mint address.
4. **Demo split evidence = NFLXx's real split**, read from its real mint. Circle collateral must pass the depth rule; NFLXx (~$2.1K liquidity) does not, AAPLx/SPYx/NVDAx do.
5. **Network is undecided** (devnet mirror / mainnet fork / mainnet): see OPEN-QUESTIONS. Gates 1-3 are network-independent (local validator + real fixtures). Nothing is deployed anywhere until it is decided.
6. **Issuer trust root for the mint allowlist (accepted 2026-09-21 by the design owner).** Nothing on-chain can establish who issued a mint: Token-2022 takes both the scaled-UI authority and the TokenMetadata update authority as **non-signer instruction data**, so a counterfeit mint can carry Backed's public keys without holding them, and the metadata URI is a string its creator chose. Those fields are integrity and drift checks only. **The accepted binding of symbol to mint address is Backed's own product page over HTTPS**, at `https://assets.backed.fi/products/<slug>` built from a reviewed slug in `ops/xstock-mints.ts`, with the origin pinned and redirects refused, stating `data-network-address="<address>"`. The trust root is therefore backed.fi's TLS and DNS, accepted knowingly rather than implied. Every fixture records the exact URL that bound it.
7. **Rent correction:** a 300 KB program needs 1.5247 SOL rent-exempt (mainnet `getMinimumBalanceForRentExemption(300000)`, 2026-09-21), not 2.09.

## 10. Acceptance criteria per gate

- **G1 (go/no-go):** `anchor test` green, using the real AAPLx and NFLXx mint fixtures (9b.1), with: effective multiplier from the NFLXx fixture = 10.000000000 (fixed 10_000_000_000) after its timestamp and 1 before; AAPLx = 1003269012 after 1786149000; PodF64 vectors (1.0026642075893797 → 1002664207, 1.0032690125398187 → 1003269012, 1.0000003 → 1000000299); NaN, ±Inf, negative, subnormal edge rejected or handled as specified; TLV byte-layout fallback test against the verified AAPLx layout; Clock-selected multiplier before/after effectiveTimestamp; I12 split (1.1 token, 150/150 → multiplier 10, share 15: H = 132 both sides); I13; I17. CU of `quote_valuation` recorded in DONE.md.
- **G2:** I1-I4, I6, I10, I11, I16 and the healthy-payout half of I18 green; SPEC §3 peak table reproduced (needs 140, 150, 30, 0) including the peak-guarantee check refusing g = 29 for the demo params; every section 5 refusal code has a negative test.
- **G3:** I7, I9, I14, I15, I18 green; SPEC §7 halt example reproduced (needed 75, remaining 70, short_by 5), then a top-up of 5 resumes; escrow-deficit case (shortfall > reserve) curable; declare_default during Repricing keeps I2.
- **G4:** every place in design/FLOWS.md §7 renders each of its states; viewer path needs no wallet; UX acceptance test (design/UX-REVIEW.md) run on one real person and the answer pasted into DONE.md.
- **G5:** demo circle seeded on devnet with the section 5 demo parameters; the seven-step demo (../SPEC.md) runs end to end; submission link live before Fri 25 Sep 21:00 Lagos.
