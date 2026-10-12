// Verse8 mod — runs inside Claude Code (2.1.287+) next to the MCP server.
//
// Older Claude Code (measured 2026-10-07 with `claude -p --plugin-dir`):
//  - 2.1.251–2.1.286: `modules` is read, but this module fails to load
//    (`session.start` unknown, or the mods rollout flag is off). The MCP
//    server still connects — the mod degrades to nothing.
//  - 2.1.240 and older: `modules` is ignored, and hooks.json MUST carry a
//    `hooks` object (even `{}`). Without it the schema check fails and the
//    WHOLE plugin is skipped: `Plugin not available for MCP: verse8 —
//    error type: hook-load-failed`. That is why hooks.json keeps `"hooks": {}`
//    next to `"modules"`; do not remove it.
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
// use instead. A Bash call is read as a list of simple commands, each a list
// of shell words, and each rule looks at ONE simple command: what it starts
// with (after env assignments) and, for git, which subcommand it is. So `git
// log --grep commit`, `git config commit.gpgsign`, `grep commit`, `git commit`
// inside a quoted string or a heredoc body, or `-n` inside a commit message is
// not a commit / --no-verify, while `git -c core.hooksPath=x commit`, a commit
// on the second line, or one after `then` still is.
//
// Deliberately NOT caught (the git hooks remain the hard layer): a commit
// made by `sh -c`, `$( … )`, a script file, `eval`, or through `git merge` /
// `revert` / `cherry-pick` / `rebase` — the commit-msg hook lets git's own
// Merge/Revert subjects through and rejects the rest.

// Split a Bash command into its simple commands, each a list of words.
// `;`, `&`, `|` and newlines end a command only outside quotes; quotes are
// removed from the words, and a heredoc body (`<<EOF` … `EOF`, `<<-`,
// quoted delimiters) is skipped, so text in a string or a heredoc never
// becomes a command. `then` / `do` / `else` are dropped so `if …; then git
// commit` is seen as `git commit`. One pass over the string, no regex
// backtracking.
function simpleCommands(cmd) {
  const commands = [];
  const heredocs = []; // delimiters whose bodies start after the next newline
  let words = [];
  let word = null; // null: between words
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    while (words.length && /^(?:then|do|else)$/.test(words[0])) words.shift();
    if (words.length) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end === -1 ? cmd.length : end;
      word = (word ?? "") + cmd.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      word = word ?? "";
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < cmd.length) i++;
        word += cmd[i++];
      }
      i++;
    } else if (c === "\\") {
      if (cmd[i + 1] !== "\n") word = (word ?? "") + (cmd[i + 1] ?? "");
      i += 2;
    } else if (c === "<" && cmd.startsWith("<<", i) && !cmd.startsWith("<<<", i)) {
      endWord();
      i += 2;
      const dash = cmd[i] === "-";
      if (dash) i++;
      while (cmd[i] === " " || cmd[i] === "\t") i++;
      const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(cmd.slice(i));
      if (m) {
        heredocs.push({ delim: (m[1] ?? m[2] ?? m[3]).replace(/\\/g, ""), dash });
        i += m[0].length;
      }
    } else if (c === "\n") {
      endCommand();
      i++;
      for (const { delim, dash } of heredocs.splice(0)) {
        for (;;) {
          if (i >= cmd.length) break;
          const eol = cmd.indexOf("\n", i);
          const stop = eol === -1 ? cmd.length : eol;
          const line = cmd.slice(i, stop);
          i = stop + 1;
          if ((dash ? line.replace(/^\t+/, "") : line) === delim) break;
        }
      }
    } else if (c === ";" || c === "&" || c === "|") {
      endCommand();
      i++;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endCommand();
  return commands;
}

// `FOO=1 env BAR=2 git …` → { env: ["FOO=1", "BAR=2"], argv: ["git", …] }
function splitEnv(words) {
  let i = 0;
  while (i < words.length && (words[i] === "env" || /^[A-Za-z_]\w*=/.test(words[i]))) i++;
  return { env: words.slice(0, i).filter((w) => w !== "env"), argv: words.slice(i) };
}

// Global git options that take their value as the next word.
const GIT_OPTION_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

// `git -c a=b -C dir commit -m x` → { sub: "commit", args: ["-m", "x"] };
// null when the command is not git. Global options before the subcommand
// (`-c key=val`, `-C dir`, `--git-dir=…`, `--no-pager`) are skipped, one
// word at a time.
function gitCall(argv) {
  if (argv[0] !== "git") return null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith("-")) i += GIT_OPTION_WITH_VALUE.has(argv[i]) ? 2 : 1;
  const sub = argv[i];
  return sub && /^[a-z][\w-]*$/.test(sub) ? { sub, args: argv.slice(i + 1) } : null;
}

// Whether `args` (up to a `--`) holds one of `flags`, alone or as `--flag=…`.
function hasFlag(args, flags) {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some((a) => flags.includes(a.replace(/=.*$/, "")));
}

// `vite` with no subcommand, or `dev` / `serve` / `preview`, starts a server;
// `build`, `optimize`, `--help`, `--version` do not, wherever they sit among
// the options (`vite --mode production build`).
const VITE_NOT_A_SERVER = new Set(["build", "optimize", "--help", "-h", "--version", "-v"]);
function startsDevServer(argv) {
  if (/^(?:bun|npm|pnpm|yarn)$/.test(argv[0] ?? "")) {
    return (argv[1] === "run" ? argv[2] : argv[1]) === "dev";
  }
  const vite = argv[0] === "npx" || argv[0] === "bunx" ? argv.slice(1) : argv;
  return vite[0] === "vite" && !vite.slice(1).some((a) => VITE_NOT_A_SERVER.has(a));
}

// The one sanctioned Bash commit: AGENTS.md allows
// `VERSE8_ALLOW_NONCOMPLIANT=1 git commit -m "…"` for a deliberate,
// user-approved one-off. The commit-msg hook honours the same variable.
// It never excuses --no-verify.
const ALLOW_NONCOMPLIANT = "VERSE8_ALLOW_NONCOMPLIANT=1";

const GUARDS = [
  {
    // `-n` is --no-verify on commit; on push it is --dry-run, so only the
    // long form counts there.
    test: ({ argv }) => {
      const g = gitCall(argv);
      if (!g) return false;
      if (g.sub === "commit") return hasFlag(g.args, ["--no-verify", "-n"]);
      if (g.sub === "push") return hasFlag(g.args, ["--no-verify"]);
      return false;
    },
    deny: "Verse8 project: --no-verify is not allowed. The commit-msg / pre-commit hooks keep Verse8's commit format. Use verse8_checkpoint instead.",
  },
  {
    test: ({ env, argv }) => gitCall(argv)?.sub === "commit" && !env.includes(ALLOW_NONCOMPLIANT),
    deny: "Verse8 project: do not run `git commit` through Bash. Use the verse8_checkpoint tool (it commits and pushes in Verse8's V8 history format).",
  },
  {
    // `bun run dev`, `npm dev`, `npx vite`, `vite --port 3000`, `vite preview`
    // (it serves too). Not `dev:server`, `vite build`, `vite optimize`,
    // `vite --help`, `vitest`, `vite-node`.
    test: ({ argv }) => startsDevServer(argv),
    deny: "Verse8 project: do not start the dev server through Bash. Use the verse8_preview tool (it bundles a V8 commit with the spawn so the preview matches git).",
  },
];

// The first rule, in GUARDS order, that any simple command trips.
function findGuard(cmd) {
  const parts = simpleCommands(cmd).map(splitEnv);
  return GUARDS.find((g) => parts.some((p) => g.test(p)));
}

export function register(on) {
  // 1. Gatekeeper
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const guard = findGuard(String(e.command ?? ""));
    if (!guard) return next(e);
    if (!(await inVerse8Project($))) return next(e);
    return { deny: guard.deny };
  }).catch(failOpen);

  // 2a. Session start: the baseline is where git stands now, until a preview.
  // A plugin reload raises session.start again with `$.state` intact; a
  // preview baseline it finds is kept, so the reload does not forget it.
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    if (await inVerse8Project($)) {
      const { value: baseline } = await $.state.get(BASELINE);
      if (baseline?.kind !== "preview") await setBaseline($, "session");
    }
    return result;
  });

  // 2b. A preview that ran moves the baseline to its commit and clears the band.
  // The MCP tool is `mcp__verse8__verse8_preview` when the server is configured
  // by the user and `mcp__plugin_verse8_verse8__verse8_preview` when this plugin
  // starts it; both end the same way. A preview that failed (`isError`) leaves
  // the baseline where it was.
  on("tool.call", { tool: /^mcp__.+__verse8_preview$/ }, async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && !result?.deny && !result?.isError) {
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
      // No baseline yet (session.start found no Verse8 project, or git could
      // not answer then): start counting now.
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

// A git that hangs (a lock, a slow disk) must not hold the turn up.
const GIT_TIMEOUT_MS = 5000;

async function git($, args) {
  try {
    const { exitCode, stdout } = await $.process.run(["git", ...args], { timeoutMs: GIT_TIMEOUT_MS });
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
  // --no-optional-locks: status would otherwise refresh the index and take
  // index.lock, racing the user's own git.
  const status = await git($, ["--no-optional-locks", "status", "--porcelain"]);
  if (diff === null || status === null) return null;
  const files = new Set(diff.split("\n").map((l) => l.trim()).filter(Boolean));
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    files.add(path.includes(" -> ") ? path.split(" -> ").pop() : path);
  }
  return [...files];
}
