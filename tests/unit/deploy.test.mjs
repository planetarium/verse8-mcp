// Unit tests for verse8_deploy (first vs update publish) and its helpers.
//
// Network is stubbed via globalThis.fetch; runDeploy is exercised in
// dryRun mode so no checkpoint / build / @agent8/deploy runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  buildDeploySteps,
  buildPlayUrl,
  buildPublishBody,
  buildPublishTags,
  deployInputSchema,
  readParentVerseId,
  runDeploy,
} from "../../dist/tools/deploy.js";
import { isMsuProject, stripComments } from "../../dist/context/msuProject.js";
import { sanitizeChildEnv } from "../../dist/util/childEnv.js";

const VERSE = "0xabc-1700000000000";

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-deploy-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git"], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".verse8"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".verse8", "project.json"),
    JSON.stringify({ version: 1, projectId: "demo", attachedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
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

function withFetch(handler, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = saved;
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Records every request and answers from a route table keyed by "METHOD path". */
function router(routes) {
  const calls = [];
  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    calls.push({ key, url: u, init });
    const route = routes[key];
    if (!route) return json(599, { error: `unrouted ${key}` });
    return route(u, init);
  };
  return { calls, handler };
}

function dryRunInput(dir, extra = {}) {
  return deployInputSchema.parse({ projectDir: dir, skipAttachCheck: true, dryRun: true, ...extra });
}

// ── pure helpers ─────────────────────────────────────────────────────────

test("buildPublishTags: update keeps user tags, drops admin system tags, keeps allowed ones", () => {
  const tags = buildPublishTags(undefined, ["rpg", "__featured_x", "__review_required", "fun"], false);
  assert.deepEqual(tags, ["rpg", "fun", "__review_required"]);
});

test("buildPublishTags: explicit input tags replace user tags; MSU adds __MSU + __review_required once", () => {
  const tags = buildPublishTags(["action"], ["old", "__review_required"], true);
  assert.deepEqual(tags, ["action", "__review_required", "__MSU"]);
});

test("buildPlayUrl: agent8-games host, chatId/sha/buildAt query like the web editor", () => {
  const url = new URL(buildPlayUrl(VERSE, "deadbeef", "u/demo", 123));
  assert.equal(url.origin + url.pathname, `https://agent8-games.verse8.io/${VERSE}/index.html`);
  assert.equal(url.searchParams.get("chatId"), "u/demo");
  assert.equal(url.searchParams.get("sha"), "deadbeef");
  assert.equal(url.searchParams.get("buildAt"), "123");
});

test("buildPublishBody: first deploy carries verseId + defaults and omits undefined fields", () => {
  const body = buildPublishBody({
    mode: "first",
    verseId: VERSE,
    playUrl: "https://agent8-games.verse8.io/x/index.html",
    fields: { title: "T", imageUrl: "https://contents.verse8.io/a.png", sendNotificationToFollowers: false },
    tags: [],
    existing: null,
    parentVerseId: "parent-1",
  });
  assert.equal(body.verseId, VERSE);
  assert.equal(body.title, "T");
  assert.equal(body.visibility, "Public");
  assert.equal(body.category, "ALL");
  assert.equal(body.parentVerseId, "parent-1");
  assert.equal(body.allowRemix, false);
  assert.equal(body.description, "");
  assert.equal(body.sendNotificationToFollowers, false);
  assert.ok(!("videoUrl" in body));
  assert.ok(!("releaseNoteTitle" in body));
});

test("buildPublishBody: update falls back to the existing verse and never sends verseId", () => {
  const body = buildPublishBody({
    mode: "update",
    verseId: VERSE,
    playUrl: "https://agent8-games.verse8.io/x/index.html",
    fields: { releaseNoteTitle: "v2", releaseNoteTypes: ["BugFixes"], sendNotificationToFollowers: false },
    tags: ["rpg"],
    existing: {
      verseId: VERSE,
      title: "Old",
      imageUrl: "https://contents.verse8.io/old.png",
      visibility: "Unlisted",
      isPublic: true,
      allowRemix: true,
      category: "ALL",
    },
    parentVerseId: null,
  });
  assert.ok(!("verseId" in body));
  assert.equal(body.title, "Old");
  assert.equal(body.imageUrl, "https://contents.verse8.io/old.png");
  assert.equal(body.visibility, "Unlisted");
  assert.equal(body.allowRemix, true);
  assert.equal(body.releaseNoteTitle, "v2");
  assert.deepEqual(body.tag, ["rpg"]);
});

test("buildDeploySteps: token only reaches the @agent8/deploy step; VITE vars reach the build", () => {
  const baseEnv = { PATH: "/bin", VITE_AGENT8_VERSE: VERSE, VITE_AGENT8_ACCOUNT: "0xabc" };
  const steps = buildDeploySteps({
    installCommand: "bun update",
    gameserver: true,
    verseId: VERSE,
    account: "0xabc",
    baseEnv,
    token: "secret-token",
  });
  const commands = steps.map((s) => s.command);
  assert.equal(commands[0], "bun update");
  assert.equal(commands[1], "bun run build --base ./");
  assert.match(commands[2], /@agent8\/gameserver-node(@\S+)? build$/);
  assert.match(commands[3], /@agent8\/deploy(@\S+)? --prod --verse 0xabc-1700000000000 --account 0xabc$/);
  for (const s of steps.slice(0, -1)) {
    assert.equal(s.env.V8_ACCESS_TOKEN, undefined, `${s.command} must not see the token`);
    assert.equal(s.env.VITE_AGENT8_VERSE, VERSE);
  }
  assert.equal(steps[steps.length - 1].env.V8_ACCESS_TOKEN, "secret-token");
});

test("buildDeploySteps: non-gameserver project skips the gameserver build", () => {
  const steps = buildDeploySteps({
    installCommand: "bun update",
    gameserver: false,
    verseId: VERSE,
    account: "0xabc",
    baseEnv: {},
    token: "t",
  });
  assert.equal(steps.length, 3);
  assert.ok(!steps.some((s) => s.command.includes("gameserver-node")));
});

test("sanitizeChildEnv: strips V8_ACCESS_TOKEN and VERSE8_WEB_URL", () => {
  const out = sanitizeChildEnv({ V8_ACCESS_TOKEN: "x", VERSE8_WEB_URL: "https://evil", KEEP: "1" });
  assert.equal(out.V8_ACCESS_TOKEN, undefined);
  assert.equal(out.VERSE8_WEB_URL, undefined);
  assert.equal(out.KEEP, "1");
});

test("readParentVerseId: reads the verse-from-<id> remix tag", () => {
  const dir = makeProject();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "--no-verify", "-m", "init"], { cwd: dir });
  assert.equal(readParentVerseId(dir), null);
  execFileSync("git", ["tag", "verse-from-parent-123"], { cwd: dir });
  assert.equal(readParentVerseId(dir), "parent-123");
});

// ── MSU detection (ported from agent8 container) ─────────────────────────

test("isMsuProject: helper bundle, code keyword, resource host → true; comment / md only → false", () => {
  const helpers = makeProject();
  fs.mkdirSync(path.join(helpers, "src", "__system__", "maple"), { recursive: true });
  assert.equal(isMsuProject(helpers), true);

  const keyword = makeProject();
  fs.mkdirSync(path.join(keyword, "src"));
  fs.writeFileSync(path.join(keyword, "src", "App.tsx"), `export const t = "MapleStory Run";\n`);
  assert.equal(isMsuProject(keyword), true);

  const host = makeProject();
  fs.writeFileSync(path.join(host, "assets.json"), `{"a":"https://resource-static.msu.io/x.png"}`);
  assert.equal(isMsuProject(host), true);

  const commentOnly = makeProject();
  fs.mkdirSync(path.join(commentOnly, "src"));
  fs.writeFileSync(path.join(commentOnly, "src", "App.tsx"), `// MapleStory-style panel\nexport const t = 1;\n`);
  fs.writeFileSync(path.join(commentOnly, "README.md"), "Inspired by MapleStory");
  assert.equal(isMsuProject(commentOnly), false);
});

test("stripComments: keeps URLs and string literals, drops comments", () => {
  const out = stripComments(`const u = "https://x.io/a"; // note\n/* block */ const s = '//not';`);
  assert.match(out, /https:\/\/x\.io\/a/);
  assert.match(out, /'\/\/not'/);
  assert.ok(!out.includes("note"));
  assert.ok(!out.includes("block"));
});

// ── runDeploy dryRun (mode resolution) ───────────────────────────────────

test("runDeploy dryRun: 404 + id available → first deploy plan with create body", async () => {
  const dir = makeProject();
  const { calls, handler } = router({
    "GET /v1/verse/verseId": () => json(404, { message: "Verse not found" }),
    "GET /v1/verse/id-available": () => json(200, { verseId: VERSE, available: true }),
  });
  const res = await withEnvToken(() =>
    withFetch(handler, () =>
      runDeploy(dryRunInput(dir, { title: "My Game", thumbnailPath: "thumb.png" }), dir),
    ),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.dryRun, true);
  assert.equal(res.mode, "first");
  assert.equal(res.publishBody.verseId, VERSE);
  assert.equal(res.publishBody.title, "My Game");
  assert.equal(res.publishBody.imageUrl, "<upload:thumb.png>");
  assert.ok(res.plannedSteps.includes("POST /v1/verse/create"));
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
  // dryRun must not create or update anything.
  assert.ok(!calls.some((c) => c.key.startsWith("POST")));
});

test("runDeploy dryRun: first deploy without title/image → invalid_input listing what is missing", async () => {
  const dir = makeProject();
  const { handler } = router({
    "GET /v1/verse/verseId": () => json(404, {}),
    "GET /v1/verse/id-available": () => json(200, { verseId: VERSE, available: true }),
  });
  const res = await withEnvToken(() => withFetch(handler, () => runDeploy(dryRunInput(dir), dir)));
  assert.equal(res.ok, false);
  assert.equal(res.error, "invalid_input");
  assert.deepEqual(res.missing, ["title", "thumbnailPath or imageUrl"]);
});

test("runDeploy dryRun: existing owned verse → update plan keeping current metadata; MSU tags added", async () => {
  const dir = makeProject();
  fs.mkdirSync(path.join(dir, "src", "__system__", "maple"), { recursive: true });
  const { handler } = router({
    "GET /v1/verse/verseId": () =>
      json(200, {
        verseId: VERSE,
        title: "Live Game",
        imageUrl: "https://contents.verse8.io/live.png",
        tag: ["rpg", "__cross"],
        visibility: "Public",
        isOwner: true,
      }),
  });
  const res = await withEnvToken(() =>
    withFetch(handler, () => runDeploy(dryRunInput(dir, { releaseNoteTitle: "v1.1" }), dir)),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.mode, "update");
  assert.equal(res.msu, true);
  assert.equal(res.publishBody.title, "Live Game");
  assert.equal(res.publishBody.imageUrl, "https://contents.verse8.io/live.png");
  assert.deepEqual(res.publishBody.tag, ["rpg", "__MSU", "__review_required"]);
  assert.ok(res.plannedSteps.includes(`POST /v1/verse/update/${VERSE}`));
});

test("runDeploy: verse owned by another account → verse_owned_by_other (id is never re-minted)", async () => {
  const dir = makeProject();
  const { handler } = router({
    "GET /v1/verse/verseId": () => json(200, { verseId: VERSE, title: "x", isOwner: false }),
  });
  const res = await withEnvToken(() => withFetch(handler, () => runDeploy(dryRunInput(dir), dir)));
  assert.equal(res.ok, false);
  assert.equal(res.error, "verse_owned_by_other");
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8").includes(VERSE), true);
});

test("runDeploy: unpublished but unavailable id (deleted) → verse_id_unavailable with reason", async () => {
  const dir = makeProject();
  const { handler } = router({
    "GET /v1/verse/verseId": () => json(404, {}),
    "GET /v1/verse/id-available": () => json(200, { verseId: VERSE, available: false, reason: "deleted" }),
  });
  const res = await withEnvToken(() =>
    withFetch(handler, () => runDeploy(dryRunInput(dir, { title: "t", imageUrl: "https://contents.verse8.io/a.png" }), dir)),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "verse_id_unavailable");
  assert.equal(res.reason, "deleted");
});

test("runDeploy: thumbnailPath + imageUrl together → invalid_input before any network call", async () => {
  const dir = makeProject();
  const { calls, handler } = router({});
  const res = await withEnvToken(() =>
    withFetch(handler, () =>
      runDeploy(dryRunInput(dir, { thumbnailPath: "a.png", imageUrl: "https://contents.verse8.io/a.png" }), dir),
    ),
  );
  assert.equal(res.error, "invalid_input");
  assert.equal(calls.length, 0);
});

test("runDeploy: reserved __ tags from the caller are rejected", async () => {
  const dir = makeProject();
  const res = await withEnvToken(() => runDeploy(dryRunInput(dir, { tags: ["__MSU"] }), dir));
  assert.equal(res.error, "invalid_input");
});

test("runDeploy: missing VITE_AGENT8_ACCOUNT → missing_account_env", async () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_VERSE=${VERSE}\n`);
  const res = await withEnvToken(() => runDeploy(dryRunInput(dir), dir));
  assert.equal(res.error, "missing_account_env");
});

test("runDeploy: token rejected on verse lookup → unauthorized", async () => {
  const dir = makeProject();
  const { handler } = router({ "GET /v1/verse/verseId": () => json(401, { message: "Unauthorized" }) });
  const res = await withEnvToken(() => withFetch(handler, () => runDeploy(dryRunInput(dir), dir)));
  assert.equal(res.error, "unauthorized");
});
