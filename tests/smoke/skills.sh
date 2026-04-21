#!/bin/sh
# tests/smoke/skills.sh — skill materialization + resources + prompts subset.
set -eu
SUITE_TESTS="
  test_ac1_empty_cwd_tools_list
  test_ac3_verse_project_expanded_set
  test_ac4_non_verse_silent
  test_skills_materialized
  test_skills_no_touch_invariant
  test_skills_no_cascade_delete
  test_ac7_resources
  test_ac8_prompts
"
export SUITE_TESTS
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_runner.sh"
