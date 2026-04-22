import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";

import { runStatus } from "../../dist/tools/status.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-status-wf-"));
}
function cleanup(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
async function startVerifyMock(respond) {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/auth/verify") {
      const { status, body } = respond();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
      }),
  };
}
function isolateEnv() {
  const prevTok = process.env.VERSE8_ACCESS_TOKEN;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevApi = process.env.VERSE8_API_URL;
  return () => {
    if (prevTok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = prevTok;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.VERSE8_API_URL;
    else process.env.VERSE8_API_URL = prevApi;
  };
}

test("verse8_status: not_logged_in + non-verse cwd → workflow.nextAction=not_verse_project (no unnecessary login nag)", async () => {
  const restore = isolateEnv();
  const xdg = tmpdir();
  const cwd = tmpdir();
  try {
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.VERSE8_ACCESS_TOKEN;
    const r = await runStatus(cwd);
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_logged_in");
    assert.ok(r.workflow);
    // Not in a verse8 project → agent shouldn't be forced to log in.
    assert.equal(r.workflow.nextAction, "not_verse_project");
    assert.equal(r.workflow.nextTool, null);
  } finally {
    cleanup(xdg);
    cleanup(cwd);
    restore();
  }
});

test("verse8_status: empty cwd + valid token → workflow.nextAction=not_verse_project (no forced verse8 creation)", async () => {
  const restore = isolateEnv();
  const xdg = tmpdir();
  const cwd = tmpdir();
  const mock = await startVerifyMock(() => ({
    status: 200,
    body: JSON.stringify({ userUid: 1, handle: "t", walletAddress: "0xaaaa" }),
  }));
  try {
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.VERSE8_ACCESS_TOKEN = "token-xyz";
    process.env.VERSE8_API_URL = mock.baseUrl;
    const r = await runStatus(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.workflow.nextAction, "not_verse_project");
    assert.equal(r.workflow.nextTool, null);
  } finally {
    await mock.close();
    cleanup(xdg);
    cleanup(cwd);
    restore();
  }
});

test("verse8_status: unattached gitlab.verse8.io clone + valid token → workflow.nextTool=verse8_attach", async () => {
  const restore = isolateEnv();
  const xdg = tmpdir();
  const cwd = tmpdir();
  const mock = await startVerifyMock(() => ({
    status: 200,
    body: JSON.stringify({ userUid: 1, handle: "t", walletAddress: "0xaaaa" }),
  }));
  try {
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.VERSE8_ACCESS_TOKEN = "token-xyz";
    process.env.VERSE8_API_URL = mock.baseUrl;
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
      { cwd },
    );
    const r = await runStatus(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.workflow.nextAction, "attach");
    assert.equal(r.workflow.nextTool, "verse8_attach");
  } finally {
    await mock.close();
    cleanup(xdg);
    cleanup(cwd);
    restore();
  }
});

test("verse8_status: attached project + valid token → workflow.nextTool=null, nextAction=ready", async () => {
  const restore = isolateEnv();
  const xdg = tmpdir();
  const cwd = tmpdir();
  const mock = await startVerifyMock(() => ({
    status: 200,
    body: JSON.stringify({ userUid: 1, handle: "t", walletAddress: "0xaaaa" }),
  }));
  try {
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.VERSE8_ACCESS_TOKEN = "token-xyz";
    process.env.VERSE8_API_URL = mock.baseUrl;
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
      { cwd },
    );
    const hooks = path.join(cwd, ".git", "hooks");
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
      path.join(cwd, "AGENTS.md"),
      "# verse8-mcp\nUse verse8_checkpoint.\n",
    );
    fs.mkdirSync(path.join(cwd, ".verse8"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".verse8", "project.json"),
      JSON.stringify({ version: 1, projectId: "p", attachedAt: "2026-04-21T00:00:00Z" }) +
        "\n",
    );
    const r = await runStatus(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.workflow.nextAction, "ready");
    assert.equal(r.workflow.nextTool, null);
  } finally {
    await mock.close();
    cleanup(xdg);
    cleanup(cwd);
    restore();
  }
});
