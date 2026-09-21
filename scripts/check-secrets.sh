#!/usr/bin/env bash
# Fails if anything that looks like a live credential reached the client bundle.
# The Supabase anon key is expected here and is not a finding; RLS is what protects it.
set -uo pipefail
DIRS="${*:-.next dist build out}"
found=0
for d in $DIRS; do
  [ -d "$d" ] || continue
  while IFS= read -r hit; do
    echo "FAIL $hit"; found=1
  done < <(grep -rIlE 'service_role|sk_live_|sk_test_|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJhbGciOi[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*' "$d" 2>/dev/null | head -20)
done
if [ "$found" -eq 1 ]; then
  echo ""
  echo "Credential-shaped strings found in a build output that ships to the browser."
  echo "Anything behind NEXT_PUBLIC_ or VITE_ is public regardless of its name."
  echo "A Supabase anon key here is expected; a service_role key is an incident."
  exit 1
fi
echo "no credential-shaped strings in client output"
