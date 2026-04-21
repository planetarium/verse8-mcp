import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { synthesizeFileChangesFromDiff } from "../../dist/format/fileChangeSynthesis.js";

function setupGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-fcs-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  // Test commits need a user identity; set repo-local config so we don't
  // poison the developer's global config.
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
}

test("fileChangeSynthesis: empty diff (no staged changes) returns []", () => {
  const root = setupGitRepo();
  try {
    const out = synthesizeFileChangesFromDiff(root);
    assert.deepEqual(out, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fileChangeSynthesis: single staged Add → write entry with content", () => {
  const root = setupGitRepo();
  try {
    fs.writeFileSync(path.join(root, "hello.txt"), "hi there");
    execFileSync("git", ["add", "hello.txt"], { cwd: root });
    const out = synthesizeFileChangesFromDiff(root);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "write");
    assert.equal(out[0].input.filePath, "hello.txt");
    assert.equal(out[0].input.content, "hi there");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fileChangeSynthesis: staged Modify → edit entry with diff", () => {
  const root = setupGitRepo();
  try {
    fs.writeFileSync(path.join(root, "x.txt"), "v1\n");
    execFileSync("git", ["add", "x.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    fs.writeFileSync(path.join(root, "x.txt"), "v2\n");
    execFileSync("git", ["add", "x.txt"], { cwd: root });
    const out = synthesizeFileChangesFromDiff(root);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "edit");
    assert.equal(out[0].input.filePath, "x.txt");
    assert.match(out[0].input.diff, /-v1/);
    assert.match(out[0].input.diff, /\+v2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fileChangeSynthesis: rename → rename entry with from/to", () => {
  const root = setupGitRepo();
  try {
    fs.writeFileSync(path.join(root, "old.txt"), "stable content here\n");
    execFileSync("git", ["add", "old.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    execFileSync("git", ["mv", "old.txt", "new.txt"], { cwd: root });
    const out = synthesizeFileChangesFromDiff(root);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "rename");
    assert.equal(out[0].input.from, "old.txt");
    assert.equal(out[0].input.to, "new.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fileChangeSynthesis: bulk-change cap — VERSE8_CHECKPOINT_FILE_CAP override emits summary entry", () => {
  const root = setupGitRepo();
  try {
    // Create 5 staged files; with cap=2 we should hit the bulk-summary path.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `${i}\n`);
    }
    execFileSync("git", ["add", "."], { cwd: root });
    const orig = process.env.VERSE8_CHECKPOINT_FILE_CAP;
    process.env.VERSE8_CHECKPOINT_FILE_CAP = "2";
    try {
      const out = synthesizeFileChangesFromDiff(root);
      assert.equal(out.length, 1);
      assert.equal(out[0].name, "bulk_change");
      assert.equal(out[0].input.totalFiles, 5);
      assert.ok(Array.isArray(out[0].input.sample));
      assert.ok(out[0].input.sample.length > 0);
    } finally {
      if (orig === undefined) delete process.env.VERSE8_CHECKPOINT_FILE_CAP;
      else process.env.VERSE8_CHECKPOINT_FILE_CAP = orig;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fileChangeSynthesis: not a git repo → []", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-fcs-nogit-"));
  try {
    const out = synthesizeFileChangesFromDiff(root);
    assert.deepEqual(out, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
