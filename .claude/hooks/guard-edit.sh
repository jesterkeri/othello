#!/usr/bin/env bash
# Blocks edits to artifacts the builder must not rewrite.
# Failure modes addressed: constraint violation (~38% of real agent sessions),
# and weakening or deleting a failing test to make a gate pass.
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
  path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
else
  path=$(printf '%s' "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi
[ -z "$path" ] && exit 0
base=$(basename "$path")

case "$base" in
  SPEC.md|INVARIANTS.md)
    deny "$base is the frozen contract for this build. If it is wrong, stop and report it: the design is corrected in the design session and the pack is re-handed. Record the problem in OPEN-QUESTIONS.md instead." ;;
  KNOWN-LIMITS.md|ARCHITECTURE.md|GLOSSARY.md)
    deny "$base is owned by the design session, not the build. Append the issue to OPEN-QUESTIONS.md instead." ;;
esac
case "$path" in
  */adr/*|adr/*)
    deny "ADRs are append-only and superseded, never edited. Add a new ADR that supersedes this one." ;;
  */supabase/migrations/*|supabase/migrations/*|*/migrations/*)
    if [ -f "$path" ]; then
      deny "Applied migrations are immutable. Editing one desynchronises every environment that already ran it. Write a new migration instead." ;
    fi ;;
  */.github/workflows/*|.github/workflows/*)
    deny "Workflow files change the security boundary of the pipeline. Propose the diff in the response for human review rather than writing it." ;;
  */.claude/*|.claude/*)
    deny "Agent configuration is out of scope for a build task and is a known malware persistence target. Propose the change instead of writing it." ;;
esac
exit 0
