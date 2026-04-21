import { z } from "zod";
import { detectWorkspace, type WorkspaceMode } from "../context/workspace.js";
import { loadToken } from "../context/token.js";
import { isSafeAbsPath } from "../util/safePath.js";
import { safeHint } from "../util/redact.js";

/**
 * `verse8_bootstrap` — the single always-first entry-point for any
 * Verse8 user request. Returns a deterministic `workflow.nextTool`
 * that MCP hosts (Claude Code, Codex, Cursor, …) can follow without
 * inferring workflow state from filesystem inspection or prose. This
 * closes the Codex UX gap where fresh sessions had no project-scoped
 * guidance because the rich `AGENTS.md` is only written AFTER attach.
 */

export const bootstrapInputSchema = z
  .object({
    userRequest: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Verbatim user message so the bootstrap response can echo it back inside `workflow.instructions`.",
      ),
    projectDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "projectDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
      })
      .optional()
      .describe("Absolute path to inspect. Defaults to the MCP server's cwd."),
  })
  .strict();

export type BootstrapInput = z.infer<typeof bootstrapInputSchema>;

export type BootstrapNextAction = "login" | "new_project" | "attach" | "ready";
export type BootstrapNextTool =
  | "verse8_login_start"
  | "verse8_new_project_start"
  | "verse8_attach"
  | null;

export interface BootstrapWorkflow {
  nextAction: BootstrapNextAction;
  nextTool: BootstrapNextTool;
  reason: string;
  instructions: string;
}

export interface BootstrapDiagnostics {
  hasGit: boolean;
  originHost: string | null;
  hasProjectMarker: boolean;
  hasToken: boolean;
  attached: boolean;
}

export interface BootstrapResult {
  ok: true;
  workspaceMode: WorkspaceMode;
  workflow: BootstrapWorkflow;
  diagnostics: BootstrapDiagnostics;
}

export function computeBootstrapWorkflow(params: {
  workspaceMode: WorkspaceMode;
  hasToken: boolean;
  userRequest?: string;
}): BootstrapWorkflow {
  const { workspaceMode, hasToken, userRequest } = params;
  const echo = userRequest ? ` User request: "${safeHint(userRequest)}".` : "";

  if (!hasToken) {
    return {
      nextAction: "login",
      nextTool: "verse8_login_start",
      reason:
        "No Verse8 access token found (env VERSE8_ACCESS_TOKEN unset, no token file at <cwd>/.verse8/token or $XDG_CONFIG_HOME/verse8/token).",
      instructions:
        `Call verse8_login_start with no arguments FIRST. Display the returned verification_uri_complete + user_code to the user, wait for browser approval, then call verse8_login_complete with the returned device_code. Do NOT generate any game code or edit files before login.${echo}`,
    };
  }
  if (workspaceMode === "attached") {
    return {
      nextAction: "ready",
      nextTool: null,
      reason:
        "Workspace is an attached verse8 project — hooks and AGENTS.md are installed; token is present.",
      instructions:
        `Proceed with the user's request directly. Use verse8_checkpoint to commit + push when a change is ready, and verse8_preview when the user should visually verify.${echo}`,
    };
  }
  if (workspaceMode === "unattached_clone") {
    return {
      nextAction: "attach",
      nextTool: "verse8_attach",
      reason:
        "Cwd looks like a verse8 project (gitlab.verse8.io origin or a .verse8/project.json marker) but hooks / AGENTS.md are not installed.",
      instructions:
        `Call verse8_attach({projectDir: <cwd>}) FIRST. It installs hooks + AGENTS.md / CLAUDE.md and copies bundled skills. Then re-call verse8_bootstrap to confirm nextAction === "ready" before implementing anything.${echo}`,
    };
  }
  // "empty" | "non_verse_dir" with a token → new project flow.
  return {
    nextAction: "new_project",
    nextTool: "verse8_new_project_start",
    reason:
      workspaceMode === "empty"
        ? "Cwd has no .git directory — user wants a fresh verse8 project."
        : "Cwd is a git repo but its origin is not gitlab.verse8.io — this is not a verse8 project.",
    instructions:
      `Call verse8_new_project_start({userRequest: <user's verbatim message>}) FIRST. It returns a proposed template + startCallId for user review. Show the proposal, wait for confirmation, then call verse8_new_project_confirm. DO NOT start generating game code directly — the Verse8 backend mints the project repo and grants the access token.${echo}`,
  };
}

export async function runBootstrap(
  input: BootstrapInput,
  serverCwd: string = process.cwd(),
): Promise<BootstrapResult> {
  const cwd = input.projectDir ?? serverCwd;
  const state = detectWorkspace(cwd);
  const token = loadToken(cwd);
  const hasToken = typeof token === "string" && token.length > 0;
  const workflow = computeBootstrapWorkflow({
    workspaceMode: state.workspaceMode,
    hasToken,
    userRequest: input.userRequest,
  });
  return {
    ok: true,
    workspaceMode: state.workspaceMode,
    workflow,
    diagnostics: {
      hasGit: state.hasGit,
      originHost: state.originHost,
      hasProjectMarker: state.hasProjectMarker,
      hasToken,
      attached: state.attached,
    },
  };
}
