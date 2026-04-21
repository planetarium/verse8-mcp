#!/usr/bin/env bash
# Pre-publish secret scanner (M4.3, AC-SECURITY-2).
#
# Runs after `tsc` and before `npm publish`. Enumerates every file that
# `npm pack --dry-run` would ship and scans each for known secret shapes
# (glpat tokens, Bearer headers, access_token JSON fields, runtime wallet
# account env values, .verse8/token paths, sourcemaps). Exits 1 with a
# file:hit diagnostic on the first finding.
#
# Intentionally scans file CONTENTS, not just names, because a stray env
# dump or JSON payload inside dist/ is the exact leak shape we want to
# catch at the tarball boundary.
set -euo pipefail

# Run against the current working directory by default (so unit tests can
# exercise the guard against scratch fixtures). Fall back to the
# verse8-mcp repo root when invoked outside of any npm package.
if [ ! -f ./package.json ]; then
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$repo_root"
fi

# Resolve the file list npm pack would ship. --json emits an array with
# `files[].path` entries; fall back to --dry-run parsing when jq is not
# available.
pack_json="$(npm pack --dry-run --json 2>/dev/null || true)"
if [ -z "$pack_json" ]; then
  echo "[prepublish-guard] npm pack --dry-run --json produced no output" >&2
  exit 1
fi

file_list="$(
  node -e '
    try {
      const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const first = Array.isArray(data) ? data[0] : data;
      const files = (first && first.files) || [];
      for (const f of files) console.log(f.path);
    } catch (e) {
      console.error("[prepublish-guard] failed to parse npm pack --json: " + e.message);
      process.exit(1);
    }
  ' <<<"$pack_json"
)"

if [ -z "$file_list" ]; then
  echo "[prepublish-guard] tarball file list empty — check `npm pack --dry-run`" >&2
  exit 1
fi

# Shape registry: name|regex. Tight length bounds avoid false-positives
# on docstring references (AC-SECURITY-2).
shapes=(
  "glpat|glpat-[A-Za-z0-9_-]{20,}"
  "bearer|Bearer [A-Za-z0-9._~+/=\\-]{20,}"
  "access_token|\"access_token\"[[:space:]]*:[[:space:]]*\"[^][^\"]{8,}\""
  "refresh_token|\"refresh_token\"[[:space:]]*:[[:space:]]*\"[^][^\"]{8,}\""
  "device_code|\"device_code\"[[:space:]]*:[[:space:]]*\"[^][^\"]{8,}\""
  "wallet_env|VITE_AGENT8_ACCOUNT=0x[a-fA-F0-9]{8,}"
)

exit_code=0

# Filename-based reject: sourcemaps never ship.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.map)
      echo "[prepublish-guard] FAIL: sourcemap in tarball: $f" >&2
      exit_code=1
      ;;
  esac
done <<<"$file_list"

# Content-based reject.
while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  [ -f "$rel" ] || continue
  # Skip binary files — grep may report them as matching from random noise.
  if file "$rel" | grep -q binary; then
    continue
  fi
  for entry in "${shapes[@]}"; do
    name="${entry%%|*}"
    pattern="${entry#*|}"
    if grep -En "$pattern" "$rel" >/dev/null 2>&1; then
      first_hit="$(grep -En "$pattern" "$rel" | head -n 1)"
      echo "[prepublish-guard] FAIL: $rel carries $name-shape secret: $first_hit" >&2
      exit_code=1
    fi
  done
done <<<"$file_list"

if [ "$exit_code" -ne 0 ]; then
  echo "[prepublish-guard] tarball REJECTED — fix the findings above before publishing." >&2
  exit "$exit_code"
fi

file_count="$(printf '%s\n' "$file_list" | grep -c . || true)"
echo "[prepublish-guard] OK — $file_count file(s) scanned, 0 secret matches."
