// verse8_verse analytics and verse8_vxshop sales / revenue — reads only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CHART_DEFAULTS, runVerseOps, verseOpsInputSchema } from "../../dist/tools/verseOps.js";
import { presentSale, runVxShop, vxShopInputSchema } from "../../dist/tools/vxShop.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-an-"));
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  return dir;
}
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function withApi(routes, f) {
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname, query: u.searchParams, auth: init.headers?.Authorization });
    const r = routes[`${method} ${u.pathname}`];
    return r ? r(u) : json(599, { message: `unrouted ${method} ${u.pathname}` });
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
const verse = (dir, i) => runVerseOps(verseOpsInputSchema.parse({ projectDir: dir, ...i }), dir);
const shop = (dir, i) => runVxShop(vxShopInputSchema.parse({ projectDir: dir, ...i }), dir);
const OWNED = { verseId: VERSE, verseShortId: "AbC12xY", isOwner: true, visibility: "Public" };

test("analytics: keyed by the lowercased verseShortId; summary only without reportType", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/verse/verseId": () => json(200, OWNED),
      "GET /v1/analytics/abc12xy/summary": () => json(200, { dau: 8, mau: 9, sessions: 13, avgSessionDuration: 384.93 }),
    },
    async (calls) => {
      const r = await verse(dir, { action: "analytics" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.summary.dau, 8);
      assert.equal(r.chart, undefined);
      assert.equal(calls.length, 2);
    },
  );
});

test("analytics chart: web defaults (interval, range), epoch-ms query, ISO points", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/verse/verseId": () => json(200, OWNED),
      "GET /v1/analytics/abc12xy/summary": () => json(200, { dau: 1 }),
      "GET /v1/analytics/abc12xy/chart": () => json(200, [{ date: 1795132800000, metricValue: 8 }]),
    },
    async (calls) => {
      const before = Date.now();
      const r = await verse(dir, { action: "analytics", reportType: "dau" });
      const q = calls.find((c) => c.path.endsWith("/chart")).query;
      assert.equal(q.get("interval"), "4h");
      assert.equal(q.get("reportType"), "dau");
      const start = Number(q.get("startDate"));
      const end = Number(q.get("endDate"));
      assert.ok(end >= before && end - start === CHART_DEFAULTS.dau.rangeMs);
      assert.deepEqual(r.chart.points, [{ at: "2026-11-20T00:00:00.000Z", value: 8 }]);
    },
  );
});

test("analytics chart: explicit dates/interval; bad dates refused; realtimeUsers note", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/verse/verseId": () => json(200, OWNED),
      "GET /v1/analytics/abc12xy/summary": () => json(200, {}),
      "GET /v1/analytics/abc12xy/chart": () => json(200, []),
    },
    async (calls) => {
      await verse(dir, { action: "analytics", reportType: "sessions", startDate: "2026-11-01", endDate: "2026-11-02T00:00:00Z", interval: "1h" });
      const q = calls.find((c) => c.path.endsWith("/chart")).query;
      assert.equal(q.get("startDate"), String(Date.parse("2026-11-01")));
      assert.equal(q.get("endDate"), String(Date.parse("2026-11-02T00:00:00Z")));
      assert.equal(q.get("interval"), "1h");
      assert.equal((await verse(dir, { action: "analytics", reportType: "dau", startDate: "nope" })).error, "invalid_input");
      assert.equal((await verse(dir, { action: "analytics", reportType: "dau", startDate: "2026-11-03", endDate: "2026-11-01" })).error, "invalid_input");
      const rt = await verse(dir, { action: "analytics", reportType: "realtimeUsers" });
      assert.match(rt.note, /usually empty/);
    },
  );
});

test("analytics: someone else's verse → forbidden, analytics not asked", async () => {
  const dir = project();
  await withApi({ "GET /v1/verse/verseId": () => json(200, { ...OWNED, isOwner: false }) }, async (calls) => {
    assert.equal((await verse(dir, { action: "analytics" })).error, "forbidden");
    assert.equal(calls.length, 1);
  });
});

const SALE = {
  id: 5, userUid: "77", shopItemId: 7, quantity: 1, unitPrice: 300, totalPrice: 300, status: "completed", stage: "PROD",
  nonce: "n", createdAt: "t", refundedAt: null, disputeStatus: "REQUEST", disputeMessage: "not received",
  claimRequestPayload: { big: "x".repeat(1000) }, claimResponsePayload: { ok: 1 },
  item: { id: 7, productId: "vault-slot", name: "Vault", imageUrl: "u" },
  buyer: { uid: "77", walletAddress: "0x1234567890123456789012345678901234567890", name: "n", displayName: "Kim", handle: "kim", profilePicture: "p" },
  externalDelivery: { status: "SUCCESS", attemptCount: 1, maxRetry: 3, requestPayload: { a: 1 }, responseBody: "long", updatedAt: "t" },
};

test("presentSale: buyer reduced to uid/handle/displayName; payloads dropped", () => {
  const s = presentSale(SALE);
  assert.deepEqual(s.buyer, { uid: "77", handle: "kim", displayName: "Kim" });
  assert.equal(s.claimRequestPayload, undefined);
  assert.equal(s.nonce, undefined);
  assert.deepEqual(s.item, { id: 7, productId: "vault-slot", name: "Vault" });
  assert.deepEqual(s.externalDelivery, { status: "SUCCESS", attemptCount: 1, httpStatus: null });
  assert.equal(JSON.stringify(s).includes("0x1234567890"), false);
});

test("sales: disputeOnly sent only when true (the API treats `false` as true); paging and item filter", async () => {
  const dir = project();
  await withApi(
    { "GET /v1/vx-shop-items/sales": () => json(200, { sales: [SALE], total: "1", page: "1", limit: "20" }) },
    async (calls) => {
      const a = await shop(dir, { action: "sales", disputeOnly: false, disputeStatus: "REQUEST" });
      assert.equal(a.total, 1);
      assert.equal(calls[0].query.get("disputeOnly"), null);
      assert.equal(calls[0].query.get("disputeStatus"), null);
      await shop(dir, { action: "sales", disputeOnly: true, disputeStatus: "REQUEST", itemId: 7, page: 2, limit: 5 });
      const q = calls[1].query;
      assert.equal(q.get("disputeOnly"), "true");
      assert.equal(q.get("disputeStatus"), "REQUEST");
      assert.equal(q.get("itemId"), "7");
      assert.equal(q.get("page"), "2");
      assert.equal(calls[1].auth, "Bearer tok");
    },
  );
});

test("revenue: PROD by default, dates forwarded, invalid date refused before the call", async () => {
  const dir = project();
  await withApi(
    { "GET /v1/vx-shop-items/revenue-stats": () => json(200, { totalVx: 600, totalCount: 2, refundedVx: 300, refundedCount: 1, revenue: 300 }) },
    async (calls) => {
      const r = await shop(dir, { action: "revenue", startDate: "2026-11-01" });
      assert.equal(r.revenue, 300);
      assert.equal(r.stage, "PROD");
      assert.equal(calls[0].query.get("stage"), "PROD");
      assert.equal(calls[0].query.get("startDate"), "2026-11-01");
      assert.equal((await shop(dir, { action: "revenue", endDate: "x" })).error, "invalid_input");
      assert.equal(calls.length, 1);
    },
  );
});
