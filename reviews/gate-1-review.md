VERDICT: implementation-ready

# Gate 1 review: the valuation spike

Reviewer: Codex (separate vendor, separate terminal, run by Joshua)
Date: 2026-09-22
Commit reviewed: `b7c68df4ff11c823c939aaf4f73a49c238255539`
Brief: `reviews/gate-1-brief.md`
Protocol: `orca-sentinel/docs/REVIEW-PROTOCOL.md`, U1 to U9

Gate 1 is **locally** implementation-ready. It is NOT deploy-ready. The
`init_price_feed` block in the brief's section 7 item 1 stands.

## Findings, verbatim

> MINOR — OUTSIDE — reviews/gate-1-brief.md:62,103: pnpm run test:t00 does not
> reach mainnet or Backed. Its suite deliberately uses a localhost HTTP server
> with OTHELLO_INSECURE_TEST_RPC=1. This can mislead a reviewer about what the
> command proves. Smallest fix: describe it as the hostile-endpoint stub suite;
> name ops/fetch-fixtures.ts as the live command and note that it writes
> fixtures.

> MINOR — OUTSIDE — tests/harness.ts:390: the Gate 1 diff has a blank line at
> EOF; git diff --check 3ac9cfa..b7c68df reports it. Smallest fix: delete the
> extra line.

> U7: 0 INSIDE, 2 OUTSIDE. Indicative only: this was a single-prompt review, so
> it was not blind under U1.

> U8: I read the Gate 1 program, harness, fixture/provenance path, tests,
> invariants, and relevant committed evidence. anchor test, P1, clippy, fmt, and
> TypeScript typecheck passed. I also fetched current data into an isolated
> temporary directory; all four scaled-UI configurations match the committed
> snapshot, though mutable mint-supply bytes differ. I did not deploy to a
> cluster, test the known init_price_feed takeover, or independently rerun
> formal mutation campaigns.

## Disposition

Both findings fixed. Neither was INSIDE the review's stated concerns and neither
touched the program.

1. The brief was wrong, twice, about its own test suite: `pnpm run test:t00`
   reaches nothing. It serves JSON-RPC and the issuer's product pages from a
   localhost server and runs the fetcher against it with
   `OTHELLO_INSECURE_TEST_RPC=1`. Verified before correcting rather than taken
   on trust: `tests/t00-mint-symbol-verification.ts:155,172-174`. The brief now
   describes it as the hostile-endpoint stub suite, names
   `ops/fetch-fixtures.ts` as the live command, and warns that it rewrites
   `tests/fixtures/`. Section 5's claim that the T00 suites "reach the network"
   was also wrong and is corrected: they are fully offline.
2. Blank line at EOF in `tests/harness.ts` deleted. `git diff --check` clean.

## Staleness

The verdict binds to `b7c68df`. The code change made after it is this, in full:

```
 tests/harness.ts | 1 -
 -
```

One blank line. `git diff --ignore-blank-lines -- programs ops tests scripts
.github` is empty. Everything else changed is documentation: this file and the
brief's own text.

`REVIEWS.md` says a fix after a review is the newest code and therefore the most
suspect, and should be re-reviewed. That rule is recorded here rather than
waived by the builder: whether to spend a round on a blank line is Joshua's
call, and DONE.md T07 records it as open.

## Independent confirmation worth recording

The reviewer fetched current mainnet data into an isolated directory and found
all four scaled-UI configurations match the committed fixtures. That is the T00
provenance chain verified by a second party against the live chain, which no
test in this repo does: the suite is offline by design.
