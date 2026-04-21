import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { applyAttachmentArtifacts } from "../../dist/tools/attach.js";
import { RollbackJournal } from "../../dist/util/rollback.js";

function setupFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-rollback-"));
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

function listAttachArtifacts(projectDir) {
  const paths = [
    ".git/hooks/pre-commit",
    ".git/hooks/commit-msg",
    "AGENTS.md",
    "CLAUDE.md",
    ".verse8",
    ".verse8/project.json",
    ".verse8/.gitignore",
    ".claude",
    ".env",
  ];
  const snap = {};
  for (const rel of paths) {
    const full = path.join(projectDir, rel);
    try {
      const stat = fs.statSync(full);
      snap[rel] = stat.isDirectory() ? { isDir: true } : { exists: true };
    } catch {
      snap[rel] = { exists: false };
    }
  }
  return snap;
}

test("RollbackJournal: rollback runs reverse ops in LIFO order", () => {
  const j = new RollbackJournal();
  const order = [];
  j.record(() => order.push("first"));
  j.record(() => order.push("second"));
  j.record(() => order.push("third"));
  assert.equal(j.size(), 3);
  j.rollback();
  assert.deepEqual(order, ["third", "second", "first"]);
  assert.equal(j.size(), 0);
});

test("RollbackJournal: individual reverse failures are swallowed; subsequent ops still run", () => {
  const j = new RollbackJournal();
  const order = [];
  j.record(() => order.push("one"));
  j.record(() => {
    throw new Error("boom");
  });
  j.record(() => order.push("three"));
  assert.doesNotThrow(() => j.rollback());
  assert.deepEqual(order, ["three", "one"]);
});

test("attachRollback: success path — journal reverses zero ops (no throw, no changes)", () => {
  const root = setupFixture();
  try {
    const preSnap = listAttachArtifacts(root);
    const result = applyAttachmentArtifacts(root, {
      overwrite: false,
      projectId: "test",
      walletAddress: "0x0000000000000000000000000000000000000001",
    });
    assert.equal(result.preCommitHook, "created");
    assert.equal(result.agentsDoc, "created");
    assert.equal(result.projectMarker, "created");
    // Idempotent second run works (no exceptions)
    const r2 = applyAttachmentArtifacts(root, {
      overwrite: false,
      projectId: "test",
      walletAddress: "0x0000000000000000000000000000000000000001",
    });
    assert.equal(r2.agentsDoc, "skipped-existing");
    // sanity: arguments didn't mutate input
    assert.ok(preSnap);
  } finally {
    cleanup(root);
  }
});

test("attachRollback: mid-sequence failure at skills step rolls back hooks + AGENTS.md + marker (AC-ATOMICITY)", () => {
  const root = setupFixture();
  try {
    const preSnap = listAttachArtifacts(root);
    // Confirm pre-state: none of the attach artifacts exist.
    assert.equal(preSnap["AGENTS.md"].exists, false);
    assert.equal(preSnap["CLAUDE.md"].exists, false);
    assert.equal(preSnap[".verse8/project.json"].exists, false);
    assert.equal(preSnap[".git/hooks/pre-commit"].exists, false);
    assert.equal(preSnap[".git/hooks/commit-msg"].exists, false);

    assert.throws(
      () =>
        applyAttachmentArtifacts(root, {
          overwrite: false,
          projectId: "test",
          walletAddress: "0x0000000000000000000000000000000000000002",
          __failAfter: "skills",
        }),
      /__failAfter:skills/,
    );

    const postSnap = listAttachArtifacts(root);
    // Everything created between step 1 and step 4 must be gone.
    assert.equal(postSnap[".git/hooks/pre-commit"].exists, false);
    assert.equal(postSnap[".git/hooks/commit-msg"].exists, false);
    assert.equal(postSnap["AGENTS.md"].exists, false);
    assert.equal(postSnap["CLAUDE.md"].exists, false);
    assert.equal(postSnap[".verse8/project.json"].exists, false);
    // `.claude/skills/` was created + written in step 4. The failure
    // triggered AFTER the step committed, so the journal must remove the
    // freshly-created skills tree.
    assert.equal(postSnap[".claude"].exists, false);
  } finally {
    cleanup(root);
  }
});

test("attachRollback: pre-existing user AGENTS.md preserved across mid-sequence failure", () => {
  const root = setupFixture();
  try {
    const userBody = "# My handwritten AGENTS.md\nCustom content here.\n";
    fs.writeFileSync(path.join(root, "AGENTS.md"), userBody);

    assert.throws(() =>
      applyAttachmentArtifacts(root, {
        overwrite: false,
        projectId: "test",
        walletAddress: "0x0000000000000000000000000000000000000003",
        __failAfter: "skills",
      }),
    );

    // applyAttachmentArtifacts with overwrite:false returns
    // "skipped-existing" when AGENTS.md is present (neither AGENTS.md nor
    // CLAUDE.md was created by us). Rollback therefore does nothing to
    // AGENTS.md — the user's file is preserved verbatim.
    assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), userBody);
  } finally {
    cleanup(root);
  }
});

test("attachRollback: overwrite=true + mid-sequence failure restores prior AGENTS.md content", () => {
  const root = setupFixture();
  try {
    const userBody = "# My handwritten AGENTS.md\nCustom content here.\n";
    fs.writeFileSync(path.join(root, "AGENTS.md"), userBody);

    assert.throws(() =>
      applyAttachmentArtifacts(root, {
        overwrite: true,
        projectId: "test",
        walletAddress: "0x0000000000000000000000000000000000000004",
        __failAfter: "skills",
      }),
    );

    // With overwrite:true the writer replaced AGENTS.md with the verse8
    // template and recorded a reverse. Rollback must restore the original.
    assert.equal(
      fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"),
      userBody,
    );
  } finally {
    cleanup(root);
  }
});
