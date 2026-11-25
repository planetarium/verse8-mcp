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

/** The project token file, relative to the project folder, as git writes it. */
export const PROJECT_TOKEN_REL_PATH = ".verse8/token";

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
export type ProjectTokenRefusal =
  /** The file or the `.verse8` folder is a link, or was swapped while being read. */
  | "symlink"
  | "not_a_file"
  /** The file or the `.verse8` folder is there but could not be examined or read. */
  | "unreadable"
  | "git_tracked"
  /** git could not be started (not installed, not on PATH) or timed out. */
  | "git_unavailable"
  /** git ran but failed for another reason than "this is not a repository". */
  | "git_check_failed";

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

/**
 * lstat that tells "nothing there" (`missing`) from "could not look"
 * (`error`). Only the first may be read as absent: a failed look is not
 * evidence that the path is harmless.
 */
function lstatStrict(p: string): fs.Stats | "missing" | "error" {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error";
  }
}

/**
 * The nearest folder, `start` or above, that holds a `.git` entry (folder or
 * file). A `.git` that cannot be examined counts as one: only a clean
 * "missing" says there is no repository there.
 */
function nearestGitEntryDir(start: string): string | null {
  let cur = start;
  for (;;) {
    if (lstatStrict(path.join(cur, ".git")) !== "missing") return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Env for the tracked-file check. Every inherited `GIT_*` variable is
 * dropped by one rule rather than a list: they can point git at another
 * repository or index (`GIT_DIR`, `GIT_INDEX_FILE`), change how the
 * pathspec is read (`GIT_LITERAL_PATHSPECS`), or inject config
 * (`GIT_CONFIG_*`), and each of those can turn "tracked" into "untracked".
 * If git then cannot work at all, the check fails and the file is refused.
 */
function gitCheckEnv(ceiling: string | null): NodeJS.ProcessEnv {
  const env = sanitizeChildEnv();
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key];
  }
  // Stop repository discovery at the nearest `.git`: when that one is
  // damaged, git must fail instead of silently answering for a repository
  // further up, where this file is merely "untracked".
  if (ceiling) env.GIT_CEILING_DIRECTORIES = ceiling;
  // The "not a git repository" answer is matched as text below.
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

type GitTrackedAnswer = "tracked" | "untracked" | "git_unavailable" | "git_check_failed";

/**
 * Is `.verse8/token` tracked by the git repo around `cwd`? A tracked token
 * file arrived with a clone or would leave with a push, so it is somebody
 * else's login or about to become public.
 *
 * Only two answers let the file through (`untracked`): the repository at
 * the nearest `.git` says the path is not in its index (exit 1), or git
 * says in so many words that `cwd` is not in a repository AND no `.git`
 * entry exists in `cwd` or above it. Every other failure — exit 128 for
 * dubious ownership, a corrupt index, a bad config, a damaged repository
 * (which git also calls "not a git repository"); git missing; a timeout —
 * refuses the file.
 */
function checkTrackedByGit(cwd: string): GitTrackedAnswer {
  let real: string;
  try {
    // git works from the physical folder; walk the same one.
    real = fs.realpathSync(cwd);
  } catch {
    return "git_check_failed";
  }
  const repoDir = nearestGitEntryDir(real);
  const above = repoDir ? path.dirname(repoDir) : null;
  const ceiling = above && above !== repoDir ? above.split(path.sep).join("/") : null;
  const r = spawnSync(
    "git",
    [
      // `:(icase)` below must be read as pathspec magic whatever the config.
      "--no-literal-pathspecs",
      "ls-files",
      "--error-unmatch",
      "--",
      // icase: on a case-insensitive filesystem `.verse8/Token` in the index
      // is this very file.
      ":(icase).verse8/token",
    ],
    {
      cwd: real,
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      env: gitCheckEnv(ceiling),
    },
  );
  if (r.error || r.status === null) return "git_unavailable";
  if (r.status === 0) return "tracked";
  if (r.status === 1) return "untracked";
  const saysNotARepo = /not a git repository/i.test(r.stderr ?? "");
  if (saysNotARepo && repoDir === null) return "untracked";
  return "git_check_failed";
}

/**
 * Look at `<cwd>/.verse8/token` without trusting it. Every check that
 * cannot be completed refuses the file; only a clean "nothing there" is
 * `absent`.
 *
 * INV-16: The project token file is never read through a link or from git
 */
export function inspectProjectToken(cwd: string): ProjectTokenState {
  const dir = path.join(cwd, ".verse8");
  const p = getProjectTokenPath(cwd);
  const refused = (reason: ProjectTokenRefusal): ProjectTokenState => ({ state: "refused", path: p, reason });

  const dirStat = lstatStrict(dir);
  if (dirStat === "missing") return { state: "absent", path: p };
  if (dirStat === "error") return refused("unreadable");
  // lstat reports Windows junctions as symbolic links too.
  if (dirStat.isSymbolicLink()) return refused("symlink");

  const fileStat = lstatStrict(p);
  if (fileStat === "missing") return { state: "absent", path: p };
  if (fileStat === "error") return refused("unreadable");
  if (fileStat.isSymbolicLink()) return refused("symlink");
  if (!fileStat.isFile()) return refused("not_a_file");

  const tracked = checkTrackedByGit(cwd);
  if (tracked === "tracked") return refused("git_tracked");
  if (tracked !== "untracked") return refused(tracked);

  let value: string;
  try {
    // O_NOFOLLOW (POSIX only) closes the gap between the lstat above and
    // this open: a file swapped for a link in between fails with ELOOP
    // instead of being followed.
    const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      // Where O_NOFOLLOW does not exist (Windows), the same swap shows up
      // as an open file that is not the one lstat examined.
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== fileStat.dev || opened.ino !== fileStat.ino) {
        return refused("symlink");
      }
      value = fs.readFileSync(fd, "utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Deleted since the lstat: nothing there. A link in its place: refused.
    if (code === "ENOENT") return { state: "absent", path: p };
    return refused(code === "ELOOP" ? "symlink" : "unreadable");
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
 * Trims trailing whitespace/newlines.
 */
export function resolveToken(cwd: string = process.cwd()): TokenResolution {
  const envToken = process.env.VERSE8_ACCESS_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return { token: envToken.trim(), source: "env" };
  }

  const project = inspectProjectToken(cwd);
  if (project.state === "usable") {
    projectDirsWithUsedToken.add(path.resolve(cwd));
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
 * Where a token came from, without the token: what a tool keeps next to the
 * token it resolved so that a later 401 hint names the right source.
 */
export type TokenWhere = Omit<TokenResolution, "token">;

/**
 * Project folders whose token file this server process has handed to a
 * tool. verse8_logout checks them all, so a logout called for one folder
 * does not report "logged out" while another folder's token is still live.
 * Holds folder paths only.
 */
const projectDirsWithUsedToken = new Set<string>();

/** Project folders (absolute) whose token file was used since the server started. */
export function listProjectDirsWithUsedToken(): string[] {
  return [...projectDirsWithUsedToken];
}

/** Forget a folder once its token file is gone. */
export function forgetProjectDirWithUsedToken(cwd: string): void {
  projectDirsWithUsedToken.delete(path.resolve(cwd));
}

/**
 * Load the Verse8 access token. Returns null if no token is available.
 * Same priority and refusals as resolveToken; a tool that may have to
 * explain a rejected token calls resolveToken instead and keeps the source.
 */
export function loadToken(cwd: string = process.cwd()): string | null {
  return resolveToken(cwd).token;
}

const REFUSAL_TEXT: Record<ProjectTokenRefusal, string> = {
  symlink: "it is (or sits behind) a link, and token files are not read through links",
  not_a_file: "it is not a regular file",
  git_tracked:
    "git tracks it, so it came with the repository or would be pushed with it (run `git rm --cached .verse8/token`, delete the file, and commit the removal with verse8_checkpoint)",
  unreadable: "it (or the .verse8 folder) could not be examined or read, so it could not be checked",
  git_unavailable:
    "git could not be started (not installed, not on PATH, or timed out), so the file could not be checked for being untracked",
  git_check_failed:
    "git failed in this folder for another reason than \"not a git repository\" (for example unsafe ownership or a damaged repository — run `git status` there to see it), so the file could not be checked for being untracked",
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
export function rejectedTokenHint(where: TokenWhere): string {
  if (where.source === "env") {
    return (
      "The rejected token comes from the VERSE8_ACCESS_TOKEN environment variable, which is used before any token file — logging in again does not replace it. " +
      "Ask the user to remove (or update) VERSE8_ACCESS_TOKEN in the MCP server's env settings and restart the server. " +
      `Then, to log in: ${LOGIN_HINT}`
    );
  }
  if (where.source === "project" && where.path) {
    return (
      `The rejected token comes from the project token file ${where.path}, which is used before the login token file — logging in again does not replace it. ` +
      `${logoutCallHint(where.path)} to delete it, then log in: ${LOGIN_HINT}`
    );
  }
  if (where.source === "config") {
    return `The rejected token comes from the login token file ${where.path}. To log in again: ${LOGIN_HINT}`;
  }
  return `To log in: ${LOGIN_HINT}`;
}

/**
 * "Call verse8_logout …" for one project token file. Always names the
 * project folder: without `projectDir` the tool looks in the MCP server's
 * working folder, which need not be the folder this token file is in.
 */
export function logoutCallHint(projectTokenPath: string): string {
  const projectDir = path.dirname(path.dirname(projectTokenPath));
  return `Call verse8_logout with projectDir ${JSON.stringify(projectDir)} (without projectDir it only looks in the MCP server's working folder)`;
}

/**
 * Test-only helper to reset the per-process warned-paths set. Lets unit
 * tests assert the warn-once behavior without process restart.
 */
export function _resetTokenWarnedPathsForTests(): void {
  warnedPaths.clear();
}
