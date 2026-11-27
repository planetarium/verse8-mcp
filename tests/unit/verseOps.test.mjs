// verse8_verse: read / edit a published verse's listing and release notes.
// fetch is mocked. Changing actions must not call any write route without
// the preview's planId, and an update must always carry the current visibility.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runVerseOps, verseOpsInputSchema } from "../../dist/tools/verseOps.js";
import { createServer } from "../../dist/server.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";

function project({ withVerse = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-vops-"));
  if (withVerse) fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  fs.writeFileSync(path.join(dir, "cover.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return dir;
}

function json(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const LIVE = {
  verseId: VERSE,
  verseShortId: "abc1234",
  title: "Old",
  description: "d",
  shortDescription: "",
  imageUrl: "https://contents.verse8.io/verses/x/old.png",
  videoUrl: null,
  tag: ["RPG", "__review_required"],
  visibility: "Private",
  isPublic: false,
  reviewStatus: "PASSED",
  allowRemix: false,
  isMobileSupported: false,
  orientation: null,
  isOwner: true,
  enableAds: true,
  admobRewardedAndroidAdUnitId: "secret-ish",
};

async function withApi(routes, f) {
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    let body = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep */
      }
    }
    calls.push({ method, path: u.pathname, query: u.searchParams, body, auth: init.headers?.Authorization });
    const r = routes[`${method} ${u.pathname}`];
    return r ? r(u, body) : json(599, { message: `unrouted ${method} ${u.pathname}` });
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

// Widening the visibility also asks the user after the planId matched
// (userConfirmGate.test.mjs covers that step); here the user says Run.
const USER_RUNS = { canAsk: true, ask: async () => ({ action: "accept", content: { choice: "Run" } }) };
const run = (dir, input) => runVerseOps(verseOpsInputSchema.parse({ projectDir: dir, ...input }), dir, USER_RUNS);
const writes = (calls) => calls.filter((c) => c.method !== "GET");

// Preview, then run with the planId the preview returned (as a host does
// after the user approved). Without a planId (refusal / no-op) the preview's
// answer is returned.
const planned = (runner) => async (dir, input) => {
  const pre = await runner(dir, input);
  if (!pre.planId) return pre;
  return runner(dir, { ...input, planId: pre.planId });
};
const runP = planned(run);

test("get: owner listing, trimmed (no ad-unit / admin fields)", async () => {
  const dir = project();
  await withApi({ "GET /v1/verse/verseId": () => json(200, LIVE) }, async (calls) => {
    const r = await run(dir, { action: "get" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.verse.visibility, "Private");
    assert.equal(r.verse.enableAds, undefined);
    assert.equal(r.verse.admobRewardedAndroidAdUnitId, undefined);
    assert.equal(calls[0].query.get("verseId"), VERSE);
    assert.equal(calls[0].auth, "Bearer tok");
  });
});

test("get: not the owner → forbidden", async () => {
  const dir = project();
  await withApi({ "GET /v1/verse/verseId": () => json(200, { ...LIVE, isOwner: false }) }, async () => {
    assert.equal((await run(dir, { action: "get" })).error, "forbidden");
  });
});

test("mine: works without a verse in .env; asks for review info", async () => {
  const dir = project({ withVerse: false });
  await withApi(
    { "GET /v1/verse/my": () => json(200, { total: 1, page: 1, limit: 20, items: [{ ...LIVE, latestReleaseNote: { buildVersion: 2, reviewStatus: "APPROVED", reviewerNote: null, createdAt: "t" } }] }) },
    async (calls) => {
      const r = await run(dir, { action: "mine" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.items[0].latestReleaseNote.reviewStatus, "APPROVED");
      assert.equal(calls[0].query.get("includeReview"), "true");
    },
  );
});

test("update without planId: preview only — changes listed, current visibility kept, no write call", async () => {
  const dir = project();
  await withApi({ "GET /v1/verse/verseId": () => json(200, LIVE) }, async (calls) => {
    const r = await run(dir, { action: "update", title: "New title", tags: ["RPG", "Puzzle"], orientation: "auto", thumbnailPath: "cover.png" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.dryRun, true);
    assert.deepEqual(
      r.changes.map((c) => c.field).sort(),
      ["imageUrl", "tag", "title"].sort(),
      "orientation auto == current null → no change",
    );
    assert.equal(r.publishBody.visibility, "Private");
    assert.equal(r.publishBody.sendNotificationToFollowers, false);
    assert.deepEqual(r.publishBody.tag, ["RPG", "Puzzle"]);
    assert.equal(r.publishBody.playUrl, undefined);
    assert.match(r.next, /planId/);
    assert.match(r.planId, /^v1\./);
    assert.ok(r.warnings.some((w) => /theme colors/.test(w)));
    assert.deepEqual(writes(calls), []);
  });
});

test("update with the preview's planId: uploads the cover, then POSTs only changed fields + current visibility (never playUrl / isPublic)", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/verse/verseId": () => json(200, LIVE),
      "POST /api/upload": () => json(200, { publicUrl: "https://contents.verse8.io/verses/x/new.png" }),
      [`POST /v1/verse/update/${VERSE}`]: (_u, body) => json(201, { ...LIVE, ...body, reviewStatus: "PASSED" }),
    },
    async (calls) => {
      const r = await runP(dir, { action: "update", title: "New title", thumbnailPath: "cover.png", allowRemix: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      const post = calls.find((c) => c.path === `/v1/verse/update/${VERSE}`);
      assert.deepEqual(post.body, {
        visibility: "Private",
        sendNotificationToFollowers: false,
        title: "New title",
        imageUrl: "https://contents.verse8.io/verses/x/new.png",
        allowRemix: true,
      });
      assert.equal(r.visibility, "Private");
      assert.ok(calls.findIndex((c) => c.path === "/api/upload") < calls.indexOf(post));
    },
  );
});

test("update: clearVideo sends videoUrl null; input checks run before any network call", async () => {
  const dir = project();
  await withApi({ "GET /v1/verse/verseId": () => json(200, { ...LIVE, videoUrl: "https://v/old.mp4" }) }, async (calls) => {
    const r = await run(dir, { action: "update", clearVideo: true });
    assert.deepEqual(r.changes, [{ field: "videoUrl", from: "https://v/old.mp4", to: null }]);
    const n = calls.length;
    assert.equal((await run(dir, { action: "update", tags: ["__MSU"] })).error, "invalid_input");
    assert.equal((await run(dir, { action: "update", thumbnailPath: "cover.png", imageUrl: "https://x/y.png" })).error, "invalid_input");
    assert.equal((await run(dir, { action: "update", videoPath: "nope.mp4" })).error, "file_not_found");
    assert.equal(calls.length, n);
  });
});

test("update: nothing actually changes → invalid_input", async () => {
  const dir = project();
  await withApi({ "GET /v1/verse/verseId": () => json(200, LIVE) }, async () => {
    assert.equal((await run(dir, { action: "update", allowRemix: false })).error, "invalid_input");
  });
});

test("update: a 400 from the API surfaces its message", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/verse/verseId": () => json(200, LIVE),
      [`POST /v1/verse/update/${VERSE}`]: () => json(400, { message: ["tag must be an array"] }),
    },
    async () => {
      const r = await runP(dir, { action: "update", title: "New title" });
      assert.equal(r.error, "bad_request");
      assert.match(r.hint, /tag must be an array/);
    },
  );
});

test("release_notes: paged list passes through", async () => {
  const dir = project();
  await withApi(
    { [`GET /v1/verse/${VERSE}/release-notes`]: () => json(200, { releaseNotes: [{ id: 7, buildVersion: 3 }], total: 1, page: 1, limit: 10 }) },
    async (calls) => {
      const r = await run(dir, { action: "release_notes" });
      assert.equal(r.releaseNotes[0].id, 7);
      assert.equal(calls[0].query.get("limit"), "10");
    },
  );
});

const NOTE = { id: 92, buildVersion: 3, title: "v3", releaseTypes: ["New"], description: "first", imageUrl: "https://i/x.png", userUid: "100012", createdAt: "t" };

test("release_note_update preview → run: PUT only the changed fields; clear image sends null", async () => {
  const dir = project();
  await withApi(
    {
      [`GET /v1/verse/${VERSE}/release-notes/version/3`]: () => json(200, NOTE),
      "GET /v1/auth/verify": () => json(200, { userUid: 100012, walletAddress: "0xabc" }),
      "PUT /v1/release-notes/92": (_u, body) => json(200, { ...NOTE, ...body }),
    },
    async (calls) => {
      const pre = await run(dir, { action: "release_note_update", buildVersion: 3, releaseNoteTitle: "v3.1", clearReleaseNoteImage: true });
      assert.equal(pre.dryRun, true);
      assert.deepEqual(pre.warnings, []);
      assert.deepEqual(writes(calls), []);
      const done = await runP(dir, { action: "release_note_update", buildVersion: 3, releaseNoteTitle: "v3.1", clearReleaseNoteImage: true });
      assert.equal(done.ok, true, JSON.stringify(done));
      const put = writes(calls);
      assert.equal(put.length, 1);
      assert.deepEqual(put[0].body, { title: "v3.1", imageUrl: null });
    },
  );
});

test("release_note_update: a note by another account → warning in the preview; by id looks it up in the list", async () => {
  const dir = project();
  await withApi(
    {
      [`GET /v1/verse/${VERSE}/release-notes`]: () => json(200, { releaseNotes: [NOTE] }),
      "GET /v1/auth/verify": () => json(200, { userUid: "999", walletAddress: "0xabc" }),
    },
    async () => {
      const r = await run(dir, { action: "release_note_update", releaseNoteId: 92, releaseNoteDescription: "second" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.match(r.warnings[0], /only its author/);
      assert.equal((await run(dir, { action: "release_note_update", releaseNoteId: 1, releaseNoteDescription: "x" })).error, "not_found");
      assert.equal((await run(dir, { action: "release_note_update", releaseNoteDescription: "x" })).error, "invalid_input");
    },
  );
});

test("schema: 1–3 release note types, title 4–50, tags ≤5", () => {
  assert.throws(() => verseOpsInputSchema.parse({ action: "release_note_update", releaseNoteTypes: [] }));
  assert.throws(() => verseOpsInputSchema.parse({ action: "release_note_update", releaseNoteTypes: ["New", "Events", "Balance", "BugFixes"] }));
  assert.throws(() => verseOpsInputSchema.parse({ action: "update", title: "abc" }));
  assert.throws(() => verseOpsInputSchema.parse({ action: "update", tags: ["a", "b", "c", "d", "e", "f"] }));
  assert.equal(verseOpsInputSchema.parse({ action: "get" }).planId, undefined);
  assert.throws(() => verseOpsInputSchema.parse({ action: "update", title: "abcd", confirm: true }), /confirm/);
});

test("tools/list: verse8_verse listed, description ≤ 2,048 chars and states the planId gate", async () => {
  const saved = { tok: process.env.VERSE8_ACCESS_TOKEN, fetch: globalThis.fetch };
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  globalThis.fetch = async () => json(503, {});
  try {
    const { tools } = await createServer()._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    const t = tools.find((x) => x.name === "verse8_verse");
    assert.ok(t);
    assert.ok(t.description.length <= 2048, String(t.description.length));
    assert.match(t.description, /planId/);
    assert.equal(t.inputSchema.properties.confirm, undefined);
    assert.equal(t.inputSchema.properties.planId.type, "string");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
});
