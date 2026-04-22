import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../../dist/server.js";

/**
 * 0.5.3 — `InitializeResult.instructions` is the strongest signal an MCP
 * server can send to the host LLM (Claude Code / Cursor / opencode include
 * it in the system prompt). Regression-guard the policy text so a future
 * edit that drops or weakens it fails the build.
 */

test("server: InitializeResult.instructions is set with the verse8 mandatory policy", () => {
  const server = createServer();
  // The MCP SDK stores instructions on the private _instructions field;
  // it is also surfaced in the initialize response. Read directly so we
  // do not need a full handshake to assert.
  const text = server._instructions;
  assert.ok(typeof text === "string" && text.length > 100,
    "expected a non-empty instructions string on the server");
  // Bootstrap-first directive.
  assert.match(text, /verse8_bootstrap/);
  assert.match(text, /at the START of EVERY turn/);
  // Mandatory rules.
  assert.match(text, /verse8_checkpoint/);
  assert.match(text, /verse8_preview/);
  assert.match(text, /--no-verify/);
  // Asset tooling pointer.
  assert.match(text, /image_asset_generate/);
});

test("prompts/list: registers /verse8:bootstrap, /verse8:attach, /verse8:status, /verse8:verse8-new-project-bootstrap", async () => {
  const server = createServer();
  const handler = server._requestHandlers.get("prompts/list");
  assert.ok(handler);
  const result = await handler({ method: "prompts/list", params: {} }, {});
  const names = result.prompts.map((p) => p.name);
  for (const expected of [
    "bootstrap",
    "attach",
    "status",
    "verse8-new-project-bootstrap",
  ]) {
    assert.ok(
      names.includes(expected),
      `prompts/list missing '${expected}'; got ${names.join(", ")}`,
    );
  }
});

test("prompts/get: /verse8:attach returns a user message that triggers verse8_attach + commit", async () => {
  const server = createServer();
  const handler = server._requestHandlers.get("prompts/get");
  const result = await handler(
    { method: "prompts/get", params: { name: "attach" } },
    {},
  );
  assert.ok(Array.isArray(result.messages));
  assert.equal(result.messages.length, 1);
  const msg = result.messages[0];
  assert.equal(msg.role, "user");
  assert.equal(msg.content.type, "text");
  assert.match(msg.content.text, /verse8_attach/);
  // Should also nudge committing the resulting AGENTS.md / CLAUDE.md so
  // future clones don't lose the guidance.
  assert.match(msg.content.text, /verse8_checkpoint/);
});

test("prompts/get: /verse8:bootstrap returns a user message that triggers verse8_bootstrap", async () => {
  const server = createServer();
  const handler = server._requestHandlers.get("prompts/get");
  const result = await handler(
    { method: "prompts/get", params: { name: "bootstrap" } },
    {},
  );
  const text = result.messages[0].content.text;
  assert.match(text, /verse8_bootstrap/);
  assert.match(text, /workflow\.nextAction|workflow\.nextTool/);
});

test("prompts/get: /verse8:status returns a user message that triggers verse8_status", async () => {
  const server = createServer();
  const handler = server._requestHandlers.get("prompts/get");
  const result = await handler(
    { method: "prompts/get", params: { name: "status" } },
    {},
  );
  const text = result.messages[0].content.text;
  assert.match(text, /verse8_status/);
});
