// `stageAll: false` / VERSE8_CHECKPOINT_REQUIRE_FILES=1: without `files`,
// verse8_checkpoint (and preview / deploy, which run it) stage nothing and
// return `files_required` + the changed paths, instead of `git add -A`
// picking up another session's work in the same folder. Default unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  REQUIRE_FILES_ENV,
  listChangedFiles,
  listStagedFiles,
  resolveStageAll,
  runCheckpoint,
} from "../../dist/tools/checkpoint.js";
import { previewInputSchema, runPreview } from "../../dist/tools/preview.js";
import { deployInputSchema } from "../../dist/tools/deploy.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeProject(sub = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-reqfiles-"));
  const bare = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
  git(repo, "remote", "set-url", "--push", "origin", bare);
  const dir = sub ? path.join(repo, sub) : repo;
  fs.mkdirSync(path.join(dir, ".verse8"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ version: 1, projectId: "demo" }));
  fs.writeFileSync(path.join(dir, ".env"), "VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=0xabc-1\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n");
  fs.writeFileSync(path.join(dir, "mine.js"), "v1\n");
  fs.writeFileSync(path.join(dir, "theirs.js"), "v1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return dir;
}

/** Two sessions' pending work: mine.js is ours, theirs.js + other.js are not. */
function dirtyBoth(dir) {
  fs.writeFileSync(path.join(dir, "mine.js"), "v2\n");
  fs.writeFileSync(path.join(dir, "theirs.js"), "v2 by another session\n");
  fs.writeFileSync(path.join(dir, "other.js"), "new, another session\n");
  fs.writeFileSync(path.join(dir, "ignored.log"), "x\n");
  fs.writeFileSync(path.join(dir, ".deployed"), "{}");
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const base = (projectDir) => ({
  projectDir,
  skipAttachCheck: true,
  useAutoToolLog: false,
  message: "[verse8] test",
});

const committedFiles = (dir) =>
  git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);

test("resolveStageAll: input wins, else the env switch, else true", () => {
  assert.equal(resolveStageAll(undefined, {}), true);
  assert.equal(resolveStageAll(undefined, { [REQUIRE_FILES_ENV]: "1" }), false);
  assert.equal(resolveStageAll(undefined, { [REQUIRE_FILES_ENV]: "TRUE" }), false);
  assert.equal(resolveStageAll(undefined, { [REQUIRE_FILES_ENV]: "0" }), true);
  assert.equal(resolveStageAll(true, { [REQUIRE_FILES_ENV]: "1" }), true);
  assert.equal(resolveStageAll(false, {}), false);
});

test("listChangedFiles: staged + modified + untracked, minus ignored and NEVER_COMMIT_FILES", () => {
  const dir = makeProject();
  dirtyBoth(dir);
  git(dir, "add", "mine.js");
  assert.deepEqual(listChangedFiles(dir), ["mine.js", "other.js", "theirs.js"]);
});

test("runCheckpoint stageAll:false without files → files_required, nothing staged or committed", async () => {
  const dir = makeProject();
  const head = git(dir, "rev-parse", "HEAD");
  dirtyBoth(dir);
  const res = await withEnv({ VERSE8_ACCESS_TOKEN: "t", [REQUIRE_FILES_ENV]: undefined }, () =>
    runCheckpoint({ ...base(dir), stageAll: false }, dir),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "files_required");
  assert.deepEqual(res.changedFiles, ["mine.js", "other.js", "theirs.js"]);
  assert.match(res.hint, /files/);
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.deepEqual(listStagedFiles(dir), []);
});

test("runCheckpoint stageAll:false with files → commits only those files", async () => {
  const dir = makeProject();
  dirtyBoth(dir);
  const res = await withEnv({ VERSE8_ACCESS_TOKEN: "t" }, () =>
    runCheckpoint({ ...base(dir), stageAll: false, files: ["mine.js"] }, dir),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(committedFiles(dir), ["mine.js"]);
});

test(`${REQUIRE_FILES_ENV}=1 turns the default off; stageAll:true overrides it`, async () => {
  const dir = makeProject();
  dirtyBoth(dir);
  await withEnv({ VERSE8_ACCESS_TOKEN: "t", [REQUIRE_FILES_ENV]: "1" }, async () => {
    const refused = await runCheckpoint(base(dir), dir);
    assert.equal(refused.error, "files_required");

    const all = await runCheckpoint({ ...base(dir), stageAll: true }, dir);
    assert.equal(all.ok, true, JSON.stringify(all));
    assert.deepEqual(committedFiles(dir).sort(), ["mine.js", "other.js", "theirs.js"]);
  });
});

test("default (no stageAll, no env) is unchanged: `git add -A` commits everything", async () => {
  const dir = makeProject();
  dirtyBoth(dir);
  const res = await withEnv({ VERSE8_ACCESS_TOKEN: "t", [REQUIRE_FILES_ENV]: undefined }, () =>
    runCheckpoint(base(dir), dir),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(committedFiles(dir).sort(), ["mine.js", "other.js", "theirs.js"]);
});

test("stageAll:false on a clean tree → nothing_to_commit (not files_required)", async () => {
  const dir = makeProject();
  const res = await withEnv({ VERSE8_ACCESS_TOKEN: "t" }, () =>
    runCheckpoint({ ...base(dir), stageAll: false }, dir),
  );
  assert.equal(res.error, "nothing_to_commit");
});

test("nested project: changedFiles are relative to projectDir and exclude the rest of the repo", async () => {
  const dir = makeProject("games/demo");
  dirtyBoth(dir);
  fs.writeFileSync(path.join(dir, "..", "..", "outside.txt"), "not in the project\n");
  const res = await withEnv({ VERSE8_ACCESS_TOKEN: "t" }, () =>
    runCheckpoint({ ...base(dir), stageAll: false }, dir),
  );
  assert.equal(res.error, "files_required");
  assert.deepEqual(res.changedFiles, ["mine.js", "other.js", "theirs.js"]);
});

test("verse8_preview / verse8_deploy accept stageAll; preview stops at the checkpoint with files_required", async () => {
  assert.ok("stageAll" in deployInputSchema.shape);
  const parsed = previewInputSchema.parse({ stageAll: false });
  assert.equal(parsed.stageAll, false);

  const dir = makeProject();
  dirtyBoth(dir);
  const res = await withEnv({ VERSE8_ACCESS_TOKEN: "t" }, () =>
    runPreview(previewInputSchema.parse({ ...base(dir), stageAll: false }), dir),
  );
  assert.equal(res.ok, false);
  assert.equal(res.stage, "checkpoint");
  assert.equal(res.checkpoint.error, "files_required");
  assert.deepEqual(listStagedFiles(dir), []);
});
