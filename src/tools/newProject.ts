import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import {
  selectTemplate,
  startCall,
  type StartCallBody,
} from "../api/agent8Backend.js";
import { loadToken } from "../context/token.js";
import { isSafeAbsPath } from "../util/safePath.js";
import { redactHead } from "../util/redact.js";
import { LOGIN_HINT } from "../util/hints.js";
import {
  checkCloneTargetLocal,
  cloneAndAttach,
  creditError,
  grantCloneAccess,
  isCreditInsufficientError,
} from "./projectClone.js";

/**
 * `verse8_new_project_{start,confirm}` — two-phase project-creation flow.
 *
 * `start` wraps `/api/startcall` and returns a template proposal for the user
 * to review. `confirm` runs `/api/select-template` → token-check / grant →
 * `git clone` → `applyAttachmentArtifacts`, producing a fully attached verse8
 * project on disk.
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
  | ReturnType<typeof creditError>;

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
  | ReturnType<typeof creditError>
  | {
      ok: false;
      error: "invalid_parent" | "missing_git";
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
      hint: LOGIN_HINT,
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
      return creditError(resp.status, resp.body);
    }
    return {
      ok: false,
      error: "startcall_failed",
      hint: `POST /api/startcall HTTP ${resp.status}: ${redactHead(resp.body, 500)}`,
      status: resp.status,
    };
  }

  const body = resp.data;
  const template = body.template;
  if (!template || typeof template.name !== "string") {
    return {
      ok: false,
      error: "startcall_failed",
      // INV-13: a 2xx body can carry secrets; redact before the cut.
      hint: `startcall response missing template.name: ${redactHead(JSON.stringify(body), 500)}`,
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
      hint: `startcall template missing githubRepo or path: ${redactHead(JSON.stringify(template), 500)}`,
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
      hint: LOGIN_HINT,
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
    // Local checks first: a target that cannot be cloned into must fail
    // before the backend creates the GitLab project and mints a token.
    const parentDir = path.resolve(input.targetDir ?? cwd);
    const local = checkCloneTargetLocal(parentDir);
    if (!local.ok) {
      return input.projectPath !== undefined
        ? { ...local, projectPath: input.projectPath }
        : local;
    }

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
          return creditError(selected.status, selected.body);
        }
        return {
          ok: false,
          error: "select_template_failed",
          hint: `GET /api/select-template HTTP ${selected.status}: ${redactHead(selected.body, 500)}`,
          status: selected.status,
        };
      }
      const project = selected.data.project;
      if (!project || typeof project.path !== "string" || project.path.length === 0) {
        return {
          ok: false,
          error: "select_template_failed",
          hint: `select-template response missing project.path: ${redactHead(JSON.stringify(selected.data), 500)}`,
          status: selected.status,
        };
      }
      projectPath = project.path;
      projectId = String(project.id ?? "unknown");
    }

    const access = await grantCloneAccess(projectPath, token);
    if (!access.ok) return access;

    const cloned = await cloneAndAttach({
      projectPath,
      projectId,
      cloneCommand: access.cloneCommand,
      parentDir,
      token,
    });
    if (!cloned.ok) return cloned;

    return {
      ok: true,
      projectDir: cloned.projectDir,
      projectId,
      projectPath,
      gitUrl: access.gitUrl ?? "",
      branch: cloned.branch,
      tokenExpiresAt: access.tokenExpiresAt,
      nextCallRequires: { projectDir: cloned.projectDir },
    };
  } finally {
    inFlightConfirms.delete(concurrencyKey);
  }
}
