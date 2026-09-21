# Open questions

Mark `BLOCKING` if the merge should not proceed without an answer.

- [ ] Clock warp in tests: LiteSVM or bankrun with anchor 1.1.x (gate 1 decides; record as ADR-011 via the design session)
- [ ] Real CU of release_pot / update_coverage with n = 8 (NFR-3 assumes ≤ 60k)
- [ ] Program binary size vs 2.5 devnet SOL (deploy with `--max-len`; faucet top-up)
- [ ] BLOCKING before T23 (any deploy): network. Devnet mirror / mainnet fork / mainnet. Decided by Joshua in the design session, not by the builder.
- [ ] Program-level mint allowlist: hardcoded constant or admin-managed account (ADR-012 prefers a hardcoded const list for the hackathon)
