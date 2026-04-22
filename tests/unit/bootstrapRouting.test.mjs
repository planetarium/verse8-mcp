import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServer } from "../../dist/server.js";

/**
 * Grep-level regression guards for the routing prose baked into
 * BASE_TOOLS descriptions. These strings are what LLMs (Codex, Claude,
 * …) see when they enumerate `tools/list`. A weakening of the language
 * here is the same UX regression that caused 0.4.x Codex sessions to
 * skip verse8_bootstrap entirely.
 */

function getHandler(server, methodName) {
  const handler = server._requestHandlers.get(methodName);
  assert.ok(handler, `no handler registered for ${methodName}`);
  return handler;
}

function withIsolatedEnv(fn) {
  const prevTok = process.env.VERSE8_ACCESS_TOKEN;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-routing-"));
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  delete process.env.VERSE8_ACCESS_TOKEN;
  try {
    return fn();
  } finally {
    if (prevTok !== undefined) process.env.VERSE8_ACCESS_TOKEN = prevTok;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

async function listTools() {
  const server = createServer();
  const handler = getHandler(server, "tools/list");
  const result = await handler({ method: "tools/list", params: {} }, {});
  return result.tools;
}

test("tools/list: verse8_bootstrap is present and listed before login_start", async () => {
  await withIsolatedEnv(async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    const bootIdx = names.indexOf("verse8_bootstrap");
    const loginIdx = names.indexOf("verse8_login_start");
    assert.ok(bootIdx >= 0, "verse8_bootstrap missing from tools/list");
    assert.ok(loginIdx >= 0, "verse8_login_start missing from tools/list");
    assert.ok(
      bootIdx < loginIdx,
      `bootstrap should be listed before login_start (got bootIdx=${bootIdx}, loginIdx=${loginIdx})`,
    );
  });
});

test("verse8_bootstrap description contains imperative 'CALL THIS FIRST' hook", async () => {
  await withIsolatedEnv(async () => {
    const tools = await listTools();
    const boot = tools.find((t) => t.name === "verse8_bootstrap");
    assert.ok(boot);
    assert.match(boot.description, /CALL THIS FIRST/);
    assert.match(boot.description, /nextTool/);
    // Strong guardrail — agents must NOT start editing files before
    // bootstrap returns a classification.
    assert.match(boot.description, /BEFORE any Edit\/Write\/Bash/i);
  });
});

test("verse8_new_project_start description references verse8_bootstrap routing", async () => {
  await withIsolatedEnv(async () => {
    const tools = await listTools();
    const startTool = tools.find((t) => t.name === "verse8_new_project_start");
    assert.ok(startTool);
    assert.match(startTool.description, /verse8_bootstrap/);
    // The description must tell the agent to call this tool when the
    // bootstrap/status workflow nextTool names it.
    assert.match(startTool.description, /workflow\.nextTool/);
    assert.match(startTool.description, /verse8_new_project_start/);
  });
});

test("verse8_attach description references bootstrap routing + idempotence", async () => {
  await withIsolatedEnv(async () => {
    const tools = await listTools();
    const attachTool = tools.find((t) => t.name === "verse8_attach");
    assert.ok(attachTool);
    assert.match(attachTool.description, /verse8_bootstrap/);
    assert.match(attachTool.description, /idempotent/i);
  });
});
