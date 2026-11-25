// verse8_deploy_status (read-only: live commit, release note, local relation,
// game server state) and verse8_preview `serverOnly` (gameserver build +
// preview upload only, server.js re-upload forced).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  SERVER_UPLOAD_TIME_NOTE,
  deployStatusInputSchema,
  parsePlayUrl,
  relateLocalToPublished,
  runDeployStatus,
} from "../../dist/tools/deployStatus.js";
import {
  buildPreflightSteps,
  forgetDeployedServerHash,
  previewInputSchema,
  runPreview,
} from "../../dist/tools/preview.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-ds-"));
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function withFetch(routes, f) {
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ u, method: init.method ?? "GET" });
    const r = routes[u.pathname];
    return r ? r(u) : json(404, { error: "Not found" });
  };
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  try {
    return await f(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}

test("parsePlayUrl: sha + buildAt (ms) → ISO; junk → nulls", () => {
  assert.deepEqual(parsePlayUrl("https://x.verse8.games/index.html?chatId=u%2Fp&sha=cc046283f0d0&buildAt=1795157396004"), {
    sha: "cc046283f0d0",
    buildAt: "2026-11-20T06:49:56.004Z",
  });
  assert.deepEqual(parsePlayUrl("https://x/index.html?sha=not-a-sha&buildAt=abc"), { sha: null, buildAt: null });
  assert.deepEqual(parsePlayUrl(undefined), { sha: null, buildAt: null });
});

test("relateLocalToPublished: ancestor + commits since + uncommitted; unknown sha", () => {
  const dir = repo();
  const published = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
  git(dir, "commit", "-qam", "two");
  fs.writeFileSync(path.join(dir, "a.txt"), "3\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
  const r = relateLocalToPublished(dir, published);
  assert.equal(r.publishedCommitKnown, true);
  assert.equal(r.publishedIsAncestorOfHead, true);
  assert.equal(r.commitsSincePublished, 1);
  assert.equal(r.uncommittedPaths, 2);
  const u = relateLocalToPublished(dir, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(u.publishedCommitKnown, false);
  assert.equal(u.commitsSincePublished, null);
});

test("runDeployStatus: published verse → sha/time, release note, local relation, server state (GET only)", async () => {
  const dir = repo();
  const sha = git(dir, "rev-parse", "HEAD");
  await withFetch(
    {
      "/v1/verse/verseId": () =>
        json(200, {
          verseId: VERSE,
          title: "G",
          visibility: "Public",
          reviewStatus: "PASSED",
          isOwner: true,
          playUrl: `https://x.verse8.games/index.html?sha=${sha}&buildAt=1795157396004`,
          latestReleaseNote: { buildVersion: 6, title: "v6", releaseTypes: ["Improvements"], createdAt: "2026-11-20T06:50:19.871Z", reviewStatus: null, description: "long" },
        }),
      [`/v1/verses/${VERSE}/server-view`]: () => json(200, { version: "v2" }),
      [`/v1/verses/${VERSE}/overview`]: () => json(200, { state: "running" }),
      [`/v1/verses/${VERSE}-preview/server-view`]: () => json(403, { error: "nope" }),
    },
    async (calls) => {
      const r = await runDeployStatus(deployStatusInputSchema.parse({ projectDir: dir }), dir);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.published, true);
      assert.equal(r.publishedSha, sha);
      assert.equal(r.publishedAt, "2026-11-20T06:49:56.004Z");
      assert.equal(r.latestReleaseNote.buildVersion, 6);
      assert.equal(r.latestReleaseNote.description, undefined);
      assert.equal(r.local.publishedIsAncestorOfHead, true);
      assert.equal(r.local.commitsSincePublished, 0);
      assert.deepEqual({ v: r.gameServer.prod.version, s: r.gameServer.prod.state }, { v: "v2", s: "running" });
      assert.match(r.gameServer.preview.error, /403/);
      assert.equal(r.gameServer.serverCodeUploadedAt, null);
      assert.equal(r.gameServer.serverCodeUploadedAtNote, SERVER_UPLOAD_TIME_NOTE);
      assert.ok(calls.every((c) => c.method === "GET"));
    },
  );
});

test("runDeployStatus: never published (404) → published:false, still reports local + server", async () => {
  const dir = repo();
  await withFetch(
    {
      "/v1/verse/verseId": () => json(404, { message: "not found" }),
      [`/v1/verses/${VERSE}/server-view`]: () => json(200, { version: null }),
      [`/v1/verses/${VERSE}/overview`]: () => json(200, { state: "never-deployed" }),
    },
    async () => {
      const r = await runDeployStatus({ projectDir: dir }, dir);
      assert.equal(r.ok, true);
      assert.equal(r.published, false);
      assert.equal(r.gameServer.prod.state, "never-deployed");
      assert.ok(r.local.head);
    },
  );
});

test("runDeployStatus: 401 from the verse API → unauthorized", async () => {
  const dir = repo();
  await withFetch({ "/v1/verse/verseId": () => json(401, { message: "bad token" }) }, async () => {
    const r = await runDeployStatus({ projectDir: dir }, dir);
    assert.equal(r.ok, false);
    assert.equal(r.error, "unauthorized");
    // The hint says where the rejected token came from (here: the env var),
    // not just "log in again".
    assert.match(r.hint, /VERSE8_ACCESS_TOKEN environment variable/);
    assert.match(r.hint, /logging in again does not replace it/);
  });
});

test("forgetDeployedServerHash: drops only server.js; missing or broken .deployed is left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-deployed-"));
  assert.equal(forgetDeployedServerHash(dir), false);
  fs.writeFileSync(path.join(dir, ".deployed"), "{not json");
  assert.equal(forgetDeployedServerHash(dir), false);
  assert.equal(fs.readFileSync(path.join(dir, ".deployed"), "utf8"), "{not json");
  fs.writeFileSync(path.join(dir, ".deployed"), JSON.stringify({ "server.js": "h1", "index.html": "h2" }));
  assert.equal(forgetDeployedServerHash(dir), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".deployed"), "utf8")), { "index.html": "h2" });
  assert.equal(forgetDeployedServerHash(dir), false);
});

test("buildPreflightSteps skipInstall: only gameserver build + preview deploy; token only on deploy", () => {
  const steps = buildPreflightSteps("bun update", true, { token: "T", baseEnv: { PATH: "/bin" }, skipInstall: true });
  assert.equal(steps.length, 2);
  assert.match(steps[0].command, /gameserver-node.* build$/);
  assert.match(steps[1].command, /@agent8\/deploy.* --preview$/);
  assert.equal(steps[0].env.V8_ACCESS_TOKEN, undefined);
  assert.equal(steps[1].env.V8_ACCESS_TOKEN, "T");
  assert.equal(buildPreflightSteps("bun update", true, { token: "T" }).length, 3);
});

test("runPreview serverOnly: no game server → no_gameserver; nothing runs", async () => {
  const dir = repo();
  const r = await runPreview(previewInputSchema.parse({ projectDir: dir, serverOnly: true }), dir);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_gameserver");
});

test("runPreview serverOnly: runs only the two server steps (fake npx), forces server.js, leaves git and the dev server alone", async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, "server"));
  fs.writeFileSync(path.join(dir, ".deployed"), JSON.stringify({ "server.js": "old", "index.html": "h" }));
  fs.writeFileSync(path.join(dir, "a.txt"), "uncommitted\n");
  const head = git(dir, "rev-parse", "HEAD");

  // A fake `npx` first on PATH that records its argv and whether it saw the token.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-fake-npx-"));
  const log = path.join(bin, "calls.log");
  fs.writeFileSync(path.join(bin, "npx.cmd"), `@echo off\r\nif defined V8_ACCESS_TOKEN (echo %* token>> "${log}") else (echo %* notoken>> "${log}")\r\n`);
  fs.writeFileSync(path.join(bin, "npx"), `#!/bin/sh\nif [ -n "$V8_ACCESS_TOKEN" ]; then echo "$* token" >> "${log}"; else echo "$* notoken" >> "${log}"; fi\n`, { mode: 0o755 });
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const savedPath = process.env[pathKey];
  const savedTok = process.env.VERSE8_ACCESS_TOKEN;
  process.env[pathKey] = bin + path.delimiter + savedPath;
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  try {
    const r = await runPreview(previewInputSchema.parse({ projectDir: dir, serverOnly: true, previewPort: 59999 }), dir);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.serverOnly, true);
    assert.equal(r.forcedServerUpload, true);
    assert.equal(r.verse, `${VERSE}-preview`);
    assert.equal(r.preflight.steps.length, 2);
    const lines = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).map((l) => l.trim());
    assert.equal(lines.length, 2, lines.join("\n"));
    assert.match(lines[0], /gameserver-node.* build notoken$/);
    assert.match(lines[1], /@agent8\/deploy.* --preview token$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".deployed"), "utf8")), { "index.html": "h" });
    // No checkpoint, no dev server.
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.match(git(dir, "status", "--porcelain"), /a\.txt/);
    assert.equal(r.preview, undefined);
  } finally {
    process.env[pathKey] = savedPath;
    if (savedTok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = savedTok;
  }
});
