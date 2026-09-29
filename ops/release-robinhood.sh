#!/usr/bin/env bash
# Release the Robinhood page as a PREBUILT artifact, and deploy exactly the bytes that were scanned (Codex code
# review r2 MAJOR 2, r3 M1). Joshua runs this with his own Vercel login; nothing else deploys.
#
#   ops/release-robinhood.sh [--prod]   preview by default; production only on Joshua's go
#
# 1. refuses a checkout with any change or untracked file (a release is built from a commit);
# 2. installs the pinned Vercel CLI with npm ci from ops/vercel-cli's lockfile into a fresh folder (never npx), checks
#    it is exactly VERCEL_CLI at VERCEL_CLI_INTEGRITY, and builds with it (tests/release-deploy.spec.ts checks this);
# 3. trust-config scans every uploaded file and writes release/robinhood-prebuilt.json and its .files.txt;
# 4. ops/release-deploy.ts rehashes the upload set, refuses on any difference, deploys with the same CLI, rehashes
#    again, and writes the deployment URL into the record. Then commit the record and its file list.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "release: commit, discard or remove changes and untracked files first; a release is built from a commit" >&2
  git status --short >&2; exit 1
fi
for v in VERCEL_ORG_ID VERCEL_PROJECT_ID VERCEL_TEAM_ID; do
  if [ -n "${!v:-}" ]; then echo "release: $v is set; it would point the Vercel CLI at another project; unset it" >&2; exit 1; fi
done
if [ -e .vercel ]; then echo "release: a .vercel folder at the repository root can move the Vercel CLI's project root; remove it" >&2; exit 1; fi
for f in vercel.* now.* VERCEL.* Vercel.*; do
  if [ -e "$f" ]; then echo "release: $f at the repository root would change how the Vercel CLI finds the project; remove it" >&2; exit 1; fi
done
for p in node_modules/vercel node_modules/.bin/vercel app/node_modules/vercel app/node_modules/.bin/vercel; do
  if [ -e "$p" ]; then echo "release: $p is a local Vercel CLI; the release runs only its own verified install (remove it)" >&2; exit 1; fi
done
TARGET="preview"; PROD=""
if [ "${1:-}" = "--prod" ]; then TARGET="production"; PROD="--prod"; fi
command -v pnpm >/dev/null || { echo "release: the Vercel build runs pnpm; install it first (npm install -g pnpm@10.32.1)" >&2; exit 1; }
# app/.vercel is build state (gitignored): keep only the project link, so nothing planted there (a builders folder,
# a compiled config, an old output) takes part; pull and build then write it afresh.
[ -f app/.vercel/project.json ] || { echo "release: link the Vercel project first (app/.vercel/project.json)" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cp app/.vercel/project.json "$WORK/project.json"
rm -rf app/.vercel && mkdir app/.vercel && cp "$WORK/project.json" app/.vercel/project.json
npx tsx ops/release-deploy.ts --preflight   # repo root, app/.vercel and the project link (keys, ids)
mkdir "$WORK/cli"
VC="$(npx tsx ops/release-deploy.ts --install-cli "$WORK/cli")"   # verified vercel@59.11.7 vc.js
RPC="${ROBINHOOD_RPC:-https://rpc.testnet.chain.robinhood.com}"
npx tsx ops/release-deploy.ts --run-cli "$VC" --cwd app -- pull --yes --environment="$TARGET"
npx tsx ops/release-deploy.ts --run-cli "$VC" --cwd app -- build --yes $PROD
npx tsx ops/trust-config.ts --rpc "$RPC" --vercel-output app/.vercel/output --record release/robinhood-prebuilt.json
npx tsx ops/release-deploy.ts --record release/robinhood-prebuilt.json --cli "$VC" $PROD
echo
echo "Released. Commit release/robinhood-prebuilt.json and release/robinhood-prebuilt.files.txt (the config review reads them)."
