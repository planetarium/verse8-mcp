// The plan gate of verse8_verse / verse8_vxshop: a changing action runs only
// with the planId its own preview returned, re-checked against a fresh read.
// For every changing action (fetch is mocked, the "server" is a mutable db):
//  (a) without planId → preview only, no write; `confirm: true` is not accepted
//  (b) preview → the same planId → runs, one write
//  (c) a current value changes after the preview → plan_mismatch naming it, no write
//  (d) a planId of another action / another target → plan_mismatch, no write

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalJson, planId } from "../../dist/tools/creatorOps.js";
import { runVerseOps, verseOpsInputSchema } from "../../dist/tools/verseOps.js";
import { runVxShop, vxShopInputSchema } from "../../dist/tools/vxShop.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";
const OTHER_VERSE = "0xabcdef0000000000000000000000000000000002-1700000000000";
const C = `/v1/verse/${VERSE}/comments`;

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-plan-"));
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  fs.writeFileSync(path.join(dir, "item.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  return dir;
}
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

const cm = (id, extra = {}) => ({ id, userUid: "9", userHandle: "h", userDisplayName: "D", content: `c${id}`, parentCommentId: null, likes: 0, isDeleted: false, createdAt: "t", ...extra });
const item = (id, extra = {}) => ({
  id, verseId: VERSE, productId: `p${id}`, name: `Item ${id}`, price: 300, stock: 100, soldCount: 0, imageUrl: null, description: "d",
  metadata: JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 2 } }), isActive: true, isArchived: false, ...extra,
});
const sale = (id) => ({ id, shopItemId: 7, status: "completed", disputeStatus: "REQUEST", disputeMessage: "not received", item: { id: 7, productId: "p7", name: "Item 7" } });
const note = (id, buildVersion) => ({ id, buildVersion, title: `v${buildVersion}`, releaseTypes: ["New"], description: "first", imageUrl: null, userUid: "100012", createdAt: "t" });

function makeDb() {
  return {
    verse: { verseId: VERSE, verseShortId: "abc", isOwner: true, title: "Old", description: "d", tag: ["RPG"], visibility: "Private", allowRemix: false },
    notes: { 3: note(92, 3), 4: note(93, 4) },
    pinned: null,
    comments: [cm(1), cm(2)],
    items: [item(7), item(8)],
    sales: [sale(55), sale(56)],
  };
}

function routes(db) {
  const r = {
    "GET /v1/verse/verseId": () => json(200, db.verse),
    [`POST /v1/verse/update/${VERSE}`]: (_u, b) => json(201, { ...db.verse, ...b }),
    "GET /v1/auth/verify": () => json(200, { userUid: 100012 }),
    [`GET ${C}`]: () => json(200, { pinnedComment: db.comments.find((c) => c.id === db.pinned) ?? null, comments: db.comments, page: 1, limit: 100, total: db.comments.length }),
    "GET /v1/vx-wallet": () => json(200, { isSeller: true, balance: 0 }),
    "GET /v1/vx-shop-items": () => json(200, { items: db.items, total: db.items.length }),
    "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: true }),
    "POST /v1/vx-shop-items": (_u, b) => json(201, { ...item(9), ...b }),
    "POST /api/upload": () => json(200, { publicUrl: "https://contents.verse8.io/vx-shop/x/i.png" }),
    "GET /v1/vx-shop-items/sales": () => json(200, { sales: db.sales, total: db.sales.length }),
  };
  for (const [v, n] of Object.entries(db.notes)) {
    r[`GET /v1/verse/${VERSE}/release-notes/version/${v}`] = () => json(200, db.notes[v]);
    r[`PUT /v1/release-notes/${n.id}`] = (_u, b) => json(200, { ...db.notes[v], ...b });
  }
  for (const c of db.comments) {
    r[`POST ${C}/${c.id}/pin`] = () => json(201, { isPinned: db.pinned !== c.id });
    r[`DELETE ${C}/${c.id}`] = () => new Response(null, { status: 204 });
  }
  for (const i of db.items) r[`PUT /v1/vx-shop-items/${i.id}`] = (_u, b) => json(200, { ...i, ...b });
  for (const s of db.sales) r[`PUT /v1/vx-shop-items/sales/${s.id}/dispute`] = () => json(200, { success: true });
  return r;
}

async function withDb(f) {
  const db = makeDb();
  const table = routes(db);
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname });
    const h = table[`${method} ${u.pathname}`];
    return h ? h(u, typeof init.body === "string" ? JSON.parse(init.body) : init.body) : json(599, { message: `unrouted ${method} ${u.pathname}` });
  };
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  try {
    return await f(db, calls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}

const TOOLS = {
  verse: { schema: verseOpsInputSchema, run: runVerseOps },
  vxshop: { schema: vxShopInputSchema, run: runVxShop },
};
// `host` answers the user confirmation some actions ask for after the planId
// matched (userConfirmGate.test.mjs covers that step); here the user says Run.
const USER_RUNS = { canAsk: true, ask: async () => ({ action: "accept", content: { choice: "Run" } }) };
const call = (tool, dir, input) => TOOLS[tool].run(TOOLS[tool].schema.parse({ projectDir: dir, ...input }), dir, USER_RUNS);
const writes = (calls) => calls.filter((c) => c.method !== "GET");

/**
 * Every changing action of #49. `other` is the same action on another
 * target; `drift` changes a current value the plan depends on (on the
 * "server", or the local file to upload) and names the part expected in
 * the refusal.
 */
const CASES = [
  {
    name: "verse update",
    tool: "verse",
    input: { action: "update", title: "New title" },
    other: { action: "update", title: "New title", verseId: OTHER_VERSE },
    drift: (db) => { db.verse.title = "Edited on the web"; },
    part: "state.title",
  },
  {
    name: "verse update (visibility re-sent)",
    tool: "verse",
    input: { action: "update", title: "New title" },
    other: { action: "update", title: "New title", verseId: OTHER_VERSE },
    drift: (db) => { db.verse.visibility = "Public"; },
    part: "state.visibility",
  },
  {
    name: "verse release_note_update",
    tool: "verse",
    input: { action: "release_note_update", buildVersion: 3, releaseNoteTitle: "v3.1" },
    other: { action: "release_note_update", buildVersion: 4, releaseNoteTitle: "v3.1" },
    drift: (db) => { db.notes[3].title = "v3 (web)"; },
    part: "state.title",
  },
  {
    name: "verse comment_pin",
    tool: "verse",
    input: { action: "comment_pin", commentId: 1 },
    other: { action: "comment_pin", commentId: 2 },
    drift: (db) => { db.pinned = 2; },
    part: "state.pinnedCommentId",
  },
  {
    name: "verse comment_pin (pinned meanwhile: the toggle must not run)",
    tool: "verse",
    input: { action: "comment_pin", commentId: 1 },
    other: { action: "comment_pin", commentId: 2 },
    drift: (db) => { db.pinned = 1; },
    part: "state.pinned",
  },
  {
    name: "verse comment_delete",
    tool: "verse",
    input: { action: "comment_delete", commentId: 1 },
    other: { action: "comment_delete", commentId: 2 },
    drift: (db) => { db.comments[0].content = "edited"; },
    part: "state.content",
  },
  {
    name: "vxshop upsert create (body + image only)",
    tool: "vxshop",
    input: { action: "upsert", productId: "gem", name: "Gems", price: 100, stock: 5, imagePath: "item.png" },
    other: { action: "upsert", productId: "gem-2", name: "Gems", price: 100, stock: 5, imagePath: "item.png" },
    drift: (_db, dir) => { fs.writeFileSync(path.join(dir, "item.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])); },
    part: "file.imagePath",
    upload: true,
  },
  {
    name: "vxshop upsert edit (price)",
    tool: "vxshop",
    input: { action: "upsert", itemId: 7, price: 350 },
    other: { action: "upsert", itemId: 8, price: 350 },
    drift: (db) => { db.items[0].price = 320; },
    part: "state.price",
  },
  {
    name: "vxshop upsert edit (purchase limits changed on the web)",
    tool: "vxshop",
    input: { action: "upsert", itemId: 7, name: "Renamed" },
    other: { action: "upsert", itemId: 8, name: "Renamed" },
    drift: (db) => { db.items[0].metadata = JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 5 } }); },
    part: "state.purchaseConstraints",
  },
  {
    name: "vxshop archive",
    tool: "vxshop",
    input: { action: "archive", itemId: 7 },
    other: { action: "archive", itemId: 8 },
    drift: (db) => { db.items[0].isArchived = true; },
    part: "state.isArchived",
  },
  {
    name: "vxshop dispute",
    tool: "vxshop",
    input: { action: "dispute", saleId: 55, disputeStatus: "RESOLVED", responseMessage: "Sent again" },
    other: { action: "dispute", saleId: 56, disputeStatus: "RESOLVED", responseMessage: "Sent again" },
    drift: (db) => { db.sales[0].disputeStatus = "IGNORE"; },
    part: "state.disputeStatus",
  },
];

for (const [i, k] of CASES.entries()) {
  test(`${k.name}: (a) no planId → preview only; confirm: true is not an input`, async () => {
    const dir = project();
    await withDb(async (_db, calls) => {
      const pre = await call(k.tool, dir, k.input);
      assert.equal(pre.ok, true, JSON.stringify(pre));
      assert.equal(pre.dryRun, true);
      assert.match(pre.planId, /^v1\.[0-9a-f]{32}\.([0-9a-f]{4})+$/);
      assert.match(pre.next, /planId/);
      assert.deepEqual(writes(calls), []);
      assert.throws(() => TOOLS[k.tool].schema.parse({ projectDir: dir, ...k.input, confirm: true }), /confirm/);
    });
  });

  test(`${k.name}: (b) preview → the same planId → runs once`, async () => {
    const dir = project();
    await withDb(async (_db, calls) => {
      const pre = await call(k.tool, dir, k.input);
      const again = await call(k.tool, dir, k.input);
      assert.equal(again.planId, pre.planId, "same arguments + same values → same planId");
      const done = await call(k.tool, dir, { ...k.input, planId: pre.planId });
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(done.dryRun, false);
      const w = writes(calls).filter((c) => c.path !== "/api/upload");
      assert.equal(w.length, 1, JSON.stringify(w));
      if (k.upload) assert.equal(writes(calls)[0].path, "/api/upload", "upload only after the plan matched");
    });
  });

  test(`${k.name}: (c) a current value changes after the preview → plan_mismatch (${k.part}), no write`, async () => {
    const dir = project();
    await withDb(async (db, calls) => {
      const pre = await call(k.tool, dir, k.input);
      k.drift(db, dir);
      const r = await call(k.tool, dir, { ...k.input, planId: pre.planId });
      assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
      assert.ok(r.changed.some((c) => c.part === k.part), JSON.stringify(r.changed));
      assert.match(r.hint, /Nothing was changed/);
      assert.match(r.hint, /fresh preview/);
      assert.deepEqual(writes(calls), []);
    });
  });

  test(`${k.name}: (d) a planId of another target / another action → plan_mismatch, no write`, async () => {
    const dir = project();
    await withDb(async (_db, calls) => {
      const otherTarget = await call(k.tool, dir, k.other);
      assert.ok(otherTarget.planId, JSON.stringify(otherTarget));
      const a = await call(k.tool, dir, { ...k.input, planId: otherTarget.planId });
      assert.equal(a.error, "plan_mismatch", JSON.stringify(a));
      assert.match(a.hint, /another target|arguments differ/);

      const otherCase = CASES.find((c) => c.tool === k.tool && c.input.action !== k.input.action) ?? CASES[(i + 1) % CASES.length];
      const otherAction = await call(otherCase.tool, dir, otherCase.input);
      assert.ok(otherAction.planId, JSON.stringify(otherAction));
      const b = await call(k.tool, dir, { ...k.input, planId: otherAction.planId });
      assert.equal(b.error, "plan_mismatch", JSON.stringify(b));
      assert.match(b.hint, /another action/);
      assert.deepEqual(writes(calls), []);
    });
  });
}

test("comment_delete with the pin preview's planId of the same comment → another action", async () => {
  const dir = project();
  await withDb(async (_db, calls) => {
    const pin = await call("verse", dir, { action: "comment_pin", commentId: 1 });
    const r = await call("verse", dir, { action: "comment_delete", commentId: 1, planId: pin.planId });
    assert.equal(r.error, "plan_mismatch");
    assert.match(r.hint, /another action/);
    assert.deepEqual(writes(calls), []);
  });
});

test("arguments changed between preview and run (price 350 → 400) → refused as differing arguments", async () => {
  const dir = project();
  await withDb(async (_db, calls) => {
    const pre = await call("vxshop", dir, { action: "upsert", itemId: 7, price: 350 });
    const r = await call("vxshop", dir, { action: "upsert", itemId: 7, price: 400, planId: pre.planId });
    assert.equal(r.error, "plan_mismatch");
    assert.match(r.hint, /arguments differ/);
    assert.deepEqual(writes(calls), []);
  });
});

test("a value the action does not depend on may change: editing the price still runs after the description changed on the web", async () => {
  const dir = project();
  await withDb(async (db, calls) => {
    const pre = await call("vxshop", dir, { action: "upsert", itemId: 7, price: 350 });
    db.items[0].description = "edited on the web";
    const r = await call("vxshop", dir, { action: "upsert", itemId: 7, price: 350, planId: pre.planId });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(writes(calls).length, 1);
  });
});

test("archive: archived on the web after the preview → the stale planId is refused, not reported as done", async () => {
  const dir = project();
  await withDb(async (db) => {
    const pre = await call("vxshop", dir, { action: "archive", itemId: 7 });
    db.items[0].isArchived = true;
    const r = await call("vxshop", dir, { action: "archive", itemId: 7, planId: pre.planId });
    assert.equal(r.error, "plan_mismatch");
    assert.deepEqual(r.changed.find((c) => c.part === "state.isArchived"), { part: "state.isArchived", now: true });
    // Without a planId the same state is answered as a no-op.
    assert.equal((await call("vxshop", dir, { action: "archive", itemId: 7 })).unchanged, true);
  });
});

test("a planId that no preview returned → plan_mismatch, no write", async () => {
  const dir = project();
  await withDb(async (_db, calls) => {
    for (const bad of ["yes", "v1.deadbeef", `v1.${"0".repeat(32)}.${"0".repeat(16)}`]) {
      const r = await call("vxshop", dir, { action: "upsert", itemId: 7, price: 350, planId: bad });
      assert.equal(r.error, "plan_mismatch", bad);
    }
    assert.deepEqual(writes(calls), []);
  });
});

test("canonicalJson / planId: key order does not matter, values do", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }], u: undefined }), '{"a":[{"c":null,"d":2}],"b":1}');
  const p = { op: "x.y", target: { verseId: "v", itemId: 1 }, body: { price: 1, purchaseConstraints: { b: 1, a: 2 } }, state: { price: 0, name: "n" } };
  const q = { state: { name: "n", price: 0 }, body: { purchaseConstraints: { a: 2, b: 1 }, price: 1 }, target: { itemId: 1, verseId: "v" }, op: "x.y" };
  assert.equal(planId(p), planId(q));
  assert.notEqual(planId(p), planId({ ...p, state: { ...p.state, price: 1 } }));
  assert.notEqual(planId(p), planId({ ...p, op: "x.z" }));
  assert.notEqual(planId(p), planId({ ...p, target: { verseId: "v", itemId: 2 } }));
});

// ── the run uploads the bytes the planId was checked against ──

// Make the next read of `file` return its content and then overwrite the
// file on disk — a change right after the plan check, before the upload.
function tamperAfterNextRead(file, tampered) {
  const orig = fsDefault.readFileSync;
  let armed = true;
  fsDefault.readFileSync = function (p, ...rest) {
    const out = orig.call(this, p, ...rest);
    if (armed && typeof p === "string" && path.resolve(p) === path.resolve(file)) {
      armed = false;
      fsDefault.writeFileSync(file, tampered);
    }
    return out;
  };
  syncBuiltinESMExports();
  return () => {
    fsDefault.readFileSync = orig;
    syncBuiltinESMExports();
  };
}
const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());

test("upsert create: the image changes right after the plan check → the checked bytes are uploaded, not the new file", async () => {
  const dir = project();
  const img = path.join(dir, "item.png");
  const checked = fs.readFileSync(img);
  const tampered = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 7, 7, 7, 7]);
  await withDb(async (_db, calls) => {
    const input = { action: "upsert", productId: "gem", name: "Gems", price: 100, stock: 5, imagePath: "item.png" };
    const pre = await call("vxshop", dir, input);
    let uploaded = null;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (new URL(url).pathname === "/api/upload") uploaded = await bytesOf(init.body.get("file"));
      return savedFetch(url, init);
    };
    const restore = tamperAfterNextRead(img, tampered);
    try {
      const r = await call("vxshop", dir, { ...input, planId: pre.planId });
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      restore();
      globalThis.fetch = savedFetch;
    }
    assert.deepEqual(fs.readFileSync(img), tampered, "the file did change after the check");
    assert.deepEqual(uploaded, checked);
    assert.equal(writes(calls).filter((c) => c.path === "/api/upload").length, 1);
  });
});

test("update videoPath: the video changes right after the plan check → the presigned PUT carries the checked bytes", async () => {
  const dir = project();
  const clip = path.join(dir, "clip.mp4");
  const checked = Buffer.from("checked-video-bytes");
  fs.writeFileSync(clip, checked);
  await withDb(async (db) => {
    let put = null;
    let declaredSize = null;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === "/api/upload/video-presigned") {
        declaredSize = JSON.parse(init.body).fileSize;
        return json(200, { uploadUrl: "https://r2.example/put/clip.mp4", publicUrl: "https://contents.verse8.io/verses/x/clip.mp4", contentType: "video/mp4" });
      }
      if (u.hostname === "r2.example") {
        put = await bytesOf(init.body);
        return new Response(null, { status: 200 });
      }
      return savedFetch(url, init);
    };
    try {
      const pre = await call("verse", dir, { action: "update", videoPath: "clip.mp4" });
      assert.ok(pre.planId, JSON.stringify(pre));
      const restore = tamperAfterNextRead(clip, Buffer.from("a-different-and-longer-video"));
      try {
        const r = await call("verse", dir, { action: "update", videoPath: "clip.mp4", planId: pre.planId });
        assert.equal(r.ok, true, JSON.stringify(r));
      } finally {
        restore();
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.deepEqual(put, checked);
    assert.equal(declaredSize, checked.length);
    assert.notDeepEqual(fs.readFileSync(clip), checked, "the file did change after the check");
  });
});
