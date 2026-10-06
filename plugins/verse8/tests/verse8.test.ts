// Tests of the Verse8 mod (hooks/verse8.mjs). Run with:
//   claude plugin test plugins/verse8   (or: npm run test:mod)
import { describe, expect, test } from "claude-code/testing";

const SESSION = { surface: "terminal", isInteractive: true, cwd: "/work" } as any;

// A fake git: `head` is what rev-parse answers, `diff` maps a baseline hash to
// the `git diff --name-only <base> HEAD` output, `status` is porcelain output.
type Repo = { head: string; diff: Record<string, string>; status: string; broken?: boolean; calls: string[][] };
const repo = (over: Partial<Repo> = {}): Repo => ({ head: "aaa111", diff: {}, status: "", calls: [], ...over });

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } });
const fail = () => ({ value: { exitCode: 128, stdout: "", stderr: "fatal: not a git repository", isStdoutTruncated: false, isStderrTruncated: false } });

function stubs(on: any, { inProject, git }: { inProject: boolean; git: Repo }) {
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd }));
  on("fs.exists", () => ({ value: inProject }));
  on("tool.call", () => ({ result: "ran" }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.render", () => ({ type: "Box", props: {}, children: [] }));
  on("process.run", (_$: any, e: any) => {
    const argv: string[] = [...e.argv];
    git.calls.push(argv);
    if (git.broken) return fail();
    const [, sub, ...rest] = argv;
    if (sub === "rev-parse") return ok(git.head + "\n");
    if (sub === "diff") return ok(git.diff[rest[1]] ?? "");
    if (sub === "status") return ok(git.status);
    return fail();
  });
}

const band = ($: any) =>
  $.ui.mount({
    plugin: "verse8",
    surface: "terminal",
    component: "AbovePrompt",
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
  } as any);

const endTurn = ($: any, turnId = "t1", extra: Record<string, unknown> = {}) =>
  $.turn.complete({ turnId, reason: "answer", answer: "ok", durationMs: 1, isAborted: false, ...extra } as any);

describe("gatekeeper", () => {
  test("refuses a raw git commit in a Verse8 project", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    const r: any = await $.tool.call({ tool: "Bash", command: 'git add -A && git commit -m "wip"' });
    expect(r.deny).toMatch(/verse8_checkpoint/);
  });

  test("refuses --no-verify with its own reason", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    const r: any = await $.tool.call({ tool: "Bash", command: "git commit --no-verify -m x" });
    expect(r.deny).toMatch(/--no-verify/);
  });

  test("refuses a hand-started dev server", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    for (const command of ["bun run dev", "cd app && npm run dev", "npx vite --port 3000"]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toMatch(/verse8_preview/);
    }
  });

  test("lets harmless git and build commands through", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    for (const command of ["git log --oneline -5", "git status", "git rebase origin/develop", "bun run build", "vite build", "grep -rn commit src/"]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toBeUndefined();
      expect(r.result).toBe("ran");
    }
  });

  test("does nothing outside a Verse8 project", async ($, on) => {
    stubs(on, { inProject: false, git: repo() });
    await $.session.start(SESSION);
    const r: any = await $.tool.call({ tool: "Bash", command: 'git commit -m "normal repo"' });
    expect(r.deny).toBeUndefined();
    expect(r.result).toBe("ran");
  });
});

describe("preview bell (git-based)", () => {
  test("draws nothing while git matches the baseline", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    await endTurn($);
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();
  });

  test("counts a dirty working tree, however it was edited", async ($, on) => {
    const git = repo({ status: " M src/main.tsx\n?? src/new.ts\nR  old.ts -> renamed.ts\n" });
    stubs(on, { inProject: true, git });
    await $.session.start(SESSION);
    await endTurn($);
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /3 files changed since this session started \(no preview yet\)/ })).toBeDefined();
    await ui.unmount();
  });

  test("counts commits made after the last preview (checkpoint, rebase)", async ($, on) => {
    const git = repo({ head: "aaa111" });
    stubs(on, { inProject: true, git });
    await $.session.start(SESSION);
    await $.tool.call({ tool: "mcp__plugin_verse8_verse8__verse8_preview" });
    git.head = "bbb222";
    git.diff["aaa111"] = "src/a.ts\nsrc/b.ts\n";
    await endTurn($);
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /2 files changed since the last preview/ })).toBeDefined();
    await ui.unmount();
  });

  test("clears as soon as verse8_preview runs (either MCP tool name)", async ($, on) => {
    const git = repo({ status: " M src/main.tsx\n" });
    stubs(on, { inProject: true, git });
    await $.session.start(SESSION);
    await endTurn($);
    let ui = await band($);
    expect(await ui.find({ type: "Text", text: /1 file changed/ })).toBeDefined();
    await ui.unmount();

    git.status = ""; // the preview committed the change
    await $.tool.call({ tool: "mcp__verse8__verse8_preview" });
    ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();

    await endTurn($, "t2");
    ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();
  });

  test("ignores subagent turns and non-Verse8 directories (no git calls at all)", async ($, on) => {
    const git = repo({ status: " M x.ts\n" });
    stubs(on, { inProject: false, git });
    await $.session.start(SESSION);
    await endTurn($, "t1");
    await endTurn($, "t2", { agentId: "sub-1" });
    expect(git.calls.length).toBe(0);
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();
  });

  test("stays quiet when git cannot answer", async ($, on) => {
    stubs(on, { inProject: true, git: repo({ broken: true }) });
    await $.session.start(SESSION);
    await endTurn($);
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();
  });
});
