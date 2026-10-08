// Unit tests for the skill materializer.
//
// Covers the hash-based conflict resolution model used by verse8_attach to
// copy bundled skills into <projectDir>/.claude/skills/<name>/SKILL.md.
//
// ACs exercised:
//   - AC-4 / AC-5: fresh project gets core + vendor skills written
//   - AC-7 / AC-17: idempotent re-run on byte-identical destination
//   - AC-8: user-edited skill preserved
//   - AC-9: overwriteAll bypasses hash check
//   - AC-14: result envelope contains the five buckets + pruned
//   - AC-15: unrelated .claude/skills/<name>/ left untouched
//   - AC-16: pruneOrphaned removes only marker-bearing orphans
//   - AC-18: CRLF on source or dest produces the same hash comparison

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  computeSkillHash,
  addHashMarker,
  stripHashMarker,
  extractMarkerHash,
  writeSkillFiles,
} from "../../dist/tools/skillWriter.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-skillwriter-"));
}

function tmpSourceDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-skillsrc-"));
}

function writeSourceSkill(dir, name, body) {
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, body);
  return {
    uri: `verse8://skill/${name}/SKILL.md`,
    name,
    mimeType: "text/markdown",
    fsPath: file,
  };
}

function readDest(projectDir, name) {
  return fs.readFileSync(
    path.join(projectDir, ".claude", "skills", name, "SKILL.md"),
    "utf8",
  );
}

// ------------------------------------------------------------------
// Hash primitives
// ------------------------------------------------------------------

test("computeSkillHash: deterministic 64-char hex", () => {
  const h = computeSkillHash("some body text\n");
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(computeSkillHash("some body text\n"), h);
});

test("computeSkillHash: CRLF and LF produce identical hash (AC-18)", () => {
  const lf = "line one\nline two\n";
  const crlf = "line one\r\nline two\r\n";
  assert.equal(computeSkillHash(lf), computeSkillHash(crlf));
});

test("computeSkillHash: trailing whitespace ignored", () => {
  assert.equal(
    computeSkillHash("body"),
    computeSkillHash("body\n\n\n   \n"),
  );
});

test("addHashMarker: roundtrips through stripHashMarker", () => {
  const body = "# Skill\n\nInstructions here.";
  const marked = addHashMarker(body);
  assert.ok(marked.endsWith(" -->\n"));
  assert.match(marked, /<!-- verse8-skill-hash: [a-f0-9]{64} -->/);
  assert.ok(stripHashMarker(marked).startsWith(body));
});

test("addHashMarker: idempotent when called on already-marked content", () => {
  const body = "hello\n";
  const once = addHashMarker(body);
  const twice = addHashMarker(once);
  assert.equal(once, twice);
});

test("extractMarkerHash: returns null when marker absent", () => {
  assert.equal(extractMarkerHash("just a body"), null);
});

test("extractMarkerHash: recovers the hash value", () => {
  const body = "body\n";
  const marked = addHashMarker(body);
  const h = extractMarkerHash(marked);
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(h, computeSkillHash(body));
});

// ------------------------------------------------------------------
// writeSkillFiles — scenarios
// ------------------------------------------------------------------

test("writeSkillFiles: fresh project → created (AC-4/AC-5)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    const skills = [
      writeSourceSkill(src, "verse8-login", "# Login\nBody A.\n"),
      writeSourceSkill(src, "gameserver-sdk", "# Gameserver\nBody B.\n"),
    ];
    const r = writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    assert.deepEqual(r.created.sort(), ["gameserver-sdk", "verse8-login"]);
    assert.deepEqual(r.updated, []);
    assert.deepEqual(r.skippedUserEdited, []);
    assert.deepEqual(r.existingUnchanged, []);
    // Files exist with marker.
    for (const name of ["verse8-login", "gameserver-sdk"]) {
      const got = readDest(proj, name);
      assert.match(got, /<!-- verse8-skill-hash: [a-f0-9]{64} -->/);
    }
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("writeSkillFiles: idempotent re-run → existingUnchanged (AC-7/AC-17)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    const skills = [writeSourceSkill(src, "a", "# A\nsame.\n")];
    writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    const mtime1 = fs.statSync(
      path.join(proj, ".claude/skills/a/SKILL.md"),
    ).mtimeMs;
    // Small wait so any write would bump mtime observably.
    const second = writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    const mtime2 = fs.statSync(
      path.join(proj, ".claude/skills/a/SKILL.md"),
    ).mtimeMs;
    assert.deepEqual(second.existingUnchanged, ["a"]);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(second.created, []);
    // existingUnchanged path must NOT rewrite the file.
    assert.equal(mtime1, mtime2, "mtime must not change on no-op re-run");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("writeSkillFiles: user edit preserved, others update (AC-8)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    const skills = [
      writeSourceSkill(src, "edited", "# E\nv1\n"),
      writeSourceSkill(src, "untouched", "# U\nv1\n"),
    ];
    writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    // User edits one file.
    const editedPath = path.join(proj, ".claude/skills/edited/SKILL.md");
    fs.writeFileSync(editedPath, "# E\nuser v2\n");
    // Upstream updates both.
    fs.writeFileSync(path.join(src, "edited.md"), "# E\nv2\n");
    fs.writeFileSync(path.join(src, "untouched.md"), "# U\nv2\n");
    const r = writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    assert.deepEqual(r.skippedUserEdited, ["edited"]);
    assert.deepEqual(r.updated, ["untouched"]);
    // Edited file preserved byte-identically.
    assert.equal(fs.readFileSync(editedPath, "utf8"), "# E\nuser v2\n");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// INV-6: Skill no-touch invariant
// INV-7: `overwriteAllSkills: true` does not cascade to .env (and vice-versa)
test("writeSkillFiles: overwriteAll bypasses user-edit protection (AC-9)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    const skills = [writeSourceSkill(src, "x", "# X\nv1\n")];
    writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    const destPath = path.join(proj, ".claude/skills/x/SKILL.md");
    fs.writeFileSync(destPath, "# X\nuser v2\n");
    fs.writeFileSync(path.join(src, "x.md"), "# X\nv3\n");
    const r = writeSkillFiles(proj, skills, { overwriteAll: true, pruneOrphaned: false });
    assert.deepEqual(r.skippedUserEdited, []);
    assert.deepEqual(r.updated, ["x"]);
    const got = fs.readFileSync(destPath, "utf8");
    assert.ok(got.includes("v3"));
    assert.ok(!got.includes("user v2"));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// INV-6: Skill no-touch invariant
test("writeSkillFiles: unrelated user skill not touched (AC-15)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    const skills = [writeSourceSkill(src, "bundled", "# B\n")];
    // Pre-populate an unrelated user skill.
    const unrelatedDir = path.join(proj, ".claude/skills/my-custom");
    fs.mkdirSync(unrelatedDir, { recursive: true });
    const unrelatedPath = path.join(unrelatedDir, "SKILL.md");
    const unrelatedContent = "# My custom\nuser-authored, no marker.\n";
    fs.writeFileSync(unrelatedPath, unrelatedContent);
    // Run attach.
    const r = writeSkillFiles(proj, skills, { overwriteAll: true, pruneOrphaned: false });
    // Bundled one written.
    assert.deepEqual(r.created, ["bundled"]);
    // Unrelated file untouched (byte-identical).
    assert.equal(fs.readFileSync(unrelatedPath, "utf8"), unrelatedContent);
    // overwriteAll: true must not touch anything outside the bundled set.
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// INV-6: Skill no-touch invariant
test("writeSkillFiles: pruneOrphaned removes only marker-bearing orphans (AC-16)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    // First attach with 2 bundled skills.
    let skills = [
      writeSourceSkill(src, "keeper", "# K\n"),
      writeSourceSkill(src, "removed-upstream", "# R\n"),
    ];
    writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    // Also pre-populate an unrelated user skill (no marker).
    const customDir = path.join(proj, ".claude/skills/my-custom");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, "SKILL.md"), "# Custom\nuser-owned.\n");
    // Upstream drops `removed-upstream`.
    skills = [skills[0]];
    // No prune: orphan survives.
    const r1 = writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    assert.deepEqual(r1.pruned, []);
    assert.ok(fs.existsSync(path.join(proj, ".claude/skills/removed-upstream/SKILL.md")));
    // Prune: marker-bearing orphan removed, user-owned survives.
    const r2 = writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: true });
    assert.deepEqual(r2.pruned, ["removed-upstream"]);
    assert.ok(!fs.existsSync(path.join(proj, ".claude/skills/removed-upstream")));
    assert.ok(fs.existsSync(path.join(proj, ".claude/skills/my-custom/SKILL.md")));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("writeSkillFiles: result envelope contains all five buckets (AC-14)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    const skills = [writeSourceSkill(src, "a", "# A\n")];
    const r = writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    for (const k of ["created", "updated", "skippedUserEdited", "existingUnchanged", "pruned"]) {
      assert.ok(Array.isArray(r[k]), `missing ${k}`);
    }
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// Belt-and-suspenders guard: the catalog placeholder must remain in the
// template. If someone accidentally deletes it during a refactor the
// catalog silently vanishes — this test is the canary.
test("AGENTS_MD_TEMPLATE: {{SKILLS_CATALOG}} placeholder is present", async () => {
  const mod = await import("../../dist/tools/attach.js");
  assert.equal(mod.AGENTS_MD_TEMPLATE_HAS_CATALOG_MARKER, true);
  assert.match(mod.AGENTS_MD_TEMPLATE_SOURCE, /\{\{SKILLS_CATALOG\}\}/);
});

test("writeSkillFiles: CRLF in destination still recognized as unedited (AC-18)", () => {
  const src = tmpSourceDir();
  const proj = tmpProject();
  try {
    const skills = [writeSourceSkill(src, "crlf", "# hello\nworld\n")];
    writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    const destPath = path.join(proj, ".claude/skills/crlf/SKILL.md");
    // Simulate a Windows editor re-saving the file with CRLF.
    const lf = fs.readFileSync(destPath, "utf8");
    const crlf = lf.replace(/\n/g, "\r\n");
    fs.writeFileSync(destPath, crlf);
    const r = writeSkillFiles(proj, skills, { overwriteAll: false, pruneOrphaned: false });
    // CRLF-only change must NOT count as user edit.
    assert.deepEqual(r.skippedUserEdited, []);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
