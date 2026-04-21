import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServer } from "../../dist/server.js";

function getHandler(server, methodName) {
  const map = server._requestHandlers;
  assert.ok(map, "server._requestHandlers not present — SDK shape changed?");
  const handler = map.get(methodName);
  assert.ok(handler, `no handler registered for ${methodName}`);
  return handler;
}

function envelopeJson(result) {
  const first = result.content[0];
  return JSON.parse(first.text);
}

function withNoRealToken(fn) {
  const prevTok = process.env.VERSE8_ACCESS_TOKEN;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-shim-"));
  delete process.env.VERSE8_ACCESS_TOKEN;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  try {
    return fn();
  } finally {
    if (prevTok !== undefined) process.env.VERSE8_ACCESS_TOKEN = prevTok;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

test("M4.5: verse8_new_project is no longer listed in tools/list", async () => {
  await withNoRealToken(async () => {
    const server = createServer();
    const handler = getHandler(server, "tools/list");
    const result = await handler({ method: "tools/list", params: {} }, {});
    const names = result.tools.map((t) => t.name);
    assert.ok(!names.includes("verse8_new_project"), `found shim in tools/list: ${names}`);
    // Sanity: the split tools must still be present.
    assert.ok(names.includes("verse8_new_project_start"));
    assert.ok(names.includes("verse8_new_project_confirm"));
  });
});

test("M4.5: calling verse8_new_project falls through to not_logged_in / unknown_tool (no tool_renamed shim)", async () => {
  await withNoRealToken(async () => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    const result = await handler(
      {
        method: "tools/call",
        params: { name: "verse8_new_project", arguments: {} },
      },
      {},
    );
    const body = envelopeJson(result);
    // Without a token, the fallthrough path returns not_logged_in. With a
    // token but no matching image proxy, it returns unknown_tool.
    // Either way, the shim's tool_renamed response must NOT be returned.
    assert.ok(body.error !== "tool_renamed", `shim still active: ${JSON.stringify(body)}`);
    assert.ok(["not_logged_in", "unknown_tool"].includes(body.error));
  });
});
