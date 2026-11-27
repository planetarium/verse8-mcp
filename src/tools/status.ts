import { execFileSync } from "node:child_process";
import { z } from "zod";
import { verifyToken, type VerifyResponse } from "../api/v8MemeApi.js";
import { detectAttachment, type AttachmentState } from "../context/attachment.js";
import {
  refusedProjectTokenHint,
  rejectedTokenHint,
  resolveToken,
  type ProjectTokenRefusal,
  type TokenResolution,
  type TokenSource,
} from "../context/token.js";
import { detectVerseProject } from "../context/verseProject.js";
import { detectWorkspace } from "../context/workspace.js";
import { isSafeAbsPath } from "../util/safePath.js";
import { redactHead, safeErrorHint } from "../util/redact.js";
import { LOGIN_HINT } from "../util/hints.js";
import { isLoopbackPortInUseSync } from "../util/loopback.js";
import { resetProxyCaches } from "../proxy/forward.js";
import { resolveMcpServices, type ResolutionSource } from "../proxy/registry.js";
import { creditSettingsUrl } from "../api/verse8Web.js";
import {
  computeBootstrapWorkflow,
  type BootstrapWorkflow,
} from "./bootstrap.js";

export const statusInputSchema = z
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
        "Absolute path to the verse8 project directory. Pass it when the project lives in a subdirectory of the MCP server's cwd (same as verse8_checkpoint / verse8_preview). If omitted, process.cwd() is used.",
      ),
  })
  .strict();

export type StatusInput = z.infer<typeof statusInputSchema>;

export interface ProjectStatus {
  isVerse: boolean;
  attached: boolean;
  projectDir: string;
  gitlabRemote?: string;
  projectId?: string;
  missing?: string[];
  attachmentDetail?: AttachmentState["checks"];
  hint?: string;
  stalePreviewWarning?: {
    port: number;
    uncommittedFiles: number;
    message: string;
  };
  mcpProxies?: {
    enabled: string[];
    disabled: string[];
    source: ResolutionSource;
  };
}

function workingTreeDirtyCount(projectDir: string): number {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf8",
    });
    return out.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

const PREVIEW_PORTS = [5173, 5174, 5175, 4173]; // vite default + fallbacks

/** Where the token in use came from. Never carries the token itself. */
export interface TokenSourceInfo {
  source: TokenSource;
  /** The token file (`project` and `config`); absent for `env`. */
  path?: string;
}

/** A project-folder token file that exists but was not read. */
export interface ProjectTokenRefusedInfo {
  path: string;
  reason: ProjectTokenRefusal;
  hint: string;
}

export type StatusResult =
  | {
      ok: true;
      profile: VerifyResponse;
      project: ProjectStatus;
      /** Bootstrap state-machine routing — mirrors verse8_bootstrap's
       *  `workflow` shape so any agent that reaches for status first gets
       *  the same deterministic nextTool signal. */
      workflow: BootstrapWorkflow;
      warnings?: string[];
      tokenExpiresAt?: string;
      tokenSource: TokenSourceInfo;
      projectTokenRefused?: ProjectTokenRefusedInfo;
      creditRechargeUrl: string;
    }
  | {
      ok: false;
      error: "not_logged_in";
      hint: string;
      project?: ProjectStatus;
      projectTokenRefused?: ProjectTokenRefusedInfo;
      workflow: BootstrapWorkflow;
    }
  | {
      ok: false;
      error: "token_invalid";
      hint: string;
      status: number;
      tokenSource: TokenSourceInfo;
      project?: ProjectStatus;
      projectTokenRefused?: ProjectTokenRefusedInfo;
      workflow: BootstrapWorkflow;
    }
  | {
      ok: false;
      /** The token could not be checked; it was not rejected. */
      error: "auth_check_unavailable";
      hint: string;
      /** HTTP status of the verify call; absent when the API was unreachable. */
      status?: number;
      tokenSource: TokenSourceInfo;
      project?: ProjectStatus;
      projectTokenRefused?: ProjectTokenRefusedInfo;
      workflow: BootstrapWorkflow;
    };

function tokenSourceInfo(source: TokenSource, where: TokenResolution): TokenSourceInfo {
  return where.path ? { source, path: where.path } : { source };
}

function projectTokenRefusedInfo(where: TokenResolution): ProjectTokenRefusedInfo | undefined {
  const r = where.refusedProjectToken;
  return r ? { path: r.path, reason: r.reason, hint: refusedProjectTokenHint(r) } : undefined;
}

const TOKEN_EXPIRES_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export function evaluateExpiry(
  expSeconds: number | undefined,
  now: number = Date.now(),
): { expiresAt?: string; expiresSoon: boolean } {
  if (typeof expSeconds !== "number" || !Number.isFinite(expSeconds)) {
    return { expiresSoon: false };
  }
  const expiresAt = new Date(expSeconds * 1000).toISOString();
  const remaining = expSeconds * 1000 - now;
  return { expiresAt, expiresSoon: remaining > 0 && remaining < TOKEN_EXPIRES_SOON_MS };
}

function detectStalePreview(projectDir: string): ProjectStatus["stalePreviewWarning"] {
  const dirty = workingTreeDirtyCount(projectDir);
  if (dirty === 0) return undefined;
  for (const port of PREVIEW_PORTS) {
    if (isLoopbackPortInUseSync(port)) {
      return {
        port,
        uncommittedFiles: dirty,
        message: `A dev server appears to be running on http://localhost:${port}, but ${dirty} file(s) have uncommitted changes. The preview the user sees is stale relative to disk. Use verse8_preview to commit + relaunch, or verse8_checkpoint to commit without touching the server.`,
      };
    }
  }
  return undefined;
}

function buildProjectStatus(cwd: string): ProjectStatus {
  const detection = detectVerseProject(cwd);
  if (!detection.isVerse) {
    return {
      isVerse: false,
      attached: false,
      projectDir: cwd,
    };
  }
  const attachment = detectAttachment(cwd);
  const stalePreviewWarning = detectStalePreview(cwd);
  const proxies = resolveMcpServices(cwd);
  return {
    isVerse: true,
    attached: attachment.attached,
    projectDir: cwd,
    gitlabRemote: detection.gitlabRemote,
    projectId: detection.projectId,
    missing: attachment.attached ? undefined : attachment.missing,
    attachmentDetail: attachment.checks,
    hint: attachment.attached
      ? undefined
      : "This is a verse8 project but verse8-mcp hooks / AGENTS.md are not installed. Call verse8_attach to complete setup. Commits via verse8_checkpoint will fail with `project_needs_attach` until you do.",
    stalePreviewWarning,
    mcpProxies: {
      enabled: proxies.enabled,
      disabled: proxies.disabled,
      source: proxies.source,
    },
  };
}

export async function runStatus(cwd: string = process.cwd()): Promise<StatusResult> {
  const project = buildProjectStatus(cwd);
  const workspaceMode = detectWorkspace(cwd).workspaceMode;
  // One resolution answers both "which token" and "from where".
  const where = resolveToken(cwd);
  const token = where.token;
  const projectTokenRefused = projectTokenRefusedInfo(where);
  if (!token || !where.source) {
    return {
      ok: false,
      error: "not_logged_in",
      hint: projectTokenRefused ? `${projectTokenRefused.hint} To log in: ${LOGIN_HINT}` : LOGIN_HINT,
      project,
      ...(projectTokenRefused ? { projectTokenRefused } : {}),
      workflow: computeBootstrapWorkflow({ workspaceMode, hasToken: false }),
    };
  }
  const tokenSource = tokenSourceInfo(where.source, where);

  // A token is rejected only when the server says so (401). Anything
  // else — a 5xx, a gateway page, an unreachable host — says nothing about
  // the token, so it must not lead to "log out" / "remove the env var".
  const unavailable = (what: string, status?: number): StatusResult => ({
    ok: false,
    error: "auth_check_unavailable",
    hint: `Could not check the login: ${what}. The token was NOT rejected — do not log out, log in again or change VERSE8_ACCESS_TOKEN because of this. Retry verse8_status in a moment.`,
    ...(status !== undefined ? { status } : {}),
    tokenSource,
    project,
    ...(projectTokenRefused ? { projectTokenRefused } : {}),
    // The token is still the best one known: route as logged in.
    workflow: computeBootstrapWorkflow({ workspaceMode, hasToken: true }),
  });
  let resp: Awaited<ReturnType<typeof verifyToken>>;
  try {
    resp = await verifyToken(token);
  } catch (e) {
    return unavailable(`the Verse8 API could not be reached (${safeErrorHint(e)})`);
  }
  // 401 is the only answer the verify endpoint gives for a bad token. A 403
  // is about the account (restricted) or comes from a proxy in front of the
  // API; clearing or replacing the token does not help with either.
  if (!resp.ok && resp.status === 403) {
    return unavailable(
      `GET /v1/auth/verify answered HTTP 403 (${redactHead(resp.body, 200)}), which refuses the request or the account, not the token — show this message to the user`,
      403,
    );
  }
  if (!resp.ok && resp.status !== 401) {
    return unavailable(`GET /v1/auth/verify answered HTTP ${resp.status}`, resp.status);
  }
  if (resp.ok) {
    const { expiresAt, expiresSoon } = evaluateExpiry(
      typeof resp.profile.exp === "number" ? resp.profile.exp : undefined,
    );
    const warnings: string[] = [];
    if (expiresSoon) warnings.push("token_expires_soon");
    const result: StatusResult = {
      ok: true,
      profile: resp.profile,
      project,
      workflow: computeBootstrapWorkflow({ workspaceMode, hasToken: true }),
      tokenSource,
      creditRechargeUrl: creditSettingsUrl(),
    };
    if (projectTokenRefused) {
      result.projectTokenRefused = projectTokenRefused;
      warnings.push("project_token_refused");
    }
    if (expiresAt) result.tokenExpiresAt = expiresAt;
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }
  // The token has been invalidated (expired / revoked / re-logged-in under a
  // different account). Any proxy discovery cached against this token is
  // guaranteed stale, so drop it now — the user will re-login and a fresh
  // tools/list cycle will re-discover under the new credentials.
  resetProxyCaches();
  return {
    ok: false,
    error: "token_invalid",
    hint: `token rejected by /v1/auth/verify. ${rejectedTokenHint(where)}`,
    status: resp.status,
    tokenSource,
    project,
    ...(projectTokenRefused ? { projectTokenRefused } : {}),
    workflow: computeBootstrapWorkflow({ workspaceMode, hasToken: false }),
  };
}
