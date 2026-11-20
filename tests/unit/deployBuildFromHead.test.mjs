// verse8_deploy `buildFrom: "head"`: install / build / upload run in a
// temporary clean checkout of HEAD, so uncommitted work in the project
// folder (e.g. another session's) never ships. Default "workingTree" keeps
// the old behavior and only adds a warning when uncommitted paths exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  createCleanCheckout,
  deployInputSchema,
  isLocalOnlyBuildFile,
  runDeploy,
  uncommittedPaths,
} from "../../dist/tools/deploy.js";

const VERSE = "0xabc-1700000000000";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Repo with the project at `sub` (or the root); .deployed / .secret / .crossramp untracked. */
function makeRepo(sub = "") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-deploy-head-test-"));
  git(repo, "init", "-q");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
  const dir = sub ? path.join(repo, sub) : repo;
  fs.mkdirSync(path.join(dir, ".verse8"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ version: 1, projectId: "demo" }));
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".deployed\n.secret\n.crossramp\nnode_modules\ndist\n");
  fs.writeFileSync(path.join(dir, "game.js"), "committed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(dir, ".deployed"), JSON.stringify({ "index.html": "old" }));
  fs.writeFileSync(path.join(dir, ".secret"), "s");
  fs.writeFileSync(path.join(dir, ".crossramp"), "{}");
  return { repo, dir };
}

const worktreeCount = (dir) => git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

test("isLocalOnlyBuildFile: env files, agent8 lock, crossramp, secret, deployed", () => {
  for (const n of [".env", ".env.local", ".env.production", ".agent8.lock", ".crossramp", ".secret", ".deployed"]) {
    assert.equal(isLocalOnlyBuildFile(n), true, n);
  }
  for (const n of ["env", ".envrc", "game.js", ".gitignore", "node_modules"]) {
    assert.equal(isLocalOnlyBuildFile(n), false, n);
  }
});

test("createCleanCheckout: HEAD content only — uncommitted edits and new files stay out; local-only files copied in", () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, "game.js"), "UNCOMMITTED edit by another session\n");
  fs.writeFileSync(path.join(dir, "wip.js"), "untracked work in progress\n");

  const co = createCleanCheckout(dir);
  try {
    assert.notEqual(path.resolve(co.projectDir), path.resolve(dir));
    assert.equal(fs.readFileSync(path.join(co.projectDir, "game.js"), "utf8"), "committed\n");
    assert.equal(fs.existsSync(path.join(co.projectDir, "wip.js")), false);
    assert.deepEqual(co.copiedIn.sort(), [".crossramp", ".deployed", ".secret"]);
    // .env is tracked here, so it comes from HEAD, not copied.
    assert.ok(fs.readFileSync(path.join(co.projectDir, ".env"), "utf8").includes(VERSE));
    assert.equal(worktreeCount(dir), 2);
  } finally {
    co.cleanup();
  }
  assert.equal(fs.existsSync(co.projectDir), false);
  assert.equal(worktreeCount(dir), 1);
  // The real project dir is untouched.
  assert.equal(fs.readFileSync(path.join(dir, "game.js"), "utf8"), "UNCOMMITTED edit by another session\n");
  assert.ok(fs.existsSync(path.join(dir, "wip.js")));
});

test("createCleanCheckout: .deployed rewritten by the upload is copied back; unchanged → left alone", () => {
  const { dir } = makeRepo();
  const co = createCleanCheckout(dir);
  try {
    const mtimeBefore = fs.statSync(path.join(dir, ".deployed")).mtimeMs;
    co.syncBack(); // nothing changed yet
    assert.equal(fs.statSync(path.join(dir, ".deployed")).mtimeMs, mtimeBefore);

    fs.writeFileSync(path.join(co.projectDir, ".deployed"), JSON.stringify({ "index.html": "new" }));
    co.syncBack();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".deployed"), "utf8")), { "index.html": "new" });
  } finally {
    co.cleanup();
  }
});

test("createCleanCheckout: project nested in a larger repo → same subdirectory inside the checkout", () => {
  const { dir } = makeRepo("games/demo");
  const co = createCleanCheckout(dir);
  try {
    assert.equal(path.basename(co.projectDir.replace(/[\\/]+$/, "")), "demo");
    assert.ok(fs.existsSync(path.join(co.projectDir, ".verse8", "project.json")));
    assert.ok(fs.existsSync(path.join(co.projectDir, ".deployed")));
  } finally {
    co.cleanup();
  }
});

test("createCleanCheckout: hooks do not run in the checkout", () => {
  const { dir } = makeRepo();
  const hooks = path.join(dir, "..", path.basename(dir) + "-hooks");
  fs.mkdirSync(hooks);
  const marker = path.join(hooks, "ran");
  fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch "${marker.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
  git(dir, "config", "core.hooksPath", hooks);
  const co = createCleanCheckout(dir);
  co.cleanup();
  assert.equal(fs.existsSync(marker), false);
});

test("uncommittedPaths: modified + untracked under the project, nothing when clean", () => {
  const { dir } = makeRepo();
  assert.deepEqual(uncommittedPaths(dir), []);
  fs.writeFileSync(path.join(dir, "game.js"), "edit\n");
  fs.writeFileSync(path.join(dir, "wip.js"), "new\n");
  assert.deepEqual(uncommittedPaths(dir).sort(), ["game.js", "wip.js"]);
});

test("deployInputSchema: buildFrom defaults to workingTree, accepts head, rejects others", () => {
  assert.equal(deployInputSchema.parse({}).buildFrom, "workingTree");
  assert.equal(deployInputSchema.parse({ buildFrom: "head" }).buildFrom, "head");
  assert.throws(() => deployInputSchema.parse({ buildFrom: "clean" }));
});

test("runDeploy dryRun buildFrom:head → plan shows the clean checkout instead of rm -rf dist", async () => {
  const { dir } = makeRepo();
  const savedFetch = globalThis.fetch;
  const savedTok = process.env.VERSE8_ACCESS_TOKEN;
  process.env.VERSE8_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === "/v1/verse/verseId") {
      return new Response(JSON.stringify({
          verseId: VERSE,
          title: "Live",
          imageUrl: "https://contents.verse8.io/live.png",
          tag: ["rpg"],
          visibility: "Public",
          isOwner: true,
        }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 599 });
  };
  try {
    const input = deployInputSchema.parse({
      projectDir: dir,
      skipAttachCheck: true,
      dryRun: true,
      buildFrom: "head",
      releaseNoteTitle: "v1.1",
      releaseNoteTypes: ["BugFixes"],
      releaseNoteDescription: "Fix.",
    });
    const res = await runDeploy(input, dir);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.plannedSteps.some((s) => s.startsWith("git worktree add --detach")), res.plannedSteps.join("\n"));
    assert.ok(!res.plannedSteps.includes("rm -rf dist"));
    assert.equal(worktreeCount(dir), 1, "dryRun must not create a checkout");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedTok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = savedTok;
  }
});
