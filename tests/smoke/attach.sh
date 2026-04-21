#!/bin/sh
# tests/smoke/attach.sh — verse8_attach / AGENTS.md / pre-commit subset.
set -eu
SUITE_TESTS="
  test_ac6_pre_commit_origin_enforcement
  test_agents_md_literals
  test_ac_hook_binary_direct
  test_ac_hook_binary_direct_github_fails
"
export SUITE_TESTS
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_runner.sh"
