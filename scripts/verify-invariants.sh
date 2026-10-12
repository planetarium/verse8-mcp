#!/usr/bin/env bash
# verify-invariants.sh
#
# The invariants live in docs/security.md › Invariants (a `| INV-n | … |`
# table); the code and tests that enforce one carry an `INV-n: <title>` /
# `MCP-UP-n: <title>` tag comment. This gate keeps the two in step:
#
#   - every ID in the table is tagged at least once outside docs/
#   - every tag outside docs/ names an ID that is in the table
#
# Exits 0 when both hold, 1 with the offending IDs otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TABLE="docs/security.md"
ID_RE='(INV|MCP-UP)-[0-9]+'

if [ ! -f "$TABLE" ]; then
  echo "verify-invariants: $TABLE not found" >&2
  exit 1
fi

defined="$(grep -oE "^\| ${ID_RE} \|" "$TABLE" | grep -oE "$ID_RE" | LC_ALL=C sort -u)"
if [ -z "$defined" ]; then
  echo "verify-invariants: no invariant rows found in $TABLE" >&2
  exit 1
fi

# Tags in tracked files, docs excluded (docs describe the tags, they do not
# enforce anything).
tagged="$(git grep -ohE "${ID_RE}:" -- . ':!docs' ':!CHANGELOG.md' | tr -d ':' | LC_ALL=C sort -u || true)"

untagged="$(LC_ALL=C comm -23 <(echo "$defined") <(echo "$tagged"))"
unknown="$(LC_ALL=C comm -13 <(echo "$defined") <(echo "$tagged"))"

status=0
if [ -n "$untagged" ]; then
  echo "verify-invariants: no code or test carries a tag for:" >&2
  echo "$untagged" | sed 's/^/  /' >&2
  status=1
fi
if [ -n "$unknown" ]; then
  echo "verify-invariants: tags name IDs missing from $TABLE:" >&2
  for id in $unknown; do
    git grep -nE "${id}:" -- . ':!docs' ':!CHANGELOG.md' | sed 's/^/  /' >&2
  done
  status=1
fi
if [ "$status" -eq 0 ]; then
  echo "verify-invariants: OK — $(echo "$defined" | wc -l | tr -d ' ') invariants, each tagged"
fi
exit "$status"
