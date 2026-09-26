# P0.2 Liveness: who keeps Othello's Pyth price fresh, and who pays

**Status: DECIDED (C), 2026-09-26.** Evidence below; the decision is at the end.

## What is true today

- Pyth does not keep Solana price accounts fresh by itself. An account is updated only when someone
  posts a signed update (from Hermes) through the Pyth receiver / push-oracle programs.
- The seven xStock feeds are **not** in Pyth's sponsored list (docs.pyth.network push-feeds/solana: 64
  feeds, none `Crypto.*X/USD`). So nothing promises their shard-0 accounts will keep updating.
- They do update on devnet today. Posted by `Ezoir8i2JgEDE8cZZ5LyzcopPfd1AZxti2nUUB7cFkxo` through
  `pythWSns…` (`UpdatePriceFeed` / `PostUpdate`), identity unknown; read by an unrelated program
  `EQqFr59r…`. In the 24 h to 2026-09-25T19:02Z: 18 bursts, gaps up to 7.5 h. The logger
  (`cadence.jsonl`) is extending this over the weekend.
- On mainnet the same accounts are 2 to 13 days stale (and pyth-crosschain #4055 reports the same): a
  third party can stop at any time.
- Hermes (the source of signed updates) needs an API key since 2026-08-26. Pyth's upgrade guide:
  "Sign up at Pyth Terminal: a free trial is included, paid plans cover ongoing use"
  (docs.pyth.network/price-feeds/core/upgrade/preparing). Plan prices are on app.pyth.com/plans, which
  refused connections from this machine; **Joshua reads the prices there before choosing A**.

## Options

| | A. On-demand, Othello posts | B. Third-party shard-0 only | C. Both: accept any valid account (recommended) |
|---|---|---|---|
| How | App's server route fetches the signed update from Hermes (server-only key); the user's transaction posts it via the receiver, then calls Othello | Othello reads the existing shard-0 accounts | Program accepts **any** PriceUpdateV2 that passes owner, Full, feed id, age, confidence, price checks. App uses shard-0 when fresh; bundles an on-demand post when a key exists and shard-0 is stale |
| Freshness | seconds, every action | whatever the third party does (7.5 h gaps seen) | best of both |
| Who pays | user: tx fee + a reclaimable PriceUpdateV2 rent (devnet SOL, free) | nobody | user, only when an on-demand post is needed |
| Money | Hermes plan after the trial (price on app.pyth.com/plans) | $0 | $0 until a key is bought; trial covers the Colosseum window if long enough |
| Keys | Hermes key in Vercel env (Joshua creates it; never in chat or repo) | none | same as A, optional |
| Program change | none beyond "accept any valid account" | none | none beyond "accept any valid account" |
| Failure mode | Hermes down or key lapses: user sees a clear error | third party stops: circle pauses at 12 h (never misprices) | falls back to B's behaviour |

No funded pusher (a server wallet posting on a schedule): it needs a hot key on a server and pays for
updates nobody reads.

## Recommendation

**C.** Build the program to accept any valid PriceUpdateV2 (already required by the r2 plan), ship the
app reading shard-0 first ($0, no key), and add the on-demand post as a second step once Joshua has a
Hermes key (trial for the Colosseum window; paid only if Othello continues past it). The staleness
ceiling stays 12 h while only shard-0 is used; when on-demand posting exists, the app posts a fresh
update before each action, so the effective age at use is seconds, and the ceiling can be tightened.

## Decision (Joshua, 2026-09-26)

- **C**, with one correction: **until a Hermes key is active, C behaves exactly as B in production.**
  The app says so plainly wherever a price is shown or an action is blocked: the price comes from a
  third-party-updated Pyth account, a stale account pauses actions, and it is not a reliable update
  service. No copy may imply Othello keeps prices fresh before on-demand posting ships.
- Pyth plans (Joshua, from app.pyth.com/plans, 2026-09-26): **Starter $500/month plus tax**, API access to
  all crypto symbols; **free trial 14 days**. `Crypto.*X/USD` feeds are crypto symbols, so Starter appears
  to cover them (to confirm inside the trial by fetching one xStock update).
- **Trial timing:** start it only once the cadence result is in and the on-demand path is built, around
  Monday 2026-09-28, so the 14 days cover the Colosseum deadline (2026-10-12). Starting it today would
  expire before then.
- **Money:** $0 until the trial; **$500/month** only if live updates are needed beyond the trial.
  Joshua decides that when the trial ends.
- The key is created by Joshua and set only in Vercel env (server-only); never in chat, repo or logs.
