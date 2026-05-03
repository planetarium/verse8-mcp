import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  createProjectAccessToken,
  getProjectAccessToken,
  parseCloneCommand,
  selectTemplate,
  startCall,
  type StartCallBody,
} from "../api/agent8Backend.js";
import { loadToken } from "../context/token.js";
import { verifyToken } from "../api/v8MemeApi.js";
import { applyAttachmentArtifacts } from "./attach.js";
import { safeHint } from "../util/redact.js";
import { isSafeAbsPath } from "../util/safePath.js";

/**
 * `verse8_new_project_{start,confirm}` — two-phase project-creation flow.
 *
 * `start` wraps `/api/startcall` and returns a template proposal for the user
 * to review. `confirm` runs `/api/select-template` → token-check / grant →
 * `git clone` → `applyAttachmentArtifacts`, producing a fully attached verse8
 * project on disk.
 *
 * See `.omc/plans/case2-new-project-flow.md` for the consensus design (the
 * plan was Architect + Critic reviewed over 2 iterations; all 14 ACs are
 * covered by the unit / smoke suites).
 */

export const newProjectStartInputSchema = z
  .object({
    userRequest: z.string().min(1),
  })
  .strict();

export type NewProjectStartInput = z.infer<typeof newProjectStartInputSchema>;

export const newProjectConfirmInputSchema = z
  .object({
    templateName: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().min(1),
    title: z.string().min(1),
    projectRepo: z.string().min(1),
    targetDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "targetDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
      })
      .optional(),
    projectPath: z.string().min(1).optional(),
    startCallId: z.string().min(1).optional(),
  })
  .strict();

export type NewProjectConfirmInput = z.infer<
  typeof newProjectConfirmInputSchema
>;

const CREDIT_RECHARGE_URL = "https://verse8.io/settings";

function isCreditInsufficientError(status: number, body: string): boolean {
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

export type NewProjectStartResult =
  | {
      ok: true;
      startCallId: string;
      templateName: string;
      template: StartCallBody["template"];
      repo: string;
      path: string;
      suggestedTitle: string;
      suggestedProjectRepo: string;
      nextActionSuggestion?: string;
    }
  | { ok: false; error: "not_logged_in"; hint: string }
  | { ok: false; error: "rate_limited"; hint: string; retryAfterMs: number }
  | {
      ok: false;
      error: "startcall_failed";
      hint: string;
      status: number;
    }
  | {
      ok: false;
      error: "insufficient_credits";
      hint: string;
      status: number;
    };

export type NewProjectConfirmResult =
  | {
      ok: true;
      projectDir: string;
      projectId: string;
      projectPath: string;
      gitUrl: string;
      branch: string;
      tokenExpiresAt?: string;
      nextCallRequires: { projectDir: string };
    }
  | { ok: false; error: "not_logged_in"; hint: string }
  | { ok: false; error: "template_mismatch"; hint: string }
  | { ok: false; error: "confirm_in_flight"; hint: string }
  | {
      ok: false;
      error:
        | "select_template_failed"
        | "token_check_failed"
        | "token_grant_failed";
      hint: string;
      status: number;
    }
  | {
      ok: false;
      error: "insufficient_credits";
      hint: string;
      status: number;
    }
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

interface StartCallMemoEntry {
  digest: string;
  createdAt: number;
}

const START_CALL_MEMO_CAP = 50;
const startCallMemo = new Map<string, StartCallMemoEntry>();

function memoizeStartCall(id: string, digest: string): void {
  // FIFO eviction — Map iteration order is insertion order.
  while (startCallMemo.size >= START_CALL_MEMO_CAP) {
    const firstKey = startCallMemo.keys().next().value;
    if (firstKey === undefined) break;
    startCallMemo.delete(firstKey);
  }
  startCallMemo.set(id, { digest, createdAt: Date.now() });
}

function digestFor(templateName: string, repo: string, path: string): string {
  return createHash("sha256")
    .update(`${templateName}\n${repo}\n${path}`)
    .digest("hex");
}

function generateStartCallId(): string {
  return `scid_${randomBytes(16).toString("hex")}`;
}

const inFlightConfirms = new Set<string>();

// Process-local rolling-window rate-limit for runNewProjectStart. Per
// Principle 6 this is best-effort — restart wipes the window. The window
// length defaults to 60s and the cap defaults to 5 calls; a test-only env
// `VERSE8_RATE_WINDOW_MS` overrides the window so unit tests don't have to
// wait 60s. (US-M2-4.)
const RATE_LIMIT_MAX = 5;
const startCallTimestamps: number[] = [];

function rateLimitWindowMs(): number {
  const env = process.env.VERSE8_RATE_WINDOW_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60_000;
}

/** Test-only helper to reset process-local state between cases. */
export function _resetNewProjectStateForTests(): void {
  startCallMemo.clear();
  inFlightConfirms.clear();
  startCallTimestamps.length = 0;
}

export async function runNewProjectStart(
  input: NewProjectStartInput,
  cwd: string = process.cwd(),
): Promise<NewProjectStartResult> {
  const token = loadToken(cwd);
  if (!token) {
    return {
      ok: false,
      error: "not_logged_in",
      hint: "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
    };
  }

  // Rolling-window rate-limit (best-effort, process-local). (US-M2-4.)
  const now = Date.now();
  const windowMs = rateLimitWindowMs();
  while (startCallTimestamps.length > 0 && startCallTimestamps[0] <= now - windowMs) {
    startCallTimestamps.shift();
  }
  if (startCallTimestamps.length >= RATE_LIMIT_MAX) {
    const oldest = startCallTimestamps[0];
    const retryAfterMs = Math.max(1, oldest + windowMs - now);
    return {
      ok: false,
      error: "rate_limited",
      hint: `verse8_new_project_start rate limit: max ${RATE_LIMIT_MAX} calls per ${windowMs}ms (process-local; resets on MCP server restart). Retry in ~${retryAfterMs}ms.`,
      retryAfterMs,
    };
  }
  startCallTimestamps.push(now);

  const resp = await startCall(input.userRequest, token);
  if (!resp.ok) {
    if (isCreditInsufficientError(resp.status, resp.body)) {
      return {
        ok: false,
        error: "insufficient_credits",
        hint: `Insufficient credits. Please recharge at ${CREDIT_RECHARGE_URL} before retrying.\n(HTTP ${resp.status}: ${resp.body.slice(0, 500)})`,
        status: resp.status,
      };
    }
    return {
      ok: false,
      error: "startcall_failed",
      hint: `POST /api/startcall HTTP ${resp.status}: ${resp.body.slice(0, 500)}`,
      status: resp.status,
    };
  }

  const body = resp.data;
  const template = body.template;
  if (!template || typeof template.name !== "string") {
    return {
      ok: false,
      error: "startcall_failed",
      hint: `startcall response missing template.name: ${JSON.stringify(body).slice(0, 500)}`,
      status: resp.status,
    };
  }

  const templateName = body.templateName ?? template.name;
  const repo =
    typeof template.githubRepo === "string" && template.githubRepo.length > 0
      ? template.githubRepo
      : "";
  const repoPath =
    typeof template.path === "string" && template.path.length > 0
      ? template.path
      : "";
  if (!repo || !repoPath) {
    return {
      ok: false,
      error: "startcall_failed",
      hint: `startcall template missing githubRepo or path: ${JSON.stringify(template).slice(0, 500)}`,
      status: resp.status,
    };
  }

  const startCallId = generateStartCallId();
  memoizeStartCall(startCallId, digestFor(templateName, repo, repoPath));

  return {
    ok: true,
    startCallId,
    templateName,
    template,
    repo,
    path: repoPath,
    suggestedTitle: body.title ?? "",
    suggestedProjectRepo: body.projectRepo ?? "",
    nextActionSuggestion: body.nextActionSuggestion,
  };
}

export async function runNewProjectConfirm(
  input: NewProjectConfirmInput,
  cwd: string = process.cwd(),
): Promise<NewProjectConfirmResult> {
  // 1. startCallId digest guardrail — runs BEFORE any HTTP call so a drifted
  //    templateName can never leak into a real project creation.
  if (input.startCallId !== undefined) {
    const memo = startCallMemo.get(input.startCallId);
    if (!memo) {
      return {
        ok: false,
        error: "template_mismatch",
        hint: "startCallId is unknown to this MCP process. The MCP server may have restarted mid-flow (the startCallId memo is process-local). Recovery: re-run verse8_new_project_start and pass the freshly-issued startCallId.",
      };
    }
    const expected = digestFor(input.templateName, input.repo, input.path);
    if (memo.digest !== expected) {
      return {
        ok: false,
        error: "template_mismatch",
        hint: "templateName/repo/path do not match the proposal returned by verse8_new_project_start for this startCallId. Do not invent these values — copy them verbatim from the start response. If the values look correct, the MCP server may have restarted; re-run verse8_new_project_start to obtain a fresh startCallId.",
      };
    }
  }

  const token = loadToken(cwd);
  if (!token) {
    return {
      ok: false,
      error: "not_logged_in",
      hint: "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
    };
  }

  const concurrencyKey =
    input.projectPath ?? `${input.startCallId ?? "anon"}::${input.templateName}`;
  if (inFlightConfirms.has(concurrencyKey)) {
    return {
      ok: false,
      error: "confirm_in_flight",
      hint: "a previous verse8_new_project_confirm is still running for this project. Wait for it to finish before retrying.",
    };
  }
  inFlightConfirms.add(concurrencyKey);

  try {
    let projectPath: string;
    let projectId: string;

    if (input.projectPath !== undefined) {
      // Retry path — caller echoes back the projectPath from a prior
      // partial-failure envelope. Skip select-template to avoid creating
      // a duplicate timestamped GitLab repo.
      projectPath = input.projectPath;
      projectId = "unknown";
    } else {
      const selected = await selectTemplate(
        {
          templateName: input.templateName,
          repo: input.repo,
          path: input.path,
          title: input.title,
          projectRepo: input.projectRepo,
        },
        token,
      );
      if (!selected.ok) {
        if (isCreditInsufficientError(selected.status, selected.body)) {
          return {
            ok: false,
            error: "insufficient_credits",
            hint: `Insufficient credits. Please recharge at ${CREDIT_RECHARGE_URL} before retrying.\n(HTTP ${selected.status}: ${selected.body.slice(0, 500)})`,
            status: selected.status,
          };
        }
        return {
          ok: false,
          error: "select_template_failed",
          hint: `GET /api/select-template HTTP ${selected.status}: ${selected.body.slice(0, 500)}`,
          status: selected.status,
        };
      }
      const project = selected.data.project;
      if (!project || typeof project.path !== "string" || project.path.length === 0) {
        return {
          ok: false,
          error: "select_template_failed",
          hint: `select-template response missing project.path: ${JSON.stringify(selected.data).slice(0, 500)}`,
          status: selected.status,
        };
      }
      projectPath = project.path;
      projectId = String(project.id ?? "unknown");
    }

    const check = await getProjectAccessToken(projectPath, token);
    if (!check.ok) {
        if (isCreditInsufficientError(check.status, check.body)) {
          return {
            ok: false,
            error: "insufficient_credits",
            hint: `Insufficient credits. Please recharge at ${CREDIT_RECHARGE_URL} before retrying.\n(HTTP ${check.status}: ${check.body.slice(0, 500)})`,
            status: check.status,
          };
        }
        return {
          ok: false,
          error: "token_check_failed",
          hint: `GET /api/gitlab/project-access-token HTTP ${check.status}: ${check.body.slice(0, 500)}`,
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
          return {
            ok: false,
            error: "insufficient_credits",
            hint: `Insufficient credits. Please recharge at ${CREDIT_RECHARGE_URL} before retrying.\n(HTTP ${created.status}: ${created.body.slice(0, 500)})`,
            status: created.status,
          };
        }
        return {
          ok: false,
          error: "token_grant_failed",
          hint: `POST /api/gitlab/project-access-token HTTP ${created.status}: ${created.body.slice(0, 500)}`,
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
      // follow-up session can narrow the schema drift without having to log
      // the full body separately.
      return {
        ok: false,
        error: "token_grant_failed",
        hint: `POST /api/gitlab/project-access-token HTTP ${created.status}: response body carries neither cloneCommand/clone_command nor gitUrl/git_url at any known path. Observed top-level keys: ${describeKeys(created.data)}. Body head: ${JSON.stringify(created.data).slice(0, 500)}`,
        status: created.status,
      };
    }
    const gitUrl: string | null = rawGitUrl ?? null;
    const tokenExpiresAt: string | undefined = rawExpiresAt ?? undefined;

    const parentDir = path.resolve(input.targetDir ?? cwd);

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
      parsed = parseCloneCommand(cloneCommand);
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
      const v = await verifyToken(token);
      if (v.ok && typeof v.profile.walletAddress === "string") {
        walletAddress = v.profile.walletAddress;
      }
    } catch {
      /* best-effort */
    }

    try {
      applyAttachmentArtifacts(projectDir, {
        overwrite: false,
        projectId,
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

    return {
      ok: true,
      projectDir,
      projectId,
      projectPath,
      gitUrl: gitUrl ?? "",
      branch: parsed.branch,
      tokenExpiresAt,
      nextCallRequires: { projectDir },
    };
  } finally {
    inFlightConfirms.delete(concurrencyKey);
  }
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
