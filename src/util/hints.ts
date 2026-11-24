/**
 * Hint text that tool results and hooks show to the agent. The agent reads
 * these inside a game project, which has no copy of this repo — so they name
 * only MCP tools and commands that exist there, never `scripts/…` or other
 * repo paths (tests/unit/runtimeHints.test.mjs checks this).
 */

/**
 * Hint for every `not_logged_in` result, and the "how to log in" part of
 * every rejected-token hint. Same order as the verse8-login skill.
 */
export const LOGIN_HINT =
  "call verse8_login_start, show verification_uri_complete and user_code to the user, wait for them to approve in the browser, then call verse8_login_complete with the same device_code";
