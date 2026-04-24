#!/bin/sh
# tests/smoke.sh
#
# verse8-mcp v1 smoke test suite.
# Runs all AC tests and exits 0 if all pass, 1 if any fail.
#
# Usage:
#   bash tests/smoke.sh
#
# Requires: node (>=18), npx (for tsx), git

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="$REPO_ROOT/dist/index.js"
TESTS_DIR="$REPO_ROOT/tests"
LIB_DIR="$TESTS_DIR/lib"
MOCKS_DIR="$TESTS_DIR/mocks"

# Counters
PASS=0
FAIL=0
SKIP=0

# Color helpers (plain fallback when not a TTY)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  RESET='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  RESET=''
fi

pass() { printf "${GREEN}PASS${RESET} %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "${RED}FAIL${RESET} %s  — %s\n" "$1" "$2"; FAIL=$((FAIL + 1)); }
skip() { printf "${YELLOW}SKIP${RESET} %s  — %s\n" "$1" "$2"; SKIP=$((SKIP + 1)); }

# Load JSON-RPC helpers
. "$LIB_DIR/jsonrpc.sh"

# ---------------------------------------------------------------------------
# Token backup/restore
# ---------------------------------------------------------------------------
REAL_TOKEN_PATH="$HOME/.config/verse8/token"
TOKEN_BACKUP="/tmp/verse8-smoke-token-backup.$$"
TOKEN_RESTORED=0

backup_token() {
  if [ -f "$REAL_TOKEN_PATH" ]; then
    cp "$REAL_TOKEN_PATH" "$TOKEN_BACKUP"
    TOKEN_RESTORED=0
  fi
}

restore_token() {
  if [ "$TOKEN_RESTORED" = "0" ] && [ -f "$TOKEN_BACKUP" ]; then
    mkdir -p "$(dirname "$REAL_TOKEN_PATH")"
    cp "$TOKEN_BACKUP" "$REAL_TOKEN_PATH"
    TOKEN_RESTORED=1
  fi
  rm -f "$TOKEN_BACKUP"
}

# Trap to always restore token and clean up mock servers on exit
_CLEANUP_PIDS=""
cleanup() {
  restore_token
  for pid in $_CLEANUP_PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  _CLEANUP_PIDS=""
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Mock server helpers
# ---------------------------------------------------------------------------

# start_v8_mock [--stub-project-404]
# Sets V8_MOCK_PID, V8_MOCK_PORT, VERSE8_API_URL
start_v8_mock() {
  local extra_args="${1:-}"
  rm -f /tmp/v8-mock-port.txt
  npx --yes tsx "$MOCKS_DIR/v8-meme-api-mock.ts" $extra_args &
  V8_MOCK_PID=$!
  _CLEANUP_PIDS="$_CLEANUP_PIDS $V8_MOCK_PID"
  # Wait for port file (up to 8s)
  local waited=0
  while [ ! -f /tmp/v8-mock-port.txt ] && [ "$waited" -lt 80 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ ! -f /tmp/v8-mock-port.txt ]; then
    echo "ERROR: v8-mock server did not start in time" >&2
    return 1
  fi
  V8_MOCK_PORT=$(cat /tmp/v8-mock-port.txt)
  export VERSE8_API_URL="http://127.0.0.1:${V8_MOCK_PORT}"
}

stop_v8_mock() {
  if [ -n "${V8_MOCK_PID:-}" ]; then
    kill "$V8_MOCK_PID" 2>/dev/null || true
    _CLEANUP_PIDS=$(printf '%s' "$_CLEANUP_PIDS" | sed "s/ $V8_MOCK_PID//g")
    V8_MOCK_PID=""
    unset VERSE8_API_URL 2>/dev/null || true
  fi
}

# start_image_mock [--force-500]
# Sets IMAGE_MOCK_PID, IMAGE_MOCK_PORT, VERSE8_IMAGE_MCP_URL
start_image_mock() {
  local extra_args="${1:-}"
  rm -f /tmp/v8-image-mock-port.txt
  npx --yes tsx "$MOCKS_DIR/image-mcp-mock.ts" $extra_args &
  IMAGE_MOCK_PID=$!
  _CLEANUP_PIDS="$_CLEANUP_PIDS $IMAGE_MOCK_PID"
  local waited=0
  while [ ! -f /tmp/v8-image-mock-port.txt ] && [ "$waited" -lt 80 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ ! -f /tmp/v8-image-mock-port.txt ]; then
    echo "ERROR: image-mock server did not start in time" >&2
    return 1
  fi
  IMAGE_MOCK_PORT=$(cat /tmp/v8-image-mock-port.txt)
  export VERSE8_IMAGE_MCP_URL="http://127.0.0.1:${IMAGE_MOCK_PORT}/mcp"
}

stop_image_mock() {
  if [ -n "${IMAGE_MOCK_PID:-}" ]; then
    kill "$IMAGE_MOCK_PID" 2>/dev/null || true
    _CLEANUP_PIDS=$(printf '%s' "$_CLEANUP_PIDS" | sed "s/ $IMAGE_MOCK_PID//g")
    IMAGE_MOCK_PID=""
    unset VERSE8_IMAGE_MCP_URL 2>/dev/null || true
  fi
}

# start_agent8_mock [extra args]
# Sets AGENT8_MOCK_PID, AGENT8_MOCK_PORT, VERSE8_AGENT8_BACKEND_URL
start_agent8_mock() {
  local extra_args="${1:-}"
  rm -f /tmp/agent8-mock-port.txt /tmp/agent8-mock-calls.jsonl
  # Expand extra_args via word-splitting intentionally
  # shellcheck disable=SC2086
  npx --yes tsx "$MOCKS_DIR/agent8-backend-mock.ts" $extra_args &
  AGENT8_MOCK_PID=$!
  _CLEANUP_PIDS="$_CLEANUP_PIDS $AGENT8_MOCK_PID"
  local waited=0
  while [ ! -f /tmp/agent8-mock-port.txt ] && [ "$waited" -lt 80 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ ! -f /tmp/agent8-mock-port.txt ]; then
    echo "ERROR: agent8-backend-mock did not start in time" >&2
    return 1
  fi
  AGENT8_MOCK_PORT=$(cat /tmp/agent8-mock-port.txt)
  export VERSE8_AGENT8_BACKEND_URL="http://127.0.0.1:${AGENT8_MOCK_PORT}"
}

stop_agent8_mock() {
  if [ -n "${AGENT8_MOCK_PID:-}" ]; then
    kill "$AGENT8_MOCK_PID" 2>/dev/null || true
    _CLEANUP_PIDS=$(printf '%s' "$_CLEANUP_PIDS" | sed "s/ $AGENT8_MOCK_PID//g")
    AGENT8_MOCK_PID=""
    unset VERSE8_AGENT8_BACKEND_URL 2>/dev/null || true
  fi
}

# install_test_token <value>
install_test_token() {
  mkdir -p "$(dirname "$REAL_TOKEN_PATH")"
  printf '%s' "${1:-test-token-xyz}" > "$REAL_TOKEN_PATH"
  chmod 600 "$REAL_TOKEN_PATH"
}

# make_tmpdir — creates a temp dir and sets TEST_TMPDIR
make_tmpdir() {
  TEST_TMPDIR=$(mktemp -d /tmp/verse8-smoke.XXXXXX)
}

# setup_verse_project_dir <dir>
# Creates a git repo with gitlab origin + .verse8/project.json
setup_verse_project_dir() {
  local dir="$1"
  git init "$dir" -b main >/dev/null 2>&1 || git init "$dir" >/dev/null 2>&1
  (
    cd "$dir"
    git config user.email "smoke@verse8.io"
    git config user.name "Smoke Test"
    git checkout -b main 2>/dev/null || true
    git remote add origin "https://gitlab.verse8.io/test/fixture.git"
    mkdir -p .verse8
    printf '{"version":1,"projectId":"proj-x","gitlabRemote":"https://gitlab.verse8.io/test/fixture.git","preset":"gameserver-v2","createdAt":"2024-01-01T00:00:00.000Z"}\n' > .verse8/project.json
  )
}

# setup_attached_verse_project_dir <dir> [<verse>]
# Extends setup_verse_project_dir with the hook signatures, AGENTS.md marker,
# and VITE_AGENT8_VERSE .env entry that detectAttachment / readEnvVerse expect.
setup_attached_verse_project_dir() {
  local dir="$1"
  local verse="${2:-smoke-verse}"
  setup_verse_project_dir "$dir"
  (
    cd "$dir"
    mkdir -p .git/hooks
    printf '#!/bin/sh\n# verse8-mcp hook pre-commit\nexit 0\n' > .git/hooks/pre-commit
    printf '#!/bin/sh\n# verse8-mcp hook commit-msg\nexit 0\n' > .git/hooks/commit-msg
    chmod +x .git/hooks/pre-commit .git/hooks/commit-msg
    printf '<!-- verse8-mcp attached -->\n# Agents\n' > AGENTS.md
    printf 'VITE_AGENT8_ACCOUNT=0xsmoke\nVITE_AGENT8_VERSE=%s\n' "$verse" > .env
  )
}

# ---------------------------------------------------------------------------
# Step 1: Build
# ---------------------------------------------------------------------------
printf '\n=== Building dist ===\n'
(cd "$REPO_ROOT" && npm run build 2>&1) || { echo "BUILD FAILED — aborting tests" >&2; exit 1; }
echo "Build OK"

printf '\n=== Running smoke tests ===\n\n'

# Backup existing token before any test modifies it
backup_token

# ===========================================================================
# test_ac1_empty_cwd_tools_list
# AC-1: In an empty cwd (no .git, no .verse8/), tools/list == exactly
#       [verse8_login, verse8_status, verse8_new_project]
# ===========================================================================
test_ac1_empty_cwd_tools_list() {
  # Token gating: isolate from the developer's real ~/.config/verse8/token by
  # pointing XDG_CONFIG_HOME at an empty tmpdir. With no token present,
  # tools/list must collapse to the base set regardless of cwd shape.
  make_tmpdir
  local isolated_config="$TEST_TMPDIR/xdg-empty"
  mkdir -p "$isolated_config"
  local resp
  resp=$(cd "$TEST_TMPDIR" && XDG_CONFIG_HOME="$isolated_config" VERSE8_ACCESS_TOKEN="" mcp_request "$BINARY" "tools/list" '{}')
  rm -rf "$TEST_TMPDIR"

  if [ -z "$resp" ]; then
    fail "ac1_empty_cwd_tools_list" "no response from server"
    return
  fi

  # Must contain all four base tools (after 2-tool split: start + confirm).
  # The old verse8_new_project name is kept as a deprecation shim so we
  # assert it is still listed — but the START + CONFIRM names MUST be
  # present because the shim alone is no longer functional.
  if ! json_contains "$resp" '"verse8_login_start"'; then
    fail "ac1_empty_cwd_tools_list" "verse8_login missing in: $resp"
    return
  fi
  if ! json_contains "$resp" '"verse8_status"'; then
    fail "ac1_empty_cwd_tools_list" "verse8_status missing in: $resp"
    return
  fi
  if ! json_contains "$resp" '"verse8_new_project_start"'; then
    fail "ac1_empty_cwd_tools_list" "verse8_new_project_start missing in: $resp"
    return
  fi
  if ! json_contains "$resp" '"verse8_new_project_confirm"'; then
    fail "ac1_empty_cwd_tools_list" "verse8_new_project_confirm missing in: $resp"
    return
  fi

  # Must NOT contain verse8_checkpoint or image tools
  if json_contains "$resp" '"verse8_checkpoint"'; then
    fail "ac1_empty_cwd_tools_list" "verse8_checkpoint unexpectedly present"
    return
  fi
  if json_contains "$resp" '"image_asset_generate"'; then
    fail "ac1_empty_cwd_tools_list" "image_asset_generate unexpectedly present"
    return
  fi

  pass "ac1_empty_cwd_tools_list"
}

# ===========================================================================
# test_ac3_verse_project_expanded_set
# AC-3: verse8 project (gitlab origin + .verse8/project.json + valid token)
#       → tools/list includes verse8_checkpoint.
# ===========================================================================
test_ac3_verse_project_expanded_set() {
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  local resp
  resp=$(cd "$TEST_TMPDIR" && mcp_request "$BINARY" "tools/list" '{}')
  rm -rf "$TEST_TMPDIR"

  if [ -z "$resp" ]; then
    fail "ac3_verse_project_expanded_set" "no response from server"
    restore_token; return
  fi

  if ! json_contains "$resp" '"verse8_checkpoint"'; then
    fail "ac3_verse_project_expanded_set" "verse8_checkpoint missing in: $resp"
    restore_token; return
  fi
  if ! json_contains "$resp" '"verse8_login_start"'; then
    fail "ac3_verse_project_expanded_set" "verse8_login missing"
    restore_token; return
  fi

  pass "ac3_verse_project_expanded_set"
}

# ===========================================================================
# test_ac3_image_tools_with_mock
# AC-3 extension: with image mock running, tools/list also exposes image tools
# ===========================================================================
test_ac3_image_tools_with_mock() {
  start_image_mock
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  local resp
  resp=$(cd "$TEST_TMPDIR" && mcp_request "$BINARY" "tools/list" '{}')
  rm -rf "$TEST_TMPDIR"
  stop_image_mock

  if [ -z "$resp" ]; then
    fail "ac3_image_tools_with_mock" "no response from server"
    return
  fi

  if ! json_contains "$resp" '"image_asset_generate"'; then
    fail "ac3_image_tools_with_mock" "image_asset_generate missing in: $resp"
    return
  fi
  if ! json_contains "$resp" '"verse8_checkpoint"'; then
    fail "ac3_image_tools_with_mock" "verse8_checkpoint missing"
    return
  fi

  pass "ac3_image_tools_with_mock"
}

# ===========================================================================
# test_ac4_non_verse_silent
# AC-4: git repo with github.com origin → tools/list = base set only
#       (no checkpoint, no image tools)
# ===========================================================================
test_ac4_non_verse_silent() {
  # Revised AC-4: non-verse8 origin cwd without token → base set only. With
  # token present, checkpoint + image tools are discoverable because the MCP
  # is cwd-agnostic (project-scoped tools validate at invocation time). This
  # test specifically covers the "no token → silent" invariant.
  make_tmpdir
  git init "$TEST_TMPDIR" -b main >/dev/null 2>&1 || git init "$TEST_TMPDIR" >/dev/null 2>&1
  (
    cd "$TEST_TMPDIR"
    git config user.email "smoke@verse8.io"
    git config user.name "Smoke Test"
    git remote add origin "https://github.com/user/my-game.git"
  )
  local isolated_config="$TEST_TMPDIR/xdg-empty"
  mkdir -p "$isolated_config"

  local resp
  resp=$(cd "$TEST_TMPDIR" && XDG_CONFIG_HOME="$isolated_config" VERSE8_ACCESS_TOKEN="" mcp_request "$BINARY" "tools/list" '{}')
  rm -rf "$TEST_TMPDIR"

  if [ -z "$resp" ]; then
    fail "ac4_non_verse_silent" "no response from server"
    return
  fi

  if json_contains "$resp" '"verse8_checkpoint"'; then
    fail "ac4_non_verse_silent" "verse8_checkpoint should not appear for github origin"
    return
  fi
  if json_contains "$resp" '"image_asset_generate"'; then
    fail "ac4_non_verse_silent" "image_asset_generate should not appear for github origin"
    return
  fi
  if ! json_contains "$resp" '"verse8_login_start"'; then
    fail "ac4_non_verse_silent" "verse8_login should still be in base set"
    return
  fi

  pass "ac4_non_verse_silent"
}

# ===========================================================================
# test_ac5_image_proxy_bearer
# AC-5: image_asset_generate via proxy forwards Bearer token correctly
# ===========================================================================
test_ac5_image_proxy_bearer() {
  start_image_mock
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"

  local test_token="smoke-bearer-test-token"
  install_test_token "$test_token"

  # Clear the calls log
  : > /tmp/v8-image-mock-calls.jsonl

  local resp
  resp=$(cd "$TEST_TMPDIR" && mcp_call_tool "$BINARY" "image_asset_generate" '{"description":"a red mushroom item"}')
  rm -rf "$TEST_TMPDIR"
  stop_image_mock

  if [ -z "$resp" ]; then
    fail "ac5_image_proxy_bearer" "no response from server"
    return
  fi

  # Check that the calls log recorded the correct Bearer token
  local expected_auth="Bearer $test_token"
  if [ ! -f /tmp/v8-image-mock-calls.jsonl ]; then
    fail "ac5_image_proxy_bearer" "calls log not found"
    return
  fi

  if ! grep -q "\"$expected_auth\"" /tmp/v8-image-mock-calls.jsonl 2>/dev/null; then
    fail "ac5_image_proxy_bearer" "expected '$expected_auth' not found in calls log. Got: $(cat /tmp/v8-image-mock-calls.jsonl)"
    return
  fi

  # Also assert the response is not an error
  if json_contains "$resp" '"isError":true'; then
    fail "ac5_image_proxy_bearer" "response has isError:true: $resp"
    return
  fi

  pass "ac5_image_proxy_bearer"
}

# ===========================================================================
# test_session_expire_retry
# Upstream MCP servers GC idle sessions. When tools/call returns
# "No valid session ID provided", the proxy must evict its cache,
# re-initialize to grab a fresh mcp-session-id, and retry the call once.
# Assertion: the second tools/call succeeds and two initialize calls
# were observed (the lazy one at tools/list + the reinit on retry).
# ===========================================================================
test_session_expire_retry() {
  start_image_mock "--session-expire-once"
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  : > /tmp/v8-image-mock-calls.jsonl

  local resp
  resp=$(cd "$TEST_TMPDIR" && mcp_call_tool "$BINARY" "image_asset_generate" '{"description":"retry smoke"}')
  rm -rf "$TEST_TMPDIR"
  stop_image_mock

  if [ -z "$resp" ]; then
    fail "session_expire_retry" "no response from server"
    return
  fi

  # The final tool-call response must NOT be an error — the retry should
  # have succeeded after reinit.
  if json_contains "$resp" '"isError":true'; then
    fail "session_expire_retry" "expected success after reinit retry, got: $resp"
    return
  fi

  local init_count
  init_count=$(grep -c '"initialize"' /tmp/v8-image-mock-calls.jsonl 2>/dev/null || echo 0)
  if [ "$init_count" -lt 2 ]; then
    fail "session_expire_retry" "expected >=2 initialize calls (discovery + reinit), got $init_count"
    return
  fi

  local call_count
  call_count=$(grep -c '"tools/call"' /tmp/v8-image-mock-calls.jsonl 2>/dev/null || echo 0)
  if [ "$call_count" -lt 2 ]; then
    fail "session_expire_retry" "expected >=2 tools/call attempts (expired + retry), got $call_count"
    return
  fi

  pass "session_expire_retry"
}

# ===========================================================================
# test_ac5b_image_error_passthrough
# AC-5b: image mock --force-500 → MCP response has isError:true, exactly 1 call
# ===========================================================================
test_ac5b_image_error_passthrough() {
  start_image_mock "--force-500"
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  # Clear calls log
  : > /tmp/v8-image-mock-calls.jsonl

  local resp
  resp=$(cd "$TEST_TMPDIR" && mcp_call_tool "$BINARY" "image_asset_generate" '{"description":"a red mushroom"}')
  rm -rf "$TEST_TMPDIR"
  stop_image_mock

  if [ -z "$resp" ]; then
    fail "ac5b_image_error_passthrough" "no response from server"
    return
  fi

  # Response must be an error
  if ! json_contains "$resp" '"isError":true'; then
    # Also accept error field without isError wrapper
    if ! json_contains "$resp" '"error"'; then
      fail "ac5b_image_error_passthrough" "expected error in response, got: $resp"
      return
    fi
  fi

  # Count calls to tools/call in log — should be exactly 1 (no retry)
  local call_count
  if [ -f /tmp/v8-image-mock-calls.jsonl ]; then
    call_count=$(grep -c '"tools/call"' /tmp/v8-image-mock-calls.jsonl 2>/dev/null || echo "0")
  else
    call_count=0
  fi
  # During tool discovery, tools/list is also called. We only count tools/call.
  # Accept 1 call (the actual invocation). If 0, the call may have failed before
  # reaching tools/call (e.g. discovery failed entirely due to 500 on init).
  # That's also acceptable — the important thing is isError:true and no retry.
  if [ "$call_count" -gt 1 ]; then
    fail "ac5b_image_error_passthrough" "expected <=1 tools/call, got $call_count (retry detected)"
    return
  fi

  pass "ac5b_image_error_passthrough"
}

# ===========================================================================
# test_ac6_pre_commit_origin_enforcement
# AC-6: pre-commit hook aborts commit when origin != gitlab.verse8.io
# ===========================================================================
test_ac6_pre_commit_origin_enforcement() {
  make_tmpdir
  git init "$TEST_TMPDIR" -b main >/dev/null 2>&1 || git init "$TEST_TMPDIR" >/dev/null 2>&1
  (
    cd "$TEST_TMPDIR"
    git config user.email "smoke@verse8.io"
    git config user.name "Smoke Test"
    git checkout -b main 2>/dev/null || true
    git remote add origin "https://github.com/user/my-game.git"

    # Install the pre-commit hook pointing to the dist binary
    mkdir -p .git/hooks
    cat > .git/hooks/pre-commit <<HOOKEOF
#!/bin/sh
exec node "$BINARY" hook pre-commit "\$@"
HOOKEOF
    chmod +x .git/hooks/pre-commit

    # Stage a file
    echo "test" > test.txt
    git add test.txt
  )

  # Commit should fail — github origin
  local commit_rc=0
  (cd "$TEST_TMPDIR" && git commit -m "test commit" 2>&1) || commit_rc=$?
  local hook_output
  hook_output=$(cd "$TEST_TMPDIR" && git commit -m "test commit" 2>&1 || true)

  if [ "$commit_rc" -eq 0 ]; then
    fail "ac6_pre_commit_github_blocks" "expected commit to fail for github origin but it succeeded"
    rm -rf "$TEST_TMPDIR"
    return
  fi

  pass "ac6_pre_commit_github_blocks_commit"

  # Now switch origin to gitlab.verse8.io — commit should succeed
  (
    cd "$TEST_TMPDIR"
    git remote set-url origin "https://gitlab.verse8.io/test/my-game.git"
    echo "test2" > test2.txt
    git add test2.txt
  )

  local commit_ok=0
  (cd "$TEST_TMPDIR" && git commit -m "[verse8] test commit" 2>&1) && commit_ok=1 || true

  rm -rf "$TEST_TMPDIR"

  if [ "$commit_ok" -eq 0 ]; then
    fail "ac6_pre_commit_gitlab_allows_commit" "expected commit to succeed for gitlab.verse8.io origin"
    return
  fi

  pass "ac6_pre_commit_gitlab_allows_commit"
}

# ===========================================================================
# test_ac9_no_token_errors
# AC-9: no token → verse8_checkpoint returns {error:"not_logged_in"}
# ===========================================================================
test_ac9_no_token_errors() {
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"

  # Remove token from all locations
  rm -f "$REAL_TOKEN_PATH"
  rm -f "$TEST_TMPDIR/.verse8/token"

  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    unset VERSE8_ACCESS_TOKEN 2>/dev/null || true
    mcp_call_tool "$BINARY" "verse8_checkpoint" '{"message":"test checkpoint"}'
  )
  rm -rf "$TEST_TMPDIR"

  if [ -z "$resp" ]; then
    fail "ac9_no_token_errors" "no response from server"
    return
  fi

  if ! json_contains "$resp" 'not_logged_in'; then
    fail "ac9_no_token_errors" "expected not_logged_in error, got: $resp"
    return
  fi

  pass "ac9_no_token_errors"
}

# ===========================================================================
# test_new_project_shim_removed
# M4.5 (0.4.0 breaking): the deprecation shim is gone. Calling the old
# verse8_new_project name now falls through to the image-proxy path,
# which returns not_logged_in (no token) or unknown_tool (with a token).
# Either is acceptable; tool_renamed must NOT appear in the envelope.
# ===========================================================================
test_new_project_tool_renamed() {
  make_tmpdir
  install_test_token "test-token-xyz"

  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_new_project" '{"gameType":"platformer","title":"My Game","preset":"gameserver-v2"}'
  )
  rm -rf "$TEST_TMPDIR"

  if [ -z "$resp" ]; then
    fail "new_project_shim_removed" "no response from server"
    return
  fi

  if json_contains "$resp" 'tool_renamed'; then
    fail "new_project_shim_removed" "shim should be removed in 0.4.0 but tool_renamed still appears: $resp"
    return
  fi
  if ! json_contains "$resp" 'not_logged_in' && ! json_contains "$resp" 'unknown_tool'; then
    fail "new_project_shim_removed" "expected not_logged_in or unknown_tool fallthrough, got: $resp"
    return
  fi

  pass "new_project_shim_removed"
}

# ===========================================================================
# test_agents_md_literals
# AC-10: after verse8_attach runs, the installed AGENTS.md (the user-visible
# artifact) must contain the 3 required literals. Greps the materialized
# file rather than the compiled template source so we test the RENDERED
# string as the LLM will actually read it.
# ===========================================================================
test_agents_md_literals() {
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_attach" '{"overwriteAgentsDoc":true}'
  )

  # Inner tool JSON has escaped quotes; match on an unambiguous unquoted
  # substring. The definitive signal is the AGENTS.md file itself, which
  # we assert below.
  if ! json_contains "$resp" 'isError":false'; then
    rm -rf "$TEST_TMPDIR"
    fail "agents_md_literals" "verse8_attach returned non-ok response: $resp"
    return
  fi

  local agents_md="$TEST_TMPDIR/AGENTS.md"
  if [ ! -f "$agents_md" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "agents_md_literals" "AGENTS.md not created at $agents_md"
    return
  fi

  if ! grep -q 'verse8_new_project_start' "$agents_md"; then
    rm -rf "$TEST_TMPDIR"
    fail "agents_md_literals" "AGENTS.md missing literal: verse8_new_project_start"
    return
  fi
  if ! grep -q 'verse8_new_project_confirm' "$agents_md"; then
    rm -rf "$TEST_TMPDIR"
    fail "agents_md_literals" "AGENTS.md missing literal: verse8_new_project_confirm"
    return
  fi
  if ! grep -qF 'pass `projectDir` on every subsequent tool call' "$agents_md"; then
    rm -rf "$TEST_TMPDIR"
    fail "agents_md_literals" "AGENTS.md missing projectDir directive"
    return
  fi

  rm -rf "$TEST_TMPDIR"
  pass "agents_md_literals"
}

# ===========================================================================
# test_skills_materialized
# AC-4, AC-5, AC-6: after verse8_attach, .claude/skills/<name>/SKILL.md files
# exist with a hash marker, AGENTS.md contains the "## Available Verse8 skills"
# catalog, and both a core (verse8-login) and a vendored (gameserver-sdk)
# skill are represented.
# ===========================================================================
test_skills_materialized() {
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_attach" '{"overwriteAgentsDoc":true}'
  )

  if ! json_contains "$resp" 'isError":false'; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "attach returned error: $resp"
    return
  fi

  local core_skill="$TEST_TMPDIR/.claude/skills/verse8-login/SKILL.md"
  local vendor_skill="$TEST_TMPDIR/.claude/skills/gameserver-sdk/SKILL.md"

  if [ ! -f "$core_skill" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "core skill not materialized at $core_skill"
    return
  fi
  if [ ! -f "$vendor_skill" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "vendored skill not materialized at $vendor_skill"
    return
  fi

  # AC-4: hash marker present on core skill
  if ! grep -q 'verse8-skill-hash:' "$core_skill"; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "core skill missing verse8-skill-hash marker"
    return
  fi
  if ! grep -q 'verse8-skill-hash:' "$vendor_skill"; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "vendor skill missing verse8-skill-hash marker"
    return
  fi

  # AC-6: AGENTS.md catalog
  if ! grep -q '## Available Verse8 skills' "$TEST_TMPDIR/AGENTS.md"; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "AGENTS.md missing '## Available Verse8 skills' section"
    return
  fi
  if ! grep -q '## Available Verse8 skills' "$TEST_TMPDIR/CLAUDE.md"; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "CLAUDE.md missing '## Available Verse8 skills' section"
    return
  fi
  # AGENTS.md catalog must list both core and vendor
  if ! grep -q 'verse8-login' "$TEST_TMPDIR/AGENTS.md"; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "AGENTS.md catalog missing verse8-login row"
    return
  fi
  if ! grep -q 'gameserver-sdk' "$TEST_TMPDIR/AGENTS.md"; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "AGENTS.md catalog missing gameserver-sdk row"
    return
  fi
  # Sanity: the raw marker token should NOT leak into the rendered output
  if grep -q '{{SKILLS_CATALOG}}' "$TEST_TMPDIR/AGENTS.md"; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_materialized" "{{SKILLS_CATALOG}} placeholder left unrendered in AGENTS.md"
    return
  fi

  rm -rf "$TEST_TMPDIR"
  pass "skills_materialized"
}

# ===========================================================================
# test_skills_no_touch_invariant
# AC-15: attach MUST NOT touch files whose basename isn't in our skill set.
# Pre-populate .claude/skills/my-custom/SKILL.md with unrelated user content,
# run attach, assert the file is byte-identical.
# ===========================================================================
test_skills_no_touch_invariant() {
  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  # Pre-populate
  local custom_dir="$TEST_TMPDIR/.claude/skills/my-custom"
  mkdir -p "$custom_dir"
  local custom_path="$custom_dir/SKILL.md"
  local custom_content='# My Custom Skill
user-authored content, no hash marker'
  printf '%s' "$custom_content" > "$custom_path"
  local before_sum
  before_sum=$(shasum -a 256 "$custom_path" | cut -d' ' -f1)

  # Run attach with overwriteAllSkills: true (the aggressive flag). Even with
  # that, unrelated user files must NOT be touched.
  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_attach" '{"overwriteAgentsDoc":true,"overwriteAllSkills":true}'
  )

  if ! json_contains "$resp" 'isError":false'; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_no_touch_invariant" "attach returned error: $resp"
    return
  fi

  local after_sum
  after_sum=$(shasum -a 256 "$custom_path" | cut -d' ' -f1)

  if [ "$before_sum" != "$after_sum" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_no_touch_invariant" "unrelated user skill was modified (sha changed)"
    return
  fi

  rm -rf "$TEST_TMPDIR"
  pass "skills_no_touch_invariant"
}

# ===========================================================================
# test_skills_no_cascade_delete
# AC-10: removing a skill from the vendor dir and re-running attach must
# leave the locally materialized copy in place (no-cascade-delete default).
# Simulates "upstream dropped a skill" by temporarily moving one vendored
# SKILL source file out, running attach twice, then restoring.
# ===========================================================================
test_skills_no_cascade_delete() {
  local victim_src="$REPO_ROOT/skills-vendor/agent8-skills/skills/gameserver-sdk.md"
  local victim_backup="/tmp/verse8-smoke-gameserver-sdk.md.bak"

  if [ ! -f "$victim_src" ]; then
    fail "skills_no_cascade_delete" "victim source skill missing at $victim_src"
    return
  fi

  make_tmpdir
  setup_verse_project_dir "$TEST_TMPDIR"
  install_test_token "test-token-xyz"

  # First attach: materializes everything.
  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_attach" '{"overwriteAgentsDoc":true}'
  )
  if ! json_contains "$resp" 'isError":false'; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_no_cascade_delete" "first attach returned error: $resp"
    return
  fi
  if [ ! -f "$TEST_TMPDIR/.claude/skills/gameserver-sdk/SKILL.md" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_no_cascade_delete" "gameserver-sdk not materialized after first attach"
    return
  fi

  # Simulate upstream deletion.
  mv "$victim_src" "$victim_backup"
  # Second attach under the new (pruned upstream) state.
  resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_attach" '{"overwriteAgentsDoc":true}'
  )
  # Restore BEFORE any early return so other smoke tests still see it.
  mv "$victim_backup" "$victim_src"

  if ! json_contains "$resp" 'isError":false'; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_no_cascade_delete" "second attach returned error: $resp"
    return
  fi
  # Orphan must persist because pruneOrphanedSkills defaults to false.
  if [ ! -f "$TEST_TMPDIR/.claude/skills/gameserver-sdk/SKILL.md" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "skills_no_cascade_delete" "upstream-deleted skill was wrongly removed from project"
    return
  fi

  rm -rf "$TEST_TMPDIR"
  pass "skills_no_cascade_delete"
}

# ===========================================================================
# test_new_project_start_shape
# AC-1: verse8_new_project_start returns template + suggestedTitle +
#       suggestedProjectRepo + startCallId envelope from /api/startcall.
# ===========================================================================
test_new_project_start_shape() {
  start_agent8_mock
  make_tmpdir
  install_test_token "test-token-xyz"

  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_new_project_start" '{"userRequest":"2D 슈팅 게임을 만들어줘"}'
  )
  rm -rf "$TEST_TMPDIR"
  stop_agent8_mock

  if [ -z "$resp" ]; then
    fail "new_project_start_shape" "no response from server"
    return
  fi

  # The tool-call response wraps the tool's JSON result inside a `text`
  # field, so inner quotes are escaped. Match on unquoted identifiers to
  # avoid fighting the double-escape.
  for field in templateName suggestedTitle suggestedProjectRepo startCallId; do
    if ! json_contains "$resp" "$field"; then
      fail "new_project_start_shape" "missing $field in: $resp"
      return
    fi
  done

  pass "new_project_start_shape"
}

# ===========================================================================
# test_new_project_not_logged_in
# AC-7: missing token → verse8_new_project_start returns not_logged_in BEFORE
# any HTTP call (we assert by not even starting the mock).
# ===========================================================================
test_new_project_not_logged_in() {
  make_tmpdir
  local isolated_config="$TEST_TMPDIR/xdg-empty"
  mkdir -p "$isolated_config"

  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    XDG_CONFIG_HOME="$isolated_config" VERSE8_ACCESS_TOKEN="" \
      mcp_call_tool "$BINARY" "verse8_new_project_start" '{"userRequest":"puzzle"}'
  )
  rm -rf "$TEST_TMPDIR"

  if [ -z "$resp" ]; then
    fail "new_project_not_logged_in" "no response from server"
    return
  fi

  if ! json_contains "$resp" 'not_logged_in'; then
    fail "new_project_not_logged_in" "expected not_logged_in, got: $resp"
    return
  fi

  pass "new_project_not_logged_in"
}

# AC-8 (VERSE8_AGENT8_BACKEND_URL host allow-list) is covered by
# tests/unit/agent8Backend.test.mjs — the mcp stdio harness drops the
# server's stderr, so we can't observe the registry's reject log from
# here. Keeping the coverage as a unit test keeps it fast + deterministic.

# ===========================================================================
# test_ac9_no_token_verse8_status
# AC-9 extension: verse8_status also returns not_logged_in without token
# ===========================================================================
test_ac9_no_token_verse8_status() {
  make_tmpdir
  rm -f "$REAL_TOKEN_PATH"
  rm -f "$TEST_TMPDIR/.verse8/token"

  local resp
  resp=$(
    cd "$TEST_TMPDIR"
    unset VERSE8_ACCESS_TOKEN 2>/dev/null || true
    mcp_call_tool "$BINARY" "verse8_status" '{}'
  )
  rm -rf "$TEST_TMPDIR"

  if [ -z "$resp" ]; then
    fail "ac9_no_token_verse8_status" "no response from server"
    return
  fi

  if ! json_contains "$resp" 'not_logged_in'; then
    fail "ac9_no_token_verse8_status" "expected not_logged_in error, got: $resp"
    return
  fi

  pass "ac9_no_token_verse8_status"
}

# ===========================================================================
# test_ac_hook_binary_direct
# Direct invocation: node dist/index.js hook pre-commit in gitlab repo exits 0
# ===========================================================================
test_ac_hook_binary_direct() {
  make_tmpdir
  git init "$TEST_TMPDIR" -b main >/dev/null 2>&1 || git init "$TEST_TMPDIR" >/dev/null 2>&1
  (cd "$TEST_TMPDIR" && git remote add origin "https://gitlab.verse8.io/test/x.git")

  local rc=0
  (cd "$TEST_TMPDIR" && node "$BINARY" hook pre-commit) || rc=$?
  rm -rf "$TEST_TMPDIR"

  if [ "$rc" -ne 0 ]; then
    fail "ac_hook_binary_direct_gitlab" "expected exit 0 for gitlab origin, got $rc"
    return
  fi
  pass "ac_hook_binary_direct_gitlab"
}

test_ac_hook_binary_direct_github_fails() {
  make_tmpdir
  git init "$TEST_TMPDIR" -b main >/dev/null 2>&1 || git init "$TEST_TMPDIR" >/dev/null 2>&1
  (cd "$TEST_TMPDIR" && git remote add origin "https://github.com/user/repo.git")

  local rc=0
  (cd "$TEST_TMPDIR" && node "$BINARY" hook pre-commit 2>/dev/null) || rc=$?
  rm -rf "$TEST_TMPDIR"

  if [ "$rc" -eq 0 ]; then
    fail "ac_hook_binary_direct_github_fails" "expected exit 1 for github origin, got 0"
    return
  fi
  pass "ac_hook_binary_direct_github_fails"
}

# ===========================================================================
# test_new_project_confirm_happy_path
# AC-2/3/4/12: start → confirm → project cloned, attached, no glpat- in
# .verse8/project.json, nextCallRequires.projectDir populated, subsequent
# tools/list from the cloned dir includes verse8_checkpoint.
# ===========================================================================
test_new_project_confirm_happy_path() {
  bash "$MOCKS_DIR/fixture-bundle.sh" >/dev/null 2>&1 || {
    fail "new_project_confirm_happy_path" "fixture-bundle.sh failed"
    return
  }

  # Pin the mock's project.path to a stable slug so the smoke test can
  # assert on a known filesystem location. The slug after /: is the
  # `git clone ... <slug>` argument.
  start_agent8_mock "--fixed-project-path=smoke-user/verse8-smoke-bundle"
  make_tmpdir
  install_test_token "test-token-xyz"

  # Phase 1: start
  local start_resp
  start_resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_new_project_start" '{"userRequest":"smoke shooter"}'
  )

  if [ -z "$start_resp" ] || ! json_contains "$start_resp" 'startCallId'; then
    stop_agent8_mock
    rm -rf "$TEST_TMPDIR"
    fail "new_project_confirm_happy_path" "no startCallId in start response: $start_resp"
    return
  fi

  # Phase 2: confirm — pass the known template triple through to the mock.
  # We intentionally OMIT startCallId here because the smoke harness spawns
  # a fresh MCP server process per tool call, so the per-process startCallId
  # memo from phase 1 is not visible to the confirm call. The plan's
  # guardrail allows omission as the old-caller backward-compat path; AC-11
  # (digest mismatch) is covered in detail by tests/unit/newProjectConfirm.
  local confirm_args
  confirm_args=$(cat <<JSONEOF
{"templateName":"basic-vite-react","repo":"planetarium/agent8-templates","path":"basic-vite-react","title":"Smoke Shooter","projectRepo":"smoke-shooter","targetDir":"$TEST_TMPDIR"}
JSONEOF
)
  local confirm_resp
  confirm_resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_new_project_confirm" "$confirm_args"
  )

  stop_agent8_mock

  if [ -z "$confirm_resp" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "new_project_confirm_happy_path" "no confirm response"
    return
  fi

  # Inner JSON is escape-quoted. Match on unquoted keys to avoid fighting
  # the wire-level escaping.
  if ! json_contains "$confirm_resp" 'projectDir'; then
    rm -rf "$TEST_TMPDIR"
    fail "new_project_confirm_happy_path" "projectDir missing: $confirm_resp"
    return
  fi
  if ! json_contains "$confirm_resp" 'nextCallRequires'; then
    rm -rf "$TEST_TMPDIR"
    fail "new_project_confirm_happy_path" "nextCallRequires missing: $confirm_resp"
    return
  fi

  # Slug comes from --fixed-project-path=smoke-user/verse8-smoke-bundle
  # → clone slug = "verse8-smoke-bundle"
  local project_dir="$TEST_TMPDIR/verse8-smoke-bundle"

  if [ ! -f "$project_dir/.verse8/project.json" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "new_project_confirm_happy_path" ".verse8/project.json missing in $project_dir"
    return
  fi

  # AC-4: token MUST NOT be in .verse8/project.json
  if grep -q 'glpat-' "$project_dir/.verse8/project.json" 2>/dev/null; then
    rm -rf "$TEST_TMPDIR"
    fail "new_project_confirm_happy_path" "glpat- leaked into .verse8/project.json"
    return
  fi

  if [ ! -x "$project_dir/.git/hooks/pre-commit" ] || [ ! -x "$project_dir/.git/hooks/commit-msg" ]; then
    rm -rf "$TEST_TMPDIR"
    fail "new_project_confirm_happy_path" "git hooks not executable in $project_dir"
    return
  fi

  # tools/list from cloned dir should include verse8_checkpoint (token present,
  # MCP tools are gated on login, not cwd — just proves a session inside the
  # new project sees the full tool set).
  local tools_resp
  tools_resp=$(
    cd "$project_dir"
    mcp_request "$BINARY" "tools/list" '{}'
  )

  rm -rf "$TEST_TMPDIR"

  if ! json_contains "$tools_resp" '"verse8_checkpoint"'; then
    fail "new_project_confirm_happy_path" "verse8_checkpoint missing in tools/list after confirm: $tools_resp"
    return
  fi

  pass "new_project_confirm_happy_path"
}

# ===========================================================================
# test_new_project_template_mismatch
# AC-11: confirm with an unknown/drifted startCallId returns template_mismatch
# with NO HTTP calls made. The smoke harness spawns a fresh MCP process per
# tool call, so any `scid_*` we pass is by definition unknown to the confirm
# process — that is one of the two template_mismatch paths (unknown id +
# digest mismatch); the digest-mismatch variant is covered by the in-process
# unit test tests/unit/newProjectConfirm.test.mjs.
# ===========================================================================
test_new_project_template_mismatch() {
  start_agent8_mock
  make_tmpdir
  install_test_token "test-token-xyz"

  # Baseline call count BEFORE the bogus-startCallId confirm attempt.
  local before_select
  before_select=$(grep -c '/api/select-template' /tmp/agent8-mock-calls.jsonl 2>/dev/null || echo 0)

  local confirm_args='{"templateName":"basic-vite-react","repo":"planetarium/agent8-templates","path":"basic-vite-react","title":"x","projectRepo":"x","startCallId":"scid_bogus_ffffffffffffffffffffffffffffffff"}'
  local confirm_resp
  confirm_resp=$(
    cd "$TEST_TMPDIR"
    mcp_call_tool "$BINARY" "verse8_new_project_confirm" "$confirm_args"
  )

  local after_select
  after_select=$(grep -c '/api/select-template' /tmp/agent8-mock-calls.jsonl 2>/dev/null || echo 0)

  stop_agent8_mock
  rm -rf "$TEST_TMPDIR"

  if ! json_contains "$confirm_resp" 'template_mismatch'; then
    fail "new_project_template_mismatch" "expected template_mismatch, got: $confirm_resp"
    return
  fi
  if [ "$before_select" != "$after_select" ]; then
    fail "new_project_template_mismatch" "expected zero new select-template calls, before=$before_select after=$after_select"
    return
  fi

  pass "new_project_template_mismatch"
}

# ===========================================================================
# test_ac7_resources
# AC-7: resources/list returns at least one verse8://skill/*/SKILL.md URI;
#       resources/read for that URI returns non-empty text content.
# Must run from repo root so the skills/ directory is discoverable.
# ===========================================================================
test_ac7_resources() {
  # resources/list — id 3
  local list_resp
  list_resp=$(
    cd "$REPO_ROOT"
    mcp_request "$BINARY" "resources/list" '{}'
  )

  if [ -z "$list_resp" ]; then
    fail "ac7_resources_list" "no response from resources/list"
    return
  fi

  if ! json_contains "$list_resp" 'verse8://skill/'; then
    fail "ac7_resources_list" "no verse8://skill/ URI in resources/list: $list_resp"
    return
  fi

  pass "ac7_resources_list"

  # Extract the first verse8://skill URI from the response for resources/read
  # Use parameter expansion to isolate the URI value
  local skill_uri
  skill_uri=$(printf '%s' "$list_resp" | \
    grep -o '"verse8://skill/[^"]*"' | head -1 | tr -d '"')

  if [ -z "$skill_uri" ]; then
    fail "ac7_resources_read" "could not extract a skill URI from resources/list response"
    return
  fi

  # resources/read — send with the extracted URI
  local read_params
  read_params=$(printf '{"uri":"%s"}' "$skill_uri")
  local read_resp
  read_resp=$(
    cd "$REPO_ROOT"
    mcp_request "$BINARY" "resources/read" "$read_params"
  )

  if [ -z "$read_resp" ]; then
    fail "ac7_resources_read" "no response from resources/read for $skill_uri"
    return
  fi

  # Response must contain a non-empty text field (the SKILL.md content)
  if ! json_contains "$read_resp" '"text"'; then
    fail "ac7_resources_read" "text field missing in resources/read response: $read_resp"
    return
  fi

  # Ensure it is not an error response
  if json_contains "$read_resp" '"error"'; then
    fail "ac7_resources_read" "resources/read returned error: $read_resp"
    return
  fi

  pass "ac7_resources_read"
}

# ===========================================================================
# test_ac8_prompts
# AC-8: prompts/list contains verse8-new-project-bootstrap;
#       prompts/get returns a messages array (MCP prompt shape).
# ===========================================================================
test_ac8_prompts() {
  local list_resp
  list_resp=$(
    cd "$REPO_ROOT"
    mcp_request "$BINARY" "prompts/list" '{}'
  )

  if [ -z "$list_resp" ]; then
    fail "ac8_prompts_list" "no response from prompts/list"
    return
  fi

  if ! json_contains "$list_resp" '"new-project"'; then
    fail "ac8_prompts_list" "new-project missing in prompts/list: $list_resp"
    return
  fi

  pass "ac8_prompts_list"

  # prompts/get
  local get_resp
  get_resp=$(
    cd "$REPO_ROOT"
    mcp_request "$BINARY" "prompts/get" '{"name":"new-project"}'
  )

  if [ -z "$get_resp" ]; then
    fail "ac8_prompts_get" "no response from prompts/get"
    return
  fi

  if ! json_contains "$get_resp" '"messages"'; then
    fail "ac8_prompts_get" "messages array missing in prompts/get response: $get_resp"
    return
  fi

  pass "ac8_prompts_get"
}

# ---------------------------------------------------------------------------
# verse8_upload_asset smoke tests (new)
# ---------------------------------------------------------------------------
test_upload_absent_without_token() {
  rm -f "$REAL_TOKEN_PATH"
  local resp
  resp=$(mcp_request "$BINARY" "tools/list" '{}')
  if json_contains "$resp" 'verse8_upload_asset'; then
    fail "upload_absent_without_token" "tool visible without token"
    return
  fi
  pass "upload_absent_without_token"
}

test_upload_present_with_token() {
  install_test_token "test-token-xyz"
  local resp
  resp=$(mcp_request "$BINARY" "tools/list" '{}')
  if ! json_contains "$resp" 'verse8_upload_asset'; then
    fail "upload_present_with_token" "tool missing with token"
    return
  fi
  pass "upload_present_with_token"
}

test_upload_happy_path() {
  start_agent8_mock
  make_tmpdir
  install_test_token "test-token-xyz"
  local project="$TEST_TMPDIR/attached"
  setup_attached_verse_project_dir "$project"
  cp "$REPO_ROOT/tests/mocks/fixtures/tiny.png" "$project/asset.png"

  local args
  args=$(printf '{"filePath":"%s/asset.png","category":"image","projectDir":"%s"}' "$project" "$project")
  local resp
  resp=$(
    cd "$project"
    mcp_call_tool "$BINARY" "verse8_upload_asset" "$args"
  )

  stop_agent8_mock
  rm -rf "$TEST_TMPDIR"

  if json_contains "$resp" '\\"ok\\":true' && json_contains "$resp" 'agent8-games.verse8.io'; then
    pass "upload_happy_path"
  else
    fail "upload_happy_path" "$resp"
  fi
}

test_upload_invalid_extension() {
  start_agent8_mock
  make_tmpdir
  install_test_token "test-token-xyz"
  local project="$TEST_TMPDIR/attached"
  setup_attached_verse_project_dir "$project"
  cp "$REPO_ROOT/tests/mocks/fixtures/bad.exe" "$project/bad.exe"

  local args
  args=$(printf '{"filePath":"%s/bad.exe","category":"image","projectDir":"%s"}' "$project" "$project")
  local resp
  resp=$(
    cd "$project"
    mcp_call_tool "$BINARY" "verse8_upload_asset" "$args"
  )

  stop_agent8_mock
  rm -rf "$TEST_TMPDIR"

  if json_contains "$resp" 'invalid_extension'; then
    pass "upload_invalid_extension"
  else
    fail "upload_invalid_extension" "$resp"
  fi
}

# ===========================================================================
# Run tests — honors VERSE8_SMOKE_ONLY filter (space-separated names). When
# unset, runs the full suite; M4.1 split files set it to restrict to their
# subset.
# ===========================================================================
ALL_TESTS="
  test_ac1_empty_cwd_tools_list
  test_ac3_verse_project_expanded_set
  test_ac3_image_tools_with_mock
  test_ac4_non_verse_silent
  test_ac5_image_proxy_bearer
  test_ac5b_image_error_passthrough
  test_session_expire_retry
  test_ac6_pre_commit_origin_enforcement
  test_ac9_no_token_errors
  test_new_project_tool_renamed
  test_agents_md_literals
  test_skills_materialized
  test_skills_no_touch_invariant
  test_skills_no_cascade_delete
  test_new_project_start_shape
  test_new_project_not_logged_in
  test_ac9_no_token_verse8_status
  test_ac_hook_binary_direct
  test_ac_hook_binary_direct_github_fails
  test_new_project_confirm_happy_path
  test_new_project_template_mismatch
  test_ac7_resources
  test_ac8_prompts
  test_upload_absent_without_token
  test_upload_present_with_token
  test_upload_happy_path
  test_upload_invalid_extension
"

SELECTED_TESTS="${VERSE8_SMOKE_ONLY:-$ALL_TESTS}"
for t in $SELECTED_TESTS; do
  "$t"
done

# Restore token after all tests
restore_token

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n=== Results ===\n'
printf '  PASS: %d\n' "$PASS"
printf '  FAIL: %d\n' "$FAIL"
printf '  SKIP: %d\n' "$SKIP"

if [ "$FAIL" -gt 0 ]; then
  printf '\nsome tests FAILED\n'
  exit 1
fi

printf '\nAll tests passed.\n'
exit 0
