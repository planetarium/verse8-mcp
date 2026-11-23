// verse8_checkpoint: a failed stage/commit puts the index back to its state
// before the call, so files this call staged do not leak into the next
// checkpoint (and the user's own staging survives).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  listStagedFiles,
  restoreIndex,
  runCheckpoint,
  snapshotIndex,
} from "../../dist/tools/checkpoint.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A verse8-looking project whose pushes land in a local bare repo. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-ckpt-restore-"));
  const bare = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const dir = path.join(root, "proj");
  fs.mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
  git(dir, "remote", "set-url", "--push", "origin", bare);
  fs.mkdirSync(path.join(dir, ".verse8"));
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ version: 1, projectId: "demo" }));
  fs.writeFileSync(path.join(dir, ".env"), "VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=0xabc-1\n");
  fs.writeFileSync(path.join(dir, "index.html"), "<title>demo</title>\n");
  fs.writeFileSync(path.join(dir, "tracked.js"), "v1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Point core.hooksPath at a dir whose pre-commit hook always fails. */
function installFailingPreCommit(dir) {
  const hooks = path.join(dir, "..", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho 'blocked by test hook' >&2\nexit 1\n", { mode: 0o755 });
  git(dir, "config", "core.hooksPath", hooks);
}

function withEnvToken(fn) {
  const saved = process.env.VERSE8_ACCESS_TOKEN;
  process.env.VERSE8_ACCESS_TOKEN = "test-token";
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved;
  });
}

const baseInput = (projectDir) => ({
  projectDir,
  skipAttachCheck: true,
  useAutoToolLog: false,
});

test("snapshotIndex/restoreIndex: restores staged entries and leaves the working tree alone", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "tracked.js"), "v2\n");
  const tree = snapshotIndex(dir);
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  fs.writeFileSync(path.join(dir, "new.js"), "n\n");
  git(dir, "add", "-A");
  assert.deepEqual(listStagedFiles(dir).sort(), ["new.js", "tracked.js"]);

  assert.equal(restoreIndex(dir, tree), true);
  assert.deepEqual(listStagedFiles(dir), []);
  assert.equal(fs.readFileSync(path.join(dir, "tracked.js"), "utf8"), "v2\n");
  assert.equal(fs.readFileSync(path.join(dir, "new.js"), "utf8"), "n\n");
  assert.equal(restoreIndex(dir, null), false);
});

test("runCheckpoint: commit_failed (pre-commit hook) restores the index — user's own staging kept, ours undone", async () => {
  const dir = makeProject();
  const head = git(dir, "rev-parse", "HEAD");
  // The user had staged one file themselves before the call.
  fs.writeFileSync(path.join(dir, "mine.js"), "staged by user\n");
  git(dir, "add", "mine.js");
  // Other pending work the checkpoint's `git add -A` will pick up.
  fs.writeFileSync(path.join(dir, "tracked.js"), "v2\n");
  fs.writeFileSync(path.join(dir, "untracked.js"), "u\n");
  installFailingPreCommit(dir);

  const res = await withEnvToken(() =>
    runCheckpoint({ ...baseInput(dir), message: "[verse8] blocked" }, dir),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "commit_failed");
  assert.equal(res.indexRestored, true);
  assert.match(res.hint, /blocked by test hook/);
  assert.match(res.hint, /index was restored/);

  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.deepEqual(listStagedFiles(dir), ["mine.js"]);
  const status = git(dir, "status", "--porcelain");
  assert.match(status, /^ M tracked\.js$/m);
  assert.match(status, /^\?\? untracked\.js$/m);
  assert.equal(fs.readFileSync(path.join(dir, "tracked.js"), "utf8"), "v2\n");
});

test("runCheckpoint: after a failed commit, the next checkpoint with `files` commits only those files", async () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "tracked.js"), "v2\n");
  fs.writeFileSync(path.join(dir, "other.js"), "someone else's work\n");
  installFailingPreCommit(dir);
  const failed = await withEnvToken(() =>
    runCheckpoint({ ...baseInput(dir), message: "[verse8] blocked" }, dir),
  );
  assert.equal(failed.error, "commit_failed");

  git(dir, "config", "--unset", "core.hooksPath");
  const res = await withEnvToken(() =>
    runCheckpoint({ ...baseInput(dir), message: "[verse8] only tracked", files: ["tracked.js"] }, dir),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["tracked.js"]);
  assert.match(git(dir, "status", "--porcelain"), /^\?\? other\.js$/m);
});

test("runCheckpoint: stage_failed (unknown path in `files`) leaves the index as it was", async () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "mine.js"), "staged by user\n");
  git(dir, "add", "mine.js");
  fs.writeFileSync(path.join(dir, "tracked.js"), "v2\n");

  const res = await withEnvToken(() =>
    runCheckpoint({ ...baseInput(dir), message: "[verse8] x", files: ["tracked.js", "does-not-exist.js"] }, dir),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "stage_failed");
  assert.equal(res.indexRestored, true);
  assert.deepEqual(listStagedFiles(dir), ["mine.js"]);
});
