// Verse8 mod — runs inside Claude Code (2.1.287+) next to the MCP server.
//
// Two jobs, both scoped to a Verse8 project (cwd has .verse8/project.json):
//
//  1. Gatekeeper  — a Bash call that would bypass the Verse8 workflow
//                   (raw `git commit`, `--no-verify`, a hand-started dev
//                   server) is refused BEFORE it runs, with the tool to use
//                   instead. The git hooks stay as the hard layer; this is
//                   the early, explanatory one.
//  2. Preview bell — "what the user sees == what is in git" is the project's
//                   rule (verse8_preview bundles a commit), so staleness is
//                   read from git, not from tool calls: the HEAD at the last
//                   preview (or at session start) is the baseline, and at the
//                   end of every main-loop turn `git diff` + `git status`
//                   count the files that differ from it. Edits through Edit,
//                   Bash (`sed -i`), subagents, a checkpoint commit or a rebase
//                   all show up the same way. A band above the prompt reports
//                   the count; it clears on the next preview.
//
// Everything outside the sandbox goes through `$`; module variables reset on
// hot reload, so all data lives in `$.state`.

const BASELINE = { plugin: "verse8", key: "baseline" };
const REMINDER = { plugin: "verse8", key: "reminder" };

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

  // 2a. Session start: the baseline is where git stands now, until a preview.
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    if (await inVerse8Project($)) {
      await setBaseline($, "session");
    }
    return result;
  });

  // 2b. A preview that ran moves the baseline to its commit and clears the band.
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && !result?.deny && isPreviewTool(e.tool)) {
      await setBaseline($, "preview");
    }
    return result;
  }).catch(failOpen);

  // 2c. Turn ended on the main loop: ask git what differs from the baseline.
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || !(await inVerse8Project($))) return result;
    let { value: baseline } = await $.state.get(BASELINE);
    if (!baseline) {
      // Hot reload or a session that started elsewhere: start counting now.
      baseline = await setBaseline($, "session");
      if (!baseline) return result;
    }
    const files = await changedSince($, baseline.head);
    await $.state.set(REMINDER, files === null || files.length === 0 ? null : { files: files.length, since: baseline.kind });
    return result;
  });

  // 2d. The band above the prompt. Reading REMINDER here subscribes the
  // render, so a later `$.state.set` redraws it without `$.ui.invalidate`.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { value: reminder } = await $.state.get(REMINDER);
    if (!reminder || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const n = reminder.files;
    const since = reminder.since === "preview" ? "since the last preview" : "since this session started (no preview yet)";
    return Box({
      flexDirection: "row",
      paddingX: 1,
      children: [
        Text({ color: "warning", bold: true, children: "⚠ Verse8" }),
        Text({ children: `  ${n} file${n === 1 ? "" : "s"} changed ${since}` }),
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

async function git($, args) {
  try {
    const { exitCode, stdout } = await $.process.run(["git", ...args]);
    return exitCode === 0 ? stdout : null;
  } catch {
    return null;
  }
}

async function setBaseline($, kind) {
  const head = (await git($, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return null;
  const baseline = { head, kind };
  await $.state.set(BASELINE, baseline);
  await $.state.set(REMINDER, null);
  return baseline;
}

// Files that differ from `head`: committed since it (diff) plus anything the
// working tree holds that git does not (status). Null when git could not say.
async function changedSince($, head) {
  const diff = await git($, ["diff", "--name-only", head, "HEAD"]);
  const status = await git($, ["status", "--porcelain"]);
  if (diff === null || status === null) return null;
  const files = new Set(diff.split("\n").map((l) => l.trim()).filter(Boolean));
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    files.add(path.includes(" -> ") ? path.split(" -> ").pop() : path);
  }
  return [...files];
}
