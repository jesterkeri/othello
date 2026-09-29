#!/usr/bin/env bash
# Release the Robinhood page as a PREBUILT artifact, and deploy exactly the bytes that were scanned (Codex code
# review r2 MAJOR 2, r3 M1). Joshua runs this with his own Vercel login; nothing else deploys.
#
#   ops/release-robinhood.sh [--prod]   preview by default; production only on Joshua's go
#
# 1. refuses a checkout with any change or untracked file (a release is built from a commit);
# 2. builds with the pinned Vercel CLI (ops/trust-config.ts VERCEL_CLI; tests/release-deploy.spec.ts checks the pin);
# 3. trust-config scans every uploaded file and writes release/robinhood-prebuilt.json and its .files.txt;
# 4. ops/release-deploy.ts rehashes the upload set, refuses on any difference, deploys with the same CLI, rehashes
#    again, and writes the deployment URL into the record. Then commit the record and its file list.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "release: commit, discard or remove changes and untracked files first; a release is built from a commit" >&2
  git status --short >&2; exit 1
fi
TARGET="preview"; PROD=""
if [ "${1:-}" = "--prod" ]; then TARGET="production"; PROD="--prod"; fi
command -v pnpm >/dev/null || { echo "release: the Vercel build runs pnpm; install it first (npm install -g pnpm@10.32.1)" >&2; exit 1; }
VERCEL=(npx --yes vercel@59.11.7)
RPC="${ROBINHOOD_RPC:-https://rpc.testnet.chain.robinhood.com}"
(cd app && "${VERCEL[@]}" pull --yes --environment="$TARGET")
(cd app && "${VERCEL[@]}" build --yes $PROD)
npx tsx ops/trust-config.ts --rpc "$RPC" --vercel-output app/.vercel/output --record release/robinhood-prebuilt.json
npx tsx ops/release-deploy.ts --record release/robinhood-prebuilt.json $PROD
echo
echo "Released. Commit release/robinhood-prebuilt.json and release/robinhood-prebuilt.files.txt (the config review reads them)."
