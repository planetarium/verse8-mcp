#!/bin/sh
# tests/smoke/new-project.sh — verse8_new_project_start/confirm subset.
set -eu
SUITE_TESTS="
  test_new_project_start_shape
  test_new_project_not_logged_in
  test_new_project_confirm_happy_path
  test_new_project_template_mismatch
"
export SUITE_TESTS
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_runner.sh"
