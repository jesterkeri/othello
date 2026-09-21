#!/usr/bin/env bash
# Two checks that catch the pipeline mistakes an agent reliably makes.
set -uo pipefail
D="${1:-.github/workflows}"; [ -d "$D" ] || { echo "no workflows at $D"; exit 0; }
fail=0

# 1. attacker-controlled context interpolated into a shell step
if grep -rnE '\$\{\{[[:space:]]*github\.event\.(issue|pull_request|comment|review|discussion)\.[a-z_.]*(title|body|name|login)' "$D" 2>/dev/null | grep -v 'env:'; then
  echo "FAIL: attacker-controlled context interpolated directly. Pass it through env: and quote the variable."
  fail=1
fi
if grep -rnE '\$\{\{[[:space:]]*github\.head_ref' "$D" 2>/dev/null | grep -v 'env:'; then
  echo "FAIL: github.head_ref is a fork-controlled branch name. Route it through env:."
  fail=1
fi

# 2. pull_request_target at all
if grep -rn 'pull_request_target' "$D" 2>/dev/null; then
  echo "FAIL: pull_request_target runs with secrets against a fork's pull request. Use pull_request, or justify it in a comment on the line and remove this check."
  fail=1
fi

# 3. actions pinned to a mutable tag. Tags move; that is how the known compromises worked.
#    Owner must be matched at the start of the action reference, not anywhere in it:
#    "tj-actions/..." contains "actions/" and must NOT be treated as first-party.
while IFS= read -r line; do
  ref=${line#*uses:}; ref=${ref## }; ref=${ref%% *}
  case "$ref" in
    actions/*|github/*) ;;                      # first-party, tag is acceptable
    ./*|docker://*) ;;                          # local or docker, different rules
    *) echo "FAIL unpinned third-party action: $ref"
       echo "     Pin to a full 40-character commit sha, e.g. owner/repo@<sha> # v1.2.3"
       fail=1 ;;
  esac
done < <(grep -rhE '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*[^ ]+@[^ ]+' "$D" 2>/dev/null | grep -vE '@[0-9a-f]{40}')

[ "$fail" -eq 0 ] && echo "workflows clean"
exit $fail
