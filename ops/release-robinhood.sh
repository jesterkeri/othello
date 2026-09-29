#!/usr/bin/env bash
# Release the Robinhood page as a PREBUILT artifact, and deploy exactly the bytes that were scanned (Codex code
# review r2 MAJOR 2, r3 M1). Joshua runs this with his own Vercel login; nothing else deploys.
#
#   ops/release-robinhood.sh [--prod]   preview by default; production only on Joshua's go
#
# 1. refuses a checkout with any change or untracked file (a release is built from a commit), then builds from a FRESH
#    CLONE of that commit with dependencies installed from the lockfiles, so no gitignored file (an app/.env*.local that
#    next build would inline, a build cache, anything under app/.vercel or node_modules) can take part;
# 2. installs the pinned Vercel CLI with npm ci from ops/vercel-cli's lockfile into a fresh folder (never npx), checks
#    it is exactly VERCEL_CLI at VERCEL_CLI_INTEGRITY, and builds with it (tests/release-deploy.spec.ts checks this);
# 3. trust-config scans every uploaded file and writes release/robinhood-prebuilt.json and its .files.txt;
# 4. ops/release-deploy.ts rehashes the upload set, refuses on any difference, deploys with the same CLI, rehashes
#    again, and writes the deployment URL into the record. Then commit the record and its file list.
set -euo pipefail
# Every variable that tools read as configuration (npm_config_*, NODE_OPTIONS, GIT_*, pnpm's, VERCEL_*) is dropped: the
# script re-runs itself with an empty environment plus this list. What is refused below is refused first, so it is
# reported rather than silently dropped.
for v in VERCEL_ORG_ID VERCEL_PROJECT_ID VERCEL_TEAM_ID; do
  if [ -n "${!v:-}" ]; then echo "release: $v is set; it would point the Vercel CLI at another project; unset it" >&2; exit 1; fi
done
if [ -n "${NODE_OPTIONS:-}" ]; then echo "release: NODE_OPTIONS is set; it would change every node step of the release; unset it" >&2; exit 1; fi
ALLOWED_ENV=(PATH HOME USER LOGNAME SHELL TERM LANG LC_ALL TMPDIR XDG_DATA_HOME XDG_CONFIG_HOME HTTPS_PROXY HTTP_PROXY NO_PROXY NVM_DIR NVM_BIN ROBINHOOD_RPC)
SCRIPT="$(readlink -f "$0")"
if [ "${RELEASE_ENV_SEALED:-}" != 1 ]; then
  keep=(RELEASE_ENV_SEALED=1)
  for v in "${ALLOWED_ENV[@]}"; do
    if [ -n "${!v:-}" ]; then keep+=("$v=${!v}"); fi
  done
  exec env -i "${keep[@]}" bash "$SCRIPT" "$@"
fi
# the flag is not trusted: the environment itself must hold nothing but the allowed variables (and bash's own)
extra="$(env | cut -d= -f1 | grep -vxE "$(IFS='|'; echo "${ALLOWED_ENV[*]}")|RELEASE_ENV_SEALED|PWD|OLDPWD|SHLVL|_" || true)"
if [ -n "$extra" ]; then echo "release: the environment holds more than the release allows ($(echo $extra)); run it plainly" >&2; exit 1; fi
# the repository the script belongs to, wherever it is run from
cd "$(dirname "$SCRIPT")/.." && cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "release: commit, discard or remove changes and untracked files first; a release is built from a commit" >&2
  git status --short >&2; exit 1
fi
if [ -e .vercel ]; then echo "release: a .vercel folder at the repository root can move the Vercel CLI's project root; remove it" >&2; exit 1; fi
for f in vercel.* now.* VERCEL.* Vercel.*; do
  if [ -e "$f" ]; then echo "release: $f at the repository root would change how the Vercel CLI finds the project; remove it" >&2; exit 1; fi
done
for p in node_modules/vercel node_modules/.bin/vercel app/node_modules/vercel app/node_modules/.bin/vercel; do
  if [ -e "$p" ]; then echo "release: $p is a local Vercel CLI; the release runs only its own verified install (remove it)" >&2; exit 1; fi
done
REPO="$(pwd)"
# the build folder is private (under HOME, mode 700), never the shared /tmp: node resolves a missing package from any
# node_modules ABOVE the clone, so no other user may be able to write above it (--preflight also refuses such files).
# It is made before any tool runs, and every temporary file from here on (node's compile cache, tsx's, npm's, pnpm's,
# next's) lives in it: a shared /tmp would let another user plant or rewrite what a step runs.
mkdir -p "$HOME/.cache/othello-release" && chmod 700 "$HOME/.cache/othello-release"
WORK="$(mktemp -d "$HOME/.cache/othello-release/XXXXXXXX")"
# on ANY exit, a record the clone wrote (even one that only says a deploy started) comes back before the folder goes, so
# an interrupted or failed deploy is never invisible in the checkout
trap 'if [ -f "$WORK/repo/release/robinhood-prebuilt.json" ]; then mkdir -p "$REPO/release" && cp "$WORK/repo/release/robinhood-prebuilt.json" "$WORK/repo/release/robinhood-prebuilt.files.txt" "$REPO/release/"; fi; rm -rf "$WORK"' EXIT
export TMPDIR="$WORK/tmp"; mkdir -m 700 "$TMPDIR"
TARGET="preview"; PROD=""
if [ "${1:-}" = "--prod" ]; then TARGET="production"; PROD="--prod"; fi
[ "$(pnpm --version 2>/dev/null)" = "10.32.1" ] || { echo "release: needs pnpm 10.32.1 on PATH (npm install -g pnpm@10.32.1)" >&2; exit 1; }
[ -f app/.vercel/project.json ] || { echo "release: link the Vercel project first (app/.vercel/project.json)" >&2; exit 1; }
COMMIT="$(git rev-parse HEAD)"

# the fresh clone: only the commit's files, plus the project link (checked by --preflight inside the clone). git runs
# with no system or global config, no clone templates and no hooks, so nothing outside the commit runs or rewrites it.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git clone -q --no-local --template= -c core.hooksPath=/dev/null "$REPO" "$WORK/repo"
git -C "$WORK/repo" -c core.hooksPath=/dev/null checkout -q --detach "$COMMIT"
mkdir "$WORK/repo/app/.vercel" && cp app/.vercel/project.json "$WORK/repo/app/.vercel/project.json"
cd "$WORK/repo"
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile
pnpm -C app install --frozen-lockfile --ignore-scripts --ignore-pnpmfile
# the checks run with the clone's own tsx, started by node directly (npx would apply npm's node-options setting)
TSX=(node "$WORK/repo/node_modules/tsx/dist/cli.mjs" --no-cache)
"${TSX[@]}" ops/release-deploy.ts --preflight   # repo root, app/.vercel and the project link (keys, ids)
mkdir "$WORK/cli"
VC="$("${TSX[@]}" ops/release-deploy.ts --install-cli "$WORK/cli")"   # verified vercel@59.11.7 vc.js
RPC="${ROBINHOOD_RPC:-https://rpc.testnet.chain.robinhood.com}"
"${TSX[@]}" ops/release-deploy.ts --run-cli "$VC" --cwd app -- pull --yes --environment="$TARGET"
"${TSX[@]}" ops/release-deploy.ts --run-cli "$VC" --cwd app -- build --yes $PROD
mkdir -p release
"${TSX[@]}" ops/trust-config.ts --rpc "$RPC" --vercel-output app/.vercel/output --record release/robinhood-prebuilt.json
"${TSX[@]}" ops/release-deploy.ts --record release/robinhood-prebuilt.json --cli "$VC" $PROD
echo
echo "Released from a fresh clone of $COMMIT. Commit release/robinhood-prebuilt.json and release/robinhood-prebuilt.files.txt"
echo "(the config review reads them)."
