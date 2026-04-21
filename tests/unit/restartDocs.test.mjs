import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

// US-M2-5 / US-M2-6 regression guards: the restart-recovery guidance must
// stay present in the user-facing docs AND in the template_mismatch hints.

test("README.md documents MCP server restart recovery", () => {
  const readme = fs.readFileSync(
    new URL("../../README.md", import.meta.url),
    "utf8",
  );
  assert.match(readme, /MCP server restarted mid-flow/);
  assert.match(readme, /template_mismatch/);
  assert.match(readme, /re-run\s+`?verse8_new_project_start/i);
});

test("AGENTS.md template documents the restart recovery path", () => {
  // Template content moved out of attach.ts in M1b-1 — search the canonical
  // location at src/prompts/agentsMdTemplate.ts.
  const src = fs.readFileSync(
    new URL("../../src/prompts/agentsMdTemplate.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /MCP server restarted mid-flow/);
  assert.match(src, /startCallId/);
  assert.match(src, /re-run\s+\\?`?verse8_new_project_start/i);
});

test("template_mismatch hints (newProject.ts) mention restart recovery", () => {
  const src = fs.readFileSync(
    new URL("../../src/tools/newProject.ts", import.meta.url),
    "utf8",
  );
  // Both branches (unknown startCallId + digest mismatch) should hint at
  // the restart path.
  const hits = src.match(/MCP server may have restarted/g) ?? [];
  assert.ok(
    hits.length >= 2,
    `expected >=2 restart-recovery hints, found ${hits.length}`,
  );
});
