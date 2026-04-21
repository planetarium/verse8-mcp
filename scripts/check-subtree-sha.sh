#!/usr/bin/env bash
# check-subtree-sha.sh
#
# Verify that `skills-vendor/` matches the SHA pinned in
# `package.json :: verse8.skillsVendor.sha`. Exits 0 on match; exits 1 with
# diff guidance on mismatch — the build / npm publish should then fail.
#
# (US-M2-3.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$REPO_ROOT/package.json"
COMPUTE="$REPO_ROOT/scripts/compute-subtree-sha.sh"

if [ ! -f "$PKG" ]; then
  echo "ERROR: $PKG not found" >&2
  exit 1
fi
if [ ! -x "$COMPUTE" ]; then
  echo "ERROR: $COMPUTE not found or not executable" >&2
  exit 1
fi

actual="$(bash "$COMPUTE")"

# Read pinned value from package.json without depending on jq (Node + tsc are
# already required for build, so node is a safe dependency here).
pinned="$(node -e '
  const pkg = require(process.argv[1]);
  const sha = pkg && pkg.verse8 && pkg.verse8.skillsVendor && pkg.verse8.skillsVendor.sha;
  if (typeof sha !== "string" || sha.length === 0) { process.exit(2); }
  process.stdout.write(sha);
' "$PKG" 2>/dev/null || true)"

if [ -z "$pinned" ]; then
  echo "ERROR: package.json :: verse8.skillsVendor.sha is missing or empty" >&2
  echo "       Run: bash scripts/compute-subtree-sha.sh" >&2
  echo "       Then set that value as verse8.skillsVendor.sha in package.json" >&2
  exit 1
fi

if [ "$actual" = "$pinned" ]; then
  echo "check-subtree-sha: OK (sha=$actual)"
  exit 0
fi

cat >&2 <<EOF
check-subtree-sha: MISMATCH
  pinned: $pinned
  actual: $actual
The skills-vendor/ subtree has changed (legitimately, e.g. via 'git subtree pull',
or unexpectedly).
- If the change is intentional, update the pin:
    sha=\$(bash scripts/compute-subtree-sha.sh)
    # then set verse8.skillsVendor.sha = "\$sha" in package.json
- If unintentional, revert your subtree changes.
EOF
exit 1
