import { execFileSync } from "node:child_process";
import { z } from "zod";
import { verifyToken, type VerifyResponse } from "../api/v8MemeApi.js";
import { detectAttachment, type AttachmentState } from "../context/attachment.js";
import { loadToken } from "../context/token.js";
import { detectVerseProject } from "../context/verseProject.js";
import { detectWorkspace } from "../context/workspace.js";
import { resetProxyCaches } from "../proxy/forward.js";
import { resolveMcpServices, type ResolutionSource } from "../proxy/registry.js";
import {
  computeBootstrapWorkflow,
  type BootstrapWorkflow,
} from "./bootstrap.js";

export const statusInputSchema = z.object({}).strict();

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

function probePortSync(port: number, host: string): boolean {
  try {
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `const net=require('net');const s=net.createConnection({port:${port},host:'${host}'});s.setTimeout(200);let done=false;const finish=v=>{if(done)return;done=true;s.destroy();process.exitCode=v?0:1;};s.once('connect',()=>finish(true));s.once('timeout',()=>finish(false));s.once('error',()=>finish(false));`,
      ],
      { timeout: 1000, stdio: ["ignore", "ignore", "ignore"] },
    );
    return out !== undefined; // exit 0 → used
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    return e.status === 0;
  }
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
      creditRechargeUrl: string;
    }
  | {
      ok: false;
      error: "not_logged_in";
      hint: string;
      project?: ProjectStatus;
      workflow: BootstrapWorkflow;
    }
  | {
      ok: false;
      error: "token_invalid";
      hint: string;
      status: number;
      project?: ProjectStatus;
      workflow: BootstrapWorkflow;
    };

const TOKEN_EXPIRES_SOON_MS = 7 * 24 * 60 * 60 * 1000;
const CREDIT_RECHARGE_URL = "https://verse8.io/settings";

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
    if (probePortSync(port, "127.0.0.1")) {
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
  const token = loadToken(cwd);
  if (!token) {
    return {
      ok: false,
      error: "not_logged_in",
      hint: "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
      project,
      workflow: computeBootstrapWorkflow({ workspaceMode, hasToken: false }),
    };
  }

  const resp = await verifyToken(token);
  if (resp.ok) {
    const { expiresAt, expiresSoon } = evaluateExpiry(
      typeof resp.profile.exp === "number" ? resp.profile.exp : undefined,
    );
    const warnings: string[] = [];
    if (expiresSoon) warnings.push("token_expires_soon");
    if (
      typeof resp.profile.totalPoints === "number" &&
      resp.profile.totalPoints <= 0
    ) {
      warnings.push("insufficient_credits");
    }
    const result: StatusResult = {
      ok: true,
      profile: resp.profile,
      project,
      workflow: computeBootstrapWorkflow({ workspaceMode, hasToken: true }),
      creditRechargeUrl: CREDIT_RECHARGE_URL,
    };
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
    hint: "token rejected by /v1/auth/verify; re-login via verse8_login_start + verse8_login_complete",
    status: resp.status,
    project,
    workflow: computeBootstrapWorkflow({ workspaceMode, hasToken: false }),
  };
}
