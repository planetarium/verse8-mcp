import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isSafeAbsPath } from "../../dist/util/safePath.js";

// US-M0-4 acceptance: 10+ cases covering traversal vectors and legitimate
// paths.

test("safePath: rejects empty string", () => {
  assert.equal(isSafeAbsPath(""), false);
});

test("safePath: rejects bare `..` segment", () => {
  assert.equal(isSafeAbsPath(".."), false);
});

test("safePath: rejects mid-path `..`", () => {
  assert.equal(isSafeAbsPath("/tmp/../etc/passwd"), false);
});

test("safePath: rejects deeply nested `..`", () => {
  assert.equal(isSafeAbsPath("/a/b/c/../../../etc/passwd"), false);
});

test("safePath: rejects relative path that starts with `..`", () => {
  assert.equal(isSafeAbsPath("../etc"), false);
});

test("safePath: rejects NUL byte injection", () => {
  assert.equal(isSafeAbsPath("/tmp/foo\0bar"), false);
});

test("safePath: rejects double-slash `//`", () => {
  assert.equal(isSafeAbsPath("//tmp/foo"), false);
});

test("safePath: rejects single dot segment", () => {
  assert.equal(isSafeAbsPath("/tmp/./foo"), false);
});

test("safePath: accepts plain absolute path", () => {
  assert.equal(isSafeAbsPath("/tmp/foo"), true);
  assert.equal(isSafeAbsPath("/Users/user/projects/proj"), true);
  assert.equal(isSafeAbsPath("/"), true);
});

test("safePath: accepts deep absolute path with hyphens / dots / underscores", () => {
  assert.equal(
    isSafeAbsPath("/Users/user/Workspace/verse8-mcp/.omc/state"),
    true,
  );
});

test("safePath: accepts `~`-prefixed home path", () => {
  assert.equal(isSafeAbsPath("~/projects/foo"), true);
  assert.equal(isSafeAbsPath("~"), true);
});

test("safePath: rejects `~/..` traversal", () => {
  assert.equal(isSafeAbsPath("~/projects/../etc"), false);
});

test("safePath: rejects non-string input", () => {
  // @ts-expect-error — runtime check
  assert.equal(isSafeAbsPath(undefined), false);
  // @ts-expect-error — runtime check
  assert.equal(isSafeAbsPath(null), false);
  // @ts-expect-error — runtime check
  assert.equal(isSafeAbsPath(12345), false);
});

// US-M0-4 acceptance: schema-level rejection BEFORE path.resolve / HTTP / fs.
test("safePath: attachInputSchema.projectDir rejects '../../etc' at parse boundary", async () => {
  const { attachInputSchema } = await import("../../dist/tools/attach.js");
  assert.throws(() => attachInputSchema.parse({ projectDir: "../../etc" }));
  assert.throws(() => attachInputSchema.parse({ projectDir: "/tmp/../etc" }));
  // Valid path passes.
  assert.doesNotThrow(() =>
    attachInputSchema.parse({ projectDir: "/tmp/foo" }),
  );
});

test("safePath: checkpointInputSchema.projectDir rejects traversal", async () => {
  const { checkpointInputSchema } = await import("../../dist/tools/checkpoint.js");
  assert.throws(() => checkpointInputSchema.parse({ projectDir: "/tmp/../etc" }));
  assert.doesNotThrow(() =>
    checkpointInputSchema.parse({ projectDir: "/tmp/foo" }),
  );
});

test("safePath: previewInputSchema.projectDir rejects traversal", async () => {
  const { previewInputSchema } = await import("../../dist/tools/preview.js");
  assert.throws(() =>
    previewInputSchema.parse({ projectDir: "/Users/u/../../etc" }),
  );
  assert.doesNotThrow(() =>
    previewInputSchema.parse({ projectDir: "/Users/u/proj" }),
  );
});

test("safePath: newProjectConfirmInputSchema.targetDir rejects traversal", async () => {
  const { newProjectConfirmInputSchema } = await import("../../dist/tools/newProject.js");
  const baseValid = {
    templateName: "tpl",
    repo: "u/r",
    path: "u/r",
    title: "t",
    projectRepo: "pr",
  };
  assert.throws(() =>
    newProjectConfirmInputSchema.parse({ ...baseValid, targetDir: "../etc" }),
  );
  assert.doesNotThrow(() =>
    newProjectConfirmInputSchema.parse({ ...baseValid, targetDir: "/tmp/scratch" }),
  );
});

test("checkParentDirSafe: rejects symlink-parent that escapes the textual path", async () => {
  const { checkParentDirSafe } = await import("../../dist/tools/newProject.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-symlink-test-"));
  try {
    const realTarget = path.join(root, "real-target");
    fs.mkdirSync(realTarget);
    // Create a symlink to a regular directory; that's allowed (resolved
    // realpath is itself well-formed).
    const linkOK = path.join(root, "link-ok");
    fs.symlinkSync(realTarget, linkOK, "dir");
    const r1 = checkParentDirSafe(linkOK);
    assert.equal(r1.ok, true, "well-formed symlink should be allowed");

    // Symlink to a file (not a directory) → invalid_parent.
    const file = path.join(root, "regular-file");
    fs.writeFileSync(file, "x");
    const linkBad = path.join(root, "link-bad");
    fs.symlinkSync(file, linkBad, "file");
    const r2 = checkParentDirSafe(linkBad);
    assert.equal(r2.ok, false);
    assert.match(r2.hint, /non-directory|symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkParentDirSafe: accepts /tmp (macOS realpath /private/tmp)", async () => {
  const { checkParentDirSafe } = await import("../../dist/tools/newProject.js");
  const r = checkParentDirSafe(os.tmpdir());
  assert.equal(r.ok, true, "os.tmpdir() must be accepted");
});

test("checkParentDirSafe: accepts path that doesn't exist yet (mkdir-recursive case)", async () => {
  const { checkParentDirSafe } = await import("../../dist/tools/newProject.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-symlink-test2-"));
  try {
    const future = path.join(root, "deep", "nested", "future");
    const r = checkParentDirSafe(future);
    assert.equal(r.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
