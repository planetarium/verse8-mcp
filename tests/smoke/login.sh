#!/bin/sh
# tests/smoke/login.sh — login / status / shim-removed subset.
# AC-OPERATIONAL-1 floor: should run in isolation in <30s against mocks.
set -eu
SUITE_TESTS="
  test_ac9_no_token_errors
  test_ac9_no_token_verse8_status
  test_new_project_tool_renamed
"
export SUITE_TESTS
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_runner.sh"
