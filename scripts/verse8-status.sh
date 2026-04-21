#!/usr/bin/env bash
# Show the current Verse8 identity by calling /v1/auth/verify with the stored token.
set -euo pipefail

API="${VERSE8_API_URL:-https://v8-meme-api.verse8.io}"
TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/verse8/token"

token="${VERSE8_ACCESS_TOKEN:-}"
if [ -z "$token" ] && [ -f "$TOKEN_FILE" ]; then
  token=$(cat "$TOKEN_FILE")
fi

if [ -z "$token" ]; then
  echo "❌ Not logged in. Run: bash scripts/verse8-login.sh" >&2
  exit 1
fi

resp=$(curl -sS --max-time 10 "$API/v1/auth/verify" \
  -H "Authorization: Bearer $token" \
  -w '\n%{http_code}')
status=$(printf '%s' "$resp" | tail -n1)
body=$(printf '%s' "$resp" | sed '$d')

if [ "$status" != "200" ]; then
  echo "❌ Token invalid or expired (HTTP $status). Re-run verse8-login.sh" >&2
  exit 1
fi

VERSE8_PROFILE_JSON="$body" python3 <<'PY'
import json, os
p = json.loads(os.environ['VERSE8_PROFILE_JSON'])
name = p.get('displayName') or p.get('handle') or p.get('userUid')
print(f"👤 {name}")
print(f"   userUid:  {p.get('userUid')}")
print(f"   handle:   {p.get('handle') or '-'}")
print(f"   email:    {p.get('email') or '-'}")
print(f"   wallet:   {p.get('walletAddress') or '-'}")
print(f"   tier:     {p.get('tier') or '-'}")
print(f"   points:   {p.get('totalPoints', 0)}")
print(f"   role:     {p.get('role') or '-'}")
print(f"   active:   {p.get('isActivated')}")
PY
