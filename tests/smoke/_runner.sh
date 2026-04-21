#!/bin/sh
# tests/smoke/_runner.sh — shared entrypoint for split smoke suites (M4.1).
# Forwards SUITE_TESTS as VERSE8_SMOKE_ONLY to smoke.sh.
set -eu

if [ -z "${SUITE_TESTS:-}" ]; then
  echo "[smoke-runner] SUITE_TESTS not set — nothing to run" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SMOKE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSE8_SMOKE_ONLY="$SUITE_TESTS" bash "$SMOKE_ROOT/smoke.sh"
