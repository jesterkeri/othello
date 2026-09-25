VERDICT: changes required

Review target: `87f1dfe` (`b62565b..87f1dfe`). I confirmed that the checked-out
head changes only `reviews/t18-brief.md` and `DONE.md` after the target.

MAJOR — INSIDE — `ops/seed-demo-circle.ts:26`, `ops/devnet-cli.ts:84-96`,
`ops/demo.ts:217-245,279-301`: an existing demo circle is not checked against
the member keys before the seed funds them. On a second machine without the
original member files, `demoMembers()` creates five new keys. Because the
circle PDA already exists, `seedDemoCircle()` skips `create_circle`, but still
funds all five new wallets with SOL, mirror stock, and test USDC. Only after
that does the first `join_and_lock` prove the new key is not a named member and
fail. This violates the claimed safe re-run/no-send behavior and silently
spends/mints demo resources after a machine change. Decode the existing circle
before any funding and refuse unless its ordered members match the supplied
keys; alternatively, make a seeded-record rerun use `loadDemoMembers()` before
calling the seed.

MINOR — INSIDE — `ops/demo.ts:176-214`:
`seedDemoCircle()` treats an existing liquidation-pool PDA as valid without
decoding and checking its `discount_bps`. A prior admin `init_pool` at the demo
pair with, for example, 1,500 bps is accepted; `create_circle` permits it
because it only requires pool discount <= haircut, and the script then creates
an Active circle presented as the 2,000-bps SPEC demo. Validate that an
existing pool has the expected admin, mints, and `DEMO.poolDiscountBps`, or
refuse before funding/creating the circle. The current tests all start from an
absent pool and do not cover this path.

MINOR — INSIDE — `tests/app-live.spec.ts:203`: `git diff --check
b62565b..87f1dfe` reports `new blank line at EOF`. A diff-whitespace gate will
reject the target despite the language formatters passing. Remove the terminal
blank line.

U7

- Findings: INSIDE 3, OUTSIDE 0. This count is indicative rather than a
  rigorous cold-read measure because the protocol and brief were supplied in
  the same review turn.

U8 — not checked

- I did not run an ops script against devnet, make an RPC request, send a live
  transaction, or directly inspect any keypair, `.env*`, `~/.config/solana`,
  or `~/.config/othello-demo` file. The bankrun suite sends only local test
  transactions.
- `next build` reported `Environments: .env.local`; Next loaded that build
  environment automatically. I did not open, print, or inspect its contents.
- I did not run a browser-wallet signing flow, deploy/seed devnet, inspect the
  copied IDL byte-for-byte, or reproduce the stated Chromium/Vercel checks.
  The full frontend that predates `46614fc` remains outside the review scope.

Verification (run serially)

```text
git diff --stat 87f1dfe..HEAD
DONE.md | 8 +++
reviews/t18-brief.md | 148 +++

git diff --shortstat b62565b..3da8b1c
14 files changed, 1347 insertions(+), 4 deletions(-)

git diff --shortstat 46614fc..87f1dfe -- app ':!app/pnpm-lock.yaml'
16 files changed, 5908 insertions(+), 22 deletions(-)

git diff --shortstat 3da8b1c..87f1dfe -- ops tests
9 files changed, 816 insertions(+)

git diff --check b62565b..87f1dfe
tests/app-live.spec.ts:203: new blank line at EOF.

corepack pnpm@10.32.1 install --frozen-lockfile &&
(cd app && corepack pnpm@10.32.1 install --frozen-lockfile)
exit 0; both lockfiles already up to date. pnpm warned that optional dependency
build scripts were ignored.

anchor build
exit 0; othello compiled. The already-recorded local program-id/keypair
mismatch notice was printed.

for f in tests/*.spec.ts; do npx mocha --import=tsx --timeout 120000 "$f"; done
31 files, launched one process per file: 187 passing, 0 assertion failures.
The first app-contribute attempt hit the documented intermittent native
Token-2022 test-runtime panic before an assertion; its isolated retry passed
3/3, and every other named file passed independently.

cargo test -p othello
57 passed, 0 failed; doc-tests 0 passed.

cargo test -p othello --features devnet
56 passed, 0 failed; doc-tests 0 passed.

cargo clippy --all-targets -- -D warnings
exit 0.

cargo fmt --check
exit 0.

pnpm exec tsc --noEmit -p tsconfig.json
exit 0.

(cd app && corepack pnpm@10.32.1 exec tsc --noEmit && corepack pnpm@10.32.1 build)
exit 0; Next 15.5.26 production build completed, generating 83 static pages.
```
