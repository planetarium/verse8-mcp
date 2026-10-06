// Verse8 mod — runs inside Claude Code (2.1.287+) next to the MCP server.
//
// Two jobs, both scoped to a Verse8 project (cwd has .verse8/project.json):
//
//  1. Gatekeeper  — a Bash call that would bypass the Verse8 workflow
//                   (raw `git commit`, `--no-verify`, a hand-started dev
//                   server) is refused BEFORE it runs, with the tool to use
//                   instead. The git hooks stay as the hard layer; this is
//                   the early, explanatory one.
//  2. Preview bell — counts Edit/Write calls during a main-loop turn. When the
//                   turn ends without `verse8_preview`, a band above the prompt
//                   reminds that the preview is stale. It clears on the next
//                   preview.
//
// Everything outside the sandbox goes through `$`; module variables reset on
// hot reload, so all data lives in `$.state`.

const EDITS = { plugin: "verse8", key: "edits" };
const REMINDER = { plugin: "verse8", key: "reminder" };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PROJECT_MARKER = ".verse8/project.json";

// Bash commands the Verse8 MCP instructions (rules 2–4) forbid, and what to
// use instead. Patterns stay narrow: a `git log`, `git commit` inside a quoted
// string, or `grep commit` is not a commit.
const GUARDS = [
  {
    test: (cmd) => /(^|[;&|]\s*)git\b[^;&|]*\b(commit|push)\b[^;&|]*(--no-verify|\s-n\b)/.test(cmd),
    deny: "Verse8 project: --no-verify is not allowed. The commit-msg / pre-commit hooks keep Verse8's commit format. Use verse8_checkpoint instead.",
  },
  {
    test: (cmd) => /(^|[;&|]\s*)git\b[^;&|]*\bcommit\b/.test(cmd),
    deny: "Verse8 project: do not run `git commit` through Bash. Use the verse8_checkpoint tool (it commits and pushes in Verse8's V8 history format).",
  },
  {
    test: (cmd) => /(^|[;&|]\s*)(bun|npm|pnpm|yarn)\s+(run\s+)?dev\b/.test(cmd) || /(^|[;&|]\s*)(npx\s+|bunx\s+)?vite\b(?!\s+build)/.test(cmd),
    deny: "Verse8 project: do not start the dev server through Bash. Use the verse8_preview tool (it bundles a V8 commit with the spawn so the preview matches git).",
  },
];

export function register(on) {
  // 1. Gatekeeper
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const cmd = String(e.command ?? "");
    const guard = GUARDS.find((g) => g.test(cmd));
    if (!guard) return next(e);
    if (!(await inVerse8Project($))) return next(e);
    return { deny: guard.deny };
  }).catch(failOpen);

  // 2a. Count file edits on the main loop; a preview resets the counter.
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || result?.deny) return result;
    if (isPreviewTool(e.tool)) {
      await $.state.set(EDITS, 0);
      await $.state.set(REMINDER, null);
    } else if (EDIT_TOOLS.has(e.tool) && (await inVerse8Project($))) {
      const { value = 0 } = await $.state.get(EDITS);
      await $.state.set(EDITS, value + 1);
    }
    return result;
  }).catch(failOpen);

  // 2b. Turn ended: edits without a preview become a reminder.
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) return result;
    const { value: edits = 0 } = await $.state.get(EDITS);
    if (edits > 0) {
      await $.state.set(REMINDER, { edits, turnId: e.turnId });
      await $.state.set(EDITS, 0);
    }
    return result;
  });

  // 2c. The band above the prompt. Reading REMINDER here subscribes the
  // render, so a later `$.state.set` redraws it without `$.ui.invalidate`.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { value: reminder } = await $.state.get(REMINDER);
    if (!reminder || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const n = reminder.edits;
    return Box({
      flexDirection: "row",
      paddingX: 1,
      children: [
        Text({ color: "warning", bold: true, children: "⚠ Verse8" }),
        Text({ children: `  ${n} file edit${n === 1 ? "" : "s"} since the last preview` }),
        Text({ dimColor: true, children: "  · run verse8_preview to refresh" }),
      ],
    });
  });
}

// A hook that throws or overruns its budget must not block Bash: the git
// hooks remain the hard layer, so this one fails open.
function failOpen($, e, next) {
  return next(e);
}

async function inVerse8Project($) {
  try {
    return await $.fs.exists(PROJECT_MARKER);
  } catch {
    return false;
  }
}

// The MCP tool is `mcp__verse8__verse8_preview` when the server is configured
// by the user and `mcp__plugin_verse8_verse8__verse8_preview` when this plugin
// starts it; both end the same way.
function isPreviewTool(tool) {
  return typeof tool === "string" && tool.startsWith("mcp__") && tool.endsWith("__verse8_preview");
}
