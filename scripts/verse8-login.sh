#!/usr/bin/env bash
# Verse8 device-flow login (RFC 8628).
# Saves access token to $XDG_CONFIG_HOME/verse8/token (default: ~/.config/verse8/token).
set -euo pipefail

API="${VERSE8_API_URL:-https://v8-meme-api.verse8.io}"
TOKEN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/verse8"
TOKEN_FILE="$TOKEN_DIR/token"

json() { python3 -c "import json,sys; print(json.load(sys.stdin).get(sys.argv[1],''))" "$1"; }

echo "🔐 Verse8 device login"
echo "   API: $API"

auth_resp=$(curl -sS --max-time 15 -X POST "$API/v1/auth/device/authorize" \
  -H "Content-Type: application/json")

device_code=$(printf '%s' "$auth_resp" | json device_code)
user_code=$(printf '%s' "$auth_resp" | json user_code)
verification_uri=$(printf '%s' "$auth_resp" | json verification_uri_complete)
expires_in=$(printf '%s' "$auth_resp" | json expires_in)
interval=$(printf '%s' "$auth_resp" | json interval)

if [ -z "$device_code" ]; then
  echo "❌ Failed to request device code:" >&2
  echo "$auth_resp" >&2
  exit 1
fi

echo ""
echo "   1. Open: $verification_uri"
echo "   2. Code: $user_code"
echo ""

if command -v open >/dev/null 2>&1; then
  open "$verification_uri" 2>/dev/null || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$verification_uri" 2>/dev/null || true
fi

echo "⏳ Waiting for authorization (up to ${expires_in}s)..."

deadline=$(( $(date +%s) + expires_in ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  resp=$(curl -sS --max-time 10 -X POST "$API/v1/auth/device/token" \
    -H "Content-Type: application/json" \
    -d "{\"device_code\":\"$device_code\"}" \
    -w '\n%{http_code}')
  status=$(printf '%s' "$resp" | tail -n1)
  body=$(printf '%s' "$resp" | sed '$d')

  if [ "$status" = "200" ] || [ "$status" = "201" ]; then
    token=$(printf '%s' "$body" | json access_token)
    mkdir -p "$TOKEN_DIR"; chmod 700 "$TOKEN_DIR"
    printf '%s' "$token" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
    echo "✅ Token saved → $TOKEN_FILE"
    exec "$(dirname "$0")/verse8-status.sh"
  fi

  err=$(printf '%s' "$body" | json error)
  case "$err" in
    authorization_pending) sleep "$interval" ;;
    slow_down) interval=$(( interval + 5 )); sleep "$interval" ;;
    expired_token) echo "❌ Code expired. Re-run verse8-login.sh" >&2; exit 1 ;;
    access_denied) echo "❌ Access denied." >&2; exit 1 ;;
    *) echo "❌ Unexpected error: $err (HTTP $status)" >&2; echo "$body" >&2; exit 1 ;;
  esac
done

echo "❌ Timed out waiting for authorization." >&2
exit 1
