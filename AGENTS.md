# Agent instructions

Hand-written on purpose. Repository overviews and generated content measurably do not
help and cost tokens; commands, deviations and boundaries do.

## Commands
<!-- fill these in. The agent uses these verbatim. -->
- install: `pnpm -C app install --frozen-lockfile`
- build: `anchor build && pnpm -C app build`
- test: `anchor test`
- lint: `cargo fmt --check && cargo clippy -- -D warnings`
- typecheck: `pnpm -C app typecheck`
- contracts test: `anchor test`

## Project deviations
- Spec: `SPEC.md` (authoritative). `design/` is read-only history; never edit it. `../SPEC.md` is the economics source only.
- Never run `anchor deploy` or `solana program deploy`. Devnet deploys are Joshua's (2.5 SOL budget). Use the local validator.
- Money maths: u128, checked, fixed-point only; collateral rounds down, obligations up. No floats in the program.
- Gate 1 is go/no-go. Do not start gate 2 until gate 1's Codex review is `implementation-ready`.

## How work is tracked
- `TASKS.md` is the live list. Work the current task only.
- `DONE.md` is append-only evidence. A task is complete only when its verification
  command has run and its **real output** is pasted in. Not a summary. Not a claim.
- Anything you notice that is outside the current task goes in `OPEN-QUESTIONS.md`.
  It does not go in the diff.
- Start every session by reading `STATUS.md`, `DONE.md`, and the recent commit log.

## Review
- After finishing a gate, write `reviews/gate-N-brief.md` and STOP. Do not review your own diff.
- The review is run by Codex, a different vendor, so it does not share your blind spots.
- Read the verdict, fix, re-review. Do not argue with findings in chat.
- Record `reviewed:` and the verdict in the DONE.md entry. A gate with no review reference is not closed.

## Never
- Never edit `SPEC.md`, `INVARIANTS.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `KNOWN-LIMITS.md`
  or anything under `adr/`. These are owned by the design session. If one is wrong, stop
  and say so; the design is corrected there and the pack is re-handed.
- Never weaken, skip or delete a failing test. A failing test is a finding.
- Never edit a migration that already exists. Write a new one.
- Never broadcast a transaction, publish a package, or deploy to production.
- Never bypass a hook or a check. If a check fails, fix the cause.

## When you are stuck
If a verification fails three times, stop and report. Do not try a fourth approach.
Say what you tried, what happened, and what you think is actually wrong.
