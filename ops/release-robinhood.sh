#!/usr/bin/env bash
# Release the Robinhood page as a PREBUILT artifact (Codex code review r2, MAJOR 2): the bytes CI's gate scans are the
# bytes Vercel serves. Joshua runs this with his own Vercel login; it never deploys by itself.
#
#   ops/release-robinhood.sh            build, scan, fingerprint, write release/robinhood-prebuilt.json
#   then:  cd app && vercel deploy --prebuilt     (preview; production only on Joshua's go)
#   then:  put the printed deployment URL into release/robinhood-prebuilt.json "deploymentUrl" and commit it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "release: commit or discard changes first; a release is built from a commit" >&2; exit 1
fi
RPC="${ROBINHOOD_RPC:-https://rpc.testnet.chain.robinhood.com}"
(cd app && vercel pull --yes --environment=preview)
(cd app && vercel build --yes)
npx tsx ops/trust-config.ts --rpc "$RPC" --vercel-output app/.vercel/output --record release/robinhood-prebuilt.json
echo
echo "Scanned and recorded. Deploy exactly this build:"
echo "  cd app && vercel deploy --prebuilt"
