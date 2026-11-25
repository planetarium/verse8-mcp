import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, repoPathRefs } from "./_repoPaths.mjs";

import { createServer } from "../../dist/server.js";
import { parseV8CommitMessage } from "../../dist/format/v8CommitMessage.js";
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

const CORE_SKILLS = fs
  .readdirSync(path.join(REPO_ROOT, "skills"))
  .map((name) => path.join("skills", name, "SKILL.md"))
  .filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)));

// The verse8-commit skill is installed into game projects, which have no copy
// of this repo — so the example lives in the doc and must stay parseable.
test("verse8-commit skill: the full example is a V8 message the hook accepts without warnings", () => {
  const doc = fs.readFileSync(path.join(REPO_ROOT, "skills", "verse8-commit", "SKILL.md"), "utf8");
  const m = doc.match(/## Full example[\s\S]*?```text\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(m, "no ```text block under '## Full example'");
  const parsed = parseV8CommitMessage(m[1]);
  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues));
  assert.deepEqual(parsed.warnings, []);
});

// Core skills, AGENTS.md and the new-project prompt are read by agents inside
// a game project. A path into this repo (src/format/…, scripts/…) is a file
// that agent cannot open.
test("installed docs: no references to files inside the verse8-mcp repo", () => {
  const docs = [
    ["AGENTS.md template", AGENTS_MD_TEMPLATE],
    ["new-project prompt", getNewProjectBootstrapPrompt().messages[0].content.text],
    ...CORE_SKILLS.map((rel) => [rel, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")]),
  ];
  assert.ok(CORE_SKILLS.length >= 3);
  // The checker itself: a sentence-ending dot must not hide a repo path,
  // and a game-project path is not a repo path.
  assert.deepEqual(repoPathRefs("See src/server.ts. Or scripts/verse8-login.sh."), ["src/server.ts", "scripts/verse8-login.sh"]);
  assert.deepEqual(repoPathRefs("Edit src/player.ts and .claude/skills/x/SKILL.md."), []);
  const bad = [];
  for (const [name, text] of docs) {
    for (const ref of repoPathRefs(text)) bad.push(`${name}: ${ref}`);
  }
  assert.deepEqual(bad, []);
});
