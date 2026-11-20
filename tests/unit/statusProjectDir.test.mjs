// verse8_status takes `projectDir` like verse8_checkpoint / verse8_preview.
// Without it, a project in a subdirectory of the MCP server's cwd was
// reported as not a verse8 project.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createServer } from "../../dist/server.js";
import { statusInputSchema } from "../../dist/tools/status.js";

function withIsolatedEnv(fn) {
  const prevTok = process.env.VERSE8_ACCESS_TOKEN;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-status-pd-"));
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  delete process.env.VERSE8_ACCESS_TOKEN;
  return Promise.resolve(fn(dir)).finally(() => {
    if (prevTok !== undefined) process.env.VERSE8_ACCESS_TOKEN = prevTok;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
}

/** <root>/games/demo is a verse8 project; <root> itself is not. */
function makeNestedProject(root) {
  const dir = path.join(root, "games", "demo");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git"], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".verse8"));
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ version: 1, projectId: "demo" }));
  return dir;
}

async function callStatus(args) {
  const server = createServer();
  const handler = server._requestHandlers.get("tools/call");
  const res = await handler(
    { method: "tools/call", params: { name: "verse8_status", arguments: args } },
    {},
  );
  return JSON.parse(res.content[0].text);
}

test("statusInputSchema: accepts an absolute projectDir and rejects `..`", () => {
  assert.deepEqual(statusInputSchema.parse({}), {});
  const abs = path.resolve(os.tmpdir(), "x");
  assert.equal(statusInputSchema.parse({ projectDir: abs }).projectDir, abs);
  assert.throws(() => statusInputSchema.parse({ projectDir: path.join(os.tmpdir(), "a") + path.sep + ".." + path.sep + "b" }));
  assert.throws(() => statusInputSchema.parse({ unknown: 1 }));
});

test("verse8_status: projectDir pointing at a nested project reports it as a verse8 project", async () => {
  await withIsolatedEnv(async (root) => {
    const projectDir = makeNestedProject(root);
    const prevCwd = process.cwd();
    process.chdir(root); // the MCP server's cwd is the parent, not the project
    try {
      const withoutDir = await callStatus({});
      assert.equal(withoutDir.project.isVerse, false);

      const withDir = await callStatus({ projectDir });
      assert.equal(withDir.error, "not_logged_in");
      assert.equal(withDir.project.isVerse, true);
      assert.equal(withDir.project.projectDir, projectDir);
      assert.equal(withDir.project.projectId, "demo");
    } finally {
      process.chdir(prevCwd);
    }
  });
});

test("tools/list: verse8_status advertises projectDir", async () => {
  await withIsolatedEnv(async () => {
    const server = createServer();
    const handler = server._requestHandlers.get("tools/list");
    const { tools } = await handler({ method: "tools/list", params: {} }, {});
    const status = tools.find((t) => t.name === "verse8_status");
    assert.ok(status.inputSchema.properties.projectDir, JSON.stringify(status.inputSchema));
    assert.match(status.description, /projectDir/);
  });
});
