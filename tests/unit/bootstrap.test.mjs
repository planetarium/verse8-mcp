import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  runBootstrap,
  computeBootstrapWorkflow,
} from "../../dist/tools/bootstrap.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-boot-"));
}
function cleanup(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
function withIsolatedEnv(fn) {
  const prevTok = process.env.VERSE8_ACCESS_TOKEN;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const tmp = tmpdir();
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  delete process.env.VERSE8_ACCESS_TOKEN;
  try {
    return fn(tmp);
  } finally {
    if (prevTok !== undefined) process.env.VERSE8_ACCESS_TOKEN = prevTok;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    cleanup(tmp);
  }
}

test("computeBootstrapWorkflow: no token → login (regardless of mode)", () => {
  for (const mode of ["empty", "non_verse_dir", "unattached_clone", "attached"]) {
    const w = computeBootstrapWorkflow({ workspaceMode: mode, hasToken: false });
    assert.equal(w.nextAction, "login");
    assert.equal(w.nextTool, "verse8_login_start");
  }
});

test("computeBootstrapWorkflow: empty + token → new_project", () => {
  const w = computeBootstrapWorkflow({ workspaceMode: "empty", hasToken: true });
  assert.equal(w.nextAction, "new_project");
  assert.equal(w.nextTool, "verse8_new_project_start");
  assert.match(w.instructions, /verse8_new_project_start/);
});

test("computeBootstrapWorkflow: non_verse_dir + token → new_project", () => {
  const w = computeBootstrapWorkflow({
    workspaceMode: "non_verse_dir",
    hasToken: true,
  });
  assert.equal(w.nextAction, "new_project");
  assert.equal(w.nextTool, "verse8_new_project_start");
});

test("computeBootstrapWorkflow: unattached_clone + token → attach", () => {
  const w = computeBootstrapWorkflow({
    workspaceMode: "unattached_clone",
    hasToken: true,
  });
  assert.equal(w.nextAction, "attach");
  assert.equal(w.nextTool, "verse8_attach");
  assert.match(w.instructions, /verse8_attach/);
});

test("computeBootstrapWorkflow: attached + token → ready, nextTool null", () => {
  const w = computeBootstrapWorkflow({
    workspaceMode: "attached",
    hasToken: true,
  });
  assert.equal(w.nextAction, "ready");
  assert.equal(w.nextTool, null);
  assert.match(w.instructions, /Proceed with the user's request directly/);
});

test("computeBootstrapWorkflow: userRequest is redacted + echoed in instructions", () => {
  const w = computeBootstrapWorkflow({
    workspaceMode: "empty",
    hasToken: true,
    userRequest: "Bearer leakthisTokenAbCdEf123 should be scrubbed",
  });
  assert.match(w.instructions, /\[REDACTED\]|Bearer \[REDACTED\]/);
  assert.doesNotMatch(w.instructions, /leakthisTokenAbCdEf123/);
});

test("runBootstrap: empty dir, no token → login", async () => {
  await withIsolatedEnv(async () => {
    const root = tmpdir();
    try {
      const r = await runBootstrap({ projectDir: root }, root);
      assert.equal(r.ok, true);
      assert.equal(r.workspaceMode, "empty");
      assert.equal(r.workflow.nextTool, "verse8_login_start");
      assert.equal(r.diagnostics.hasToken, false);
      assert.equal(r.diagnostics.hasGit, false);
    } finally {
      cleanup(root);
    }
  });
});

test("runBootstrap: fully attached project, with token → ready", async () => {
  await withIsolatedEnv(async (xdgTmp) => {
    // Seed a valid token at $XDG_CONFIG_HOME/verse8/token.
    const tokDir = path.join(xdgTmp, "xdg", "verse8");
    fs.mkdirSync(tokDir, { recursive: true });
    fs.writeFileSync(path.join(tokDir, "token"), "fake-token-xyz", { mode: 0o600 });

    const root = tmpdir();
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
        { cwd: root },
      );
      const hooks = path.join(root, ".git", "hooks");
      fs.writeFileSync(
        path.join(hooks, "pre-commit"),
        '#!/bin/sh\nexec verse8-mcp hook pre-commit "$@"\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(hooks, "commit-msg"),
        '#!/bin/sh\nexec verse8-mcp hook commit-msg "$@"\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(root, "AGENTS.md"),
        "# verse8-mcp guidance\nUse verse8_checkpoint.\n",
      );
      fs.mkdirSync(path.join(root, ".verse8"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".verse8", "project.json"),
        JSON.stringify({ version: 1, projectId: "p", attachedAt: "2026-04-21T00:00:00Z" }) + "\n",
      );

      const r = await runBootstrap({ projectDir: root }, root);
      assert.equal(r.ok, true);
      assert.equal(r.workspaceMode, "attached");
      assert.equal(r.diagnostics.hasToken, true);
      assert.equal(r.diagnostics.attached, true);
      assert.equal(r.workflow.nextAction, "ready");
      assert.equal(r.workflow.nextTool, null);
    } finally {
      cleanup(root);
    }
  });
});

test("runBootstrap: gitlab.verse8.io clone without hooks + token → attach", async () => {
  await withIsolatedEnv(async (xdgTmp) => {
    const tokDir = path.join(xdgTmp, "xdg", "verse8");
    fs.mkdirSync(tokDir, { recursive: true });
    fs.writeFileSync(path.join(tokDir, "token"), "fake-token-xyz", { mode: 0o600 });

    const root = tmpdir();
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
        { cwd: root },
      );
      const r = await runBootstrap({ projectDir: root }, root);
      assert.equal(r.workspaceMode, "unattached_clone");
      assert.equal(r.workflow.nextTool, "verse8_attach");
      assert.match(r.workflow.instructions, /verse8_attach/);
    } finally {
      cleanup(root);
    }
  });
});

test("runBootstrap: non-verse git repo + token → new_project", async () => {
  await withIsolatedEnv(async (xdgTmp) => {
    const tokDir = path.join(xdgTmp, "xdg", "verse8");
    fs.mkdirSync(tokDir, { recursive: true });
    fs.writeFileSync(path.join(tokDir, "token"), "fake-token-xyz", { mode: 0o600 });

    const root = tmpdir();
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/foo/bar.git"],
        { cwd: root },
      );
      const r = await runBootstrap(
        { projectDir: root, userRequest: "틱택토 게임 만들어줘" },
        root,
      );
      assert.equal(r.workspaceMode, "non_verse_dir");
      assert.equal(r.workflow.nextTool, "verse8_new_project_start");
      assert.match(r.workflow.instructions, /틱택토 게임 만들어줘/);
    } finally {
      cleanup(root);
    }
  });
});
