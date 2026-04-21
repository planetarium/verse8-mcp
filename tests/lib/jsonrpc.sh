#!/bin/sh
# tests/lib/jsonrpc.sh
# Helper functions to drive a verse8-mcp process via MCP stdio protocol.
#
# MCP framing: each message is a JSON object terminated by a newline (\n).
# The handshake sequence is:
#   client -> initialize
#   server -> InitializeResult
#   client -> notifications/initialized  (no response)
#   client -> <actual request>
#   server -> <response>
#
# Usage:
#   . tests/lib/jsonrpc.sh
#   response=$(mcp_request "$BINARY" tools/list '{}')

# mcp_request <binary> <method> <params_json>
# Sends initialize + notifications/initialized + the requested method.
# Keeps stdin open (via sleep) until the server has responded, then kills.
# Captures the JSON line whose "id" == 3.
mcp_request() {
  _mr_binary="$1"
  _mr_method="$2"
  _mr_params="${3:-__EMPTY__}"
  if [ "$_mr_params" = "__EMPTY__" ]; then _mr_params='{}'; fi

  _mr_init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}'
  _mr_notif='{"jsonrpc":"2.0","method":"notifications/initialized"}'
  _mr_req=$(printf '{"jsonrpc":"2.0","id":3,"method":"%s","params":%s}' "$_mr_method" "$_mr_params")

  _mr_tmpout=$(mktemp /tmp/verse8-smoke-rpc.XXXXXX)

  # Keep stdin open with sleep so the server can process all messages
  # before stdin EOF causes it to exit.
  (
    printf '%s\n' "$_mr_init"
    printf '%s\n' "$_mr_notif"
    printf '%s\n' "$_mr_req"
    sleep 4
  ) | timeout 8 node "$_mr_binary" > "$_mr_tmpout" 2>/dev/null

  _mr_result=""
  while IFS= read -r _mr_line; do
    case "$_mr_line" in
      *'"id":3'*|*'"id": 3'*)
        _mr_result="$_mr_line"
        ;;
    esac
  done < "$_mr_tmpout"
  rm -f "$_mr_tmpout"

  printf '%s' "$_mr_result"
}

# mcp_call_tool <binary> <tool_name> <arguments_json>
# Shorthand for tools/call.
mcp_call_tool() {
  _mct_binary="$1"
  _mct_tool="$2"
  _mct_args="${3:-__EMPTY__}"
  if [ "$_mct_args" = "__EMPTY__" ]; then _mct_args='{}'; fi
  _mct_params=$(printf '{"name":"%s","arguments":%s}' "$_mct_tool" "$_mct_args")
  mcp_request "$_mct_binary" "tools/call" "$_mct_params"
}

# json_contains <json_string> <substring>
# Returns 0 if substring found, 1 otherwise.
json_contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}
