// verse8_vxshop: list / create / edit VX Shop items. fetch is mocked.
// Guards: no write without the preview's planId; an edit always re-sends the current
// purchase limits (the server deletes them when absent); metadata goes as a
// JSON object string; stock required on create; non-sellers refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseItemMetadata, runVxShop, vxShopInputSchema } from "../../dist/tools/vxShop.js";
import { createServer } from "../../dist/server.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-vx-"));
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  fs.writeFileSync(path.join(dir, "item.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return dir;
}

function json(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ITEM = {
  id: 7,
  verseId: VERSE,
  productId: "vault-slot",
  name: "Vault slot",
  price: 300,
  stock: 100,
  soldCount: 2,
  imageUrl: null,
  description: "d",
  metadata: JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 2 }, rarity: "rare" }),
  isActive: true,
  isArchived: false,
};

async function withApi(routes, f, { seller = true } = {}) {
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  const all = {
    "GET /v1/vx-wallet": () => json(200, { userUid: "1", balance: 10, isSeller: seller }),
    "GET /v1/vx-shop-items": () => json(200, { items: [ITEM], total: 1, page: "1", limit: "20" }),
    ...routes,
  };
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
    calls.push({ method, path: u.pathname, query: u.searchParams, body, isForm: init.body instanceof FormData, form: init.body });
    const r = all[`${method} ${u.pathname}`];
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

const run = (dir, input) => runVxShop(vxShopInputSchema.parse({ projectDir: dir, ...input }), dir);
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

test("parseItemMetadata: splits custom keys from purchase limits; junk → nulls", () => {
  assert.deepEqual(parseItemMetadata(ITEM.metadata), { metadata: { rarity: "rare" }, purchaseConstraints: { maxPurchasePerUser: 2 } });
  assert.deepEqual(parseItemMetadata("not json"), { metadata: null, purchaseConstraints: null });
  assert.deepEqual(parseItemMetadata("[1]"), { metadata: null, purchaseConstraints: null });
  assert.deepEqual(parseItemMetadata(null), { metadata: null, purchaseConstraints: null });
});

test("list: seller status + items with parsed limits; includeArchived forwarded", async () => {
  const dir = project();
  await withApi({}, async (calls) => {
    const r = await run(dir, { action: "list", includeArchived: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.seller.isSeller, true);
    assert.deepEqual(r.items[0].purchaseConstraints, { maxPurchasePerUser: 2 });
    assert.deepEqual(r.items[0].metadata, { rarity: "rare" });
    const q = calls.find((c) => c.path === "/v1/vx-shop-items").query;
    assert.equal(q.get("includeArchived"), "true");
    assert.equal(q.get("verseId"), VERSE);
  });
});

test("list as a non-seller: answered, with a warning", async () => {
  const dir = project();
  await withApi({}, async () => {
    const r = await run(dir, { action: "list" });
    assert.equal(r.seller.isSeller, false);
    assert.match(r.warning, /not an approved VX seller/);
  }, { seller: false });
});

test("upsert as a non-seller → not_seller, no write", async () => {
  const dir = project();
  await withApi({}, async (calls) => {
    const r = await runP(dir, { action: "upsert", productId: "p", name: "n", price: 1, stock: 1 });
    assert.equal(r.error, "not_seller");
    assert.deepEqual(writes(calls), []);
  }, { seller: false });
});

// #66: a non-seller is told where to ask for seller access and to stop.
test("non-seller: list and not_seller carry the seller-access page and say to stop", async () => {
  const dir = project();
  await withApi({}, async () => {
    const l = await run(dir, { action: "list" });
    assert.equal(l.seller.applyUrl, "https://verse8.io/settings");
    assert.equal(l.seller.discordUrl, "https://discord.gg/verse8-official");
    assert.match(l.warning, /Stop the VX Shop work/);
    assert.match(l.warning, /Creator Partners Program section of https:\/\/verse8\.io\/settings/);
    const u = await run(dir, { action: "upsert", productId: "p", name: "n", price: 1, stock: 1 });
    assert.equal(u.applyUrl, "https://verse8.io/settings");
    assert.match(u.hint, /Stop the VX Shop work/);
  }, { seller: false });
  await withApi({}, async () => {
    assert.equal((await run(dir, { action: "list" })).seller.applyUrl, undefined, "a seller gets no apply link");
  });
});

// #66: an item the user already made is found by the id the code uses, on any page, archived included.
test("list with productId: finds the item across pages (archived included); none → empty", async () => {
  const dir = project();
  const page1 = Array.from({ length: 100 }, (_, i) => ({ ...ITEM, id: 100 + i, productId: `filler-${i}` }));
  const old = { ...ITEM, id: 300, productId: "gold-pack", isArchived: true, isActive: false };
  await withApi(
    { "GET /v1/vx-shop-items": (u) => json(200, { items: u.searchParams.get("page") === "1" ? page1 : [old], total: 101 }) },
    async (calls) => {
      const r = await run(dir, { action: "list", productId: "gold-pack" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.total, 1);
      assert.equal(r.items[0].id, 300);
      assert.equal(r.items[0].isArchived, true);
      const qs = calls.filter((c) => c.path === "/v1/vx-shop-items").map((c) => c.query);
      assert.deepEqual(qs.map((q) => q.get("page")), ["1", "2"]);
      assert.ok(qs.every((q) => q.get("includeArchived") === "true" && q.get("limit") === "100"));
      const none = await run(dir, { action: "list", productId: "nope" });
      assert.deepEqual([none.total, none.items], [0, []]);
    },
  );
});

test("create: productId taken → the existing item comes back to use, nothing written", async () => {
  const dir = project();
  await withApi({ "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }) }, async (calls) => {
    const r = await run(dir, { action: "upsert", productId: "vault-slot", name: "n", price: 10, stock: 1 });
    assert.equal(r.error, "product_id_taken");
    assert.equal(r.existingItem.id, 7);
    assert.deepEqual(r.existingItem.purchaseConstraints, { maxPurchasePerUser: 2 });
    assert.match(r.hint, /It is item 7 \('Vault slot', productId 'vault-slot', 300 VX, stock 100, on sale\): show the user its values and use it/);
    assert.deepEqual(writes(calls), []);
  });
});

// #66: the code is wired with the productId the server stored, and the item stays unsold until the user starts the sale.
test("create, run: the result names the productId for the code and says the item is hidden until a confirmed sale start", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: true }),
      "POST /v1/vx-shop-items": (_u, body) => json(201, { ...ITEM, id: 8, ...body }),
    },
    async () => {
      const done = await runP(dir, { action: "upsert", productId: "gem-pack", name: "Gems", price: 100, stock: 50 });
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(done.productId, "gem-pack");
      assert.equal(done.item.isActive, false);
      assert.match(done.next[0], /Use productId 'gem-pack' exactly as written in the game's code: useVXShop getItem \/ buyItem and the 'gem-pack' case/);
      assert.match(done.next[1], /hidden: players cannot buy it, and getItem does not return it on the PREVIEW stage either.*Starting the sale is a separate edit \(itemId 8, isActive: true\) that the user confirms/);
      // A purchase before the granting code is live is paid and not granted (#66 review).
      assert.match(done.next[2], /publish the code that grants the item \(\$onItemPurchased\) with verse8_deploy before the sale starts/);
    },
  );
});

test("edit, the web's {isActive} toggle case: the current purchase limits are re-sent", async () => {
  const dir = project();
  await withApi({ "PUT /v1/vx-shop-items/7": (_u, body) => json(200, { ...ITEM, ...body }) }, async (calls) => {
    const pre = await run(dir, { action: "upsert", itemId: 7, isActive: false });
    assert.equal(pre.dryRun, true);
    assert.deepEqual(pre.body, { isActive: false, purchaseConstraints: { maxPurchasePerUser: 2 } });
    assert.ok(pre.warnings.some((w) => /stops selling/.test(w)));
    assert.deepEqual(writes(calls), []);

    const done = await runP(dir, { action: "upsert", itemId: 7, isActive: false });
    assert.equal(done.ok, true, JSON.stringify(done));
    const put = writes(calls);
    assert.equal(put.length, 1);
    assert.deepEqual(put[0].body, { isActive: false, purchaseConstraints: { maxPurchasePerUser: 2 } });
  });
});

test("edit: new limits replace, clear removes (body has none), metadata goes as a JSON object string", async () => {
  const dir = project();
  await withApi({}, async () => {
    const a = await run(dir, { action: "upsert", itemId: 7, purchaseConstraints: { maxPurchasePerUser: 5 } });
    assert.deepEqual(a.body, { purchaseConstraints: { maxPurchasePerUser: 5 } });
    const b = await run(dir, { action: "upsert", itemId: 7, clearPurchaseConstraints: true });
    assert.deepEqual(b.body, {});
    assert.ok(b.warnings.some((w) => /purchase limits are removed/.test(w)));
    const c = await run(dir, { action: "upsert", itemId: 7, metadata: { rarity: "epic", tier: 2 }, price: 350 });
    assert.equal(typeof c.body.metadata, "string");
    assert.deepEqual(JSON.parse(c.body.metadata), { rarity: "epic", tier: 2 });
    assert.deepEqual(c.body.purchaseConstraints, { maxPurchasePerUser: 2 });
    assert.equal(c.body.price, 350);
    assert.ok(c.warnings.some((w) => /Price changes from 300 to 350/.test(w)));
  });
});

test("edit: unknown item → not_found; productId change and metadata.purchaseConstraints refused", async () => {
  const dir = project();
  await withApi({}, async () => {
    assert.equal((await run(dir, { action: "upsert", itemId: 99, price: 1 })).error, "not_found");
    assert.equal((await run(dir, { action: "upsert", itemId: 7, productId: "x" })).error, "invalid_input");
    assert.equal((await run(dir, { action: "upsert", itemId: 7, metadata: { purchaseConstraints: {} } })).error, "invalid_input");
    assert.equal((await run(dir, { action: "upsert", itemId: 7, price: 300 })).error, "invalid_input", "unchanged");
  });
});

test("create: requires productId/name/price/stock; productId taken → product_id_taken", async () => {
  const dir = project();
  await withApi({ "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }) }, async (calls) => {
    const miss = await run(dir, { action: "upsert", productId: "p", name: "n", price: 10 });
    assert.equal(miss.error, "invalid_input");
    assert.deepEqual(miss.missing, ["stock"]);
    assert.equal((await run(dir, { action: "upsert", productId: "vault-slot", name: "n", price: 10, stock: 1 })).error, "product_id_taken");
    assert.deepEqual(writes(calls), []);
  });
});

test("create: hidden by default; when run, the image goes to category vx-shop, then POST", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: true }),
      "POST /api/upload": () => json(200, { publicUrl: "https://contents.verse8.io/vx-shop/x/i.png" }),
      "POST /v1/vx-shop-items": (_u, body) => json(201, { ...ITEM, id: 8, ...body }),
    },
    async (calls) => {
      const pre = await run(dir, { action: "upsert", productId: "gem-pack", name: "Gems", price: 100, stock: 0, imagePath: "item.png", purchaseConstraints: { maxPurchasePerUser: 1 } });
      assert.equal(pre.body.isActive, false);
      assert.ok(pre.warnings.some((w) => /Created hidden/.test(w)));
      assert.ok(pre.warnings.some((w) => /out of stock/.test(w)));
      assert.deepEqual(writes(calls), []);

      const done = await runP(dir, { action: "upsert", productId: "gem-pack", name: "Gems", price: 100, stock: 0, imagePath: "item.png", purchaseConstraints: { maxPurchasePerUser: 1 } });
      assert.equal(done.ok, true, JSON.stringify(done));
      const upload = calls.find((c) => c.path === "/api/upload");
      assert.equal(upload.form.get("category"), "vx-shop");
      const post = calls.find((c) => c.method === "POST" && c.path === "/v1/vx-shop-items");
      assert.deepEqual(post.body, {
        verseId: VERSE,
        productId: "gem-pack",
        name: "Gems",
        price: 100,
        stock: 0,
        isActive: false,
        imageUrl: "https://contents.verse8.io/vx-shop/x/i.png",
        purchaseConstraints: { maxPurchasePerUser: 1 },
      });
    },
  );
});

test("tools/list: verse8_vxshop listed, description ≤ 2,048, planId gate stated", async () => {
  const saved = { tok: process.env.VERSE8_ACCESS_TOKEN, fetch: globalThis.fetch };
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  globalThis.fetch = async () => json(503, {});
  try {
    const { tools } = await createServer()._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    const t = tools.find((x) => x.name === "verse8_vxshop");
    assert.ok(t);
    assert.ok(t.description.length <= 2048);
    assert.match(t.description, /planId/);
    assert.equal(t.inputSchema.properties.confirm, undefined);
    assert.equal(t.inputSchema.properties.purchaseConstraints.type, "object");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
});

// ── #66 review (PR #77) ──

const NO_VERSE = () => json(404, { statusCode: 404, message: `Verse with ID ${VERSE} not found` });

// An unpublished game has no verse record: every verse-level shop read answers 404. The seller
// status is still known and goes with the failure, and the hint says to publish first without deploying.
test("unpublished game: list (plain and by productId) keeps the seller status and says to publish first", async () => {
  const dir = project();
  for (const seller of [false, true]) {
    await withApi({ "GET /v1/vx-shop-items": NO_VERSE }, async () => {
      for (const input of [{ action: "list" }, { action: "list", productId: "gold-pack" }]) {
        const r = await run(dir, input);
        assert.equal(r.ok, false, JSON.stringify(r));
        assert.equal(r.error, "not_found");
        assert.equal(r.needsPublish, true);
        assert.match(r.hint, /not found\. This game is not published yet.*do not deploy on your own/);
        assert.equal(r.seller.isSeller, seller);
        if (seller) assert.equal(r.seller.applyUrl, undefined);
        else {
          assert.equal(r.seller.applyUrl, "https://verse8.io/settings");
          assert.equal(r.seller.discordUrl, "https://discord.gg/verse8-official");
          assert.match(r.warning, /Stop the VX Shop work/);
        }
      }
    }, { seller });
  }
});

test("unpublished game: create, sales and revenue say to publish first too", async () => {
  const dir = project();
  await withApi(
    { "GET /v1/vx-shop-items/check-product-id": NO_VERSE, "GET /v1/vx-shop-items/sales": NO_VERSE, "GET /v1/vx-shop-items/revenue-stats": NO_VERSE },
    async (calls) => {
      for (const input of [
        { action: "upsert", productId: "gem", name: "Gems", price: 1, stock: 1 },
        { action: "sales" },
        { action: "revenue" },
      ]) {
        const r = await run(dir, input);
        assert.equal(r.needsPublish, true, `${input.action}: ${JSON.stringify(r)}`);
      }
      assert.deepEqual(writes(calls), []);
    },
  );
  // A 404 that is not about the verse stays a plain not_found.
  await withApi({ "GET /v1/vx-shop-items/sales": () => json(404, { message: "Cannot GET" }) }, async () => {
    assert.equal((await run(dir, { action: "sales" })).needsPublish, undefined);
  });
});

// The server compares product ids without regard to case: the item stored as 'Gold-Pack' holds 'gold-pack'.
test("productId lookup: exact first, else case-insensitive with the stored value; existingItem the same", async () => {
  const dir = project();
  const stored = { ...ITEM, id: 40, productId: "Gold-Pack" };
  await withApi(
    { "GET /v1/vx-shop-items": () => json(200, { items: [stored], total: 1 }), "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }) },
    async () => {
      const l = await run(dir, { action: "list", productId: "gold-pack" });
      assert.equal(l.items[0].id, 40);
      assert.equal(l.items[0].productId, "Gold-Pack");
      assert.match(l.notes[0], /Stored as 'Gold-Pack'.*use that exact value in the code/);
      const t = await run(dir, { action: "upsert", productId: "gold-pack", name: "n", price: 1, stock: 1 });
      assert.equal(t.existingItem.id, 40);
      assert.match(t.hint, /use 'Gold-Pack' exactly in the code/);
    },
  );
  const exact = { ...ITEM, id: 41, productId: "gold-pack" };
  await withApi({ "GET /v1/vx-shop-items": () => json(200, { items: [stored, exact], total: 2 }) }, async () => {
    const l = await run(dir, { action: "list", productId: "gold-pack" });
    assert.equal(l.items[0].id, 41, "an exact match wins over a case match");
    assert.equal(l.notes, undefined);
  });
});

test("archived item found: list and product_id_taken say to restore with archive, archived: false", async () => {
  const dir = project();
  const old = { ...ITEM, id: 42, productId: "old-pack", isArchived: true, isActive: false };
  await withApi(
    { "GET /v1/vx-shop-items": () => json(200, { items: [old], total: 1 }), "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }) },
    async () => {
      const l = await run(dir, { action: "list", productId: "old-pack" });
      assert.match(l.notes.join(" "), /restore it with action archive, itemId 42, archived: false \(an isActive edit does not restore it\)/);
      const t = await run(dir, { action: "upsert", productId: "old-pack", name: "n", price: 1, stock: 1 });
      assert.match(t.hint, /archived\).*restore it with action archive, itemId 42, archived: false/);
    },
  );
});

// "on sale" is judged from the on-sale flag, archive flag and purchase dates, not the flag alone.
test("sale state: scheduled and closed items are not called on sale (list, product_id_taken, create result)", async () => {
  const dir = project();
  const at = (c) => JSON.stringify({ purchaseConstraints: c });
  const scheduled = { ...ITEM, id: 43, productId: "later", metadata: at({ purchaseStartDate: "2999-01-01T00:00:00Z" }) };
  const closed = { ...ITEM, id: 44, productId: "over", metadata: at({ purchaseEndDate: "2000-01-01T00:00:00Z" }) };
  await withApi(
    {
      "GET /v1/vx-shop-items": () => json(200, { items: [ITEM, scheduled, closed], total: 3 }),
      "GET /v1/vx-shop-items/check-product-id": (u) => json(200, { available: u.searchParams.get("productId") === "fresh" }),
      "POST /v1/vx-shop-items": (_u, body) => json(201, { ...ITEM, id: 45, ...body, metadata: at(body.purchaseConstraints) }),
    },
    async () => {
      const l = await run(dir, { action: "list" });
      assert.deepEqual(l.items.map((i) => i.saleState), ["on sale", "scheduled", "sale window closed"]);
      assert.match((await run(dir, { action: "upsert", productId: "later", name: "n", price: 1, stock: 1 })).hint, /stock 100, scheduled\)/);
      assert.match((await run(dir, { action: "upsert", productId: "over", name: "n", price: 1, stock: 1 })).hint, /stock 100, sale window closed\)/);
      const input = { action: "upsert", productId: "fresh", name: "n", price: 1, stock: 1, isActive: true, purchaseConstraints: { purchaseStartDate: "2999-01-01T00:00:00Z" } };
      const pre = await run(dir, input);
      // The user chooses Run in the host's prompt.
      const host = { canAsk: true, ask: async () => ({ action: "accept", content: { choice: "Run" } }), isCancelled: () => false };
      const done = await runVxShop(vxShopInputSchema.parse({ projectDir: dir, ...input, planId: pre.planId }), dir, host);
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(done.next[1], "The item is scheduled.");
    },
  );
});

test("list by productId: a failed second page is an error, not 'no such item'", async () => {
  const dir = project();
  const page1 = Array.from({ length: 100 }, (_, i) => ({ ...ITEM, id: 100 + i, productId: `filler-${i}` }));
  await withApi(
    { "GET /v1/vx-shop-items": (u) => (u.searchParams.get("page") === "1" ? json(200, { items: page1, total: 150 }) : json(503, { message: "down" })) },
    async () => {
      const r = await run(dir, { action: "list", productId: "gold-pack" });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "upstream_error");
      assert.equal(r.seller.isSeller, true, "the seller status still comes back");
    },
  );
});
