#!/bin/sh
# tests/smoke/upload-asset.sh — verse8_upload_asset subset.
set -eu
SUITE_TESTS="
  test_upload_absent_without_token
  test_upload_present_with_token
  test_upload_happy_path
  test_upload_invalid_extension
"
export SUITE_TESTS
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_runner.sh"
