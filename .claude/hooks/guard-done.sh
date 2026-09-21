#!/usr/bin/env bash
# Stop hook. Refuses to end a turn that checked a task off without pasting
# the verification output into DONE.md.
# Failure mode addressed: agents reporting work complete that is not (~23% of real sessions).
set -uo pipefail
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
T="$ROOT/TASKS.md"; D="$ROOT/DONE.md"
[ -f "$T" ] || exit 0            # not a pipeline project, nothing to enforce
[ -f "$D" ] || { echo "TASKS.md exists but DONE.md does not. Create it before marking any task complete." >&2; exit 2; }

missing=""
while IFS= read -r line; do
  id=$(printf '%s' "$line" | grep -oE '\b[A-Z]+[0-9]+\b' | head -1)
  [ -z "$id" ] && continue
  grep -q "$id" "$D" || missing="${missing}${id} "
done < <(grep '^- \[x\]' "$T" 2>/dev/null || true)

if [ -n "$missing" ]; then
  cat >&2 <<MSG
Blocked: these tasks are checked off in TASKS.md but have no entry in DONE.md: ${missing}
A task is complete only when its verification command has been run and its ACTUAL output is recorded.
For each id above append to DONE.md:
  ## <id> — <date>
  commit: <sha>
  verified: <the exact command you ran>
  output:
  <paste the real output, not a summary>
  notes: <anything that changed the design>
If the verification did not pass, uncheck the task instead.
MSG
  exit 2
fi
exit 0
