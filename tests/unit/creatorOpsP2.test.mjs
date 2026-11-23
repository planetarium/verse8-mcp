// P2 creator operations: visibility change, comment pin / delete, VX item
// archive / restore, dispute answer. All preview first; fetch is mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runVerseOps, verseOpsInputSchema, visibilityWarnings } from "../../dist/tools/verseOps.js";
import { runVxShop, vxShopInputSchema } from "../../dist/tools/vxShop.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";
const C = `/v1/verse/${VERSE}/comments`;

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-p2-"));
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  return dir;
}
function json(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}
async function withApi(routes, f) {
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path: u.pathname, query: u.searchParams, body });
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
const writes = (calls) => calls.filter((c) => c.method !== "GET");
const V = (dir, i) => runVerseOps(verseOpsInputSchema.parse({ projectDir: dir, ...i }), dir);
const X = (dir, i) => runVxShop(vxShopInputSchema.parse({ projectDir: dir, ...i }), dir);

// Preview, then run with the planId the preview returned (as a host does
// after the user approved). Without a planId (refusal / no-op) the preview's
// answer is returned.
const planned = (runner) => async (dir, input) => {
  const pre = await runner(dir, input);
  if (!pre.planId) return pre;
  return runner(dir, { ...input, planId: pre.planId });
};
const VP = planned(V);
const XP = planned(X);

const PRIVATE_REVIEWED = { verseId: VERSE, isOwner: true, visibility: "Private", tag: ["RPG", "__review_required"], title: "Game" };

// ── visibility ──

test("visibilityWarnings: per target, plus the review warning for a __review_required Private game", () => {
  assert.match(visibilityWarnings({ visibility: "Public", tag: [] }, "Private")[0], /only you can open/);
  const w = visibilityWarnings(PRIVATE_REVIEWED, "Public");
  assert.ok(w.some((x) => /PRIVATE_REVIEW/.test(x)));
  assert.equal(visibilityWarnings({ visibility: "Private", tag: ["RPG"] }, "Unlisted").some((x) => /review/.test(x)), false);
});

test("update visibility: preview sends the new visibility; once run, a PRIVATE_REVIEW answer is reported", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/verse/verseId": () => json(200, PRIVATE_REVIEWED),
      [`POST /v1/verse/update/${VERSE}`]: (_u, b) => json(201, { ...PRIVATE_REVIEWED, visibility: b.visibility, reviewStatus: "PRIVATE_REVIEW" }),
    },
    async (calls) => {
      const pre = await V(dir, { action: "update", visibility: "Public" });
      assert.deepEqual(pre.publishBody, { visibility: "Public", sendNotificationToFollowers: false });
      assert.equal(pre.keptVisibility, undefined);
      assert.ok(pre.warnings.some((w) => /PRIVATE_REVIEW/.test(w)));
      assert.deepEqual(writes(calls), []);
      const done = await VP(dir, { action: "update", visibility: "Public" });
      assert.equal(done.reviewStatus, "PRIVATE_REVIEW");
      assert.ok(done.warnings.some((w) => /stays hidden/.test(w)));
      assert.deepEqual(writes(calls)[0].body, { visibility: "Public", sendNotificationToFollowers: false });
    },
  );
});

// ── comments ──

const cm = (id, extra = {}) => ({ id, userUid: "9", userHandle: "h", userDisplayName: "D", content: `c${id}`, parentCommentId: null, likes: 0, isDeleted: false, createdAt: "t", ...extra });

function commentRoutes({ pinned = null, comments = [cm(1), cm(2, { replies: [cm(3, { parentCommentId: 2 })] })] } = {}) {
  return {
    "GET /v1/verse/verseId": () => json(200, { verseId: VERSE, isOwner: true, visibility: "Public" }),
    [`GET ${C}`]: () => json(200, { pinnedComment: pinned, comments, page: 1, limit: 100, total: comments.length }),
    [`POST ${C}/1/pin`]: () => json(201, { isPinned: true }),
    [`POST ${C}/2/pin`]: () => json(201, { isPinned: false }),
    [`DELETE ${C}/1`]: () => new Response(null, { status: 204 }),
  };
}

test("comments: list with pinned comment, authors trimmed", async () => {
  const dir = project();
  await withApi(commentRoutes({ pinned: cm(2) }), async (calls) => {
    const r = await V(dir, { action: "comments", sortBy: "latest" });
    assert.equal(r.pinnedComment.id, 2);
    assert.deepEqual(r.comments[0].author, { uid: "9", handle: "h", displayName: "D" });
    assert.equal(r.comments[1].replies[0].id, 3);
    assert.equal(calls[0].query.get("sortBy"), "latest");
  });
});

test("comment_pin: preview → run POSTs the toggle once; replacing a pin is warned", async () => {
  const dir = project();
  await withApi(commentRoutes({ pinned: cm(2) }), async (calls) => {
    const pre = await V(dir, { action: "comment_pin", commentId: 1 });
    assert.deepEqual(pre.changes, [{ field: "pinned", from: false, to: true }]);
    assert.ok(pre.warnings.some((w) => /Replaces the current pin \(comment 2\)/.test(w)));
    assert.deepEqual(writes(calls), []);
    const done = await VP(dir, { action: "comment_pin", commentId: 1 });
    assert.equal(done.pinned, true);
    assert.equal(writes(calls).length, 1);
  });
});

test("comment_pin: already in the wanted state → no call (the route would toggle it back)", async () => {
  const dir = project();
  await withApi(commentRoutes({ pinned: cm(2) }), async (calls) => {
    const r = await VP(dir, { action: "comment_pin", commentId: 2, pinned: true });
    assert.equal(r.unchanged, true);
    const u = await VP(dir, { action: "comment_pin", commentId: 1, pinned: false });
    assert.equal(u.unchanged, true);
    assert.deepEqual(writes(calls), []);
    const unpin = await VP(dir, { action: "comment_pin", commentId: 2, pinned: false });
    assert.equal(unpin.pinned, false);
    assert.equal(writes(calls).length, 1);
  });
});

test("comment_pin: a reply cannot be pinned; unknown / missing ids refused", async () => {
  const dir = project();
  await withApi(commentRoutes(), async (calls) => {
    assert.equal((await V(dir, { action: "comment_pin", commentId: 3 })).error, "invalid_input");
    assert.equal((await V(dir, { action: "comment_pin", commentId: 99 })).error, "not_found");
    assert.equal((await V(dir, { action: "comment_delete" })).error, "invalid_input");
    assert.deepEqual(writes(calls), []);
  });
});

test("comment_delete: preview shows the comment and the irreversibility; run → DELETE (204 is success)", async () => {
  const dir = project();
  await withApi(commentRoutes({ pinned: cm(1) }), async (calls) => {
    const pre = await V(dir, { action: "comment_delete", commentId: 1 });
    assert.equal(pre.comment.content, "c1");
    assert.ok(pre.warnings.some((w) => /irreversible/.test(w)));
    assert.ok(pre.warnings.some((w) => /gets unpinned/.test(w)));
    assert.deepEqual(writes(calls), []);
    const done = await VP(dir, { action: "comment_delete", commentId: 1 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.deleted, 1);
  });
});

test("comment_delete: an already-deleted comment is refused", async () => {
  const dir = project();
  await withApi(commentRoutes({ comments: [cm(1, { isDeleted: true, content: "" })] }), async () => {
    assert.equal((await V(dir, { action: "comment_delete", commentId: 1 })).error, "invalid_input");
  });
});

// ── VX archive / dispute ──

const ITEM = { id: 7, verseId: VERSE, productId: "p", name: "n", price: 1, stock: 1, soldCount: 0, imageUrl: null, description: null, metadata: JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 1 } }), isActive: true, isArchived: false };
const shopRoutes = (extra = {}) => ({
  "GET /v1/vx-shop-items": () => json(200, { items: [ITEM], total: 1 }),
  "PUT /v1/vx-shop-items/7": (_u, b) => json(200, { ...ITEM, ...b }),
  ...extra,
});

test("archive: keeps the purchase limits in the PUT; restore of a non-archived item is a no-op", async () => {
  const dir = project();
  await withApi(shopRoutes(), async (calls) => {
    const pre = await X(dir, { action: "archive", itemId: 7 });
    assert.deepEqual(pre.body, { isArchived: true, purchaseConstraints: { maxPurchasePerUser: 1 } });
    assert.deepEqual(writes(calls), []);
    await XP(dir, { action: "archive", itemId: 7 });
    assert.deepEqual(writes(calls)[0].body, { isArchived: true, purchaseConstraints: { maxPurchasePerUser: 1 } });
    const noop = await XP(dir, { action: "archive", itemId: 7, archived: false });
    assert.equal(noop.unchanged, true);
    assert.equal(writes(calls).length, 1);
  });
});

const DISPUTED = { id: 55, shopItemId: 7, status: "completed", disputeStatus: "REQUEST", disputeMessage: "not received", buyer: { uid: "1", walletAddress: "0x1", handle: "b" }, item: { id: 7, productId: "p", name: "n" } };

test("dispute: preview shows the sale and warns the buyer is notified / no refund; run PUTs status + message", async () => {
  const dir = project();
  await withApi(
    shopRoutes({
      "GET /v1/vx-shop-items/sales": () => json(200, { sales: [DISPUTED], total: 1 }),
      "PUT /v1/vx-shop-items/sales/55/dispute": () => json(200, { success: true }),
    }),
    async (calls) => {
      const pre = await X(dir, { action: "dispute", saleId: 55, disputeStatus: "RESOLVED", responseMessage: "Sent again" });
      assert.equal(pre.sale.buyer.walletAddress, undefined);
      assert.ok(pre.warnings.some((w) => /notification/.test(w)));
      assert.ok(pre.warnings.some((w) => /does not refund/.test(w)));
      assert.equal(calls[0].query.get("disputeOnly"), "true");
      assert.deepEqual(writes(calls), []);
      const done = await XP(dir, { action: "dispute", saleId: 55, disputeStatus: "RESOLVED", responseMessage: "Sent again" });
      assert.equal(done.ok, true);
      assert.deepEqual(writes(calls)[0].body, { status: "RESOLVED", responseMessage: "Sent again" });
    },
  );
});

test("dispute: missing inputs / no such dispute refused without a write", async () => {
  const dir = project();
  await withApi(shopRoutes({ "GET /v1/vx-shop-items/sales": () => json(200, { sales: [], total: 0 }) }), async (calls) => {
    assert.equal((await X(dir, { action: "dispute", saleId: 55 })).error, "invalid_input");
    assert.equal((await XP(dir, { action: "dispute", saleId: 55, disputeStatus: "IGNORE" })).error, "not_found");
    assert.deepEqual(writes(calls), []);
  });
});
