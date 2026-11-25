import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { deviceAuthorize, deviceToken } from "../api/v8MemeApi.js";
import {
  getConfigTokenPath,
  inspectProjectToken,
  refusedProjectTokenHint,
  forgetProjectDirWithUsedToken,
  listProjectDirsWithUsedToken,
  logoutCallHint,
  resolveToken,
  type ProjectTokenRefusal,
  type TokenSource,
} from "../context/token.js";
import { resetProxyCaches } from "../proxy/forward.js";
import { atomicWriteFileSync } from "../util/atomicWrite.js";
import { isSafeAbsPath } from "../util/safePath.js";

/**
 * RFC 8628 device flow, split into two tools.
 *
 *   1. `verse8_login_start()` — request a device code. Returns the
 *      verification URL + user code **immediately** so the host LLM can show
 *      them to the user before any polling begins.
 *   2. `verse8_login_complete({device_code, max_wait_seconds?})` — block up
 *      to max_wait_seconds polling the token endpoint. On success, write the
 *      access token to ${XDG_CONFIG_HOME or ~/.config}/verse8/token.
 *
 * `verse8_logout` (end of this file) deletes the local token again.
 *
 * Why split: the previous single blocking tool returned the URL only after
 * its 120s window expired, so by the time the user saw the URL the
 * corresponding device_code was orphaned (the polling loop had already
 * terminated). Splitting the flow lets the LLM surface the URL in its first
 * response turn, then invoke complete once the user confirms.
 */

export const loginStartInputSchema = z.object({}).strict();

export const loginCompleteInputSchema = z
  .object({
    device_code: z
      .string()
      .min(1)
      .describe("device_code returned by verse8_login_start"),
    max_wait_seconds: z
      .number()
      .int()
      .min(5)
      .max(1800)
      .default(120)
      .describe("max seconds to poll before returning login_timeout"),
  })
  .strict();

export interface LoginStartResult {
  ok: true;
  device_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  user_code: string;
  expires_in: number;
  interval: number;
  next: string;
}

export interface LoginStartError {
  ok: false;
  error: string;
  hint?: string;
}

export interface LoginCompleteOk {
  ok: true;
  saved_to: string;
  profile_hint: string;
  /** Set when another token source outranks the file just written. */
  warning?: string;
}

export interface LoginCompleteError {
  ok: false;
  error: string;
  hint?: string;
  verification_uri?: string;
  user_code?: string;
}

export async function runLoginStart(): Promise<LoginStartResult | LoginStartError> {
  let auth;
  try {
    auth = await deviceAuthorize();
  } catch (e) {
    return { ok: false, error: "device_authorize_failed", hint: (e as Error).message };
  }

  const verificationUri = auth.verification_uri_complete || auth.verification_uri;
  // Best-effort stderr diagnostics for non-MCP hosts; never stdout.
  console.error(`[verse8-login-start] Open: ${verificationUri}`);
  console.error(`[verse8-login-start] Code: ${auth.user_code}`);

  return {
    ok: true,
    device_code: auth.device_code,
    verification_uri: auth.verification_uri,
    verification_uri_complete: auth.verification_uri_complete,
    user_code: auth.user_code,
    expires_in: auth.expires_in,
    interval: auth.interval,
    next: "Display verification_uri_complete (or verification_uri when it is absent) + user_code to the user, wait for them to confirm they have approved in the browser, then call verse8_login_complete with the same device_code.",
  };
}

export async function runLoginComplete(
  input: z.infer<typeof loginCompleteInputSchema>,
  cwd: string = process.cwd(),
): Promise<LoginCompleteOk | LoginCompleteError> {
  const deviceCode = input.device_code;
  const maxWaitMs = (input.max_wait_seconds ?? 120) * 1000;
  const deadline = Date.now() + maxWaitMs;
  let interval = 5;

  while (Date.now() < deadline) {
    const resp = await deviceToken(deviceCode);
    if (resp.ok) {
      const tokenPath = getConfigTokenPath();
      try {
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(tokenPath, resp.token.access_token, { mode: 0o600 });
      } catch (e) {
        return {
          ok: false,
          error: "token_write_failed",
          hint: (e as Error).message,
        };
      }
      // New identity → proxy caches keyed by URL may hold stale session IDs
      // and tool schemas tied to the previous bearer. Drop them so the next
      // tools/list rediscovers under the new credentials.
      resetProxyCaches();
      // The new login only takes effect if nothing outranks the file.
      const inUse = resolveToken(cwd);
      const warning =
        inUse.source === "env"
          ? "The new login is saved but NOT in use: the VERSE8_ACCESS_TOKEN environment variable is used before any token file. Ask the user to remove it from the MCP server's env settings and restart the server."
          : inUse.source === "project"
            ? `The new login is saved but NOT in use: the project token file ${inUse.path} is used before it. ${logoutCallHint(inUse.path ?? "")} to delete it (this also deletes the login just saved), then log in again.`
            : undefined;
      return {
        ok: true,
        saved_to: tokenPath,
        profile_hint: "Call verse8_status to see the logged-in profile.",
        ...(warning ? { warning } : {}),
      };
    }

    const code = resp.error.error;
    if (code === "authorization_pending") {
      await sleep(interval * 1000);
      continue;
    }
    if (code === "slow_down") {
      interval += 5;
      await sleep(interval * 1000);
      continue;
    }
    if (code === "expired_token") {
      return {
        ok: false,
        error: "expired_token",
        hint: "device_code expired (30-min window). Call verse8_login_start again to get a fresh code.",
      };
    }
    if (code === "access_denied") {
      return {
        ok: false,
        error: "access_denied",
        hint: "user rejected the authorization in the browser",
      };
    }
    return {
      ok: false,
      error: code || `http_${resp.status}`,
      hint: resp.error.error_description,
    };
  }

  return {
    ok: false,
    error: "login_timeout",
    hint: `no authorization received within ${input.max_wait_seconds}s. The device_code is still valid for ~30 minutes — call verse8_login_complete again with the same device_code if the user is still authorizing.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `verse8_logout` — delete the local login. Removes the config-folder token
 * file and the project-folder one, and reports what it could not clear (the
 * VERSE8_ACCESS_TOKEN environment variable, a refused project token file).
 * There is no server-side revocation API, so the result always says the
 * token itself stays valid until it expires.
 */
export const logoutInputSchema = z
  .object({
    projectDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "projectDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
      })
      .optional()
      .describe(
        "Absolute path to the verse8 project directory whose .verse8/token should also be removed. If omitted, process.cwd() is used.",
      ),
  })
  .strict();

export interface LogoutEntry {
  source: TokenSource;
  /** The token file (`project` and `config`); absent for `env`. */
  path?: string;
}

export interface LogoutLeft extends LogoutEntry {
  reason: string;
}

const NOT_REVOKED =
  "Deleting the local token does not revoke it: Verse8 has no token revocation API, so the token stays valid on the server until it expires, and any other copy of it still works.";

export interface LogoutOk {
  ok: true;
  /** Token files this call deleted. */
  removed: LogoutEntry[];
  /** Token sources this call left in place, none of which can supply a token. */
  left: LogoutLeft[];
  serverSide: string;
  /** The project folder whose `.verse8/token` this call handled. */
  projectDir: string;
  next: string;
}

export interface LogoutError {
  ok: false;
  error: "logout_incomplete";
  hint: string;
  /** The source that still supplies a token, or still holds one that may be used again. */
  tokenSource: LogoutEntry;
  removed: LogoutEntry[];
  left: LogoutLeft[];
  serverSide: string;
  /** The project folder whose `.verse8/token` this call handled. */
  projectDir: string;
}

/**
 * Project token refusals that only say "could not check right now". The file
 * may well be a usable token once git works again or the folder is readable,
 * so logout must not call the login gone while it is still there.
 */
const UNVERIFIED_REFUSALS: ReadonlySet<ProjectTokenRefusal> = new Set<ProjectTokenRefusal>([
  "unreadable",
  "git_unavailable",
  "git_check_failed",
]);

/** Delete one token file. Returns the entry when the file is still there afterwards. */
function removeTokenFile(
  entry: LogoutEntry & { path: string },
  removed: LogoutEntry[],
  left: LogoutLeft[],
): LogoutLeft | null {
  try {
    // unlink removes a link itself, never the file it points at.
    fs.unlinkSync(entry.path);
    removed.push(entry);
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Only "nothing there" is a clean outcome; any other failure leaves a token behind.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    const kept: LogoutLeft = { ...entry, reason: `could not delete the file (${code ?? "unknown error"})` };
    left.push(kept);
    return kept;
  }
}

export async function runLogout(
  input: z.infer<typeof logoutInputSchema> = {},
  cwd: string = process.cwd(),
): Promise<LogoutOk | LogoutError> {
  const projectDir = input.projectDir ?? cwd;
  const removed: LogoutEntry[] = [];
  const left: LogoutLeft[] = [];
  /** Token files that are still on disk and may supply a token later. */
  const stillThere: LogoutLeft[] = [];

  const configKept = removeTokenFile({ source: "config", path: getConfigTokenPath() }, removed, left);
  if (configKept) stillThere.push(configKept);

  const project = inspectProjectToken(projectDir);
  if (project.state === "usable") {
    const kept = removeTokenFile({ source: "project", path: project.path }, removed, left);
    if (kept) stillThere.push(kept);
    else forgetProjectDirWithUsedToken(projectDir);
  } else if (project.state === "refused") {
    // Not deleted: behind a linked `.verse8` the file is outside the
    // project, and deleting a tracked file would dirty the repository.
    const kept: LogoutLeft = {
      source: "project",
      path: project.path,
      reason: `not deleted: ${refusedProjectTokenHint({ path: project.path, reason: project.reason })}`,
    };
    left.push(kept);
    if (UNVERIFIED_REFUSALS.has(project.reason)) stillThere.push(kept);
  }

  // Token files in other project folders this server has been using. This
  // call was not asked to delete them, but saying "logged out" while tools
  // called with that projectDir still find a token would be wrong — and it
  // is exactly what happens when a hint's verse8_logout is called without
  // the projectDir the token file is in.
  const elsewhere: Array<{ kept: LogoutLeft; hint: string }> = [];
  for (const dir of listProjectDirsWithUsedToken()) {
    if (path.resolve(dir) === path.resolve(projectDir)) continue;
    const other = inspectProjectToken(dir);
    const scope = `this call handled projectDir ${JSON.stringify(projectDir)} only, and this server has used this token file for projectDir ${JSON.stringify(dir)}`;
    let kept: LogoutLeft;
    let hint: string;
    if (other.state === "usable") {
      // Still in use there, and a logout for that folder would delete it.
      kept = { source: "project", path: other.path, reason: `not deleted: ${scope}` };
      hint = `Logout is not complete: tools called with another projectDir still find the project token file ${other.path}. ${logoutCallHint(other.path)} to delete it too.`;
    } else if (other.state === "refused" && UNVERIFIED_REFUSALS.has(other.reason)) {
      // Could not be checked: not in use right now, and verse8_logout would
      // not delete it either, so do not send the caller back to this tool.
      const why = refusedProjectTokenHint({ path: other.path, reason: other.reason });
      kept = { source: "project", path: other.path, reason: `not deleted and not checked: ${why} (${scope})` };
      hint = `Logout is not complete: the project token file ${other.path} is still on disk and could not be checked. ${why} It is not in use right now but may be used again once the check works, and verse8_logout does not delete a file it cannot check. Ask the user to delete that file.`;
    } else {
      forgetProjectDirWithUsedToken(dir);
      continue;
    }
    left.push(kept);
    elsewhere.push({ kept, hint });
  }

  const envToken = process.env.VERSE8_ACCESS_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    left.push({
      source: "env",
      reason:
        "VERSE8_ACCESS_TOKEN is set in the MCP server's environment; the server cannot unset it for the host",
    });
  }

  // The previous identity's proxy sessions and tool schemas are stale now.
  resetProxyCaches();

  const incomplete = (tokenSource: LogoutEntry, hint: string): LogoutError => ({
    ok: false,
    error: "logout_incomplete",
    hint,
    tokenSource,
    projectDir,
    removed,
    left,
    serverSide: NOT_REVOKED,
  });

  const after = resolveToken(projectDir);
  if (after.source) {
    const tokenSource: LogoutEntry = after.path
      ? { source: after.source, path: after.path }
      : { source: after.source };
    return incomplete(
      tokenSource,
      after.source === "env"
        ? "Still logged in: the VERSE8_ACCESS_TOKEN environment variable supplies a token and is used before any token file. Ask the user to remove it from the MCP server's env settings and restart the server."
        : `Still logged in: ${after.path} could not be deleted. Ask the user to delete that file.`,
    );
  }
  // No token resolves right now, but a file that could not be deleted or
  // could not be checked is still a login waiting to come back.
  if (stillThere.length > 0) {
    const kept = stillThere[0];
    return incomplete(
      { source: kept.source, path: kept.path },
      `Logout is not complete: ${kept.path} is still on disk (${kept.reason}). It is not in use right now but may be used again later. Ask the user to delete that file.`,
    );
  }
  if (elsewhere.length > 0) {
    const { kept, hint } = elsewhere[0];
    return incomplete({ source: kept.source, path: kept.path }, hint);
  }

  return {
    ok: true,
    projectDir,
    removed,
    left,
    serverSide: NOT_REVOKED,
    next: `verse8_status now answers not_logged_in. Only this project folder was checked for a project token file: ${projectDir} — a project in another folder needs verse8_logout with its projectDir. To switch accounts, call verse8_login_start and have the user approve in a browser signed in to the other Verse8 account.`,
  };
}
