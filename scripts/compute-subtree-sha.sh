#!/usr/bin/env bash
# compute-subtree-sha.sh
#
# Compute a deterministic content-hash over `skills-vendor/`. The subtree was
# git-merged (no separate .git inside), so we cannot use `git rev-parse HEAD`.
# Instead, we sha256 each file (sorted by path) and then sha256 the result.
# Same content always produces the same digest across machines.
#
# (US-M2-3.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBTREE="$REPO_ROOT/skills-vendor"

if [ ! -d "$SUBTREE" ]; then
  echo "ERROR: $SUBTREE not found" >&2
  exit 1
fi

# Pick a sha256 binary that works on macOS (shasum) AND Linux (sha256sum).
if command -v sha256sum >/dev/null 2>&1; then
  SHA_BIN="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_BIN="shasum -a 256"
else
  echo "ERROR: no sha256sum / shasum available" >&2
  exit 1
fi

cd "$REPO_ROOT"
# Sort by relative path for determinism, then sha256 each file. Final sha256
# over the per-file digest list yields the canonical subtree fingerprint.
# LC_ALL=C pins the byte-wise order: under a UTF-8 locale `sort` collates
# differently (e.g. ignores `-`), and a pin computed by hand would not match
# the one CI computes.
find skills-vendor -type f -print0 \
  | LC_ALL=C sort -z \
  | xargs -0 $SHA_BIN \
  | $SHA_BIN \
  | awk '{print $1}'
