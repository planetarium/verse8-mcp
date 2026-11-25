import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createProjectAccessToken,
  getProjectAccessToken,
  parseCloneCommand,
  tolerantJsonParse,
} from "../api/agent8Backend.js";
import { verifyToken } from "../api/v8MemeApi.js";
import { applyAttachmentArtifacts } from "./attach.js";
import { redactHead, safeHint, stripUrlCredentials } from "../util/redact.js";
import { creditSettingsUrl } from "../api/verse8Web.js";

/**
 * Shared "grant a project token → clone → attach" steps.
 *
 * Used by `verse8_new_project_confirm` (after the backend created the GitLab
 * project from a template) and `verse8_open_project` (an existing project
 * not cloned locally yet). Both tools go through these functions so the
 * backend response-shape tolerance and the clone guards live in one place.
 */

export function creditError(
  status: number,
  body: string,
): { ok: false; error: "insufficient_credits"; hint: string; status: number } {
  return {
    ok: false,
    error: "insufficient_credits",
    hint: `Insufficient credits. Please recharge at ${creditSettingsUrl()} before retrying.\n(HTTP ${status}: ${redactHead(body, 500)})`,
    status,
  };
}

export function isCreditInsufficientError(status: number, body: string): boolean {
  if (status === 402) return true;
  const lower = body.toLowerCase();
  const keywords = [
    "insufficient credit",
    "insufficient fund",
    "not enough credit",
    "not enough fund",
    "no credit",
    "no fund",
    "zero credit",
    "zero fund",
    "credit limit",
    "check your credit",
    "out of credit",
    "recharge",
    "top up",
    "top-up",
  ];
  return keywords.some((kw) => lower.includes(kw));
}

// The backend owns the per-project cap on active tokens (and puts the number
// in its own message); we only recognise its error code and say where the
// user can free a slot. There is deliberately no revoke call here: revoking
// breaks pushes from every other clone made with that token, and calling the
// backend's DELETE without a tokenId revokes them all.
const TOKEN_LIMIT_CODE = "TOKEN_LIMIT_EXCEEDED";
const TOKEN_LIMIT_HINT =
  "This project already has the maximum number of active access tokens. To free one: open this game in the Verse8 web editor, open the Git Clone menu, and Revoke a token that is no longer used, then retry. A revoked token stops every other folder cloned with it from pushing, so let the user choose which one to revoke. Do not call the revoke API yourself.";

function isTokenLimitExceeded(body: string): boolean {
  const parsed = tolerantJsonParse<{ error?: unknown; code?: unknown }>(body);
  if (parsed && typeof parsed === "object") {
    return parsed.error === TOKEN_LIMIT_CODE || parsed.code === TOKEN_LIMIT_CODE;
  }
  return body.includes(TOKEN_LIMIT_CODE);
}

export type GrantCloneAccessResult =
  | {
      ok: true;
      /**
       * Internal: carries the project token (the clone URL's userinfo). Pass
       * it to `cloneAndAttach` only; never put it in a tool result.
       */
      cloneCommand: string;
      /**
       * The backend's clone URL with userinfo removed, safe to return to the
       * agent. `null` when the backend sent none or it does not parse.
       */
      gitUrl: string | null;
      tokenExpiresAt?: string;
    }
  | {
      ok: false;
      error: "token_check_failed" | "token_grant_failed";
      hint: string;
      status: number;
    }
  | ReturnType<typeof creditError>;

/**
 * GET (existence check) then POST /api/gitlab/project-access-token for
 * `projectPath`, and resolve a usable `git clone` command from the response.
 * Backend errors (including a 403/404 for a project the user does not own)
 * are returned with their HTTP status and body head; only known secret
 * shapes in the body are redacted.
 */
export async function grantCloneAccess(
  projectPath: string,
  token: string,
): Promise<GrantCloneAccessResult> {
  const check = await getProjectAccessToken(projectPath, token);
  if (!check.ok) {
    if (isCreditInsufficientError(check.status, check.body)) {
      return creditError(check.status, check.body);
    }
    return {
      ok: false,
      error: "token_check_failed",
      hint: `GET /api/gitlab/project-access-token HTTP ${check.status}: ${redactHead(check.body, 500)}`,
      status: check.status,
    };
  }

  // The GET endpoint currently only reports PAT existence — it doesn't
  // hand back a usable cloneCommand — so we always POST to get the
  // token + clone URL. The hasToken bit is kept as an observable signal
  // for future plumbing; the behavioural path is the same today.
  const created = await createProjectAccessToken(projectPath, token);
  if (!created.ok) {
    if (isCreditInsufficientError(created.status, created.body)) {
      return creditError(created.status, created.body);
    }
    const base = `POST /api/gitlab/project-access-token HTTP ${created.status}: ${redactHead(created.body, 500)}`;
    return {
      ok: false,
      error: "token_grant_failed",
      hint: isTokenLimitExceeded(created.body) ? `${base}\n${TOKEN_LIMIT_HINT}` : base,
      status: created.status,
    };
  }

  // Response-shape tolerance:
  // The agent8-backend POST /api/gitlab/project-access-token response has
  // drifted across environments — we've seen `cloneCommand`/`gitUrl` at the
  // top level (camelCase), snake_case (`clone_command`/`git_url`), and
  // occasionally one layer of nesting (`{data: {...}}` or `{result: {...}}`).
  // Instead of pinning the parser to one shape, pick each field with
  // `pickString` which tries a small list of sensible paths and returns
  // the first non-empty string it finds.
  const rawClone = pickString(created.data, [
    "cloneCommand",
    "clone_command",
    "data.cloneCommand",
    "data.clone_command",
    "result.cloneCommand",
    "result.clone_command",
  ]);
  const rawGitUrl = pickString(created.data, [
    "gitUrl",
    "git_url",
    "cloneUrl",
    "clone_url",
    "data.gitUrl",
    "data.git_url",
    "result.gitUrl",
    "result.git_url",
  ]);
  const rawExpiresAt = pickString(created.data, [
    "expiresAt",
    "expires_at",
    "data.expiresAt",
    "data.expires_at",
  ]);

  let cloneCommand = "";
  if (rawClone) {
    cloneCommand = rawClone;
  } else if (rawGitUrl) {
    // Synthesize from gitUrl — covers "backend re-issue" path (hasToken true
    // returns token + gitUrl but no pre-formatted cloneCommand) AND any
    // environment where the server just stopped emitting cloneCommand.
    const synthesizedSlug =
      projectPath.split("/").filter(Boolean).pop() ?? "repo";
    cloneCommand = `git clone -b develop ${rawGitUrl} ${synthesizedSlug}`;
  } else {
    // Still no URL anywhere — surface the available keys in the hint so a
    // follow-up session can narrow the schema drift. Key names only: this is
    // a successful grant, so the body holds the token that was just minted.
    // INV-13: no body values in this hint.
    return {
      ok: false,
      error: "token_grant_failed",
      hint: `POST /api/gitlab/project-access-token HTTP ${created.status}: response body carries neither cloneCommand/clone_command nor gitUrl/git_url at any known path. Observed top-level keys: ${describeKeys(created.data)}.`,
      status: created.status,
    };
  }

  return {
    ok: true,
    cloneCommand,
    // INV-15: the clone URL's userinfo is the project token.
    gitUrl: stripUrlCredentials(rawGitUrl),
    tokenExpiresAt: rawExpiresAt ?? undefined,
  };
}

export interface CloneAndAttachParams {
  projectPath: string;
  /** Written to `.verse8/project.json`; `undefined` → the marker's default. */
  projectId: string | undefined;
  cloneCommand: string;
  /** Absolute directory the repo is cloned into (as `<parentDir>/<slug>`). */
  parentDir: string;
  /** Verse8 access token — used only for the best-effort wallet lookup. */
  token: string;
}

export type CloneAndAttachResult =
  | { ok: true; projectDir: string; branch: string }
  | {
      ok: false;
      error: "invalid_parent";
      hint: string;
      projectPath?: string;
    }
  | {
      ok: false;
      error: "clone_target_exists";
      hint: string;
      projectPath: string;
    }
  | {
      ok: false;
      error: "clone_parse_failed" | "clone_failed" | "attach_failed";
      hint: string;
      projectPath?: string;
    };

/**
 * Clone `cloneCommand` under `parentDir` and install the verse8 attachment
 * artifacts (hooks, AGENTS.md, skills, marker, .env). Never overwrites an
 * existing directory.
 */
export async function cloneAndAttach(
  params: CloneAndAttachParams,
): Promise<CloneAndAttachResult> {
  const { projectPath, parentDir } = params;

  // Symlink-parent guard (US-M0-5). Reject when any non-realpath segment
  // of `parentDir` is a symlink, because cloning into a symlinked
  // directory tree is a TOCTOU vector — between resolution and
  // `git clone`, the symlink target could be swapped to point at a
  // sensitive location. macOS `/tmp → /private/tmp` is a legitimate OS-
  // canonical equivalence and is allowed by re-validating the resolved
  // path is itself traversal-free.
  const parentGuard = checkParentDirSafe(parentDir);
  if (!parentGuard.ok) {
    return {
      ok: false,
      error: "invalid_parent",
      hint: parentGuard.hint,
      projectPath,
    };
  }

  let parsed;
  try {
    parsed = parseCloneCommand(params.cloneCommand);
  } catch (e) {
    // parseCloneCommand already calls truncate() which redacts glpat-*,
    // but defense-in-depth: run safeHint here too so any future
    // code path that bypasses truncate still cannot leak the PAT.
    return {
      ok: false,
      error: "clone_parse_failed",
      hint: safeHint((e as Error).message),
      projectPath,
    };
  }

  // Path-traversal guard: parsed.slug is a token from the backend's
  // cloneCommand. A hostile or buggy backend could return "..", "/",
  // "../../etc", etc. Reject anything that isn't a plain directory
  // name. parentDir is our trust boundary; the join must stay under it.
  if (
    parsed.slug.length === 0 ||
    parsed.slug === "." ||
    parsed.slug === ".." ||
    parsed.slug.includes("/") ||
    parsed.slug.includes("\\") ||
    parsed.slug.includes("\0")
  ) {
    return {
      ok: false,
      error: "clone_parse_failed",
      hint: `cloneCommand slug is not a safe directory name: ${JSON.stringify(parsed.slug)}`,
      projectPath,
    };
  }

  const projectDir = path.join(parentDir, parsed.slug);
  if (fs.existsSync(projectDir)) {
    return {
      ok: false,
      error: "clone_target_exists",
      hint: `${projectDir} already exists; delete it or pass a different targetDir.`,
      projectPath,
    };
  }

  try {
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch {
      /* parent exists or unreachable — let git clone surface the real error */
    }
    execFileSync(
      "git",
      [
        "clone",
        // INV-1: Token never hits a shell
        ...parsed.passthroughFlags,
        "-b",
        parsed.branch,
        parsed.url,
        parsed.slug,
      ],
      {
        cwd: parentDir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    return {
      ok: false,
      error: "clone_failed",
      hint: safeHint((e as Error).message),
      projectPath,
    };
  }

  // Best-effort walletAddress lookup so the freshly-cloned project gets
  // a populated .env (VITE_AGENT8_ACCOUNT / VITE_AGENT8_VERSE). A failed
  // lookup degrades to skipped-not-logged-in in the env result envelope;
  // it never blocks attach.
  let walletAddress: string | null = null;
  try {
    const v = await verifyToken(params.token);
    if (v.ok && typeof v.profile.walletAddress === "string") {
      walletAddress = v.profile.walletAddress;
    }
  } catch {
    /* best-effort */
  }

  try {
    applyAttachmentArtifacts(projectDir, {
      overwrite: false,
      projectId: params.projectId,
      walletAddress,
    });
  } catch (e) {
    // Defense-in-depth: applyAttachmentArtifacts touches filesystem paths
    // that may include the freshly-resolved projectDir. Route through
    // safeHint so any future write that surfaces a tokenized URL or
    // path can't leak. (Architect review note 2.)
    return {
      ok: false,
      error: "attach_failed",
      hint: safeHint((e as Error).message),
      projectPath,
    };
  }

  return { ok: true, projectDir, branch: parsed.branch };
}

export type CloneTargetCheckResult =
  | { ok: true }
  | { ok: false; error: "invalid_parent" | "missing_git"; hint: string };

/**
 * Local checks that must pass BEFORE a project token is requested (or, for
 * new-project, before the GitLab project is created): every request mints a
 * fresh 30-day token and the backend caps the active tokens per project, so
 * a clone that is bound to fail locally must not spend one.
 *
 * Checks: the symlink-parent guard; the nearest existing component of
 * `parentDir` is a directory (not a file) and writable, so `mkdir -p` and
 * `git clone` can create the folder; `git` runs.
 */
export function checkCloneTargetLocal(parentDir: string): CloneTargetCheckResult {
  const guard = checkParentDirSafe(parentDir);
  if (!guard.ok) return { ok: false, error: "invalid_parent", hint: guard.hint };

  let cur = parentDir;
  for (;;) {
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return {
          ok: false,
          error: "invalid_parent",
          hint: safeHint(`cannot inspect ${cur}: ${(e as Error).message}`),
        };
      }
    }
    if (st) {
      if (!st.isDirectory()) {
        return {
          ok: false,
          error: "invalid_parent",
          hint: `${cur} exists and is not a directory, so nothing can be cloned under ${parentDir}. Pass a targetDir that is (or can be created as) a folder.`,
        };
      }
      try {
        fs.accessSync(cur, fs.constants.W_OK);
      } catch {
        return {
          ok: false,
          error: "invalid_parent",
          hint: `${cur} is not writable, so nothing can be cloned under ${parentDir}. Pass a targetDir you can write to.`,
        };
      }
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }

  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    return {
      ok: false,
      error: "missing_git",
      hint: "`git` could not be run (not installed or not on PATH). Install git, then retry.",
    };
  }
  return { ok: true };
}

/**
 * Verify that `parentDir` and every existing ancestor segment is either a
 * regular directory or a symlink whose realpath has the same effective
 * meaning (e.g. macOS `/tmp` → `/private/tmp`). Returns `{ok:true}` when
 * the path is safe to clone into, `{ok:false, hint}` when a non-canonical
 * symlink is detected. Non-existent ancestor segments are ignored —
 * `mkdirSync(..., {recursive:true})` will create them later.
 *
 * (US-M0-5.)
 */
export function checkParentDirSafe(
  parentDir: string,
): { ok: true } | { ok: false; hint: string } {
  if (typeof parentDir !== "string" || parentDir.length === 0) {
    return { ok: false, hint: "parentDir is empty" };
  }
  let realParent: string = parentDir;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    // parentDir doesn't fully exist yet — walk up to the deepest existing
    // ancestor and treat that as the canonicalization target.
    let cur = parentDir;
    while (cur !== path.dirname(cur)) {
      cur = path.dirname(cur);
      try {
        realParent = fs.realpathSync(cur);
        break;
      } catch {
        /* keep walking */
      }
    }
  }

  // The realpath must itself be traversal-free (defence-in-depth even
  // though zod refines `targetDir` at the dispatch boundary). Any
  // ".." segments in the resolved path indicate the resolution went
  // somewhere unexpected.
  if (realParent.split(path.sep).includes("..")) {
    return {
      ok: false,
      hint: safeHint(`resolved parentDir contains '..' after realpath: ${realParent}`),
    };
  }

  let cursor = parentDir;
  const segments: string[] = [];
  while (cursor !== path.dirname(cursor)) {
    segments.unshift(cursor);
    cursor = path.dirname(cursor);
  }
  for (const seg of segments) {
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(seg);
    } catch {
      // Segment doesn't exist — `mkdirSync` will create it; nothing to check.
      continue;
    }
    if (!lstat.isSymbolicLink()) continue;
    let segReal: string;
    try {
      segReal = fs.realpathSync(seg);
    } catch (e) {
      return {
        ok: false,
        hint: safeHint(`symlink at ${seg} could not be resolved: ${(e as Error).message}`),
      };
    }
    let segRealStat: fs.Stats;
    try {
      segRealStat = fs.statSync(segReal);
    } catch (e) {
      return {
        ok: false,
        hint: safeHint(`symlink target at ${seg} → ${segReal} is not accessible: ${(e as Error).message}`),
      };
    }
    if (!segRealStat.isDirectory()) {
      return {
        ok: false,
        hint: safeHint(`symlink at ${seg} resolves to a non-directory: ${segReal}`),
      };
    }
    if (segReal.split(path.sep).includes("..")) {
      return {
        ok: false,
        hint: safeHint(`symlink at ${seg} resolves to a path with '..': ${segReal}`),
      };
    }
  }

  return { ok: true };
}

/**
 * Resolve the first non-empty string value found at any of the given dotted
 * paths. Used to read response fields tolerantly across camelCase vs
 * snake_case vs one-level-nested ("data.foo", "result.foo") variants so a
 * backend response-shape drift doesn't turn a recoverable success into a
 * structural failure.
 *
 * Returns `undefined` when no path resolves to a non-empty string; the
 * caller decides whether that's a real failure or a synthesis opportunity.
 */
export function pickString(obj: unknown, paths: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const p of paths) {
    let cursor: unknown = obj;
    for (const seg of p.split(".")) {
      if (cursor && typeof cursor === "object" && seg in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[seg];
      } else {
        cursor = undefined;
        break;
      }
    }
    if (typeof cursor === "string" && cursor.trim().length > 0) {
      return cursor;
    }
  }
  return undefined;
}

/** Diagnostic helper — comma-joined list of the top-level keys of an
 * object-shaped response, or a parenthesized type name for non-objects. */
function describeKeys(obj: unknown): string {
  if (obj === null) return "(null)";
  if (obj === undefined) return "(undefined)";
  if (typeof obj !== "object") return `(${typeof obj})`;
  const keys = Object.keys(obj as Record<string, unknown>);
  return keys.length === 0 ? "(empty)" : keys.join(",");
}
