import type {
  GetPromptResult,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Slash-command prompts — surfaced in Claude Code as `/verse8:<name>` so
 * users can trigger common Verse8 actions manually when the agent has
 * not auto-routed them. Each prompt returns a short user-message that
 * instructs the LLM to call the corresponding tool.
 */

// ---------------------------------------------------------------------------
// /verse8:bootstrap
// ---------------------------------------------------------------------------

export const bootstrapPrompt: Prompt = {
  name: "bootstrap",
  title: "Verse8 bootstrap",
  description:
    "Manually run verse8_bootstrap on the current directory to classify the workspace and return the next tool the agent should use. Useful when the agent skipped bootstrap or you want to see what it would decide.",
  arguments: [],
};

export function getBootstrapPrompt(): GetPromptResult {
  return {
    description: bootstrapPrompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Call `verse8_bootstrap({})` on the current directory and report:\n" +
            "- `workspaceMode`\n" +
            "- `workflow.nextAction` / `workflow.nextTool`\n" +
            "- a one-line summary of `workflow.reason`.\n\n" +
            "If `nextTool` is set, offer to call it next. If `nextAction === \"ready\"` or `\"not_verse_project\"`, just report the classification.",
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// /verse8:attach
// ---------------------------------------------------------------------------

export const attachPrompt: Prompt = {
  name: "attach",
  title: "Verse8 attach (install hooks + AGENTS.md + skills)",
  description:
    "Manually run verse8_attach on the current directory. Installs pre-commit + commit-msg hooks, writes AGENTS.md / CLAUDE.md with the skills catalog, materializes bundled skills to .claude/skills/, and ensures .verse8/project.json. Use when you just cloned a gitlab.verse8.io repo and want to bring it under verse8-mcp governance, or when verse8_checkpoint returned `project_needs_attach`.",
  arguments: [],
};

export function getAttachPrompt(): GetPromptResult {
  return {
    description: attachPrompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Call `verse8_attach({})` on the current directory. It installs git hooks, writes AGENTS.md / CLAUDE.md, and materializes bundled skills.\n\n" +
            "After it returns, summarize `installed.{preCommitHook, commitMsgHook, agentsDoc, projectMarker, skills, env, gitIgnore}` so I can see what changed, and **commit the resulting files to the repo** via `verse8_checkpoint({userPrompt: \"verse8_attach setup\", problemStatement: \"Attach this clone to verse8-mcp so AGENTS.md/CLAUDE.md/.claude/skills/ propagate on future clones\", workSummary: \"Ran verse8_attach\"})` so the attach artifacts are tracked in git.\n\n" +
            "If attach fails, show me the error and the hint.",
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// /verse8:status
// ---------------------------------------------------------------------------

export const statusPrompt: Prompt = {
  name: "status",
  title: "Verse8 status",
  description:
    "Manually run verse8_status — checks token validity, profile, project attachment, MCP proxy state, and (if <7d) emits a token_expires_soon warning. Also returns the same `workflow.nextTool` routing as verse8_bootstrap.",
  arguments: [],
};

export function getStatusPrompt(): GetPromptResult {
  return {
    description: statusPrompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Call `verse8_status({})` and give me a concise report:\n" +
            "- login state (logged-in user + wallet, or `not_logged_in`)\n" +
            "- project attachment (isVerse / attached / missing list)\n" +
            "- `workflow.nextAction` and `workflow.nextTool`\n" +
            "- any `warnings` (esp. `token_expires_soon`) and `tokenExpiresAt`.",
        },
      },
    ],
  };
}
