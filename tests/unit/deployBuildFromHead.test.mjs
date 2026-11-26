// verse8_deploy `buildFrom: "head"`: install / build / upload run in a
// temporary clean checkout of the checkpoint commit (HEAD read once after
// the checkpoint; playUrl records the same sha), so paths that commit left
// out stay out of the build. Without `files` the checkpoint commits every
// change in the folder — another session's too — so head then warns and
// lists them. Default "workingTree" keeps the old behavior plus a warning
// for paths missing from the commit when the build starts.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  createCleanCheckout,
  deployInputSchema,
  isLocalOnlyBuildFile,
  pruneStaleDeployCheckouts,
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

// ── Full (non-dryRun) runDeploy against fake `bun` / `npx` ────────────────

/**
 * Fake toolchain first on PATH. `bun run build` writes dist/index.html with
 * the game.js it sees (and whether other.js exists), then — as another
 * session would during a minutes-long build — commits a new game.js in the
 * real project, moving HEAD. The `@agent8/deploy --prod` step saves the
 * uploaded dist/index.html to `uploaded`. Other bun / npx calls do nothing.
 */
function fakeToolchain(realDir) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-fake-bin-"));
  const uploaded = path.join(bin, "uploaded.json");
  const bunJs = [
    'const fs = require("fs"); const path = require("path"); const cp = require("child_process");',
    "const args = process.argv.slice(2);",
    'if (args[0] === "run" && args[1] === "build") {',
    '  fs.mkdirSync("dist", { recursive: true });',
    '  fs.writeFileSync(path.join("dist", "index.html"), JSON.stringify({ game: fs.readFileSync("game.js", "utf8"), other: fs.existsSync("other.js") }));',
    `  const real = ${JSON.stringify(realDir)};`,
    '  fs.writeFileSync(path.join(real, "game.js"), "committed by another session during the build\\n");',
    '  const g = (...a) => cp.execFileSync("git", ["-c", "user.email=o@o", "-c", "user.name=other", ...a], { cwd: real, stdio: "ignore" });',
    '  g("add", "game.js");',
    '  g("commit", "-q", "-m", "another session");',
    "}",
  ].join("\n");
  const npxJs = [
    'const fs = require("fs"); const path = require("path");',
    `if (process.argv.includes("--prod")) fs.copyFileSync(path.join("dist", "index.html"), ${JSON.stringify(uploaded)});`,
  ].join("\n");
  for (const [name, js] of [["bun", bunJs], ["npx", npxJs]]) {
    fs.writeFileSync(path.join(bin, `${name}.cjs`), js);
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec node "$(dirname "$0")/${name}.cjs" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@node "%~dp0${name}.cjs" %*\r\n`);
  }
  return { bin, uploaded };
}

/** makeRepo() that can checkpoint offline: commits as a local user, pushes to a local bare repo. */
function makeDeployableRepo() {
  const { repo, dir } = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-deploy-head-remote-"));
  git(bare, "init", "-q", "--bare");
  git(repo, "config", "user.email", "me@me");
  git(repo, "config", "user.name", "me");
  // detectVerseProject needs the gitlab origin; the push goes to the bare repo.
  git(repo, "config", "remote.origin.pushurl", bare);
  return { repo, dir };
}

async function deployWithFakes(dir, extra) {
  const { bin, uploaded } = fakeToolchain(dir);
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN, path: process.env.PATH };
  process.env.VERSE8_ACCESS_TOKEN = "test-token";
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (p === "/v1/verse/verseId") {
      return json({ verseId: VERSE, title: "Live", imageUrl: "https://contents.verse8.io/live.png", tag: ["rpg"], visibility: "Public", isOwner: true });
    }
    if (p === `/v1/verse/update/${VERSE}` && init?.method === "POST") return json({ verseId: VERSE, title: "Live" });
    return new Response("{}", { status: 599 });
  };
  try {
    const input = deployInputSchema.parse({
      projectDir: dir,
      skipAttachCheck: true,
      message: "wip",
      installCommand: "bun install",
      releaseNoteTitle: "v1.1",
      releaseNoteTypes: ["BugFixes"],
      releaseNoteDescription: "Fix.",
      ...extra,
    });
    const res = await runDeploy(input, dir);
    assert.equal(res.ok, true, JSON.stringify(res));
    const sha = new URL(res.playUrl).searchParams.get("sha");
    return { res, sha, uploaded: JSON.parse(fs.readFileSync(uploaded, "utf8")) };
  } finally {
    globalThis.fetch = saved.fetch;
    process.env.PATH = saved.path;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}

for (const buildFrom of ["head", "workingTree"]) {
  test(`runDeploy buildFrom:${buildFrom}: HEAD moving during the build → uploaded build and playUrl sha are the same commit`, async () => {
    const { dir } = makeDeployableRepo();
    fs.writeFileSync(path.join(dir, "game.js"), "v2 from this session\n");
    const { sha, uploaded } = await deployWithFakes(dir, { buildFrom });
    assert.match(sha ?? "", /^[0-9a-f]{40}$/);
    assert.notEqual(git(dir, "rev-parse", "HEAD"), sha, "the fake build moved HEAD");
    assert.equal(uploaded.game, "v2 from this session\n");
    assert.equal(git(dir, "show", `${sha}:game.js`), "v2 from this session");
    if (buildFrom === "head") assert.equal(worktreeCount(dir), 1, "checkout removed");
  });
}

/**
 * A pre-push hook: while the checkpoint pushes (its commit made, its result
 * not yet returned), another session commits game.js in the same folder.
 * The hook records the checkpoint commit (HEAD when it starts) first.
 */
function commitRightAfterCheckpoint(repo, dir) {
  const hooks = path.resolve(repo, git(repo, "rev-parse", "--git-path", "hooks"));
  fs.mkdirSync(hooks, { recursive: true });
  const ckFile = path.join(repo, "..", `${path.basename(repo)}-checkpoint-sha`);
  const sh = (p) => `'${p.replace(/\\/g, "/")}'`;
  fs.writeFileSync(
    path.join(hooks, "pre-push"),
    [
      "#!/bin/sh",
      "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE",
      `cd ${sh(dir)} || exit 1`,
      `git rev-parse HEAD > ${sh(ckFile)}`,
      "printf 'committed by another session right after the checkpoint\\n' > game.js",
      'git -c user.email=o@o -c user.name=other commit -q -am "another session" >/dev/null 2>&1',
      'rm -f "$0"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return () => fs.readFileSync(ckFile, "utf8").trim();
}

for (const buildFrom of ["head", "workingTree"]) {
  test(`runDeploy buildFrom:${buildFrom}: a commit right after the checkpoint → playUrl records the checkpoint's commit${buildFrom === "head" ? ", and that commit is built" : "; the moved HEAD is warned"}`, async () => {
    const { repo, dir } = makeDeployableRepo();
    fs.writeFileSync(path.join(dir, "game.js"), "v2 from this session\n");
    const checkpointSha = commitRightAfterCheckpoint(repo, dir);
    const { res, sha, uploaded } = await deployWithFakes(dir, { buildFrom });
    const ck = checkpointSha();
    assert.match(ck, /^[0-9a-f]{40}$/, "the hook ran during the checkpoint's push");
    assert.equal(git(dir, "log", "--format=%s", "--reverse", `${ck}..HEAD`).split("\n")[0], "another session", "another session committed right after the checkpoint");
    assert.equal(sha, ck, "playUrl records the checkpoint's commit, not the HEAD after it");
    assert.equal(git(dir, "show", `${sha}:game.js`), "v2 from this session");
    if (buildFrom === "head") {
      assert.equal(uploaded.game, "v2 from this session\n", "the checkpoint's commit is what was built");
      assert.ok(!res.warnings.some((w) => w.includes("HEAD moved to")), res.warnings.join("\n"));
    } else {
      assert.equal(uploaded.game, "committed by another session right after the checkpoint\n", "the working tree build sees the later commit");
      assert.ok(res.warnings.some((w) => w.includes("HEAD moved to") && w.includes(ck.slice(0, 12))), res.warnings.join("\n"));
    }
  });
}

const sweptWarning = (res) => res.warnings.find((w) => w.includes("without `files` the checkpoint committed"));
const workingTreeWarning = (res) => res.warnings.find((w) => w.startsWith("Built from the working tree"));

test("runDeploy buildFrom:head without files → the checkpoint commits another session's edits too; warning lists the committed paths", async () => {
  const { dir } = makeDeployableRepo();
  fs.writeFileSync(path.join(dir, "game.js"), "v2 from this session\n");
  fs.writeFileSync(path.join(dir, "other.js"), "another session's work in progress\n");
  const { res, uploaded } = await deployWithFakes(dir, { buildFrom: "head" });
  // head does not filter what the checkpoint itself committed.
  assert.equal(uploaded.other, true);
  const w = sweptWarning(res);
  assert.ok(w, res.warnings.join("\n"));
  assert.match(w, /\(2 path\(s\)\): game\.js, other\.js\./);
  assert.equal(workingTreeWarning(res), undefined);
});

test("runDeploy buildFrom:head without files, many paths → first 10 listed plus a count", async () => {
  const { dir } = makeDeployableRepo();
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, "0")}.js`), `${i}\n`);
  const { res } = await deployWithFakes(dir, { buildFrom: "head" });
  const w = sweptWarning(res);
  assert.ok(w, res.warnings.join("\n"));
  assert.match(w, /\(12 path\(s\)\): f00\.js, .*f09\.js … and 2 more\./);
  assert.ok(!w.includes("f10.js"));
});

test("runDeploy buildFrom:head with files → only those are committed and built; no swept-paths warning", async () => {
  const { dir } = makeDeployableRepo();
  fs.writeFileSync(path.join(dir, "game.js"), "v2 from this session\n");
  fs.writeFileSync(path.join(dir, "other.js"), "another session's work in progress\n");
  const { res, uploaded } = await deployWithFakes(dir, { buildFrom: "head", files: ["game.js"] });
  assert.equal(uploaded.game, "v2 from this session\n");
  assert.equal(uploaded.other, false, "another session's uncommitted file stays out of the build");
  assert.equal(sweptWarning(res), undefined);
  assert.deepEqual(uncommittedPaths(dir), ["other.js"]);
});

test("runDeploy buildFrom:workingTree: warning only for paths the checkpoint left out (files), not after a full checkpoint", async () => {
  const scoped = makeDeployableRepo();
  fs.writeFileSync(path.join(scoped.dir, "game.js"), "v2 from this session\n");
  fs.writeFileSync(path.join(scoped.dir, "other.js"), "another session's work in progress\n");
  const a = await deployWithFakes(scoped.dir, { files: ["game.js"] });
  assert.equal(a.uploaded.other, true);
  assert.match(workingTreeWarning(a.res) ?? "", /1 path\(s\) not in the deployed commit \(e\.g\. other\.js\)/);

  const full = makeDeployableRepo();
  fs.writeFileSync(path.join(full.dir, "game.js"), "v2 from this session\n");
  fs.writeFileSync(path.join(full.dir, "other.js"), "another session's work in progress\n");
  // Not gitignored here: never committed, and a clean checkout gets it too — not counted.
  fs.writeFileSync(path.join(full.dir, ".gitignore"), "node_modules\ndist\n");
  git(full.dir, "add", ".gitignore");
  git(full.dir, "commit", "-q", "-m", "track less");
  const b = await deployWithFakes(full.dir, {});
  assert.equal(workingTreeWarning(b.res), undefined, b.res.warnings.join("\n"));
  assert.equal(sweptWarning(b.res), undefined);
});

test("createCleanCheckout(dir, sha): checks out that commit even after HEAD moved; exposes the sha", () => {
  const { dir } = makeRepo();
  const first = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "game.js"), "newer\n");
  git(dir, "commit", "-q", "-am", "newer");
  const co = createCleanCheckout(dir, first);
  try {
    assert.equal(co.sha, first);
    assert.equal(fs.readFileSync(path.join(co.projectDir, "game.js"), "utf8"), "committed\n");
  } finally {
    co.cleanup();
  }
});

test("uncommittedPaths: a staged rename counts once, by its new path (porcelain -z puts the old path in a separate token)", () => {
  const { dir } = makeRepo();
  git(dir, "mv", "game.js", "main.js");
  assert.deepEqual(uncommittedPaths(dir), ["main.js"]);
});

test("uncommittedPaths: nested project → paths relative to the project; exceptLocalOnly skips untracked local build files", () => {
  const { dir } = makeRepo("games/demo");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\ndist\n");
  git(dir, "commit", "-q", "-am", "track less");
  fs.writeFileSync(path.join(dir, "game.js"), "edit\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", ".env"), "not at the project root\n");
  assert.deepEqual(uncommittedPaths(dir).sort(), [".crossramp", ".deployed", ".secret", "game.js", "src/.env"]);
  assert.deepEqual(uncommittedPaths(dir, { exceptLocalOnly: true }).sort(), ["game.js", "src/.env"]);
});

// ── Checkouts left behind by a deploy whose process died ──────────────────

const worktreePaths = (dir) =>
  git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => path.resolve(l.slice("worktree ".length)));

/** A pid that is not running: a child that already exited. */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/**
 * What a deploy whose process died mid-build leaves: a worktree at
 * `<tmp>/verse8-deploy-head-*` + `/checkout` and its owner record. Made by
 * hand — createCleanCheckout() would prune the previous one first.
 */
function abandonCheckout(dir, owner = { pid: process.pid, createdAt: Date.now() }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-deploy-head-"));
  const root = path.join(tmp, "checkout");
  git(dir, "worktree", "add", "-q", "--detach", root, "HEAD");
  fs.writeFileSync(path.join(tmp, "owner.json"), JSON.stringify(owner));
  return path.resolve(root);
}

test("pruneStaleDeployCheckouts: removes only our stale checkouts; user worktrees (even prunable) and live checkouts stay", () => {
  const { repo, dir } = makeRepo();
  // The user's own worktrees: one present, one whose folder is gone (prunable).
  const userWt = fs.mkdtempSync(path.join(os.tmpdir(), "user-wt-")) + "/wt";
  git(dir, "worktree", "add", "-q", "--detach", userWt, "HEAD");
  const userGone = fs.mkdtempSync(path.join(os.tmpdir(), "user-wt-gone-"));
  git(dir, "worktree", "add", "-q", "--detach", path.join(userGone, "wt"), "HEAD");
  fs.rmSync(userGone, { recursive: true, force: true });

  const live = abandonCheckout(dir); // owned by this (running) process
  const deadOwner = abandonCheckout(dir, { pid: deadPid(), createdAt: Date.now() });
  const tooOld = abandonCheckout(dir, { pid: process.pid, createdAt: Date.now() - 25 * 60 * 60 * 1000 });
  const folderGone = abandonCheckout(dir);
  fs.rmSync(path.dirname(folderGone), { recursive: true, force: true });
  assert.equal(worktreeCount(dir), 7);

  const removed = pruneStaleDeployCheckouts(dir).map((p) => path.resolve(p));
  assert.deepEqual(removed.sort(), [deadOwner, tooOld, folderGone].sort());

  const left = worktreePaths(dir);
  assert.ok(left.includes(path.resolve(repo)));
  assert.ok(left.includes(path.resolve(userWt)), "user worktree kept");
  assert.ok(left.includes(path.resolve(userGone, "wt")), "user's prunable worktree record kept (no plain git worktree prune)");
  assert.ok(left.includes(live), "a checkout another deploy is building in is kept");
  assert.equal(left.length, 4);
  assert.ok(fs.existsSync(live));
  assert.equal(fs.existsSync(path.dirname(deadOwner)), false, "temp dir removed too");
  assert.equal(fs.existsSync(path.dirname(tooOld)), false);
  assert.ok(fs.existsSync(userWt));
});

test("createCleanCheckout prunes a stale checkout first; cleanup() leaves the user's prunable worktree record alone", () => {
  const { dir } = makeRepo();
  const userGone = fs.mkdtempSync(path.join(os.tmpdir(), "user-wt-gone-"));
  git(dir, "worktree", "add", "-q", "--detach", path.join(userGone, "wt"), "HEAD");
  fs.rmSync(userGone, { recursive: true, force: true });
  abandonCheckout(dir, { pid: deadPid(), createdAt: Date.now() });
  assert.equal(worktreeCount(dir), 3);
  const co = createCleanCheckout(dir);
  assert.equal(worktreeCount(dir), 3, "stale one removed, new one added");
  co.cleanup();
  assert.deepEqual(worktreePaths(dir).slice(1), [path.resolve(userGone, "wt")]);
});

// ── INV-17: the publish uses the game as it is after the build, not as it was before ──
// The build and upload take minutes. The deploy reads the game again right
// before the publish call: what changed on the web meanwhile is kept, and a
// publish that would widen who can see the game without the user's
// confirmation of exactly that change does not happen.

/**
 * A full deploy with the fake toolchain. `readings` is what each successive
 * GET of the game answers (the last one repeats): the first is the reading
 * at the start, later ones are after the user's Run and before the publish.
 */
async function deployOverTime(dir, { extra = {}, readings, host }) {
  const { bin } = fakeToolchain(dir);
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN, path: process.env.PATH };
  process.env.VERSE8_ACCESS_TOKEN = "test-token";
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  const base = { verseId: VERSE, title: "Live", imageUrl: "https://contents.verse8.io/live.png", tag: ["rpg"], isOwner: true };
  const posts = [];
  let gets = 0;
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (p === "/v1/verse/verseId") return json({ ...base, ...readings[Math.min(gets++, readings.length - 1)] });
    if (p === `/v1/verse/update/${VERSE}` && init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return json({ verseId: VERSE, title: "Live" });
    }
    return new Response("{}", { status: 599 });
  };
  try {
    const input = deployInputSchema.parse({
      projectDir: dir,
      skipAttachCheck: true,
      message: "wip",
      installCommand: "bun install",
      releaseNoteTitle: "v1.1",
      releaseNoteTypes: ["BugFixes"],
      releaseNoteDescription: "Fix.",
      ...extra,
    });
    const res = await runDeploy(input, dir, host);
    return { res, posts, gets };
  } finally {
    globalThis.fetch = saved.fetch;
    process.env.PATH = saved.path;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}
const userRuns = () => {
  const asked = [];
  return { asked, canAsk: true, ask: async (message) => { asked.push(message); return { action: "accept", content: { choice: "Run" } }; } };
};
const freshProject = () => {
  const { dir } = makeDeployableRepo();
  fs.writeFileSync(path.join(dir, "game.js"), "v2 from this session\n");
  return dir;
};

test("deploy without visibility: the game is set to Private on the web during the build → the publish sends Private, not the Public read at the start", async () => {
  const { res, posts, gets } = await deployOverTime(freshProject(), { readings: [{ visibility: "Public" }, { visibility: "Private" }] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(gets, 2, "read at the start and again before publishing");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].visibility, "Private");
  assert.equal(res.publishBody.visibility, "Private");
});

test("deploy without visibility: a title and tags edited on the web during the build are published as they are now, not put back", async () => {
  const { res, posts } = await deployOverTime(freshProject(), {
    readings: [{ visibility: "Public" }, { visibility: "Public", title: "Renamed on the web", tag: ["rpg", "arcade"] }],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(posts[0].title, "Renamed on the web");
  assert.deepEqual(posts[0].tag, ["rpg", "arcade"]);
  assert.equal(posts[0].visibility, "Public");
});

test("deploy with visibility Public on a Public game (not asked): set to Private on the web during the build → not published; says the files are uploaded and to deploy again", async () => {
  const host = userRuns();
  const { res, posts } = await deployOverTime(freshProject(), {
    extra: { visibility: "Public" },
    readings: [{ visibility: "Public" }, { visibility: "Private" }],
    host,
  });
  assert.equal(host.asked.length, 0, "Public → Public was not a widening, nobody was asked");
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.stage, "publish");
  assert.equal(res.error, "plan_mismatch");
  assert.deepEqual(posts, [], "nothing was published");
  assert.equal(res.filesLive, true);
  assert.deepEqual(res.visibility, { atStart: "Public", now: "Private", requested: "Public" });
  assert.match(res.hint, /^Not published: the game changed on the web during the build\. It is now Private/);
  assert.match(res.hint, /the user was not asked/);
  assert.match(res.hint, /game files are already uploaded at https:\/\//);
  assert.match(res.hint, /Run verse8_deploy again/);
  assert.ok(res.steps.length > 0, "the steps that did run are reported");
});

test("deploy with visibility Public, confirmed Private → Public: the game is Unlisted by publish time → not published (not the change the user confirmed)", async () => {
  const host = userRuns();
  const { res, posts, gets } = await deployOverTime(freshProject(), {
    extra: { visibility: "Public" },
    readings: [{ visibility: "Private" }, { visibility: "Private" }, { visibility: "Unlisted" }],
    host,
  });
  assert.equal(host.asked.length, 1);
  assert.match(host.asked[0], /Visibility: Private → Public/);
  assert.equal(gets, 3, "start, after Run, before publishing");
  assert.equal(res.error, "plan_mismatch", JSON.stringify(res));
  assert.equal(res.stage, "publish");
  assert.match(res.hint, /It is now Unlisted .*the user confirmed Private → Public/);
  assert.deepEqual(posts, []);
});

test("deploy with visibility Public, confirmed Private → Public, nothing changed during the build → published as confirmed", async () => {
  const host = userRuns();
  const { res, posts } = await deployOverTime(freshProject(), { extra: { visibility: "Public" }, readings: [{ visibility: "Private" }], host });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(host.asked.length, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].visibility, "Public");
});

test("deploy with visibility Private: whatever the game became during the build, narrowing is published without asking", async () => {
  const { res, posts } = await deployOverTime(freshProject(), { extra: { visibility: "Private" }, readings: [{ visibility: "Public" }, { visibility: "Unlisted" }] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(posts[0].visibility, "Private");
});

test("deploy: the game cannot be read again before publishing → not published, and the result says the files are already uploaded", async () => {
  const dir = freshProject();
  const { bin } = fakeToolchain(dir);
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN, path: process.env.PATH };
  process.env.VERSE8_ACCESS_TOKEN = "test-token";
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  let gets = 0;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    if (p === "/v1/verse/verseId") {
      return gets++ === 0
        ? new Response(JSON.stringify({ verseId: VERSE, title: "Live", imageUrl: "https://contents.verse8.io/live.png", tag: ["rpg"], visibility: "Public", isOwner: true }), { status: 200 })
        : new Response(JSON.stringify({ message: "boom" }), { status: 503 });
    }
    if (init?.method === "POST") posts.push(p);
    return new Response("{}", { status: 599 });
  };
  try {
    const input = deployInputSchema.parse({ projectDir: dir, skipAttachCheck: true, message: "wip", installCommand: "bun install", releaseNoteTitle: "v1.1", releaseNoteTypes: ["BugFixes"], releaseNoteDescription: "Fix." });
    const res = await runDeploy(input, dir);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.stage, "publish");
    assert.equal(res.error, "upstream_error");
    assert.equal(res.filesLive, true);
    assert.match(res.hint, /could not be read again before publishing: HTTP 503/);
    assert.match(res.hint, /already uploaded/);
    assert.deepEqual(posts, []);
  } finally {
    globalThis.fetch = saved.fetch;
    process.env.PATH = saved.path;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
});
