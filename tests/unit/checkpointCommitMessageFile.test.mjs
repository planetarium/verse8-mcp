// verse8_checkpoint: the commit message goes through a file (`git commit -F`),
// so a V8 message with many file diffs does not hit the Windows command-line
// limit (spawnSync git ENAMETOOLONG, ~32,767 chars).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  commitWithMessageFile,
  runCheckpoint,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-ckpt-rec-"));
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

test("commitWithMessageFile: stores the message exactly like `git commit -m` (multi-line, # lines, unicode)", () => {
  const dir = makeProject();
  const message = "[verse8] subject\n\n# kept heading\n한글 본문 — “quotes” $HOME `tick`\n";
  fs.writeFileSync(path.join(dir, "a.js"), "a\n");
  git(dir, "add", "a.js");
  commitWithMessageFile(dir, message);
  const viaFile = git(dir, "log", "-1", "--format=%B");

  fs.writeFileSync(path.join(dir, "b.js"), "b\n");
  git(dir, "add", "b.js");
  git(dir, "commit", "-q", "-m", message);
  const viaArgv = git(dir, "log", "-1", "--format=%B");

  assert.equal(viaFile, viaArgv);
  assert.ok(viaFile.includes("# kept heading"));
  assert.ok(viaFile.includes("한글 본문"));
});

test("commitWithMessageFile: leaves no temp message file behind", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "a.js"), "a\n");
  git(dir, "add", "a.js");
  // A private temp dir, so test files running in parallel cannot interfere.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-tmpdir-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = tmp;
  try {
    assert.equal(os.tmpdir(), tmp);
    commitWithMessageFile(dir, "[verse8] tmp cleanup");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "[verse8] tmp cleanup");
});

test("runCheckpoint: a V8 message longer than the Windows command line (32,767 chars) commits", async () => {
  const dir = makeProject();
  // Each new file inlines up to 2,000 chars into the V8 message; 30 files ≈ 60k.
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(dir, `asset${i}.txt`), `${i}`.padEnd(2500, "x") + "\n");
  }
  const res = await withEnvToken(() =>
    runCheckpoint(
      {
        ...baseInput(dir),
        userPrompt: "add many files",
        problemStatement: "The user wants many files added.",
        workSummary: "Added 30 files.",
      },
      dir,
    ),
  );
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 2000));
  assert.ok(res.messageLength > 32_767, `messageLength ${res.messageLength} should exceed the Windows limit`);
  const body = git(dir, "log", "-1", "--format=%B");
  assert.ok(body.length > 32_767);
  assert.ok(body.startsWith("add many files"), body.slice(0, 200));
  assert.equal(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).length, 30);
});
