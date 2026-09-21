# Othello: frame, tier, spec diff

Source: `../SPEC.md` (BUILD SPEC v4, three Codex reviews). Date: 2026-09-21.

## 1. The job (solution-agnostic)

A small group that already trusts each other pools a fixed amount each period and each person
receives the whole pot once, in turn. The failure that kills these circles is an early recipient
taking the pot and stopping payment. Othello lets members secure their future contributions with
tokenized stocks they already hold, without selling them, and makes the protection checkable by
anyone instead of resting on reputation.

Positioning: trust that is verified, not believed. No iagos. The stock-split demo is the
handkerchief: false evidence a naive vault believes, and Othello does not.

## 2. Consumers

| Class | What they need |
|---|---|
| Circle member | Join, lock xStock collateral, lock guarantee, contribute each round, receive pot once, see their health and max loss, get everything back at the end |
| Circle creator | Set contribution, size, schedule, haircut, coverage target; invite members; activate |
| Anyone / keeper | Call `refresh_health`, `declare_default` once the Clock says it is due. No reward in the prototype |
| Demo admin (devnet only) | Seed mock oracle, trigger the 10:1 split, seed the mock liquidation pool |
| Judge | Understand the premise in one screen and watch the seven-step demo end to end |

## 3. Stage and hard constraints

- Stage: hackathon prototype. Stocklana, judged on "could this be a real app people will use", working end-to-end demo, reason it belongs on Solana, execution quality.
- Chain: Solana devnet only. Anchor. Token-2022 Scaled UI Amount on a mock xStock mint the admin controls.
- Budget: $0. ~2.5 devnet SOL.
- Team: Joshua, solo.
- Deadline: Fri 25 Sep 21:00 Lagos (16:00 ET). Edits allowed until close, so a stub submission removes lock-out risk.
- Competing deadline: Spout bounty due Wed 23 Sep.
- Visual style: neubrutalism.

## 4. Non-goals (from SPEC "CUT")

Borrow solo, generic lending, open-market liquidation, PvP, guarantee fee, tax export, portfolio
dashboard, governance, interest curves, mainnet, pre-payout dropout.

## 5. Tier: 1

Short doc per stage. Reason: the spec already carries the hard economics and three external
reviews, the build window is ~2.5 working days, and a Tier 2 pass would eat the build. Tier 0
is too light because the default waterfall and reserve accounting have real edge cases.

## 6. Spec diff

### 6a. What SPEC v4 already decides (do not re-litigate)

- Dual valuation `H = min(fundamental, executable) × haircut`, raw maths, non-scaled wrapper price
- PodF64 bit-exact decode, `MULTIPLIER_SCALE = 1e9`, round collateral down and obligations up
- Invariants `Oᵢ ≤ Hᵢ + Gᵢ` and the non-circular reserve form; four reserve fields
- Coverage bands 125 / 110, cross-multiplied in checked u128
- Health recomputed on every state change plus permissionless `refresh_health`; Clock-verified `declare_default`
- Default waterfall, whole-obligation recovery, surplus returned, replacement escrow, circle can halt
- Round state machine; post-payout default only
- 10:1 split demo; spike-first go/no-go; seven-step demo; claims table

### 6b. What it silently assumes

1. **A mock USDC mint** and its program (classic SPL vs Token-2022). Not specified.
2. **An admin authority** over the mock oracle, the mock pool and the mint's multiplier. The trust model of that key is unstated.
3. **How members join.** Open join, invite list, or creator names wallets up front.
4. **How turn order is agreed.** "Every member approves turn order and maximum loss" implies a per-member approval step before activation. No instruction exists for it.
5. **Collateral sizing.** Who sets the minimum H per member (spec example H = $120) and whether it is checked at activation.
6. **Guarantee sizing.** Equal deposit sized to peak exposure across the schedule ($30 each in the example). Computed on-chain or supplied by the creator?
7. **Demo timescale.** Rounds, deadlines and grace must be minutes, not months, or the demo cannot show a default.
8. **Units.** xStock 8 decimals, USDC 6, oracle price scale. Not stated.
9. **Frontend.** Next.js + wallet adapter on Vercel free, reusing `lib/pegdata.js` for the live collateral detail view.

### 6c. What it never mentions (the real work)

1. **Oracle vs multiplier epoch mismatch.** If the mock share price drops 10x before the multiplier activates, fundamental value reads 90% low and can push a healthy member to Critical and into a false default. If the multiplier activates before the price update, fundamental reads 10x high (the `min` with executable saves this side). The spec says integrations should pause around activation but defines no pause. Needs a rule: the oracle records which multiplier it is priced against, or health-driven defaults are blocked inside an activation window.
2. **Oracle staleness threshold.** "Reject stale" with no number.
3. **Completion.** No instruction or flow returns collateral, unused guarantee (pro rata) and escrow remainders when the circle finishes.
4. **Recovery / top-up.** A halted circle resumes "when members top it up or the next recipient supplies more collateral". Neither action is defined.
5. **Cure action.** "Critical past the cure window" defaults a member, but there is no add-collateral or top-up instruction to cure with.
6. **Issuer powers at runtime.** A real xStock can be paused or frozen (pausableConfig, freezeAuthority, permanentDelegate). If the vault is frozen, liquidation fails. What does the program do? Out of scope on devnet, but it must be a stated limit.
7. **"Removed from future circles."** Needs a per-wallet record across circles, or the claim goes. Right now nothing stores it.
8. **Contribution mechanics.** Each contribution needs the member's signature every round. A missed one is only a default once someone calls `declare_default` after grace.
9. **Reading state in the UI.** No indexer. Direct RPC account reads. Fine at demo scale, should be stated.
10. **Program upgrade authority and IDL.** Not mentioned.

## 7. Answers (2026-09-21)

- Spike: **not started**. It stays gate 1 and the go/no-go. Its design is already complete in SPEC v4 (build order + implementation notes), so it can start in parallel with the rest of this design pass without waiting for stage 5.
- Days: **some of Mon to Wed** plus Thu and Fri. Plan: spike in the Mon to Wed gaps, circle Thu, demo + UI Fri.
