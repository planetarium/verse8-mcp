// Tests of the Verse8 mod (hooks/verse8.mjs). Run with:
//   claude plugin test plugins/verse8
import { describe, expect, test } from "claude-code/testing";

const SESSION = { surface: "terminal", isInteractive: true, cwd: "/work" } as any;

function stubs(on: any, { inProject }: { inProject: boolean }) {
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd }));
  on("fs.exists", () => ({ value: inProject }));
  on("tool.call", () => ({ result: "ran" }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.render", () => ({ type: "Box", props: {}, children: [] }));
}

describe("gatekeeper", () => {
  test("refuses a raw git commit in a Verse8 project", async ($, on) => {
    stubs(on, { inProject: true });
    await $.session.start(SESSION);
    const r: any = await $.tool.call({ tool: "Bash", command: 'git add -A && git commit -m "wip"' });
    expect(r.deny).toMatch(/verse8_checkpoint/);
  });

  test("refuses --no-verify with its own reason", async ($, on) => {
    stubs(on, { inProject: true });
    await $.session.start(SESSION);
    const r: any = await $.tool.call({ tool: "Bash", command: "git commit --no-verify -m x" });
    expect(r.deny).toMatch(/--no-verify/);
  });

  test("refuses a hand-started dev server", async ($, on) => {
    stubs(on, { inProject: true });
    await $.session.start(SESSION);
    for (const command of ["bun run dev", "cd app && npm run dev", "npx vite --port 3000"]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toMatch(/verse8_preview/);
    }
  });

  test("lets harmless git and build commands through", async ($, on) => {
    stubs(on, { inProject: true });
    await $.session.start(SESSION);
    for (const command of ["git log --oneline -5", "git status", "bun run build", "vite build", "grep -rn commit src/"]) {
      const r: any = await $.tool.call({ tool: "Bash", command });
      expect(r.deny).toBeUndefined();
      expect(r.result).toBe("ran");
    }
  });

  test("does nothing outside a Verse8 project", async ($, on) => {
    stubs(on, { inProject: false });
    await $.session.start(SESSION);
    const r: any = await $.tool.call({ tool: "Bash", command: 'git commit -m "normal repo"' });
    expect(r.deny).toBeUndefined();
    expect(r.result).toBe("ran");
  });
});

describe("preview bell", () => {
  const band = ($: any) =>
    $.ui.mount({
      plugin: "verse8",
      surface: "terminal",
      component: "AbovePrompt",
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    } as any);

  const endTurn = ($: any, turnId: string) =>
    $.turn.complete({ turnId, reason: "answer", answer: "ok", durationMs: 1, isAborted: false } as any);

  test("draws nothing while no edits happened", async ($, on) => {
    stubs(on, { inProject: true });
    await $.session.start(SESSION);
    await endTurn($, "t0");
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();
  });

  test("reminds after a turn that edited files without a preview", async ($, on) => {
    stubs(on, { inProject: true });
    await $.session.start(SESSION);
    await $.tool.call({ tool: "Edit", file_path: "src/App.tsx", old_string: "a", new_string: "b" });
    await $.tool.call({ tool: "Write", file_path: "src/new.ts", content: "x" });
    await endTurn($, "t1");
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /2 file edits since the last preview/ })).toBeDefined();
    await ui.unmount();
  });

  test("clears once verse8_preview runs (either MCP tool name)", async ($, on) => {
    stubs(on, { inProject: true });
    await $.session.start(SESSION);
    await $.tool.call({ tool: "Edit", file_path: "src/App.tsx", old_string: "a", new_string: "b" });
    await endTurn($, "t1");
    await $.tool.call({ tool: "mcp__plugin_verse8_verse8__verse8_preview" });
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();
  });

  test("ignores edits made by subagents and outside Verse8 projects", async ($, on) => {
    stubs(on, { inProject: false });
    await $.session.start(SESSION);
    await $.tool.call({ tool: "Edit", file_path: "x", old_string: "a", new_string: "b" });
    await $.tool.call({ tool: "Edit", file_path: "x", old_string: "a", new_string: "b", agentId: "sub-1" } as any);
    await endTurn($, "t2");
    const ui = await band($);
    expect(await ui.find({ type: "Text", text: /Verse8/ })).toBeUndefined();
    await ui.unmount();
  });
});
