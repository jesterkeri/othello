# P0.2 Cadence: how fresh the free devnet xStock prices really are

**Result: the free shard-0 accounts are NOT usable on their own for a user pilot.** They are updated on
weekdays around US market hours only; a circle reading them pauses every weekend and most nights.

## Evidence

Logger: `ops/p0/cadence-logger.ts` (read-only, polls the seven accounts every 60 s from
2026-09-26T06:57Z), output `cadence.jsonl`. Direct re-check over devnet RPC on 2026-09-27T12:23Z:

| Account | Last publish | Age at 2026-09-27T12:23Z |
|---|---|---|
| AAPLx `Gs4DVtiGSJ9LJvXaQFjYp6vhLNK2QsH4qWox2ck1kuMp` | 2026-09-25T19:01:50Z | **41.4 h** |
| TSLAx `GpoWLTd6GoisYxYgHz7mTcZvgnfJu4SN7T6PxWjgUTFY` | 2026-09-25T19:01:50Z | **41.4 h** |
| (all seven xStocks) | 2026-09-25T19:01:50Z | 41.4 h (logger: one row each, no later update) |
| SOL/USD `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` (Pyth-sponsored) | 2026-09-27T12:22:33Z | 0.0 h |

- AAPLx's most recent transactions: 2026-09-25T19:02:13Z, 19:01:58Z, 18:41:56Z (none since).
- Earlier, in the 24 h to 2026-09-25T19:02Z: 18 update bursts, gaps up to 7.5 h (overnight).
- Friday 19:01Z is shortly before US market close (20:00Z); nothing since, through the weekend. The xStock
  feeds are 24/7 in Hermes' schedule (`O,O,O,O,O,O,O`), so the gap is the third-party updater's choice, not the
  feed's.
- The logger recorded one transient `fetch failed` (2026-09-26T13:58Z) and recovered.
- Confidence over the logged samples: median 2.8 bps, max 83.3 bps (MSFTx).

## Consequence

- With the 12 h ceiling, a circle priced only from these accounts would refuse join, release, coverage and
  default from roughly Friday evening to Monday, and on most nights. Contributions stay possible (§6.2 of the
  product design), but nothing can be released.
- **Liveness option C must include on-demand posting before a user pilot**: the user's transaction posts a fresh
  Hermes update (paid key; Pyth Starter $500/month, trial length unconfirmed publicly).
- Open question for the trial: whether Hermes publishes `Crypto.*X/USD` updates on weekends (the schedule says
  24/7; publisher behaviour is unverified until a key exists).
- Confidence cap: a 200 bps `max_conf_bps` would have accepted every logged sample (max 83.3).
