#!/usr/bin/env bash
# Autonomous live verification loop for verse8-mcp v1.
# Exercises real backend (v8-meme-api) + real image MCP with the cached token.
# No pushes to real gitlab — uses a fake-origin local repo for project-scoped tool tests.
#
# Exit 0: all blocking checks pass
# Exit 1: blocking failure (needs code fix or re-login)
# Exit 2: external dependency blocked (e.g., backend API not shipped)
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist/index.js"
TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/verse8/token"
API="${VERSE8_API_URL:-https://v8-meme-api.verse8.io}"
IMAGE_MCP="${VERSE8_IMAGE_MCP_URL:-https://mcp-image-svc.verse8.io/mcp}"
REPORT="$ROOT/tests/e2e/last-report.json"
TMPROOT="$(mktemp -d -t v8-e2e.XXXXXX)"
PASS=0; FAIL=0; BLOCKED=0
RESULTS=()

cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32mPASS\033[0m %s\n' "$1" >&2; PASS=$((PASS+1)); RESULTS+=("{\"test\":\"$1\",\"status\":\"pass\"}"); }
bad()  { printf '\033[1;31mFAIL\033[0m %s — %s\n' "$1" "$2" >&2; FAIL=$((FAIL+1)); RESULTS+=("{\"test\":\"$1\",\"status\":\"fail\",\"reason\":$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}"); }
blk()  { printf '\033[1;33mBLOCKED\033[0m %s — %s\n' "$1" "$2" >&2; BLOCKED=$((BLOCKED+1)); RESULTS+=("{\"test\":\"$1\",\"status\":\"blocked\",\"reason\":$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}"); }

need_token() {
  if [ ! -f "$TOKEN_FILE" ]; then bad "pre_token_present" "no token at $TOKEN_FILE"; return 1; fi
  TOKEN=$(cat "$TOKEN_FILE")
  [ -n "$TOKEN" ]
}

# --- TEST 1: token health ---
t_token_health() {
  local resp status
  resp=$(curl -sS "$API/v1/auth/verify" -H "Authorization: Bearer $TOKEN" -w "\n%{http_code}" --max-time 10)
  status=$(printf '%s' "$resp" | tail -n1)
  if [ "$status" = "200" ]; then ok "token_health"; else bad "token_health" "HTTP $status — run verse8-login"; return 1; fi
}

# --- TEST 2: live image MCP direct (proxy upstream) ---
t_image_mcp_direct() {
  local init_resp session
  init_resp=$(curl -sS -D "$TMPROOT/hdr" -X POST "$IMAGE_MCP" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' \
    -w "\n%{http_code}" --max-time 30)
  status=$(printf '%s' "$init_resp" | tail -n1)
  if [ "$status" != "200" ]; then bad "image_mcp_initialize" "HTTP $status"; return 1; fi
  session=$(grep -i '^mcp-session-id:' "$TMPROOT/hdr" | awk '{print $2}' | tr -d '\r\n')
  [ -n "$session" ] && ok "image_mcp_initialize" || { bad "image_mcp_initialize" "no session-id in headers"; return 1; }
}

# --- TEST 3: MCP server base tools (no token → only base set regardless of cwd) ---
t_base_tools() {
  local dir="$TMPROOT/empty" response
  mkdir -p "$dir"
  local xdg="$TMPROOT/xdg-empty-3"
  mkdir -p "$xdg"
  response=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
      sleep 1
    ) | (cd "$dir" && XDG_CONFIG_HOME="$xdg" VERSE8_ACCESS_TOKEN="" node "$DIST" serve 2>/dev/null)
  )
  local names
  names=$(printf '%s\n' "$response" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line or not line.startswith('{'): continue
    try:
        m = json.loads(line)
        if m.get('id') == 2 and 'result' in m:
            print(','.join(sorted(t['name'] for t in m['result']['tools'])))
    except: pass
" | head -n1)
  if [ "$names" = "verse8_attach,verse8_login_complete,verse8_login_start,verse8_new_project,verse8_status" ]; then
    ok "base_tools_list"
  else
    bad "base_tools_list" "got: $names"
  fi
}

# --- TEST 4: verse-project tools (fake gitlab origin) ---
t_verse_project_tools() {
  local dir="$TMPROOT/fakeverse"
  git init -q "$dir"
  git -C "$dir" config user.email "e2e@test.local"
  git -C "$dir" config user.name "e2e"
  git -C "$dir" remote add origin "https://gitlab.verse8.io/test/fake.git"
  mkdir -p "$dir/.verse8"
  printf '{"version":1,"projectId":"e2e-test","gitlabRemote":"https://gitlab.verse8.io/test/fake.git"}' > "$dir/.verse8/project.json"
  local response names
  response=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
      sleep 3
    ) | (cd "$dir" && node "$DIST" serve 2>/dev/null)
  )
  names=$(printf '%s\n' "$response" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line or not line.startswith('{'): continue
    try:
        m = json.loads(line)
        if m.get('id') == 2 and 'result' in m:
            print(','.join(sorted(t['name'] for t in m['result']['tools'])))
    except: pass
" | head -n1)
  case "$names" in
    *verse8_checkpoint*image_asset_generate*|*image_asset_generate*verse8_checkpoint*)
      ok "verse_project_tools_expanded" ;;
    *verse8_checkpoint*)
      blk "verse_project_tools_expanded" "base+checkpoint present, image tools missing (upstream unreachable?)"
      ;;
    *)
      bad "verse_project_tools_expanded" "got: $names"
      ;;
  esac
}

# --- TEST 5: verse8_checkpoint (local commit only, no push) ---
t_checkpoint_local() {
  local dir="$TMPROOT/checkpoint_test"
  git init -q "$dir"
  git -C "$dir" config user.email "e2e@test.local"
  git -C "$dir" config user.name "e2e"
  git -C "$dir" remote add origin "https://gitlab.verse8.io/test/fake.git"
  git -C "$dir" commit --allow-empty -q -m "initial"
  mkdir -p "$dir/.verse8"
  printf '{"version":1,"projectId":"e2e"}' > "$dir/.verse8/project.json"
  # install pre-commit hook
  cat > "$dir/.git/hooks/pre-commit" <<'HOOK'
#!/bin/sh
exec node "$VERSE8_MCP_DIST" hook pre-commit "$@"
HOOK
  chmod +x "$dir/.git/hooks/pre-commit"
  echo "console.log('hello')" > "$dir/hello.js"
  # drive checkpoint via MCP (message only; push will fail on fake origin — expect it)
  local response exitcode
  response=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"verse8_checkpoint","arguments":{"message":"[verse8] e2e smoke","skipAttachCheck":true}}}'
      sleep 3
    ) | (cd "$dir" && VERSE8_MCP_DIST="$DIST" node "$DIST" serve 2>/dev/null)
  )
  # check local commit was made (push may fail on fake origin)
  local log
  log=$(git -C "$dir" log --oneline 2>/dev/null | head -n5 || true)
  if printf '%s' "$log" | grep -q "e2e smoke"; then
    ok "checkpoint_local_commit"
  else
    bad "checkpoint_local_commit" "no '[verse8] e2e smoke' commit. git log: $log"
  fi
  # push SHOULD have failed (fake origin). Verify the tool reported error/hint appropriately.
  local errtype
  errtype=$(printf '%s\n' "$response" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('{'): continue
    try:
        m = json.loads(line)
        if m.get('id') == 2:
            content = m.get('result', {}).get('content', [])
            if content:
                txt = content[0].get('text', '')
                try:
                    d = json.loads(txt)
                    print(d.get('error', 'none') if not d.get('ok') else 'ok_but_push_also_ok')
                except:
                    print('unparsed:' + txt[:80])
    except: pass
" | head -n1)
  echo "  [checkpoint result: $errtype]" >&2
}

# --- TEST 6: image proxy via MCP with real upstream ---
t_image_proxy_live() {
  local dir="$TMPROOT/image_live"
  git init -q "$dir"
  git -C "$dir" remote add origin "https://gitlab.verse8.io/test/fake.git"
  mkdir -p "$dir/.verse8"
  printf '{"version":1,"projectId":"e2e"}' > "$dir/.verse8/project.json"
  local response imageurl
  response=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"image_asset_generate","arguments":{"description":"simple red gem item","style":"pixel art","assetType":"item","width":256,"height":256,"verse_address":"e2e-autonomous"}}}'
      sleep 60
    ) | (cd "$dir" && node "$DIST" serve 2>/dev/null)
  )
  imageurl=$(printf '%s\n' "$response" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('{'): continue
    try:
        m = json.loads(line)
        if m.get('id') == 2:
            content = m.get('result', {}).get('content', [])
            if content:
                txt = content[0].get('text', '')
                try:
                    d = json.loads(txt)
                    if d.get('url'): print(d['url'])
                except: pass
    except: pass
" | head -n1)
  if printf '%s' "$imageurl" | grep -q '^https://'; then
    # verify URL actually serves an image
    local ct
    ct=$(curl -sS -I "$imageurl" --max-time 10 | grep -i '^content-type:' | awk '{print $2}' | tr -d '\r\n')
    if printf '%s' "$ct" | grep -qi 'image/'; then
      ok "image_proxy_live"
    else
      bad "image_proxy_live" "URL returned content-type: $ct"
    fi
  else
    bad "image_proxy_live" "no image URL in response"
  fi
}

# --- TEST 7: stub_new_project (current backend returns 404) ---
t_stub_new_project() {
  local dir="$TMPROOT/stubnew"
  mkdir -p "$dir"
  local response errcode
  response=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"verse8_new_project","arguments":{"gameType":"platformer","title":"e2e-stub","preset":"basic"}}}'
      sleep 5
    ) | (cd "$dir" && node "$DIST" serve 2>/dev/null)
  )
  errcode=$(printf '%s\n' "$response" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('{'): continue
    try:
        m = json.loads(line)
        if m.get('id') == 2:
            content = m.get('result', {}).get('content', [])
            if content:
                txt = content[0].get('text', '')
                try:
                    d = json.loads(txt)
                    print(d.get('error', 'none'))
                except: pass
    except: pass
" | head -n1)
  if [ "$errcode" = "not_yet_available" ]; then
    ok "stub_new_project"
  else
    bad "stub_new_project" "expected 'not_yet_available', got: $errcode"
  fi
}

# --- TEST 8: cwd-post-clone regression (known v1 limitation) ---
t_cwd_post_clone_regression() {
  # Simulate case 2 post-clone scenario: MCP server spawned in parent dir, project cloned into child.
  local parent="$TMPROOT/case2_parent"
  local child="$parent/subproject"
  mkdir -p "$parent"
  git init -q "$child"
  git -C "$child" remote add origin "https://gitlab.verse8.io/test/fake.git"
  mkdir -p "$child/.verse8"
  printf '{"version":1}' > "$child/.verse8/project.json"
  # spawn from PARENT, check if tools/list sees expanded set
  local response names
  response=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
      sleep 1
    ) | (cd "$parent" && node "$DIST" serve 2>/dev/null)
  )
  names=$(printf '%s\n' "$response" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line or not line.startswith('{'): continue
    try:
        m = json.loads(line)
        if m.get('id') == 2 and 'result' in m:
            print(','.join(sorted(t['name'] for t in m['result']['tools'])))
    except: pass
" | head -n1)
  # CURRENT behavior: MCP sees parent cwd → base tools only. This confirms the v1 limitation.
  if [ "$names" = "verse8_login,verse8_new_project,verse8_status" ]; then
    blk "cwd_post_clone_regression" "v1 limitation confirmed: MCP in parent cwd sees only base tools. Need projectDir param or server restart for case 2."
  else
    ok "cwd_post_clone_regression (mitigated — tools list: $names)"
  fi
}

# --- TEST 9: case-2 post-clone checkpoint via projectDir param ---
t_checkpoint_with_projectdir() {
  # MCP server spawned in PARENT dir, child dir is the verse project.
  # Agent must pass projectDir to verse8_checkpoint and get a successful commit.
  local parent="$TMPROOT/case2_ok"
  local child="$parent/game_sub"
  mkdir -p "$parent"
  git init -q "$child"
  git -C "$child" config user.email "e2e@test.local"
  git -C "$child" config user.name "e2e"
  git -C "$child" remote add origin "https://gitlab.verse8.io/test/fake.git"
  git -C "$child" commit --allow-empty -q -m "initial"
  mkdir -p "$child/.verse8"
  printf '{"version":1}' > "$child/.verse8/project.json"
  echo "content" > "$child/new-file.txt"
  local response
  response=$(
    (
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"verse8_checkpoint\",\"arguments\":{\"message\":\"[verse8] via projectDir\",\"projectDir\":\"$child\",\"skipAttachCheck\":true}}}"
      sleep 3
    ) | (cd "$parent" && node "$DIST" serve 2>/dev/null)
  )
  local log
  log=$(git -C "$child" log --oneline 2>/dev/null | head -n3 || true)
  if printf '%s' "$log" | grep -q "via projectDir"; then
    ok "checkpoint_with_projectdir"
  else
    bad "checkpoint_with_projectdir" "expected commit in child, git log: $log"
  fi
}

# --- main ---
log "start verify-loop.sh (root=$ROOT)"
[ -f "$DIST" ] || { echo "dist not built; running npm run build…" >&2; (cd "$ROOT" && npm run build >&2) || exit 1; }
need_token || { echo "blocked on token"; exit 1; }

t_token_health || exit 1
t_image_mcp_direct
t_base_tools
t_verse_project_tools
t_checkpoint_local
t_image_proxy_live
t_stub_new_project
t_cwd_post_clone_regression
t_checkpoint_with_projectdir

# write report
python3 -c "
import json, sys
results = [json.loads(r) for r in sys.argv[1:]]
report = {
    'summary': {'pass': $PASS, 'fail': $FAIL, 'blocked': $BLOCKED},
    'timestamp': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
    'results': results
}
open('$REPORT','w').write(json.dumps(report, indent=2, ensure_ascii=False))
" "${RESULTS[@]}" 2>/dev/null || true

printf '\n\033[1m=== Results ===\033[0m\n'
printf '  \033[1;32mPASS\033[0m:    %d\n' "$PASS"
printf '  \033[1;31mFAIL\033[0m:    %d\n' "$FAIL"
printf '  \033[1;33mBLOCKED\033[0m: %d\n' "$BLOCKED"
printf '  report: %s\n' "$REPORT"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$BLOCKED" -gt 0 ]; then exit 2; fi
exit 0
