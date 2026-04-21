import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { applyAttachmentArtifacts } from "../../dist/tools/attach.js";

// US-M1b pre-extraction guardrail. Asserts that running
// applyAttachmentArtifacts twice on a fixture verse8 project produces
// byte-identical state for files that should be preserved (AGENTS.md,
// CLAUDE.md, hook scripts, project marker, .gitignore stanza).
//
// This test must continue to pass through every M1b extraction (template
// move, hooks dedup, skillCatalog extract). If a future split changes the
// rendered output of any of these files, this test fails — proving the
// extraction broke a behavioral invariant rather than just relocating code.

function setupVerseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-attach-idem-"));
  // git init so .git/hooks exists for writeHook to target.
  execFileSync("git", ["init", "-q"], { cwd: root });
  // Mark as verse8 project so detectVerseProject is irrelevant for the
  // applyAttachmentArtifacts test (it doesn't gate on detection).
  fs.mkdirSync(path.join(root, ".verse8"));
  fs.writeFileSync(
    path.join(root, ".verse8", "project.json"),
    JSON.stringify({ version: 1, projectId: "test", attachedAt: "2026-04-21T00:00:00Z" }) + "\n",
  );
  return root;
}

function snapshotKeyArtifacts(projectDir) {
  const targets = [
    "AGENTS.md",
    "CLAUDE.md",
    ".verse8/project.json",
    ".verse8/.gitignore",
    ".git/hooks/pre-commit",
    ".git/hooks/commit-msg",
  ];
  const snap = {};
  for (const rel of targets) {
    try {
      const full = path.join(projectDir, rel);
      const stat = fs.statSync(full);
      snap[rel] = {
        size: stat.size,
        mode: stat.mode & 0o777,
        content: fs.readFileSync(full, "utf8"),
      };
    } catch {
      snap[rel] = null;
    }
  }
  return snap;
}

test("M1b guardrail: applyAttachmentArtifacts idempotent (no overwrite of user-equivalent state on 2nd call)", () => {
  const root = setupVerseFixture();
  try {
    const opts = {
      overwrite: false,
      projectId: "test",
      walletAddress: "0xCAFE000000000000000000000000000000000001",
    };
    const r1 = applyAttachmentArtifacts(root, opts);
    const snap1 = snapshotKeyArtifacts(root);
    const r2 = applyAttachmentArtifacts(root, opts);
    const snap2 = snapshotKeyArtifacts(root);

    // (a) AGENTS.md byte-identical content + size + mode.
    assert.equal(snap1["AGENTS.md"]?.content, snap2["AGENTS.md"]?.content);
    // (b) CLAUDE.md byte-identical.
    assert.equal(snap1["CLAUDE.md"]?.content, snap2["CLAUDE.md"]?.content);
    // (c) hook scripts unchanged.
    assert.equal(
      snap1[".git/hooks/pre-commit"]?.content,
      snap2[".git/hooks/pre-commit"]?.content,
    );
    assert.equal(
      snap1[".git/hooks/commit-msg"]?.content,
      snap2[".git/hooks/commit-msg"]?.content,
    );
    // (d) project marker unchanged.
    assert.equal(
      snap1[".verse8/project.json"]?.content,
      snap2[".verse8/project.json"]?.content,
    );
    // (e) .gitignore unchanged + 2nd call returns already-present per US-M2-2.
    assert.equal(
      snap1[".verse8/.gitignore"]?.content,
      snap2[".verse8/.gitignore"]?.content,
    );
    assert.equal(r2.gitIgnore.status, "already-present");

    // Status flags reflect "no change" semantics on the 2nd call:
    assert.equal(r2.preCommitHook, "already-present");
    assert.equal(r2.commitMsgHook, "already-present");
    assert.equal(r2.agentsDoc, "skipped-existing");
    assert.equal(r2.projectMarker, "already-present");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M1b guardrail: handwritten AGENTS.md / CLAUDE.md preserved (no clobber when user wrote them)", () => {
  const root = setupVerseFixture();
  try {
    const opts = {
      overwrite: false,
      projectId: "test",
      walletAddress: "0xCAFE000000000000000000000000000000000002",
    };
    // User wrote both docs first.
    const userAgents = "# My handwritten AGENTS.md\nKeep this exactly.\n";
    const userClaude = "# My handwritten CLAUDE.md\nKeep this too.\n";
    fs.writeFileSync(path.join(root, "AGENTS.md"), userAgents);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), userClaude);

    const r = applyAttachmentArtifacts(root, opts);

    // The writer must NOT overwrite when either doc already exists and
    // overwrite is false.
    assert.equal(r.agentsDoc, "skipped-existing");
    assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), userAgents);
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), userClaude);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
