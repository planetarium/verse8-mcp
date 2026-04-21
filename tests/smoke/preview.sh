#!/bin/sh
# tests/smoke/preview.sh — image-proxy / preview bearer / session subset.
set -eu
SUITE_TESTS="
  test_ac3_image_tools_with_mock
  test_ac5_image_proxy_bearer
  test_ac5b_image_error_passthrough
  test_session_expire_retry
"
export SUITE_TESTS
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_runner.sh"
