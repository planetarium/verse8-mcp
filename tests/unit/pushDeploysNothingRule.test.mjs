import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../../dist/server.js";
import { AGENTS_MD_TEMPLATE } from "../../dist/prompts/agentsMdTemplate.js";

/**
 * The vendored agent8-skills `gameserver-sdk` skill says a push builds and
 * deploys the game server. That holds in the Agent8 web editor (it sends a
 * preview deploy after each turn), not through this MCP: nothing deploys on
 * push, `verse8_preview` deploys the server for testing and `verse8_deploy`
 * publishes. Both the server instructions and the AGENTS.md template say so,
 * and the template rule sits before the skills it overrides.
 */

test("SERVER_INSTRUCTIONS: a push deploys nothing; verse8_preview deploys the server", () => {
  const text = createServer()._instructions;
  assert.match(text, /A push deploys nothing, whatever a skill says/);
  assert.match(text, /`verse8_preview` deploys the server for testing/);
});

test("AGENTS_MD_TEMPLATE: a push deploys nothing; preview to test, deploy to publish", () => {
  assert.match(AGENTS_MD_TEMPLATE, /\*\*A push deploys nothing here\.\*\*/);
  assert.match(AGENTS_MD_TEMPLATE, /run `verse8_preview` to\s+build \+ deploy the server for testing, `verse8_deploy` to publish/);
  assert.match(AGENTS_MD_TEMPLATE, /This rule overrides any skill text\./);
});

test("AGENTS_MD_TEMPLATE: the rule sits in the deploy section, before the skills catalog", () => {
  const section = AGENTS_MD_TEMPLATE.indexOf("## 🚨 Deploy only through `verse8_deploy`");
  const rule = AGENTS_MD_TEMPLATE.indexOf("A push deploys nothing here.");
  const next = AGENTS_MD_TEMPLATE.indexOf("## You are operating inside a Verse8 project");
  const catalog = AGENTS_MD_TEMPLATE.indexOf("{{SKILLS_CATALOG}}");
  assert.ok(section >= 0 && section < rule && rule < next && rule < catalog);
});
