// The verse8-docs core skill points agents at live docs.verse8.io pages and at
// the installed skill for each topic. These tests check that it is installed
// like the other core skills, and that the skill names and links it gives
// still point somewhere. Whether each page exists on the live site is checked
// by hand when the table of contents is updated, not in CI.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { REPO_ROOT } from "./_repoPaths.mjs";
import { listSkillResources } from "../../dist/resources/skills.js";
import { applyAttachmentArtifacts } from "../../dist/tools/attach.js";

const SKILL = fs.readFileSync(path.join(REPO_ROOT, "skills", "verse8-docs", "SKILL.md"), "utf8");

test("verse8-docs: attach installs it for Claude Code and lists it in the AGENTS.md catalog", () => {
  // No package.json: core skills do not depend on the project's packages.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verse8-docs-attach-")));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    const installed = fs.readFileSync(path.join(root, ".claude", "skills", "verse8-docs", "SKILL.md"), "utf8");
    assert.match(installed, /^---\nname: verse8-docs\n/);
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /\| `verse8-docs` \| Read the official Verse8 docs .*\| `verse8:\/\/skill\/verse8-docs\/SKILL\.md` \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verse8-docs: every skill named in the table of contents is bundled", () => {
  const bundled = new Set(listSkillResources().map((s) => s.name));
  const toc = SKILL.slice(SKILL.indexOf("## Table of contents"));
  const rows = toc.split("\n").filter((ln) => ln.startsWith("| ") && !ln.startsWith("| Page"));
  const named = new Set();
  for (const row of rows) {
    const skillCell = row.split(" | ")[2] ?? "";
    for (const m of skillCell.matchAll(/`([a-z0-9-]+)`/g)) named.add(m[1]);
  }
  assert.ok(named.size >= 7, `expected the topic skills, got ${[...named]}`);
  assert.deepEqual([...named].filter((n) => !bundled.has(n)), []);
});

test("verse8-docs: page paths are relative to /en/docs/ and appear once", () => {
  const toc = SKILL.slice(SKILL.indexOf("## Table of contents"));
  const paths = [...toc.matchAll(/^\| [^|]+ \| `([^`]+)` \|/gm)].map((m) => m[1]);
  assert.ok(paths.length >= 48, `expected the full table of contents, got ${paths.length}`);
  for (const p of paths) assert.match(p, /^(guide|verse8|gameserver|vxshop|ads|local-cache)\/[\w./-]+$/, p);
  assert.equal(new Set(paths).size, paths.length, "duplicate page path");
  // Absolute links use the /en/ prefix: a bare /docs/ link redirects by Accept-Language.
  for (const m of SKILL.matchAll(/https:\/\/docs\.verse8\.io(\/[^\s`)*]*)?/g)) {
    const p = m[1] ?? "";
    assert.ok(p === "" || p.startsWith("/en/docs"), `link without /en/: ${m[0]}`);
  }
});
