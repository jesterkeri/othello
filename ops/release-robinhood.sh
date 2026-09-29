#!/usr/bin/env bash
# Release the Robinhood page as a PREBUILT artifact (Codex code review r2, MAJOR 2): the bytes CI's gate scans are the
# bytes Vercel serves. Joshua runs this with his own Vercel login; it never deploys by itself.
#
#   ops/release-robinhood.sh [--prod]   build, scan, fingerprint, write release/robinhood-prebuilt.json (+ .files.txt)
#   then:  cd app && vercel deploy --prebuilt [--prod]   (preview by default; production only on Joshua's go)
#   then:  put the printed deployment URL into release/robinhood-prebuilt.json "deploymentUrl" and commit it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "release: commit, discard or remove changes and untracked files first; a release is built from a commit" >&2
  git status --short >&2; exit 1
fi
TARGET="preview"; PROD=""
if [ "${1:-}" = "--prod" ]; then TARGET="production"; PROD="--prod"; fi
command -v pnpm >/dev/null || { echo "release: vercel build runs pnpm; install it first (npm install -g pnpm@10.32.1)" >&2; exit 1; }
RPC="${ROBINHOOD_RPC:-https://rpc.testnet.chain.robinhood.com}"
(cd app && vercel pull --yes --environment="$TARGET")
(cd app && vercel build --yes $PROD)
npx tsx ops/trust-config.ts --rpc "$RPC" --vercel-output app/.vercel/output --record release/robinhood-prebuilt.json
echo
echo "Scanned and recorded. Deploy exactly this build:"
echo "  cd app && vercel deploy --prebuilt $PROD"
echo "Do not run next dev/build or pnpm install in app/ until it is deployed: the deploy uploads app/.next and"
echo "node_modules files the scan just fingerprinted (release/robinhood-prebuilt.files.txt)."
