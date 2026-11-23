/**
 * Central ErrorCode registry (M3.2, AC-TYPES-1). Every `{ok: false, error}`
 * literal must draw from this union. AST coverage test enforces this.
 */

export const ERROR_CODES = [
  // Auth / login
  "not_logged_in",
  "device_authorize_failed",
  "token_write_failed",
  "expired_token",
  "access_denied",
  "login_timeout",
  "slow_down",
  "authorization_pending",
  "token_invalid",
  "token_expires_soon",
  // IP asset access
  "a2a_not_configured",
  "a2a_invalid_response",
  "a2a_response_too_large",
  "a2a_access_denied",
  "token_exchange_not_configured",
  "token_exchange_invalid_response",
  "token_exchange_response_too_large",
  "token_exchange_access_denied",
  "token_exchange_unavailable",
  "a2a_request_failed",
  "a2a_interrupted",
  "artifact_invalid",
  "artifact_write_failed",
  // Project lifecycle / new-project
  "rate_limited",
  "startcall_failed",
  "template_mismatch",
  "confirm_in_flight",
  "invalid_parent",
  "invalid_input",
  "clone_target_exists",
  "clone_parse_failed",
  "clone_failed",
  "select_template_failed",
  "token_check_failed",
  "token_grant_failed",
  "tool_renamed",
  // Open existing project (verse8_open_project)
  "environment_mismatch",
  "open_in_flight",
  // Attach / verse-project
  "not_a_verse_project",
  "missing_git",
  "attach_failed",
  "project_needs_attach",
  // Checkpoint
  "stage_failed",
  "nothing_to_commit",
  "files_required",
  "commit_failed",
  "push_failed",
  "checkpoint_failed",
  // Preview
  "dev_server_not_ready",
  "dev_server_exited",
  "empty_command",
  "preflight_failed",
  "preview_failed",
  // Dispatch / server
  "unknown_tool",
  "unknown_uri",
  "unknown_prompt",
  "tool_exception",
  "prompt_exception",
  "not_implemented",
  "hook_failed",
  "no_token",
  "read_failed",
  "upstream_unreachable",
  "upstream_error",
  "not_yet_available",
  // Deploy (verse8_deploy / verse8_upload_thumbnail)
  "missing_account_env",
  "verse_owned_by_other",
  "verse_id_unavailable",
  "captcha_required",
  "build_failed",
  "plugin_shim_missing",
  "deploy_upload_failed",
  "verse_publish_failed",
  "media_too_large",
  // Asset upload (verse8_upload_asset)
  "missing_verse_env",
  "file_not_found",
  "file_not_regular",
  "invalid_extension",
  "cdn_path_required",
  "cdn_path_invalid",
  "unauthorized",
  "forbidden",
  "bad_request",
  "upload_failed",
  "upload_response_malformed",
  // Credits / billing
  "insufficient_credits",
  // Game server / creator operations
  "not_found",
  "logs_unavailable",
  "no_gameserver",
  "not_seller",
  "product_id_taken",
  "plan_mismatch",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && ERROR_CODE_SET.has(v);
}
