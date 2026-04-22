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

export type BootstrapNextAction =
  | "login"
  | "new_project"
  | "attach"
  | "ready"
  | "not_verse_project";
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

  // verse8 workspace detected — force verse8 flow even if no token.
  if (workspaceMode === "attached" || workspaceMode === "unattached_clone") {
    if (!hasToken) {
      return {
        nextAction: "login",
        nextTool: "verse8_login_start",
        reason:
          "Workspace is a verse8 project but no access token was found. Login is required before attach / checkpoint / preview.",
        instructions:
          `Call verse8_login_start with no arguments FIRST. Display the returned verification_uri_complete + user_code to the user, wait for browser approval, then call verse8_login_complete. After login, re-call verse8_bootstrap to get the next routing step.${echo}`,
      };
    }
    if (workspaceMode === "attached") {
      return {
        nextAction: "ready",
        nextTool: null,
        reason:
          "Workspace is an attached verse8 project — hooks and AGENTS.md are installed; token is present.",
        instructions:
          `This is an attached Verse8 project. Proceed with the user's request while honoring these MANDATORY rules (violating any will corrupt the project or the user's preview):\n1) NEVER \`git commit\` via Bash — ALWAYS verse8_checkpoint. The installed commit-msg hook rejects non-V8 messages.\n2) NEVER \`bun run dev\` / \`vite\` / any dev server via Bash — ALWAYS verse8_preview (it bundles a checkpoint so 'what the user sees == what is in git').\n3) NEVER pass \`--no-verify\` to git.\n4) If your change produces a visible delta (UI / gameplay / bug fix / asset swap), END the turn with verse8_preview.\n5) Images / music / sfx / 3D / skybox → use image_asset_generate / music_generate / sfx_generate / spritesheet_generate / skybox_generate / claythis_3d_generate / etc. NEVER external APIs.${echo}`,
      };
    }
    // unattached_clone
    return {
      nextAction: "attach",
      nextTool: "verse8_attach",
      reason:
        "Cwd looks like a verse8 project (gitlab.verse8.io origin or a .verse8/project.json marker) but hooks / AGENTS.md are not installed.",
      instructions:
        `Call verse8_attach({projectDir: <cwd>}) FIRST. It installs hooks + AGENTS.md / CLAUDE.md and copies bundled skills. Then re-call verse8_bootstrap to confirm nextAction === "ready" before implementing anything.${echo}`,
    };
  }

  // Non-verse workspace (empty dir OR unrelated git repo). Bootstrap stays
  // silent and returns null — the agent proceeds with its usual tools.
  // Verse8 new-project is offered only when the user explicitly asks for it.
  if (!hasToken) {
    return {
      nextAction: "not_verse_project",
      nextTool: null,
      reason:
        workspaceMode === "empty"
          ? "Cwd is empty (no .git) and no Verse8 access token is available. Treating as a non-verse workspace."
          : "Cwd is a git repo whose origin is not gitlab.verse8.io, and no Verse8 access token is available. Treating as a non-verse workspace.",
      instructions:
        `This workspace is NOT a Verse8 project. Proceed with the user's request using your usual tools (file edits, shell, etc.). If the user EXPLICITLY asks to create a Verse8 game (mentions "verse8" / "Verse8 / 버스8"), call verse8_login_start then verse8_new_project_start.${echo}`,
    };
  }
  return {
    nextAction: "not_verse_project",
    nextTool: null,
    reason:
      workspaceMode === "empty"
        ? "Cwd has no .git directory. Treating as a non-verse workspace — Verse8 new-project is opt-in, not the default."
        : "Cwd is a git repo but its origin is not gitlab.verse8.io. This is not a verse8 project.",
    instructions:
      `This workspace is NOT a Verse8 project. Proceed with the user's request using your usual tools (file edits, shell, build, etc.) — do NOT call Verse8 checkpoint / preview / attach. If the user EXPLICITLY asks to create a Verse8 game (they mention "verse8" / "Verse8" / "버스8"), call verse8_new_project_start({userRequest}) to start the new-project flow.${echo}`,
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
