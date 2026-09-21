# Preflight (devnet deploy)

Run before every deploy. Never delete a line because it failed.

## Build
- [ ] Clean clone builds: `git clone . /tmp/o && cd /tmp/o && anchor build && pnpm -C app install --frozen-lockfile && pnpm -C app build`
- [ ] `cargo fmt --check && cargo clippy -- -D warnings` clean
- [ ] `anchor test` green; counts recorded here:
- [ ] `pnpm -C app typecheck` clean

## Secrets and access
- [ ] `./scripts/check-secrets.sh` passes against `app/.next`
- [ ] No keypair file inside the repo: `git ls-files | grep -Ei 'id\.json|keypair|\.key$'` returns nothing
- [ ] Only NEXT_PUBLIC_ values are the program id, cluster and (optional) public RPC URL
- [ ] Every admin instruction has a negative test with a non-admin signer (I8)
- [ ] Admin place renders nothing for a non-admin wallet

## Chain
- [ ] `solana balance --url devnet` ≥ binary size × 6,960 lamports × 1.2 (record both numbers)
- [ ] Deploy uses `--max-len` = measured binary size × 1.2
- [ ] Program id matches `declare_id!`, Anchor.toml and app config
- [ ] Mock mint has no transfer hook; pool seeded; price feed stamped for the current multiplier
- [ ] Rollback: previous `.so` kept in `target/deploy/prev/`; redeploying it is the rollback (costs SOL; no point of no return on devnet)

## Failure behaviour
- [ ] Every FLOWS §8 refusal renders with numbers from a fixture; 404, offline, wrong network, wallet rejected, tx expired states render
- [ ] /api/live failure shows "Live data unavailable", never breaks the page

## Evidence
- [ ] DONE.md entries exist for this gate with real output
- [ ] `./scripts/check-reviews.sh` passes; every gate's Codex review is `implementation-ready`
