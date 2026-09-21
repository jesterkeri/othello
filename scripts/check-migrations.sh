#!/usr/bin/env bash
# Fails on a migration that cannot be rolled back unless it is explicitly acknowledged.
# You cannot roll back a DROP. This forces the decision to be deliberate.
set -uo pipefail
DIR="${1:-supabase/migrations}"
BASE="${BASE_REF:-origin/main}"
[ -d "$DIR" ] || { echo "no migrations dir at $DIR, skipping"; exit 0; }

# Prefer only what this branch adds. If the base ref is unavailable, fall back to
# scanning everything rather than silently passing, which is the dangerous failure.
if git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  changed=$(git diff --name-only --diff-filter=A "$BASE"...HEAD -- "$DIR" 2>/dev/null || true)
  scope="new since $BASE"
else
  echo "note: base ref '$BASE' not found, scanning all migrations instead"
  changed=$(find "$DIR" -type f -name '*.sql' 2>/dev/null)
  scope="all files"
fi
[ -z "$changed" ] && { echo "no migrations to check ($scope)"; exit 0; }

fail=0
for f in $changed; do
  [ -f "$f" ] || continue
  if grep -qiE 'drop[[:space:]]+(table|column|schema)|alter[[:space:]]+column[^;]*type|set[[:space:]]+not[[:space:]]+null|truncate' "$f"; then
    if grep -qiE '^--[[:space:]]*destructive:[[:space:]]*acknowledged' "$f" && grep -qiE '^--[[:space:]]*recovery:' "$f"; then
      echo "OK   $f destructive, acknowledged with a recovery note"
    else
      echo "FAIL $f contains destructive DDL with no acknowledgement"
      echo "     You cannot roll back a DROP. Either split it into a later migration,"
      echo "     or add these two lines at the top of the file:"
      echo "       -- destructive: acknowledged"
      echo "       -- recovery: <how you recover if this is wrong>"
      fail=1
    fi
  fi
done
exit $fail
