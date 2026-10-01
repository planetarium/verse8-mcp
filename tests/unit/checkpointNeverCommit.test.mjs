// verse8_checkpoint must never commit `.deployed` / `.secret` — the same
// NEVER_COMMIT_FILES rule as the agent8 container. `@agent8/deploy` writes
// `.deployed` after every upload, so without this the checkpoint that
// follows a deploy would push it to gitlab.verse8.io.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  NEVER_COMMIT_FILES,
  listStagedFiles,
  runCheckpoint,
  unstageNeverCommitFiles,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-ckpt-"));
  const bare = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const dir = path.join(root, "proj");
  fs.mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  // detectVerseProject checks the fetch URL host; pushes go to the bare repo.
  git(dir, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
  git(dir, "remote", "set-url", "--push", "origin", bare);
  fs.mkdirSync(path.join(dir, ".verse8"));
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ version: 1, projectId: "demo" }));
  fs.writeFileSync(path.join(dir, ".env"), "VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=0xabc-1\n");
  fs.writeFileSync(path.join(dir, "index.html"), "<title>demo</title>\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function withEnvToken(fn) {
  const saved = process.env.VERSE8_ACCESS_TOKEN;
  process.env.VERSE8_ACCESS_TOKEN = "test-token";
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved;
  });
}

const checkpointInput = (projectDir) => ({
  projectDir,
  skipAttachCheck: true,
  useAutoToolLog: false,
  message: "[verse8] test checkpoint",
});

test("NEVER_COMMIT_FILES matches the container list", () => {
  assert.deepEqual([...NEVER_COMMIT_FILES].sort(), [".deployed", ".secret"]);
});

test("unstageNeverCommitFiles: drops only .deployed/.secret from the index, keeps the files on disk", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, ".deployed"), "{}");
  fs.writeFileSync(path.join(dir, ".secret"), "s3cr3t");
  fs.writeFileSync(path.join(dir, "src.js"), "1");
  git(dir, "add", "-A");
  assert.deepEqual(listStagedFiles(dir).sort(), [".deployed", ".secret", "src.js"]);

  const dropped = unstageNeverCommitFiles(dir);
  assert.deepEqual(dropped.sort(), [".deployed", ".secret"]);
  assert.deepEqual(listStagedFiles(dir), ["src.js"]);
  assert.ok(fs.existsSync(path.join(dir, ".deployed")));
  assert.ok(fs.existsSync(path.join(dir, ".secret")));
  // Idempotent.
  assert.deepEqual(unstageNeverCommitFiles(dir), []);
});

test("runCheckpoint: commits the game change but never .deployed, even when listed in `files`", async () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, ".deployed"), JSON.stringify({ sha: "abc" }));
  fs.writeFileSync(path.join(dir, "game.js"), "play()");

  const res = await withEnvToken(() =>
    runCheckpoint({ ...checkpointInput(dir), files: [".deployed", "game.js"] }, dir),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.pushed, true);
  const committed = git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
  assert.deepEqual(committed, ["game.js"]);
  assert.ok(!git(dir, "ls-files").split("\n").includes(".deployed"));
});

test("runCheckpoint: only .deployed changed → nothing_to_commit, no commit is made", async () => {
  const dir = makeProject();
  const before = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, ".deployed"), "{}");

  const res = await withEnvToken(() => runCheckpoint(checkpointInput(dir), dir));
  assert.equal(res.ok, false);
  assert.equal(res.error, "nothing_to_commit");
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
});

test("runCheckpoint: project nested inside a larger repo → game/.deployed is still kept out (paths are project-relative)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-nested-"));
  const bare = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
  git(repo, "remote", "set-url", "--push", "origin", bare);
  const dir = path.join(repo, "game");
  fs.mkdirSync(path.join(dir, ".verse8"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ version: 1, projectId: "demo" }));
  fs.writeFileSync(path.join(dir, ".env"), "VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=0xabc-1\n");
  fs.writeFileSync(path.join(repo, "README.md"), "root\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  fs.writeFileSync(path.join(dir, ".deployed"), "{}");
  fs.writeFileSync(path.join(dir, "game.js"), "play()");
  const res = await withEnvToken(() => runCheckpoint(checkpointInput(dir), dir));
  assert.equal(res.ok, true, JSON.stringify(res));
  const committed = git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
  assert.deepEqual(committed, ["game/game.js"]);
});

test("runCheckpoint: deleting an already-tracked .deployed goes through (that is how it leaves the remote)", async () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, ".deployed"), "{}");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", "legacy commit that tracked .deployed");
  assert.ok(git(dir, "ls-files").split("\n").includes(".deployed"));

  fs.rmSync(path.join(dir, ".deployed"));
  const res = await withEnvToken(() => runCheckpoint(checkpointInput(dir), dir));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!git(dir, "ls-files").split("\n").includes(".deployed"));
});
