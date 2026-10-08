import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import * as url from "node:url";

import { alreadyVendored, commitExists, isAncestor } from "../../scripts/sync-skip-check.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "sync-skip-check.mjs");

/**
 * A stand-in for the agent8-skills checkout: a repo whose main is A → B → C,
 * plus a commit D on main after C, and a dangling commit X nobody pinned.
 * Hooks and user config are isolated so the host's git setup cannot leak in.
 */
function upstreamRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verse8-skip-up-")));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, ".no-global-gitconfig"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const g = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env: gitEnv, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  const commit = (msg) => {
    g("commit", "-q", "--allow-empty", "-m", msg);
    return g("rev-parse", "HEAD");
  };
  const A = commit("A");
  const B = commit("B");
  const C = commit("C");
  const D = commit("D");
  // X: an unrelated branch, so it exists but is not on main.
  g("checkout", "-q", "--orphan", "x");
  const X = commit("X");
  g("checkout", "-q", "main");
  return { dir, A, B, C, D, X, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function withUpstream(fn) {
  const up = upstreamRepo();
  try {
    return fn(up);
  } finally {
    up.cleanup();
  }
}

test("git helpers: commitExists / isAncestor (self counts as ancestor)", () => {
  withUpstream(({ dir, A, C, X }) => {
    assert.equal(commitExists(dir, A), true);
    assert.equal(commitExists(dir, X), true);
    assert.equal(commitExists(dir, "0".repeat(40)), false);
    assert.equal(isAncestor(dir, A, C), true);
    assert.equal(isAncestor(dir, C, C), true);
    assert.equal(isAncestor(dir, C, A), false);
    assert.equal(isAncestor(dir, X, C), false);
  });
});

test("alreadyVendored: a stale dispatch (B) does not rewind a sync PR that already carries C", () => {
  withUpstream(({ dir, A, B, C }) => {
    // main pins A; the open sync branch pins C; B arrives late / is re-run.
    const r = alreadyVendored({
      upstreamDir: dir,
      sha: B,
      pins: [
        { label: "main", commit: A },
        { label: "sync/agent8-skills", commit: C },
      ],
    });
    assert.equal(r.skip, true);
    assert.equal(r.by, "sync/agent8-skills");
    assert.equal(r.pin, C);
    assert.deepEqual(r.warnings, []);
  });
});

test("alreadyVendored: with only main's pin (A), B is new and must be vendored", () => {
  withUpstream(({ dir, A, B }) => {
    const r = alreadyVendored({ upstreamDir: dir, sha: B, pins: [{ label: "main", commit: A }, { label: "sync/agent8-skills", commit: "" }] });
    assert.equal(r.skip, false);
  });
});

test("alreadyVendored: the pinned commit itself, or an ancestor of main's pin, is skipped", () => {
  withUpstream(({ dir, A, B, C }) => {
    assert.equal(alreadyVendored({ upstreamDir: dir, sha: C, pins: [{ label: "sync/agent8-skills", commit: C }] }).skip, true);
    const r = alreadyVendored({ upstreamDir: dir, sha: A, pins: [{ label: "main", commit: B }, { label: "sync/agent8-skills", commit: C }] });
    assert.equal(r.skip, true);
    assert.equal(r.by, "main");
  });
});

test("alreadyVendored: a commit newer than every pin (D after C) is vendored", () => {
  withUpstream(({ dir, A, C, D }) => {
    const r = alreadyVendored({ upstreamDir: dir, sha: D, pins: [{ label: "main", commit: A }, { label: "sync/agent8-skills", commit: C }] });
    assert.equal(r.skip, false);
  });
});

test("alreadyVendored: a pin not on main's history, or malformed, is ignored with a warning", () => {
  withUpstream(({ dir, B, X }) => {
    const r = alreadyVendored({
      upstreamDir: dir,
      sha: B,
      pins: [
        { label: "main", commit: "0".repeat(40) },
        { label: "sync/agent8-skills", commit: "f4eca9b" },
        { label: "x", commit: X },
      ],
    });
    assert.equal(r.skip, false);
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0], /^main: pinned upstream commit 0{40} is not in upstream main's history/);
    assert.match(r.warnings[1], /^sync\/agent8-skills: pin "f4eca9b" is not a full sha/);
  });
});

test("alreadyVendored: --sha must be a full sha", () => {
  withUpstream(({ dir }) => {
    assert.throws(() => alreadyVendored({ upstreamDir: dir, sha: "abc", pins: [] }), /--sha must be a full 40-hex sha/);
  });
});

function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("cli: prints exactly `skip=true` / `skip=false` on stdout, reasoning on stderr", () => {
  withUpstream(({ dir, A, B, C, D }) => {
    const stale = runCli(["--upstream", dir, "--sha", B, "--pin", `main=${A}`, "--pin", `sync/agent8-skills=${C}`]);
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(stale.stdout, "skip=true\n");
    assert.match(stale.stderr, /is the sync\/agent8-skills pin .* or an ancestor of it/);

    const fresh = runCli(["--upstream", dir, "--sha", D, "--pin", `main=${A}`, "--pin", "sync/agent8-skills="]);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout, "skip=false\n");
    assert.match(fresh.stderr, /is newer than every pin \(main=/);
  });
});

test("cli: a pin outside main's history is a ::warning:: under Actions; usage errors exit 2", () => {
  withUpstream(({ dir, B }) => {
    const res = runCli(["--upstream", dir, "--sha", B, "--pin", `main=${"0".repeat(40)}`], { GITHUB_ACTIONS: "true" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "skip=false\n");
    assert.match(res.stderr, /^::warning::main: pinned upstream commit/m);

    assert.equal(runCli(["--upstream", dir]).status, 2);
    assert.equal(runCli(["--upstream", dir, "--sha", B, "--pin", "nolabel"]).status, 2);
    assert.equal(runCli(["--upstream", dir, "--sha", "short"]).status, 2);
  });
});
