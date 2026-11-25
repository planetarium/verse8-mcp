import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeChildEnv } from "../util/childEnv.js";
import { LOGIN_HINT } from "../util/hints.js";

/**
 * Resolve the path to the Verse8 token file, honoring XDG_CONFIG_HOME.
 */
export function getConfigTokenPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "verse8", "token");
}

/** Path of the project-folder token file for `cwd`. */
export function getProjectTokenPath(cwd: string): string {
  return path.join(cwd, ".verse8", "token");
}

/**
 * Per-process set of token paths we have already warned about. Prevents
 * stderr spam: every loadToken() call must not re-emit the mode warning
 * for the same file. Cleared on process exit (no IPC).
 */
const warnedPaths = new Set<string>();

/**
 * On POSIX, the token file should be mode 0600 (owner read/write only).
 * On Windows, POSIX mode bits are not meaningful, so the check is skipped.
 * Warning is best-effort and never refuses the read — it only nudges the
 * user to tighten permissions. (US-M0-7.)
 */
function warnOnLooseTokenMode(p: string): void {
  if (process.platform === "win32") return;
  if (warnedPaths.has(p)) return;
  let mode: number;
  try {
    mode = fs.statSync(p).mode & 0o777;
  } catch {
    return;
  }
  if (mode !== 0o600) {
    warnedPaths.add(p);
    process.stderr.write(
      `[verse8-token] WARNING: ${p} mode is 0${mode.toString(8)}; expected 0600. ` +
        `Tighten with: chmod 600 "${p}"\n`,
    );
  }
}

/** Where the token in use came from. */
export type TokenSource = "env" | "project" | "config";

/** Why a project-folder token file was not read. */
export type ProjectTokenRefusal = "symlink" | "not_a_file" | "git_tracked" | "git_check_failed";

export interface RefusedProjectToken {
  path: string;
  reason: ProjectTokenRefusal;
}

/**
 * The one answer to "which token is in use and where did it come from".
 * verse8_status, the rejected-token hints and verse8_logout all read this.
 * `token` is the secret itself — never copy it into a tool result or a log;
 * `source` / `path` / `refusedProjectToken` are safe to show.
 */
export interface TokenResolution {
  token: string | null;
  source: TokenSource | null;
  /** The file the token was read from (`project` and `config` only). */
  path?: string;
  /** A project-folder token file that exists but was not read. */
  refusedProjectToken?: RefusedProjectToken;
}

export type ProjectTokenState =
  | { state: "absent"; path: string }
  | { state: "refused"; path: string; reason: ProjectTokenRefusal }
  | { state: "usable"; path: string; value: string };

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Is `.verse8/token` tracked by the git repo around `cwd`? A tracked token
 * file arrived with a clone or would leave with a push, so it is somebody
 * else's login or about to become public. `null` = git could not answer.
 */
function isTrackedByGit(cwd: string): boolean | null {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", ".verse8/token"], {
    cwd,
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
    env: sanitizeChildEnv(),
  });
  if (r.error || r.status === null) return null;
  // 0 = tracked; 1 = not tracked; 128 = not a git repository.
  return r.status === 0;
}

/**
 * Look at `<cwd>/.verse8/token` without trusting it.
 *
 * INV-16: The project token file is never read through a link or from git
 */
export function inspectProjectToken(cwd: string): ProjectTokenState {
  const dir = path.join(cwd, ".verse8");
  const p = getProjectTokenPath(cwd);

  const dirStat = lstatOrNull(dir);
  if (!dirStat) return { state: "absent", path: p };
  // lstat reports Windows junctions as symbolic links too.
  if (dirStat.isSymbolicLink()) return { state: "refused", path: p, reason: "symlink" };

  const fileStat = lstatOrNull(p);
  if (!fileStat) return { state: "absent", path: p };
  if (fileStat.isSymbolicLink()) return { state: "refused", path: p, reason: "symlink" };
  if (!fileStat.isFile()) return { state: "refused", path: p, reason: "not_a_file" };

  const tracked = isTrackedByGit(cwd);
  if (tracked === null) return { state: "refused", path: p, reason: "git_check_failed" };
  if (tracked) return { state: "refused", path: p, reason: "git_tracked" };

  let value: string;
  try {
    // O_NOFOLLOW (POSIX only) closes the gap between the lstat above and
    // this open: a file swapped for a link in between fails instead of
    // being followed.
    const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      value = fs.readFileSync(fd, "utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { state: "absent", path: p };
  }
  if (value.length === 0) return { state: "absent", path: p };
  warnOnLooseTokenMode(p);
  return { state: "usable", path: p, value };
}

function readConfigToken(): { path: string; value: string } | null {
  const p = getConfigTokenPath();
  try {
    if (!fs.existsSync(p)) return null;
    warnOnLooseTokenMode(p);
    const value = fs.readFileSync(p, "utf8").trim();
    return value.length > 0 ? { path: p, value } : null;
  } catch {
    return null;
  }
}

/**
 * Find the Verse8 access token using the documented priority:
 *   1. VERSE8_ACCESS_TOKEN env
 *   2. <cwd>/.verse8/token — only a regular, untracked file (see
 *      inspectProjectToken); a refused file is reported and skipped
 *   3. ${XDG_CONFIG_HOME or ~/.config}/verse8/token
 *
 * Trims trailing whitespace/newlines. Has no side effect on the hint state
 * (see loadToken).
 */
export function resolveToken(cwd: string = process.cwd()): TokenResolution {
  const envToken = process.env.VERSE8_ACCESS_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return { token: envToken.trim(), source: "env" };
  }

  const project = inspectProjectToken(cwd);
  if (project.state === "usable") {
    return { token: project.value, source: "project", path: project.path };
  }
  const refusedProjectToken =
    project.state === "refused" ? { path: project.path, reason: project.reason } : undefined;

  const config = readConfigToken();
  if (config) {
    return { token: config.value, source: "config", path: config.path, refusedProjectToken };
  }
  return { token: null, source: null, refusedProjectToken };
}

/**
 * Where the token most recently handed to a tool came from. Tools that turn
 * an upstream 401 into a hint far from where they loaded the token
 * (`apiFail`, the gameserver gateway) read it through
 * `rejectedTokenHintForLastLoad`. Never holds the token itself.
 */
let lastLoaded: Omit<TokenResolution, "token"> = { source: null };

/**
 * Load the Verse8 access token for a tool call. Returns null if no token is
 * available. Same priority and refusals as resolveToken, and remembers the
 * source for `rejectedTokenHintForLastLoad`.
 */
export function loadToken(cwd: string = process.cwd()): string | null {
  const { token, ...where } = resolveToken(cwd);
  lastLoaded = where;
  return token;
}

const REFUSAL_TEXT: Record<ProjectTokenRefusal, string> = {
  symlink: "it is (or sits behind) a link, and token files are not read through links",
  not_a_file: "it is not a regular file",
  git_tracked:
    "git tracks it, so it came with the repository or would be pushed with it (remove it with `git rm --cached .verse8/token` and delete the file)",
  git_check_failed: "git could not be run to check that the file is untracked",
};

/** One sentence about a project-folder token file that was not read. */
export function refusedProjectTokenHint(r: RefusedProjectToken): string {
  return `The project token file ${r.path} was ignored: ${REFUSAL_TEXT[r.reason]}.`;
}

/**
 * What to do about a token the server rejected (HTTP 401), by source. A
 * fresh login only rewrites the config-folder file, so a stale env or
 * project token has to be cleared first or it keeps winning.
 */
export function rejectedTokenHint(where: Omit<TokenResolution, "token">): string {
  if (where.source === "env") {
    return (
      "The rejected token comes from the VERSE8_ACCESS_TOKEN environment variable, which is used before any token file — logging in again does not replace it. " +
      "Ask the user to remove (or update) VERSE8_ACCESS_TOKEN in the MCP server's env settings and restart the server. " +
      `Then, to log in: ${LOGIN_HINT}`
    );
  }
  if (where.source === "project") {
    return (
      `The rejected token comes from the project token file ${where.path}, which is used before the login token file — logging in again does not replace it. ` +
      `Call verse8_logout to delete it, then log in: ${LOGIN_HINT}`
    );
  }
  if (where.source === "config") {
    return `The rejected token comes from the login token file ${where.path}. To log in again: ${LOGIN_HINT}`;
  }
  return `To log in: ${LOGIN_HINT}`;
}

/** rejectedTokenHint for the token the last loadToken() call returned. */
export function rejectedTokenHintForLastLoad(): string {
  return rejectedTokenHint(lastLoaded);
}

/**
 * Test-only helper to reset the per-process warned-paths set. Lets unit
 * tests assert the warn-once behavior without process restart.
 */
export function _resetTokenWarnedPathsForTests(): void {
  warnedPaths.clear();
}
