# P0.3 Crate spike: `pyth-solana-receiver-sdk` inside Othello's program

**Result: PASS. Use the official SDK (`=2.0.0`); no hand-written decoder.**

Spike branch: `spike/P0-pyth-sdk` (worktree `~/myvscode_linux/othello-pyth-spike`, from 72114c0), never
merged. It adds the dependency, one instruction `pyth_spike(feed_id, max_age)` taking
`Account<'info, PriceUpdateV2>` and calling `get_price_no_older_than`, and one bankrun spec.

## Build (`anchor build -- --features devnet`, rustc 1.89.0, anchor-cli 1.1.2)

| | before (72114c0) | with SDK |
|---|---|---|
| exit | 0 | 0 |
| time (warm deps after first) | 2m36s (cold) | 1m16s |
| `target/deploy/othello.so` | 694,064 bytes | 708,704 bytes (+14,640, +2.1%) |
| IDL | — | carries `pyth_spike`, `PriceUpdateV2`, `PriceFeedMessage` |

`cargo tree -e normal -p pyth-solana-receiver-sdk --depth 1`:

```
pyth-solana-receiver-sdk v2.0.0
├── anchor-lang v1.1.2      <- the same instance the program uses
├── borsh v1.8.1            <- the same instance the program uses
├── cfg-if v1.0.5
├── hex v0.4.3
└── pythnet-sdk v3.0.0
```

Duplicates: the tree already had 38 duplicate lines before (e.g. solana-pubkey 3.0.0 and 4.3.0). The SDK
adds, through `pythnet-sdk`, borsh 0.9.3, solana-sysvar 5.0.0, solana-rent 4.5.0 and similar. None
of them is in a type that crosses into Othello's code: `Account<PriceUpdateV2>` type-checks against
anchor-lang 1.1.2's `Owner`/`AccountDeserialize`, and the program links.

## Behaviour (bankrun, real account bytes)

Fixture `tests/fixtures/pyth-aaplx-devnet.json`: `getAccountInfo` of devnet
`Gs4DVtiGSJ9LJvXaQFjYp6vhLNK2QsH4qWox2ck1kuMp` (shard-0 `Crypto.AAPLX/USD`), 134 bytes, owner
`rec5EKMG…`, fetched 2026-09-26T07:04:28Z at slot 504,323,212.

```
$ npx mocha --import=tsx --timeout 600000 tests/p0-pyth-sdk-spike.spec.ts
  P0.3 Pyth SDK spike: real devnet AAPLx PriceUpdateV2
    ✔ reads the price at its real address, fresh (48ms)
    ✔ accepts the same bytes at ANY address (no canonical PDA)
    ✔ refuses a price older than max_age
    ✔ refuses the wrong feed id
    ✔ refuses the same bytes owned by another program
    ✔ refuses a Partial verification level
  6 passing (439ms)
```

Refusal codes are pinned, not guessed: `PriceTooOld` 16000, `MismatchedFeedId` 16002,
`InsufficientVerificationLevel` 16003 (pyth-solana-receiver-sdk-2.0.0 `src/error.rs`: `PriceTooOld =
10000` then +1 each, plus Anchor's 6000 offset for `#[error_code]`), and `AccountOwnedByWrongProgram` 3007
(anchor-lang-error-1.1.2 `src/lib.rs:251`).

## What the SDK does NOT check (Othello must, per fixed-point.md)

exponent (−8 required), price > 0, conf < price, publish_time not in the future, the confidence cap, the
repricing guard. `get_price_no_older_than` covers Full verification, feed id and age together; the owner
and discriminator come from `Account<>`.

## Thin

- Only the spike instruction exercises the SDK; the valuation path is P2.
- The `.so` is not re-verified by `tests/deploy-artifact.spec.ts` on the spike branch (the spike is never
  deployable).
