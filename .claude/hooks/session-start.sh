#!/usr/bin/env bash
# Injects current build state so a fresh session resumes instead of guessing.
# Failure mode addressed: context loss across sessions; agents restarting from a guess.
set -uo pipefail
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
out=""
add() { out="${out}$1"$'\n'; }

add "=== BUILD STATE (injected by harness) ==="
if [ -f "$ROOT/STATUS.md" ]; then
  add "--- STATUS.md ---"; add "$(head -30 "$ROOT/STATUS.md")"
else
  add "STATUS.md missing. If this project went through the design pipeline, it should exist."
fi
if [ -f "$ROOT/TASKS.md" ]; then
  open_count=$(grep -c '^- \[ \]' "$ROOT/TASKS.md" 2>/dev/null || echo 0)
  add "--- TASKS.md: ${open_count} open ---"
  add "$(grep -m 5 '^- \[ \]' "$ROOT/TASKS.md" 2>/dev/null || echo '(none)')"
fi
if [ -f "$ROOT/DONE.md" ]; then
  add "--- last DONE entry ---"; add "$(tail -12 "$ROOT/DONE.md")"
fi
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  add "--- recent commits ---"; add "$(git -C "$ROOT" log --oneline -8 2>/dev/null)"
  dirty=$(git -C "$ROOT" status --porcelain 2>/dev/null | head -10)
  [ -n "$dirty" ] && { add "--- uncommitted ---"; add "$dirty"; }
fi
add "=== RULES ==="
add "Work only the current task. Out-of-scope findings go to OPEN-QUESTIONS.md, not into the diff."
add "A task is done only when its verification command has run and its real output is in DONE.md."
add "Do not edit acceptance criteria in SPEC.md. Do not weaken or delete a failing test."

command -v jq >/dev/null 2>&1 || { printf '%s\n' "$out"; exit 0; }
jq -n --arg ctx "$out" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
exit 0
