#!/usr/bin/env bash
# Every completed task must name its review. Every review must have reached a verdict,
# and no gate merges on "changes required".
# Failure mode addressed: the review step being the one that quietly gets skipped
# under deadline, which is exactly when it matters most.
set -uo pipefail
fail=0

# 1. Every DONE.md entry names a review, or says n/a with a reason.
if [ -f DONE.md ]; then
  cur=""
  while IFS= read -r line; do
    case "$line" in
      '## '*) 
        if [ -n "$cur" ] && [ "$seen" -eq 0 ]; then
          echo "FAIL $cur has no 'reviewed:' line in DONE.md"; fail=1
        fi
        cur=$(printf '%s' "$line" | sed 's/^## //'); seen=0 ;;
      reviewed:*) seen=1 ;;
    esac
  done < DONE.md
  if [ -n "$cur" ] && [ "${seen:-0}" -eq 0 ]; then
    echo "FAIL $cur has no 'reviewed:' line in DONE.md"; fail=1
  fi
  [ "$fail" -eq 1 ] && {
    echo "     Each entry needs one of:"
    echo "       reviewed: reviews/gate-N-review.md | verdict: implementation-ready | C0 M0 m2"
    echo "       reviewed: n/a (<why this did not need an independent review>)"
  }
fi

# 2. No review file left at "changes required".
if [ -d reviews ]; then
  for f in reviews/*review*.md; do
    [ -f "$f" ] || continue
    if ! grep -qE '^VERDICT: (implementation-ready|changes required)' "$f"; then
      echo "FAIL $f has no verdict line"; fail=1
    elif grep -qE '^VERDICT: changes required' "$f"; then
      echo "FAIL $f says changes required. Fix and re-review, or record a deliberate override in KNOWN-LIMITS.md and remove the file from this gate."
      fail=1
    fi
  done
fi
[ "$fail" -eq 0 ] && echo "reviews ok"
exit $fail
