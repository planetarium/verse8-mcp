import { test } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../../dist/server.js";
import { AGENTS_MD_TEMPLATE } from "../../dist/prompts/agentsMdTemplate.js";
import { getNewProjectBootstrapPrompt } from "../../dist/prompts/newProjectBootstrap.js";

async function listTools() {
  const saved = { tok: process.env.VERSE8_ACCESS_TOKEN, fetch: globalThis.fetch };
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  globalThis.fetch = async () => new Response("{}", { status: 503 }); // proxy discovery
  try {
    const { tools } = await createServer()._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    return tools;
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}

// runPreview skips only the checkpoint on startOnly; preflight is gated on
// skipPreflight alone (#31). The docs used to say startOnly skipped both.
test("verse8_preview docs: startOnly skips the commit, not preflight; description under 2,048 chars", async () => {
  const t = (await listTools()).find((x) => x.name === "verse8_preview");
  assert.ok(t);
  assert.ok(t.description.length <= 2048, `${t.description.length}`);
  assert.doesNotMatch(t.description, /AND preflight/i);
  assert.match(t.inputSchema.properties.startOnly.description, /skipPreflight/);

  const i = AGENTS_MD_TEMPLATE.indexOf("Use `startOnly: true`");
  assert.ok(i >= 0);
  assert.match(AGENTS_MD_TEMPLATE.slice(i, i + 300), /not the preflight[\s\S]*skipPreflight: true/);
});

// The agent8-backend client and its mock call GET /api/select-template.
test("new-project step list: GET /api/select-template in both AGENTS.md and the new-project prompt", () => {
  const prompt = getNewProjectBootstrapPrompt().messages[0].content.text;
  for (const [name, text] of [["AGENTS.md", AGENTS_MD_TEMPLATE], ["new-project prompt", prompt]]) {
    assert.match(text, /GET\s+\/api\/select-template/, name);
    assert.doesNotMatch(text, /POST\s+\/api\/select-template/, name);
  }
});

// The commit-msg hook rejects format drift (exit 1) and only warns about
// missing narrative — AGENTS.md must not call both "warnings".
test("AGENTS.md commit policy: format drift is rejected, missing narrative only warns", () => {
  assert.doesNotMatch(AGENTS_MD_TEMPLATE, /warnings on\s+stderr if your commit drifts from the format/);
  assert.match(AGENTS_MD_TEMPLATE, /drifts from\s+the format is rejected/);
  assert.match(AGENTS_MD_TEMPLATE, /missing narrative is accepted with warnings/);
});
