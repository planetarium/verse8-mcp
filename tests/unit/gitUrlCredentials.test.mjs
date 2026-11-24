// INV-15: Git URLs in tool results carry no credentials.
//
// A clone made with a project token keeps it in origin
// (`https://oauth2:<PAT>@gitlab.verse8.io/…`). verse8_status reports that URL
// as `project.gitlabRemote` in a SUCCESS result, which the dispatch-boundary
// redaction (INV-13) deliberately leaves alone — so the URL has to be clean
// where it is read.
//
// Runs against dist/ with globalThis.fetch stubbed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { stripUrlCredentials } from "../../dist/util/redact.js";
import { detectVerseProject } from "../../dist/context/verseProject.js";
import { runStatus } from "../../dist/tools/status.js";
import { runPreCommitHook } from "../../dist/cli/preCommitHook.js";

const PAT = "glpat-leakInOriginUrl0123456789";

const savedEnv = {};
const roots = [];
before(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VERSE8_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
});
after(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("VERSE8_")) delete process.env[k];
  Object.assign(process.env, savedEnv);
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

/** A verse8-looking repo (marker + origin) whose origin is `origin`. */
function repoWithOrigin(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-giturl-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  fs.mkdirSync(path.join(dir, ".verse8"));
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), '{"version":1,"projectId":"p1"}\n');
  return dir;
}

test("INV-15: stripUrlCredentials drops userinfo, keeps scp-style remotes, rejects garbage", () => {
  assert.equal(
    stripUrlCredentials(`https://oauth2:${PAT}@gitlab.verse8.io/owner/game.git`),
    "https://gitlab.verse8.io/owner/game.git",
  );
  assert.equal(stripUrlCredentials("https://gitlab.verse8.io/owner/game.git"), "https://gitlab.verse8.io/owner/game.git");
  assert.equal(stripUrlCredentials("git@gitlab.verse8.io:owner/game.git"), "git@gitlab.verse8.io:owner/game.git");
  assert.equal(stripUrlCredentials(""), null);
  assert.equal(stripUrlCredentials(undefined), null);
  assert.equal(stripUrlCredentials("not a url"), null);
});

test("INV-15: project detection reports origin without the project token", () => {
  const dir = repoWithOrigin(`https://oauth2:${PAT}@gitlab.verse8.io/owner/game.git`);
  const d = detectVerseProject(dir);
  assert.equal(d.isVerse, true);
  assert.equal(d.gitlabRemote, "https://gitlab.verse8.io/owner/game.git");
});

test("INV-15: verse8_status success result carries no token in project.gitlabRemote", async () => {
  const dir = repoWithOrigin(`https://oauth2:${PAT}@gitlab.verse8.io/owner/game.git`);
  process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";
  const saved = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ walletAddress: "0xabc", exp: Math.floor(Date.now() / 1000) + 86400 }), { status: 200 });
  try {
    const r = await runStatus(dir);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.project.gitlabRemote, "https://gitlab.verse8.io/owner/game.git");
    assert.ok(!JSON.stringify(r).includes(PAT), JSON.stringify(r));
  } finally {
    globalThis.fetch = saved;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("INV-15: the pre-commit hook's wrong-origin message carries no credentials", () => {
  // Its stderr reaches the agent through `git commit` output.
  const dir = repoWithOrigin(`https://user:${PAT}@github.com/owner/game.git`);
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return true;
  };
  let code;
  try {
    code = runPreCommitHook(dir);
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(code, 1);
  const out = writes.join("");
  assert.match(out, /got: github\.com from https:\/\/github\.com\/owner\/game\.git/);
  assert.ok(!out.includes(PAT), out);
});
