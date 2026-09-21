# Pipeline

## Stages (GitHub Actions, `harness.yml` + `ci.yml`)
| Stage | Runs | Budget | Required |
|---|---|---|---|
| PR | harness checks (workflows, secrets, reviews, pack integrity); `anchor build`; `anchor test`; `pnpm -C app install --frozen-lockfile && pnpm -C app typecheck && pnpm -C app build` | < 10 min | yes (make them required status checks) |
| Advisory | clippy, bundle size | | no |
| Deploy | none in CI. Devnet deploys run on Joshua's machine only | | human |

## Environments
local validator (tests) · Vercel preview per PR (no secrets) · Vercel production (hobby) · Solana devnet.

## Secrets
| Secret | Lives | Blast radius | Rotation |
|---|---|---|---|
| Deploy / upgrade keypair | Joshua's machine only, outside the repo | replace the devnet program | new keypair + `solana program set-upgrade-authority` |
| Demo admin keypair | Joshua's machine only | set fake prices on devnet | re-init feed with a new authority |
| Optional RPC URL | NEXT_PUBLIC_ env on Vercel | rate-limit abuse of a free key | regenerate in provider dashboard |

## Supply chain
Lockfiles committed; installs frozen; `pnpm` install scripts off except an allowlist; third-party actions pinned by commit hash (harness check); toolchain pinned (`rust-toolchain.toml`, `Anchor.toml`, `.nvmrc`).

## Branch policy
`main` protected: required checks, no force push, no direct push. Claude Code opens PRs; Joshua merges after the Codex verdict.
