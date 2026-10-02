#!/bin/bash -p
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
# GNU tools at fixed paths under /usr/bin are assumed below (stat -c, the absolute tool paths): Linux only
[ "$(/usr/bin/uname -s 2>/dev/null)" = Linux ] || { echo "release: runs on Linux only (WSL included)" >&2; exit 1; }
# Every variable that tools read as configuration (npm_config_*, NODE_OPTIONS, GIT_*, pnpm's, VERCEL_*) is dropped: the
# script re-runs itself with an empty environment plus this list. What is refused below is refused first, so it is
# reported rather than silently dropped.
for v in VERCEL_ORG_ID VERCEL_PROJECT_ID VERCEL_TEAM_ID; do
  if [ -n "${!v:-}" ]; then echo "release: $v is set; it would point the Vercel CLI at another project; unset it" >&2; exit 1; fi
done
if [ -n "${NODE_OPTIONS:-}" ]; then echo "release: NODE_OPTIONS is set; it would change every node step of the release; unset it" >&2; exit 1; fi
ALLOWED_ENV=(PATH HOME USER LOGNAME SHELL TERM LANG LC_ALL TMPDIR XDG_DATA_HOME XDG_CONFIG_HOME HTTPS_PROXY HTTP_PROXY NO_PROXY NVM_DIR NVM_BIN ROBINHOOD_RPC)
# before the seal below nothing is looked up on the caller's PATH: builtins and absolute system paths only, and bash -p
# (no BASH_ENV, no functions taken from the environment) for the re-run (Codex r6 F1)
SCRIPT="$(/usr/bin/readlink -f "$0")"
if [ "${RELEASE_ENV_SEALED:-}" != 1 ]; then
  keep=(RELEASE_ENV_SEALED=1)
  for v in "${ALLOWED_ENV[@]}"; do
    if [ -n "${!v:-}" ]; then keep+=("$v=${!v}"); fi
  done
  exec /usr/bin/env -i "${keep[@]}" /bin/bash -p "$SCRIPT" "$@"
fi
# PATH, before any command is looked up on it (Codex r6 F1). The trust boundary: the operator's own account is trusted,
# because anything running as it already holds the Vercel login in HOME and could deploy without this script; so the
# release does not authenticate the operator's own toolchain (node, pnpm, npm, forge found on PATH). What is not the
# operator's is dropped from PATH before anything runs: a relative or empty entry (the working folder), a missing folder,
# a folder owned by another user, and a folder that group or others can write to, or that sits under one they can write
# to without the sticky bit (where another user could plant or swap a program; WSL's /mnt/c folders are all 0777). The
# system tools the release itself uses (git, env, grep, cut, sort, mkdir, cp, rm, mktemp, chmod, dirname, readlink, stat,
# id, bash) are run by absolute path, so PATH only ever supplies the operator's own toolchain. Builtins only here.
me="$(/usr/bin/id -u)"
# a folder is the operator's own when it and every folder above it belong to the operator or root, it cannot be written
# by group or others, and a folder above can be only with the sticky bit (which stops others, not that folder's owner:
# hence the owner rule for every folder above too; adversary pass on 7afd45e)
declare -A own_ok=()
own_dir() {
  local d="$1" o m first=1
  [ -n "${own_ok[$1]:-}" ] && return 0
  while :; do
    read -r o m <<< "$(/usr/bin/stat -L -c '%u %a' -- "$d" 2>/dev/null)" || return 1
    [ -n "$m" ] || return 1
    { [ "$o" = "$me" ] || [ "$o" = 0 ]; } || return 1
    if (( 8#$m & 8#022 )); then
      [ "$first" = 1 ] && return 1
      (( 8#$m & 8#1000 )) || return 1
    fi
    first=0
    if [ "$d" = / ]; then own_ok[$1]=1; return 0; fi
    d="${d%/*}"; [ -n "$d" ] || d=/
  done
}
safe_path=""
dropped=0
rest="$PATH"
while :; do
  d="${rest%%:*}"
  # judged and kept as the folder it resolves to, once: a link (or /proc/self/cwd) would otherwise be checked by its
  # name and resolved again at every lookup, into a folder the checks never saw (adversary pass on 275f514)
  why=""
  if [ "${d#/}" = "$d" ]; then why="relative or empty"
  elif ! r="$(/usr/bin/realpath -e -- "$d" 2>/dev/null)" || [ ! -d "$r" ]; then why="missing"
  elif ! own_dir "$r"; then why="another user's, or it or a folder above it writable by others"
  fi
  if [ -z "$why" ]; then
    safe_path="${safe_path:+$safe_path:}$r"
  else
    dropped=$((dropped + 1))
    echo "release: not using PATH entry \"$d\" ($why)" >&2
  fi
  [ "$rest" = "${rest#*:}" ] && break
  rest="${rest#*:}"
done
if [ "$dropped" -gt 0 ]; then echo "release: $dropped PATH entries that are not the operator's own (relative, missing, another user's, or writable by others) are not used" >&2; fi
[ -n "$safe_path" ] || { echo "release: no PATH folder is the operator's own; nothing can run" >&2; exit 1; }
export PATH="$safe_path"
# every program a lookup can find in a kept folder must itself be the operator's: the release's own tools look up others
# by name on this PATH (pnpm runs sh, next's shim sed and dirname, the build uname and getconf, the Vercel CLI git), so
# no list of names is enough (adversary passes on 7afd45e and aed6598). Each kept folder's files must belong to the
# operator or root and be unwritable by group or others; each link is followed hop by hop, every folder a hop lives in
# (the one a dangling link points into included) must be an own folder, and the file it ends at must pass the same
# rule. The release then runs with a PATH of one private folder ($WORK/bin, built below) holding a link to the final
# file of every program that passes, in PATH order (the first of a name wins, as a lookup would): a program that does
# not pass (on WSL, Docker Desktop's links into /mnt/wsl) is simply absent, and nothing found later can be swapped.
own_program() {
  local cur="$1" dir t o m hops=0
  while :; do
    dir="$(/usr/bin/realpath -e -- "${cur%/*}/" 2>/dev/null)" && own_dir "$dir" || return 1
    cur="$dir/${cur##*/}"
    [ -L "$cur" ] || break
    hops=$((hops + 1)); [ "$hops" -le 40 ] || return 1
    t="$(/usr/bin/readlink -- "$cur")"
    case "$t" in /*) cur="$t" ;; *) cur="$dir/$t" ;; esac
  done
  own_target="$cur"
  [ -e "$cur" ] || return 0
  [ -d "$cur" ] && return 0
  read -r o m <<< "$(/usr/bin/stat -c '%u %a' -- "$cur" 2>/dev/null)" || return 1
  [ -n "$m" ] || return 1
  { [ "$o" = "$me" ] || [ "$o" = 0 ]; } && ! (( 8#$m & 8#022 ))
}
# every tool from here on, the environment check included, matches and parses in the C locale: under a UTF-8 one grep
# drops a line that is not valid UTF-8 (a path git printed raw, a variable name), so a check could pass what it should
# refuse (adversary passes on 86afb72 and 7552f17). LC_ALL is on the allowed list.
export LC_ALL=C
# the flag is not trusted: the environment itself must hold nothing but the allowed variables (and bash's own)
# (by absolute path: a PATH program named env that printed nothing would make this check pass on anything)
extra="$(/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/grep -vxE "$(IFS='|'; echo "${ALLOWED_ENV[*]}")|RELEASE_ENV_SEALED|PWD|OLDPWD|SHLVL|_" || true)"
if [ -n "$extra" ]; then echo "release: the environment holds more than the release allows ($(echo $extra)); run it plainly" >&2; exit 1; fi
# git, from its first call (Codex r5 F2): no system or global configuration (HOME's .gitconfig, XDG's git/config), no
# replace refs, no lazy fetch of a missing object (in a partial clone a tree read would start the configured
# upload-pack; adversary pass on 12f1cb7), and the settings that run a program (core.fsmonitor, hooks) or change what status reports (the user's
# ignore and attributes files, the untracked cache) overridden, and no pager (a repository's core.pager would run when a
# refusal is printed on a terminal; adversary pass on 4570ded). Every git call below is safe_git; the Vercel CLI's own
# git calls get the same variables (ops/release-deploy.ts deployEnv).
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
safe_git() {
  # the C locale: under a UTF-8 one git's regex skips a name that is not valid UTF-8, so the refused-config check below
  # would miss a driver named with such a byte (adversary pass on cf03f94); gitIn runs in the C locale too (PATH only)
  LC_ALL=C /usr/bin/git --no-pager --no-replace-objects -c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null \
    -c core.excludesFile=/dev/null -c core.attributesFile=/dev/null -c core.quotePath=true "$@"
}
# the repository the script belongs to, wherever it is run from
cd "$(/usr/bin/dirname "$SCRIPT")/.." && cd "$(safe_git rev-parse --show-toplevel)"
# a repository's own config can name programs git starts while it compares files (a clean or process filter during
# status, a diff or merge driver) or fetches (a partial clone's promisor remote, its upload-pack, an ssh command or
# proxy), and no -c switch turns those off: refused before the first status (adversary passes on ce04cd9 and 12f1cb7).
# A release checkout is an ordinary full clone. Reading config runs nothing.
drivers="$(safe_git config --get-regexp '^(filter\..*\.(clean|smudge|process)|diff\..*\.(textconv|command)|merge\..*\.driver|diff\.external|remote\..*\.(uploadpack|receivepack|promisor|partialclonefilter)|extensions\.partialclone|core\.(sshcommand|gitproxy|askpass))$' | /usr/bin/cut -d' ' -f1 || true)"
if [ -n "$drivers" ]; then echo "release: the repository's own config names programs that would run during its checks ($(echo $drivers)); remove them" >&2; exit 1; fi
# a gitlink (another repository's commit) belongs only under evm/lib/, the contracts' pinned libraries, which are no
# build input here (the fresh clone below initialises its own from the commit's gitlinks). git answers for a gitlink
# from that repository's own config, and treats one it cannot open as unchanged (adversary pass on d39ec27), so none may
# exist anywhere else, in HEAD or in the index. Reading the tree and the index opens no submodule.
tree="$(safe_git ls-tree -r HEAD)" || { echo "release: HEAD's tree cannot be read; the checkout cannot be checked" >&2; exit 1; }
index="$(safe_git ls-files -s)" || { echo "release: the index cannot be read; the checkout cannot be checked" >&2; exit 1; }
links="$(printf '%s\n%s\n' "$tree" "$index" | /usr/bin/grep '^160000 ' | /usr/bin/cut -f2- | /usr/bin/grep -v '^evm/lib/' | /usr/bin/sort -u || true)"
if [ -n "$links" ]; then echo "release: a nested repository outside evm/lib/ ($(echo $links)); a release builds from this repository's own files" >&2; exit 1; fi
# submodule work trees are not looked into: git would run a status inside each with that submodule's own config (its
# filter drivers included; adversary pass on 4570ded). "dirty", not "all": an added, removed or moved gitlink is still
# reported (adversary pass on 1e196ff). A status that fails stops the release (its output is not read as "clean").
status="$(safe_git status --porcelain --untracked-files=all --ignore-submodules=dirty)" || { echo "release: the status check failed; the checkout cannot be checked" >&2; exit 1; }
if [ -n "$status" ]; then
  echo "release: commit, discard or remove changes and untracked files first; a release is built from a commit" >&2
  safe_git status --short --ignore-submodules=dirty >&2; exit 1
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
/usr/bin/mkdir -p "$HOME/.cache/othello-release" && /usr/bin/chmod 700 "$HOME/.cache/othello-release"
WORK="$(/usr/bin/mktemp -d "$HOME/.cache/othello-release/XXXXXXXX")"
# on ANY exit, a record that reached the deploy step (it carries deployStartedAt, written before Vercel is contacted)
# comes back to the checkout before the folder goes, so an interrupted or failed deploy is never invisible; a record from
# a run that stopped earlier never replaces the committed one. The copy cannot stop the clean-up.
bring_back() {
  local r="$WORK/repo/release/robinhood-prebuilt.json"
  if [ -f "$r" ] && /usr/bin/grep -q '"deployStartedAt": "' "$r"; then
    /usr/bin/mkdir -p "$REPO/release" && /usr/bin/cp "$r" "$WORK/repo/release/robinhood-prebuilt.files.txt" "$REPO/release/"
  fi
}
# if the record cannot be copied back, the folder that holds it is KEPT and the release fails, saying where it is
trap 'if bring_back; then /usr/bin/rm -rf "$WORK"; else echo "release: could not copy the record back; it is kept at $WORK/repo/release/robinhood-prebuilt.json and robinhood-prebuilt.files.txt (copy both into release/ yourself)" >&2; exit 1; fi' EXIT
export TMPDIR="$WORK/tmp"; /usr/bin/mkdir -m 700 "$TMPDIR"
/usr/bin/mkdir -m 700 "$WORK/bin"
declare -A seen=() unsafe=()
skipped=()
rest="$PATH"
while :; do
  d="${rest%%:*}"
  unsafe=()
  while IFS= read -r -d '' f; do unsafe[${f##*/}]=1; done \
    < <(/usr/bin/find "$d" -mindepth 1 -maxdepth 1 -type f \( ! -uid "$me" ! -uid 0 -o -perm /022 \) -print0 2>/dev/null)
  files=()
  for f in "$d"/* "$d"/.[!.]*; do
    n="${f##*/}"
    [ -e "$f" ] || [ -L "$f" ] || continue
    [ -n "${seen[$n]:-}" ] && continue
    # like a lookup: an entry that cannot run (a folder, a dangling link, not executable) is passed over; one that is not
    # the operator's own is passed over too and named; the first that passes wins its name
    own_target=""
    if [ -L "$f" ]; then
      if own_program "$f"; then
        if [ -f "$own_target" ] && [ -x "$own_target" ]; then /usr/bin/ln -s -- "$own_target" "$WORK/bin/$n"; seen[$n]=1; fi
      else
        skipped+=("$f")
      fi
    elif [ -f "$f" ] && [ -x "$f" ]; then
      if [ -n "${unsafe[$n]:-}" ]; then skipped+=("$f"); else files+=("$f"); seen[$n]=1; fi
    fi
  done
  [ "${#files[@]}" -eq 0 ] || /usr/bin/ln -s -t "$WORK/bin" -- "${files[@]}"
  [ "$rest" = "${rest#*:}" ] && break
  rest="${rest#*:}"
done
if [ "${#skipped[@]}" -gt 0 ]; then echo "release: not using ${#skipped[@]} program(s) that are not the operator's own: ${skipped[*]}" >&2; fi
export PATH="$WORK/bin"
TARGET="preview"; PROD=""
if [ "${1:-}" = "--prod" ]; then TARGET="production"; PROD="--prod"; fi
[ "$(pnpm --version 2>/dev/null)" = "10.32.1" ] || { echo "release: needs pnpm 10.32.1 on PATH (npm install -g pnpm@10.32.1)" >&2; exit 1; }
[ -f app/.vercel/project.json ] || { echo "release: link the Vercel project first (app/.vercel/project.json)" >&2; exit 1; }
COMMIT="$(safe_git rev-parse HEAD)"

# the fresh clone: only the commit's files, plus the project link (checked by --preflight inside the clone). git runs
# with no system or global config, no clone templates and no hooks, so nothing outside the commit runs or rewrites it;
# the clone keeps hooks and fsmonitor off in its own config for every later git call in it (the CLI's included).
safe_git clone -q --no-local --template= -c core.hooksPath=/dev/null -c core.fsmonitor=false "$REPO" "$WORK/repo"
safe_git -C "$WORK/repo" checkout -q --detach "$COMMIT"
/usr/bin/mkdir "$WORK/repo/app/.vercel" && /usr/bin/cp app/.vercel/project.json "$WORK/repo/app/.vercel/project.json"
cd "$WORK/repo"
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile
pnpm -C app install --frozen-lockfile --ignore-scripts --ignore-pnpmfile
# the checks run with the clone's own tsx, started by node directly (npx would apply npm's node-options setting)
TSX=(node "$WORK/repo/node_modules/tsx/dist/cli.mjs" --no-cache)
"${TSX[@]}" ops/release-deploy.ts --preflight --before-pull   # the reviewed target and settings document, repo root, app/.vercel, the link
# a set TRUSTED_FACTORY is verified against the reviewed contract's own build (trust-config reads evm/out): fetch the
# libraries at the commits the repository pins and build them here from scratch (--force: no committed or cached
# output is reused), never from the working checkout's evm/out. Whether it is set is asked of trust-config's own parser.
CONFIG_STATE="$("${TSX[@]}" ops/trust-config.ts --config-state)"
if [ "$CONFIG_STATE" != "null" ]; then
  safe_git -c init.templateDir= submodule update --init --recursive -q
  (cd evm && forge build --force)
fi
/usr/bin/mkdir "$WORK/cli"
VC="$("${TSX[@]}" ops/release-deploy.ts --install-cli "$WORK/cli")"   # verified vercel@59.11.7 vc.js
RPC="${ROBINHOOD_RPC:-https://rpc.testnet.chain.robinhood.com}"
"${TSX[@]}" ops/release-deploy.ts --run-cli "$VC" --cwd app -- pull --yes --environment="$TARGET"
# the pulled project variables: checked by name only (never their values) against the reviewed list, then removed, so
# the build loads none (adversary pass on ce04cd9: a pulled NODE_OPTIONS ran a program in the build)
"${TSX[@]}" ops/release-deploy.ts --drop-pulled-env
"${TSX[@]}" ops/release-deploy.ts --run-cli "$VC" --cwd app -- build --yes $PROD
"${TSX[@]}" ops/release-deploy.ts --preflight   # again: the pulled settings are the reviewed ones; build changed nothing about the target or app/.vercel
/usr/bin/mkdir -p release
"${TSX[@]}" ops/trust-config.ts --rpc "$RPC" --vercel-output app/.vercel/output --record release/robinhood-prebuilt.json
"${TSX[@]}" ops/release-deploy.ts --record release/robinhood-prebuilt.json --cli "$VC" $PROD
echo
echo "Released from a fresh clone of $COMMIT. Commit release/robinhood-prebuilt.json and release/robinhood-prebuilt.files.txt"
echo "(the config review reads them)."
