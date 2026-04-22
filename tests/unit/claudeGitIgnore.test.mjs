import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ensureClaudeGitIgnore,
} from "../../dist/context/gitIgnore.js";
import { applyAttachmentArtifacts } from "../../dist/tools/attach.js";

function setupFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-claude-ignore-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test("ensureClaudeGitIgnore: creates .claude/.gitignore with skills/ entry on empty project", () => {
  const root = setupFixture();
  try {
    const r = ensureClaudeGitIgnore(root);
    assert.equal(r.status, "created");
    const body = fs.readFileSync(path.join(root, ".claude", ".gitignore"), "utf8");
    assert.match(body, /^skills\/$/m);
  } finally {
    cleanup(root);
  }
});

test("ensureClaudeGitIgnore: idempotent on re-run (already-present)", () => {
  const root = setupFixture();
  try {
    ensureClaudeGitIgnore(root);
    const r = ensureClaudeGitIgnore(root);
    assert.equal(r.status, "already-present");
  } finally {
    cleanup(root);
  }
});

test("ensureClaudeGitIgnore: preserves pre-existing user entries in .claude/.gitignore", () => {
  const root = setupFixture();
  try {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const existing = "# user stuff\nsettings.local.json\ntmp/\n";
    fs.writeFileSync(path.join(claudeDir, ".gitignore"), existing);

    const r = ensureClaudeGitIgnore(root);
    assert.equal(r.status, "updated");
    const body = fs.readFileSync(path.join(claudeDir, ".gitignore"), "utf8");
    assert.ok(body.includes("settings.local.json"), "user entry preserved");
    assert.ok(body.includes("tmp/"), "user entry preserved");
    assert.match(body, /^skills\/$/m);
  } finally {
    cleanup(root);
  }
});

test("applyAttachmentArtifacts: materializes .claude/skills/ AND writes .claude/.gitignore excluding them from git", () => {
  const root = setupFixture();
  try {
    const result = applyAttachmentArtifacts(root, {
      overwrite: false,
      projectId: "test",
      walletAddress: "0x000000000000000000000000000000000000dead",
    });

    assert.equal(result.claudeGitIgnore.status, "created");

    const ignoreBody = fs.readFileSync(
      path.join(root, ".claude", ".gitignore"),
      "utf8",
    );
    assert.match(ignoreBody, /^skills\/$/m);

    // Verify git actually respects the nested .gitignore.
    // `git check-ignore -v <path>` exits 0 and prints the matching rule
    // when a path is ignored; exits 1 if not. Use --no-index to stay
    // deterministic across git versions.
    const skillPath = ".claude/skills/spritesheet-generator/SKILL.md";
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "-q", skillPath], {
        cwd: root,
      });
      ignored = true;
    } catch (e) {
      // exit 1 = not ignored; anything else = real error.
      if (e.status !== 1) throw e;
    }
    assert.ok(ignored, `.claude/skills/ must be git-ignored by .claude/.gitignore`);
  } finally {
    cleanup(root);
  }
});
