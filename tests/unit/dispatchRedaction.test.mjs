import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServer } from "../../dist/server.js";
import { safeHint, safeErrorHint } from "../../dist/util/redact.js";

/** Pull the registered handler for `methodName` off a Server instance. */
function getHandler(server, methodName) {
  // MCP SDK stores handlers on a private `_requestHandlers` Map. We only
  // need read access for the dispatch tests.
  const map = server._requestHandlers;
  assert.ok(map, "server._requestHandlers not present — SDK shape changed?");
  const handler = map.get(methodName);
  assert.ok(handler, `no handler registered for ${methodName}`);
  return handler;
}

/** Set up a temp scratch dir so token / project detection paths don't leak
 *  developer state into a test. We never put a real token here. */
function withCleanCwd(fn) {
  const orig = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-dispatch-redact-"));
  process.chdir(dir);
  // Make sure VERSE8_ACCESS_TOKEN doesn't bleed in from the dev env.
  const savedToken = process.env.VERSE8_ACCESS_TOKEN;
  delete process.env.VERSE8_ACCESS_TOKEN;
  try {
    return fn(dir);
  } finally {
    process.chdir(orig);
    if (savedToken !== undefined) process.env.VERSE8_ACCESS_TOKEN = savedToken;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Extract the JSON envelope text from a CallTool result. */
function envelopeText(result) {
  assert.ok(result, "no result");
  assert.ok(Array.isArray(result.content), "result.content not array");
  const first = result.content[0];
  assert.ok(first && typeof first.text === "string", "no text content");
  return first.text;
}

test("dispatch: ReadResource with tokenized URI redacts hint (skill-name path)", async () => {
  const server = createServer();
  const handler = getHandler(server, "resources/read");
  const uri = "verse8://skill/glpat-leakAbCdEf123/SKILL.md";
  const result = await handler({ method: "resources/read", params: { uri } }, {});
  const text = result.contents[0].text;
  assert.match(text, /glpat-\*\*\*/);
  assert.doesNotMatch(text, /glpat-leakAbCdEf/);
});

test("dispatch: ReadResource with non-matching URI redacts hint (regex-fail path)", async () => {
  const server = createServer();
  const handler = getHandler(server, "resources/read");
  const uri = "verse8://oauth2:glpat-secret@host/foo";
  const result = await handler({ method: "resources/read", params: { uri } }, {});
  const text = result.contents[0].text;
  assert.doesNotMatch(text, /glpat-secret/);
});

test("dispatch: GetPrompt with tokenized prompt name redacts hint", async () => {
  const server = createServer();
  const handler = getHandler(server, "prompts/get");
  const result = await handler(
    {
      method: "prompts/get",
      params: { name: "Bearer leakthis_token_abc" },
    },
    {},
  );
  const text = result.messages[0].content.text;
  assert.match(text, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(text, /leakthis_token_abc/);
});

test("dispatch: CallTool unknown_tool redacts attacker-controlled name", async () => {
  await withCleanCwd(async () => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    // Without a token, the unknown_tool path returns `not_logged_in` first.
    // Set a fake token via env so we reach the unknown_tool branch.
    process.env.VERSE8_ACCESS_TOKEN = "fake-token-for-unknown-tool-path";
    try {
      const name = "glpat-leakXyzSecret-tool";
      const result = await handler(
        {
          method: "tools/call",
          params: { name, arguments: {} },
        },
        {},
      );
      const text = envelopeText(result);
      // unknown_tool path may surface as `unknown_tool` after image proxy
      // discovery returns nothing for a fake token. The hint must be
      // redacted regardless of which error code lands.
      assert.doesNotMatch(text, /glpat-leakXyzSecret/);
    } finally {
      delete process.env.VERSE8_ACCESS_TOKEN;
    }
  });
});

test("dispatch: CallTool generic catch wraps thrown exception via safeErrorHint", async () => {
  const e = new Error(
    "clone failed: https://oauth2:glpat-leakAbCdEfGh@gitlab.verse8.io/u/p.git plus Bearer eyJtoken_abc",
  );
  const enveloped = JSON.stringify(
    { error: "tool_exception", hint: safeErrorHint(e) },
    null,
    2,
  );
  assert.doesNotMatch(enveloped, /glpat-leakAbCdEfGh/);
  assert.doesNotMatch(enveloped, /eyJtoken_abc/);
  assert.match(enveloped, /oauth2:\*\*\*@/);
  assert.match(enveloped, /Bearer \[REDACTED\]/);
});

test("dispatch: server.ts wires safeErrorHint into the generic catch (source-level guard)", async () => {
  // Belt-and-suspenders regression guard: the source must contain the
  // safeErrorHint(e) wrapping so a future refactor that re-introduces the
  // raw `(e as Error).message` leak fails this test instead of shipping.
  const src = fs.readFileSync(
    new URL("../../src/server.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /hint:\s*safeErrorHint\(e\)/);
  assert.match(src, /from "\.\/util\/redact\.js"/);
});

test("dispatch: every secret shape from SECRET_SHAPES is scrubbed by safeHint+jsonContent path", async () => {
  const samples = [
    "https://oauth2:glpat-leakUserInfoX@gitlab.verse8.io/u/p.git",
    "Authorization header: Bearer mySecretToken_with-stuff",
    'response: {"access_token":"eyJaccess","scope":"r"}',
    'response: {"refresh_token":"refSecretRR","x":1}',
    "device_code lookup: {\"device_code\":\"devSecretCode_xx\"}",
  ];
  for (const sample of samples) {
    const enveloped = JSON.stringify({ hint: safeHint(sample) });
    assert.doesNotMatch(enveloped, /glpat-leakUserInfoX/);
    assert.doesNotMatch(enveloped, /mySecretToken_with-stuff/);
    assert.doesNotMatch(enveloped, /eyJaccess/);
    assert.doesNotMatch(enveloped, /refSecretRR/);
    assert.doesNotMatch(enveloped, /devSecretCode_xx/);
  }
});
