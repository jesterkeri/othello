#!/usr/bin/env bash
# Blocks commands that cross a boundary the design reserved for a human.
# Deny rules in settings.json cover exact prefixes; this catches the shapes
# that a prefix rule cannot express.
set -uo pipefail
input=$(cat)
deny() {
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 0
  fi
  echo "$1" >&2; exit 2
}
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
else
  cmd=$(printf '%s' "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi
[ -z "$cmd" ] && exit 0
low=$(printf '%s' "$cmd" | tr '[:upper:]' '[:lower:]')

# Anything that broadcasts, publishes or deploys is a human decision, per the design.
echo "$low" | grep -qE '(^|[;&|[:space:]])(forge|cast)[[:space:]].*--broadcast' && \
  deny "Broadcasting a transaction is gated on a human. CI produces calldata and a simulation; a multisig executes. Run the simulation without --broadcast instead."
echo "$low" | grep -qE 'sui[[:space:]]+client[[:space:]]+(publish|upgrade)' && \
  deny "Publishing or upgrading a Sui package is gated on a human and the UpgradeCap holder, which is not this session."
echo "$low" | grep -qE 'npm[[:space:]]+publish|pnpm[[:space:]]+publish|yarn[[:space:]]+npm[[:space:]]+publish' && \
  deny "Publishing a package is a release action, not a build task."
echo "$low" | grep -qE 'supabase[[:space:]]+db[[:space:]]+push|prisma[[:space:]]+migrate[[:space:]]+deploy' && \
  deny "Applying migrations to a remote database is gated. Run them against the local or branch database instead."
echo "$low" | grep -qE '(vercel|netlify|wrangler)[[:space:]].*(--prod|deploy[[:space:]]+--prod)' && \
  deny "Deploying to production is gated on the pre-deployment checklist and a human."

# Secret exfiltration shapes. The documented agent-injection incidents all end here.
echo "$low" | grep -qE '(cat|less|head|tail|xxd|base64)[[:space:]]+[^|;&]*(/proc/[0-9a-z]+/environ|\.env($|[[:space:]])|\.npmrc|id_rsa|\.aws/credentials)' && \
  deny "Reading credential material is blocked. If a task genuinely needs a secret, it is passed as an environment variable by the runner, never read from disk by the agent."
echo "$low" | grep -qE '\bcurl\b[^|;&]*(-d|--data|-F|--upload-file|-T)\b' && \
  deny "Posting data to a network endpoint from inside a build task is blocked: this is the exfiltration step in every documented agent-injection incident. If this is a legitimate API call, state what it sends and let a human approve it."
echo "$low" | grep -qE 'env[[:space:]]*\|[[:space:]]*(curl|nc|wget)|printenv[[:space:]]*\|' && \
  deny "Piping the environment to a network command is blocked."

# Test-suite tampering.
echo "$low" | grep -qE '(rm|git[[:space:]]+rm)[[:space:]]+[^|;&]*(test|spec)' && \
  deny "Deleting tests is blocked. A failing test is a finding, not an obstacle. Report it."
echo "$low" | grep -qE '\-\-dangerously-skip-permissions|--no-verify' && \
  deny "Bypassing verification is blocked. If a pre-commit hook fails, fix the cause."
exit 0
