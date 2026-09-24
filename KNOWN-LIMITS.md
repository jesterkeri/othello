# Known limits

Accepted tradeoffs. Reviews do not re-report these unless the statement itself is wrong.

| # | limit | why accepted | recorded at gate | revisit at |
|---|---|---|---|---|
| L1 | Devnet only; a single demo admin key sets prices, seeds the pool and changes the mint multiplier | hackathon, $0; stated on the site | design | mainnet |
| L2 | Program upgrade authority is Joshua's single devnet key | devnet | design | mainnet (multisig + timelock) |
| L3 | Pre-payout default (a member who has not received yet) is unsupported; they can still pay late | out of scope in SPEC v4 | design | post-hackathon |
| L4 | No exit from Active without a successful payout (no dissolve) | create-time peak check makes it unreachable without a default or price fall | design r2 | post-hackathon |
| L5 | Coverage-based default ("critical past cure window", SPEC v4 §5) cut; only missed contributions default | time; supersedes SPEC v4 §5 | design r2 | post-hackathon |
| L6 | Rounding dust stays in vaults; Member accounts not closed by `withdraw` (rent locked). The exception is `leave_forming`, which closes the leaver's Member account so the same wallet can rejoin (SPEC §7, r5) | simplicity | design | post-hackathon |
| L7 | Issuer powers of real xStocks (pause, freeze, permanent delegate) not handled; mock mint has none | devnet mock | design | mainnet |
| L8 | pool_insufficient reverts a default until the admin reseeds the pool | devnet mock | design | mainnet (real route) |
| L9 | next_gate_short_by (Paused) is as of the last refresh; the Repricing-branch value is approximate | no keeper | design r4 | post-hackathon |
| L10 | No keeper; every transition needs someone to send a transaction | Solana has no cron | design | never (by design) |
| L11 | One stock per circle | scope | design | post-hackathon |
| L12 | Tier 1 design depth for a money-holding program | deadline; four review rounds compensate | design | mainnet (Tier 2 + audit) |
| L13 | "Removed from future circles" claim dropped; default is recorded only in its circle | no cross-circle record | design | post-hackathon |
| L14 | A top-up that fills an escrow deficit prefunds a defaulter's contributions and is then a deposit like any other: shared pro rata at settlement, so it can come back as less than was put in, after losses (SPEC r8, decision (a)) | the circle must be able to complete; the filler is not singled out to carry the default | design r3, r9 | never (by design) |
