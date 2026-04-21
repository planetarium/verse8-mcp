#!/usr/bin/env bash
# Delete the stored Verse8 access token.
set -euo pipefail

TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/verse8/token"

if [ -f "$TOKEN_FILE" ]; then
  rm -f "$TOKEN_FILE"
  echo "✅ Removed $TOKEN_FILE"
else
  echo "ℹ️  No token file at $TOKEN_FILE"
fi
