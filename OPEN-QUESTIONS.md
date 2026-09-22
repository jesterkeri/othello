# Open questions

Mark `BLOCKING` if the merge should not proceed without an answer.

- [ ] Clock warp in tests: LiteSVM or bankrun with anchor 1.1.x (gate 1 decides; record as ADR-011 via the design session)
      P1 ANSWERED THE BUILD HALF, 2026-09-22: bankrun (`solana-bankrun` 0.4.0). It
      loads the real NFLXx mint at its canonical address byte for byte and places the
      Clock on 1763337299 and 1763337300 exactly, with the program reading each back
      (`pnpm run test:p1`). LiteSVM was tried first, since anchor-cli 1.1.2's own
      template ships it: in this repo's install it aborts the process with
      `std::bad_alloc` shortly after the first transaction that invokes the loaded
      program, 0 of 8 runs surviving. That is NOT a property of LiteSVM. The adversary
      pass ran the same workload in a separate worktree on 0.5.0/0.7.0/0.8.0 and it
      completed; one identical probe run against both installs gave 5/5 survival there
      and 0/5 here, with byte-identical litesvm-linux-x64-gnu@0.8.0 binaries. So the
      choice rests on reliability observed here, not on a proven LiteSVM defect, and
      the ADR should say so. NOTE: this line says ADR-011, but ADR-011 is already
      Jupiter price units (SPEC 9b.2), so that number is stale. The build does not
      write ADRs; the design session picks the number and writes it.
- [ ] Real CU of release_pot / update_coverage with n = 8 (NFR-3 assumes ≤ 60k)
- [ ] Program binary size vs 2.5 devnet SOL (deploy with `--max-len`; faucet top-up)
- [ ] BLOCKING before T23 (any deploy): network. Devnet mirror / mainnet fork / mainnet. Decided by Joshua in the design session, not by the builder.
- [ ] Program-level mint allowlist: hardcoded constant or admin-managed account (ADR-012 prefers a hardcoded const list for the hackathon)
- [x] RESOLVED 2026-09-21 by the design owner: Backed's HTTPS product-page assertion
      is accepted as the trust root, and SPYx and NVDAx are recorded in SPEC 9b.1 with
      the root stated in SPEC 9b.6. The four-fixture contract stands unchanged.
      Original question: what is the trust root for the SPYx and
      NVDAx mint addresses? They are not in SPEC 9b.1, unlike AAPLx and NFLXx. Codex
      round 2 established that NOTHING on-chain can establish issuer identity: the
      scaled-UI authority and the metadata update authority are both non-signer
      instruction data, so a counterfeit mint can carry Backed's public keys without
      holding them, and the metadata URI is attacker-chosen. The strongest binding
      available is Backed's own product page fetched over TLS at a URL this repo
      derives from the symbol, which is now enforced per fetch. That makes the trust
      root backed.fi's TLS and DNS, plus Joshua's reading of that page. Decide: accept
      that root and record SPYx/NVDAx in SPEC 9b.1, or restrict gate 1 to the two
      SPEC-pinned mints. This is a design decision, not a build one.
- [ ] RPC transport is pinned to https + api.mainnet-beta.solana.com, because a
      genesis hash is public and authenticates nobody. A paid provider will need
      adding to TRUSTED_RPC_HOSTS as an explicit decision, not an env override.
- [ ] Test runner: ARCHITECTURE's repository layout names ts-mocha, and T01 uses
      mocha with the tsx loader (`mocha --import=tsx`) instead. The repo is ESM
      (`"type": "module"`, `ops/*.ts` importing `./issuer.ts`), and ts-mocha drives
      ts-node's CommonJS path, which does not load those imports. Same runner, same
      spec files, different loader. Not blocking; recorded because ARCHITECTURE is
      owned by the design session and the build must not edit it.
