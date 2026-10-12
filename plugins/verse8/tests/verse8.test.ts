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

// `tool` answers a tool call; by default every tool runs and succeeds.
type Tool = (e: any) => Record<string, unknown>;
function stubs(on: any, { inProject, git, tool = () => ({ result: "ran" }) }: { inProject: boolean; git: Repo; tool?: Tool }) {
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd }));
  on("fs.exists", () => ({ value: inProject }));
  on("tool.call", (_$: any, e: any) => tool(e));
  on("turn.complete", () => ({ text: "" }));
  on("ui.render", () => ({ type: "Box", props: {}, children: [] }));
  on("process.run", (_$: any, e: any) => {
    const argv: string[] = [...e.argv];
    git.calls.push(argv);
    if (git.broken) return fail();
    const [, ...words] = argv;
    while (words[0]?.startsWith("-")) words.shift(); // --no-optional-locks
    const [sub, ...rest] = words;
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
    for (const command of [
      "git log --oneline -5",
      "git status",
      "git rebase origin/develop",
      "bun run build",
      "vite build",
      "grep -rn commit src/",
      // the word `commit` after git, but not the subcommand
      "git log --oneline --grep commit",
      "git log -1 --format='commit %H'",
      "git config commit.gpgsign false",
      "git diff -- docs/commit.md",
      // `-n` on push is --dry-run, not --no-verify
      "git push -n origin main",
      // vite-shaped things that are not the dev server
      "vite --version",
      "npx vitest run",
      "npx vite-node scripts/x.ts",
      "bun run dev:server",
      "bun run lint && bun run build",
      // the commit lives in a string, not in a command
      "echo 'run git commit later'",
    ]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toBeUndefined();
      expect(r.result).toBe("ran");
    }
  });

  test("sees a commit wherever it sits in the script", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    for (const command of [
      "echo hi\ngit commit -m x",
      "if true; then git commit -m x; fi",
      "git -c core.hooksPath=/dev/null commit -m x",
      "GIT_AUTHOR_NAME=bot git commit -m x",
    ]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toMatch(/verse8_checkpoint/);
    }
    const dev: any = await $.tool.call({ tool: "Bash", command: "PORT=3000 bun run dev" });
    expect(dev.deny).toMatch(/verse8_preview/);
  });

  test("lets the documented VERSE8_ALLOW_NONCOMPLIANT one-off through, never --no-verify", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    const ok: any = await $.tool.call({ tool: "Bash", command: 'VERSE8_ALLOW_NONCOMPLIANT=1 git commit -m "bootstrap"' });
    expect(ok.deny).toBeUndefined();
    expect(ok.result).toBe("ran");
    const no: any = await $.tool.call({ tool: "Bash", command: "VERSE8_ALLOW_NONCOMPLIANT=1 git commit -n -m x" });
    expect(no.deny).toMatch(/--no-verify/);
  });

  test("never reads quoted text or a heredoc body as a command", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    for (const command of [
      'echo "x; git commit -m y"',
      "echo 'a && bun run dev'",
      'echo "say \\"hi\\"; git commit -m y"',
      "cat > notes.md <<EOF\nbun run dev\ngit commit -m x\nEOF",
      "cat <<-'END' > a.txt\n\tvite --port 3000\n\tEND\necho done",
      // `-n` inside the message is not --no-verify
      'VERSE8_ALLOW_NONCOMPLIANT=1 git commit -m "fix -n flag"',
    ]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toBeUndefined();
      expect(r.result).toBe("ran");
    }
    // a command after the heredoc ends is still read
    const after: any = await $.tool.call({ tool: "Bash", command: "cat <<EOF > a.txt\nhello\nEOF\ngit commit -m x" });
    expect(after.deny).toMatch(/verse8_checkpoint/);
  });

  test("refuses only the vite forms that start a server", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    for (const command of ["vite --help", "vite optimize", "vite --mode production build", "vite  build", "bunx vite build"]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toBeUndefined();
    }
    for (const command of ["vite", "vite dev", "vite serve", "vite preview", "vite --host 0.0.0.0 --port 5173", "bunx vite"]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toMatch(/verse8_preview/);
    }
  });

  test("reads a long run of git options in linear time", async ($, on) => {
    stubs(on, { inProject: true, git: repo() });
    await $.session.start(SESSION);
    const command = "git " + Array.from({ length: 200 }, (_, i) => `--opt-${i}`).join(" ");
    const started = Date.now();
    const r: any = await $.tool.call({ tool: "Bash", command });
    expect(Date.now() - started).toBeLessThan(200);
    expect(r.deny).toBeUndefined();
    const commit: any = await $.tool.call({ tool: "Bash", command: `${command} commit -m x` });
    expect(commit.deny).toMatch(/verse8_checkpoint/);
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

  test("a failed preview leaves the baseline where it was", async ($, on) => {
    const git = repo({ head: "aaa111" });
    stubs(on, {
      inProject: true,
      git,
      tool: (e) => (e.tool.endsWith("__verse8_preview") ? { result: [{ type: "text", text: "preview failed" }], text: "preview failed", isError: true } : { result: "ran" }),
    });
    await $.session.start(SESSION);
    git.head = "bbb222";
    git.diff["aaa111"] = "src/a.ts\n";
    await $.tool.call({ tool: "mcp__verse8__verse8_preview" });
    await endTurn($);
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /1 file changed since this session started/ })).toBeDefined();
    await ui.unmount();
  });

  test("a reload's session.start keeps the last preview baseline", async ($, on) => {
    const git = repo({ head: "aaa111" });
    stubs(on, { inProject: true, git });
    await $.session.start(SESSION);
    await $.tool.call({ tool: "mcp__verse8__verse8_preview" });
    git.head = "bbb222";
    git.diff["aaa111"] = "src/a.ts\n";
    await $.session.start(SESSION); // the plugin reloaded
    await endTurn($);
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /1 file changed since the last preview/ })).toBeDefined();
    await ui.unmount();
  });

  test("git status takes no optional locks", async ($, on) => {
    const git = repo();
    stubs(on, { inProject: true, git });
    await $.session.start(SESSION);
    await endTurn($);
    expect(git.calls.find((argv) => argv.includes("status"))).toEqual(["git", "--no-optional-locks", "status", "--porcelain"]);
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
