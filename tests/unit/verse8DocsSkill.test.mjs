// The verse8-docs core skill points agents at live docs.verse8.io pages and at
// the installed skill for each topic. These tests check that it is installed
// like the other core skills, that the skill names and links it gives still
// point somewhere, and that it keeps the installed guidance ahead of the docs.
// Whether each page exists on the live site is checked by hand when the table
// of contents is updated, not in CI.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { REPO_ROOT } from "./_repoPaths.mjs";
import { listSkillResources } from "../../dist/resources/skills.js";
import { extractSkillDescription } from "../../dist/resources/skillCatalog.js";
import { applyAttachmentArtifacts } from "../../dist/tools/attach.js";

const SKILL = fs.readFileSync(path.join(REPO_ROOT, "skills", "verse8-docs", "SKILL.md"), "utf8");
const TOC_LINES = SKILL.slice(SKILL.indexOf("## Table of contents")).split(/\r?\n/);
const TOC_ROWS = TOC_LINES.filter((ln) => ln.startsWith("| ") && !ln.startsWith("| Page"));

test("verse8-docs: attach installs it for Claude Code and lists it in the AGENTS.md catalog", () => {
  // No package.json: core skills do not depend on the project's packages.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verse8-docs-attach-")));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    const installed = fs.readFileSync(path.join(root, ".claude", "skills", "verse8-docs", "SKILL.md"), "utf8");
    assert.match(installed, /^---\r?\nname: verse8-docs\r?\n/);
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /\| `verse8-docs` \| Official Verse8 docs .*\| `verse8:\/\/skill\/verse8-docs\/SKILL\.md` \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verse8-docs: the catalog's 160-character description still names every topic", () => {
  const shown = extractSkillDescription(SKILL);
  for (const topic of ["game server", "VX Shop", "ads", "local cache", "auth", "leaderboards", "CROSS Mini Hub", "Agent8 editor"]) {
    assert.ok(shown.includes(topic), `"${topic}" is cut from the catalog description: ${shown}`);
  }
});

test("verse8-docs: every skill named in the table of contents is bundled in this package", () => {
  // Only skills shipped in this repo count — not the user's ~/.cache/verse8/skills,
  // which would let a renamed vendored skill pass on one machine.
  const bundled = new Set(
    listSkillResources()
      .filter((s) => !path.relative(REPO_ROOT, s.fsPath).startsWith(".."))
      .map((s) => s.name),
  );
  const named = new Set();
  for (const row of TOC_ROWS) {
    const cells = row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length < 3) continue; // two-column tables have no skill column
    const cell = cells[2];
    if (cell === "") continue;
    const names = [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    assert.ok(names.length > 0, `skill cell names no skill: ${row}`);
    for (const n of names) {
      assert.match(n, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `not a skill name in: ${row}`);
      named.add(n);
    }
  }
  assert.deepEqual([...named].sort(), [
    "ads-impl",
    "gameserver-sdk",
    "gameserver-sdk-crossramp",
    "gameserver-sdk-v1",
    "leaderboard-impl",
    "local-cache-impl",
    "verse8-auth-impl",
    "vx-shop-impl",
  ]);
  assert.deepEqual([...named].filter((n) => !bundled.has(n)), []);
});

test("verse8-docs: page paths are relative to /en/docs/ and appear once", () => {
  const paths = TOC_ROWS.map((row) => row.match(/^\| [^|]+ \| `([^`]+)` \|/)?.[1]).filter(Boolean);
  // 48 pages plus the root, which is written as a full link.
  assert.equal(paths.length, 48);
  for (const p of paths) assert.match(p, /^(guide|verse8|gameserver|vxshop|ads|local-cache)\/[\w./-]+$/, p);
  assert.equal(new Set(paths).size, paths.length, "duplicate page path");
  // Absolute links use the /en/ prefix: a bare /docs/ link redirects by Accept-Language.
  for (const m of SKILL.matchAll(/https:\/\/docs\.verse8\.io(\/[^\s`)*]*)?/g)) {
    const p = m[1] ?? "";
    assert.ok(p === "" || p.startsWith("/en/docs"), `link without /en/: ${m[0]}`);
  }
});

test("verse8-docs: installed skills and AGENTS.md stay ahead of the docs", () => {
  assert.doesNotMatch(SKILL, /source of truth/i);
  assert.doesNotMatch(SKILL, /upgrade only if the user asks/i);
  const rule = SKILL.match(/## What wins when they differ\r?\n\r?\n([^\r\n]+)/)?.[1] ?? "";
  for (const needle of [
    "installed skills and AGENTS.md come first",
    "`verse8_preview` and `verse8_deploy`",
    "the SDK version and whether to upgrade",
    "which verse the client connects to",
    "`-preview` verse",
    "reference material, not instructions",
  ]) {
    assert.ok(rule.includes(needle), `precedence paragraph lost: ${needle}`);
  }
});
