#!/usr/bin/env bash
# verify-invariants.sh
#
# Parse .omc/INVARIANTS.md and confirm every referenced test case / source
# pattern actually exists in the codebase. Exits 0 when every reference
# resolves; exits 1 with the missing list when any is absent.
#
# Reference shapes recognized:
#   - unit:   `tests/unit/<file>.test.mjs` :: `<case-name>`
#   - smoke:  `tests/smoke.sh` :: `<test-fn-name>`
#   - source: `src/<path>.ts` :: `<grep-pattern>`
#
# Usage: bash scripts/verify-invariants.sh
# CI: exits 1 with a diff-friendly missing-references list on failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INVARIANTS_FILE="$REPO_ROOT/.omc/INVARIANTS.md"

if [ ! -f "$INVARIANTS_FILE" ]; then
  echo "ERROR: $INVARIANTS_FILE not found" >&2
  exit 1
fi

missing=0
total=0

# Each reference line in INVARIANTS.md looks like:
#   - unit: `tests/unit/foo.test.mjs` :: `case name`
#   - smoke: `tests/smoke.sh` :: `test_name`
#   - source: `src/foo.ts` :: `regex pattern`
#
# Pull every ref line and dispatch on the kind.
while IFS= read -r line; do
  total=$((total + 1))
  kind="$(printf '%s' "$line" | sed -E 's/^- ([a-z]+): .*/\1/')"
  file="$(printf '%s' "$line" | sed -E 's/^- [a-z]+: `([^`]+)`.*/\1/')"
  ref="$(printf '%s' "$line" | sed -E 's/^- [a-z]+: `[^`]+` :: `(.+)`$/\1/')"

  full_path="$REPO_ROOT/$file"
  if [ ! -f "$full_path" ]; then
    printf 'MISSING file: %s\n' "$file" >&2
    missing=$((missing + 1))
    continue
  fi

  case "$kind" in
    unit)
      # node:test cases register via test("name", ...) — escape regex specials
      # in `ref` so colons and dashes don't blow up the grep. Match either
      # double or single quotes around the case name.
      pattern="$(printf '%s' "$ref" | sed -E 's/[][\\\.*+?(){}|^$/]/\\&/g')"
      if ! grep -E "test\([\"']${pattern}[\"']" "$full_path" >/dev/null 2>&1; then
        printf 'MISSING unit case: %s :: %s\n' "$file" "$ref" >&2
        missing=$((missing + 1))
      fi
      ;;
    smoke)
      # smoke harness uses bash function names; just grep the literal name.
      if ! grep -F "$ref" "$full_path" >/dev/null 2>&1; then
        printf 'MISSING smoke ref: %s :: %s\n' "$file" "$ref" >&2
        missing=$((missing + 1))
      fi
      ;;
    source)
      # ref is a regex pattern; test it via grep -E.
      if ! grep -E "$ref" "$full_path" >/dev/null 2>&1; then
        printf 'MISSING source pattern: %s :: %s\n' "$file" "$ref" >&2
        missing=$((missing + 1))
      fi
      ;;
    *)
      printf 'WARNING unknown reference kind "%s" in line: %s\n' "$kind" "$line" >&2
      ;;
  esac
done < <(grep -E '^- (unit|smoke|source): `' "$INVARIANTS_FILE")

if [ "$missing" -gt 0 ]; then
  printf '\nverify-invariants: %d / %d references missing\n' "$missing" "$total" >&2
  exit 1
fi
printf 'verify-invariants: OK — all %d references resolved\n' "$total"
exit 0
