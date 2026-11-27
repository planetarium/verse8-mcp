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
      // The client code always; the grant by the delivery setting (PR #77 re-review 3, note 2).
      assert.match(done.next[0], /Use productId 'gem-pack' exactly as written in the client code — useVXShop getItem \/ buyItem — in every game\. The grant goes in the 'gem-pack' case of the server's \$onItemPurchased \(the default delivery\), or, for a game with external-only delivery, in its external receiver instead/);
      assert.match(done.next[1], /hidden: players cannot buy it, and getItem does not return it on the PREVIEW stage either.*Starting the sale is a separate edit \(itemId 8, isActive: true\) that the user confirms/);
      // A purchase before the granting code is live is paid and not granted (#66 review).
      // Only the user asks for a deploy (an update that keeps the visibility asks nobody).
      // A deploy only if the grant is not live yet, and only when the user asks.
      assert.match(done.next[2], /If the game is published and the code that grants this item is not live there yet .*: tell the user a deploy is needed before the sale starts, and run verse8_deploy only when they ask for it\./);
      assert.match(done.next[3], /external receiver \(external-only delivery, which does not call \$onItemPurchased\), the grant for this productId must be in that receiver first/);
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

// As the backend sends it: the body always carries the request path, whose query names the verse.
const errBody = (message) => ({ statusCode: 404, timestamp: "2026-11-27T00:00:00.000Z", path: `/v1/vx-shop-items?verseId=${VERSE}&page=1`, message });
const NO_VERSE = () => json(404, errBody(`Verse with ID ${VERSE} not found`));

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
  // Other 404s are not "not published", though their body's path holds `verseId=` (PR #77 re-review).
  // The route-miss message holds `verseId=` itself: a loose /verse/i on the message would fail here (PR #77 re-review 3, note 5).
  for (const message of ["Cannot GET", "User with UID 123 not found", `Cannot GET /v1/vx-shop-items/sales?verseId=${VERSE}`]) {
    await withApi({ "GET /v1/vx-shop-items/sales": () => json(404, errBody(message)), "GET /v1/vx-shop-items": () => json(404, errBody(message)) }, async () => {
      assert.equal((await run(dir, { action: "sales" })).needsPublish, undefined, message);
      assert.equal((await run(dir, { action: "list" })).needsPublish, undefined, message);
    });
  }
});

// The server compares product ids without regard to case: the item stored as 'Gold-Pack' holds 'gold-pack'.
// The server's unique index ignores case, so at most one item matches 'gold-pack' that way.
test("productId lookup: case-insensitive, and the stored value comes back (top level too); existingItem the same", async () => {
  const dir = project();
  const stored = { ...ITEM, id: 40, productId: "Gold-Pack" };
  await withApi(
    { "GET /v1/vx-shop-items": () => json(200, { items: [stored], total: 1 }), "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }) },
    async () => {
      const l = await run(dir, { action: "list", productId: "gold-pack" });
      assert.equal(l.items[0].id, 40);
      assert.equal(l.items[0].productId, "Gold-Pack");
      assert.equal(l.productId, "Gold-Pack", "the top-level productId is the stored one once found");
      assert.match(l.notes[0], /Stored as 'Gold-Pack'.*use that exact value in the code/);
      const t = await run(dir, { action: "upsert", productId: "gold-pack", name: "n", price: 1, stock: 1 });
      assert.equal(t.existingItem.id, 40);
      assert.match(t.hint, /use 'Gold-Pack' exactly in the code/);
      const same = await run(dir, { action: "list", productId: "Gold-Pack" });
      assert.equal(same.notes, undefined, "an exact match needs no note");
      const none = await run(dir, { action: "list", productId: "silver-pack" });
      assert.equal(none.productId, "silver-pack", "nothing found: the asked value");
    },
  );
});

// What a restore does follows the on-sale flag and the purchase dates, as the confirmation reads them (PR #77 re-reviews).
test("archived item found: the restore hint follows its on-sale flag and sale window", async () => {
  const dir = project();
  const at = (c) => JSON.stringify({ purchaseConstraints: c });
  const items = [
    { ...ITEM, id: 42, productId: "old-pack", isArchived: true, isActive: false },
    { ...ITEM, id: 46, productId: "flag-pack", isArchived: true, isActive: true },
    { ...ITEM, id: 51, productId: "later-pack", isArchived: true, isActive: true, metadata: at({ purchaseStartDate: "2999-01-01T00:00:00Z" }) },
    { ...ITEM, id: 52, productId: "over-pack", isArchived: true, isActive: true, metadata: at({ purchaseEndDate: "2000-01-01T00:00:00Z" }) },
  ];
  await withApi(
    { "GET /v1/vx-shop-items": () => json(200, { items, total: items.length }), "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }) },
    async () => {
      const both = async (productId) => {
        const l = await run(dir, { action: "list", productId });
        const t = await run(dir, { action: "upsert", productId, name: "n", price: 1, stock: 1 });
        return [l.notes.join(" "), t.hint];
      };
      for (const text of await both("old-pack")) assert.match(text, /restore it \(action archive, itemId 42, archived: false; an isActive edit does not restore it\)\. It comes back hidden/);
      for (const text of await both("flag-pack")) {
        assert.match(text, /on-sale flag still set, so restoring it starts its sale.*only once the code that grants it is live — or first edit it to isActive: false, then restore it/);
        assert.doesNotMatch(text, /comes back hidden/);
      }
      for (const text of await both("later-pack")) assert.match(text, /restoring it schedules its sale/);
      for (const text of await both("over-pack")) {
        assert.match(text, /its sale window has closed, so it comes back without selling/);
        assert.doesNotMatch(text, /starts its sale|only once the code that grants it is live/);
      }
    },
  );
});

test("product_id_taken survives a helper read that throws: no existingItem, still product_id_taken", async () => {
  const dir = project();
  await withApi(
    {
      "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }),
      "GET /v1/vx-shop-items": () => {
        throw new TypeError("fetch failed");
      },
    },
    async () => {
      const r = await run(dir, { action: "upsert", productId: "vault-slot", name: "n", price: 10, stock: 1 });
      assert.equal(r.error, "product_id_taken", JSON.stringify(r));
      assert.equal(r.existingItem, undefined);
    },
  );
});

test("saleState: a purchase date the server cannot read is unknown, not on sale", async () => {
  const dir = project();
  const odd = { ...ITEM, id: 47, productId: "odd", metadata: JSON.stringify({ purchaseConstraints: { purchaseStartDate: "2026-12 20:00" } }) };
  await withApi({ "GET /v1/vx-shop-items": () => json(200, { items: [odd], total: 1 }) }, async () => {
    assert.equal((await run(dir, { action: "list" })).items[0].saleState, "unknown");
  });
});

// The before-the-sale warning and the confirmation share one test (vxSaleKind): the warning is there
// exactly when the confirmation asks "start selling" / "put it back on sale" (PR #77 re-review 3, note 1).
const SALE_START_Q = /Start selling|start selling|put it back on sale/;
// Loose on purpose: any wording of the deploy step / receiver step counts as "warned".
const BEFORE = /tell the user a deploy is needed.*run verse8_deploy only when they ask for it/;
const EXT = /grant for this productId .*(receiver|there) first/;
const SALE_ITEMS = (() => {
  const at = (c) => JSON.stringify({ purchaseConstraints: c });
  return [
    { ...ITEM, id: 60, isActive: false }, // hidden
    { ...ITEM, id: 61, stock: 0 }, // on sale, sold out
    { ...ITEM, id: 62, stock: 0, metadata: at({ purchaseStartDate: "2999-01-01T00:00:00Z" }) }, // scheduled, sold out
    { ...ITEM, id: 63, metadata: at({ purchaseStartDate: "2999-01-01T00:00:00Z" }) }, // scheduled
    { ...ITEM, id: 64, isArchived: true, isActive: false }, // archived, hidden
    { ...ITEM, id: 65, isArchived: true }, // archived, flag set, window open
    { ...ITEM, id: 66, isArchived: true, metadata: at({ purchaseEndDate: "2000-01-01T00:00:00Z" }) }, // archived, window closed
    { ...ITEM, id: 67 }, // on sale
  ];
})();
for (const [name, input, opens] of [
  ["create on sale", { action: "upsert", productId: "fresh", name: "n", price: 1, stock: 1, isActive: true }, true],
  ["create hidden", { action: "upsert", productId: "fresh", name: "n", price: 1, stock: 1 }, false],
  ["create with the flag but a closed window", { action: "upsert", productId: "fresh", name: "n", price: 1, stock: 1, isActive: true, purchaseConstraints: { purchaseEndDate: "2000-01-01T00:00:00Z" } }, false],
  ["flag on for a hidden item", { action: "upsert", itemId: 60, isActive: true }, true],
  ["stock 0 → 5 on an item on sale", { action: "upsert", itemId: 61, stock: 5 }, true],
  ["stock 0 → 5 on a scheduled item", { action: "upsert", itemId: 62, stock: 5 }, true],
  ["move a future start date into the past", { action: "upsert", itemId: 63, purchaseConstraints: { purchaseStartDate: "2000-01-01T00:00:00Z" } }, true],
  ["flag on for an archived item (editing does not restore)", { action: "upsert", itemId: 64, isActive: true }, false],
  ["restore an archived item whose flag is set", { action: "archive", itemId: 65, archived: false }, true],
  ["restore an archived item whose window has closed", { action: "archive", itemId: 66, archived: false }, false],
  ["restore an archived hidden item", { action: "archive", itemId: 64, archived: false }, false],
  ["reprice an item on sale (asks, but starts no sale)", { action: "upsert", itemId: 67, price: 99 }, false],
]) {
  test(`before-the-sale warning follows the confirmation's sale-start test: ${name} → ${opens ? "warned" : "not warned"}`, async () => {
    const dir = project();
    await withApi(
      { "GET /v1/vx-shop-items": () => json(200, { items: SALE_ITEMS, total: SALE_ITEMS.length }), "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: true }) },
      async () => {
        const pre = await run(dir, input);
        assert.equal(pre.ok, true, JSON.stringify(pre));
        const warned = pre.warnings.some((w) => BEFORE.test(w));
        assert.equal(warned, opens, JSON.stringify(pre.warnings));
        assert.equal(pre.warnings.some((w) => EXT.test(w)), opens);
        assert.equal(warned, SALE_START_Q.test(pre.confirmation ?? ""), `the warning and the confirmation disagree: ${pre.confirmation}`);
      },
    );
  });
}

test("stock 0 edit: says stock 0 does not stop the sale, isActive: false does", async () => {
  const dir = project();
  await withApi({ "GET /v1/vx-shop-items": () => json(200, { items: SALE_ITEMS, total: SALE_ITEMS.length }) }, async () => {
    const pre = await run(dir, { action: "upsert", itemId: 67, stock: 0 });
    assert.ok(pre.warnings.includes("stock 0 does not stop the sale (a refund or an expired reservation brings units back and they sell); to stop selling, set isActive: false."), JSON.stringify(pre.warnings));
    const other = await run(dir, { action: "upsert", itemId: 67, stock: 7 });
    assert.ok(!other.warnings.some((w) => /stock 0 does not stop/.test(w)));
  });
});

test("product_id_taken names an unreadable sale state as 'sale state unknown'", async () => {
  const dir = project();
  const odd = { ...ITEM, id: 68, productId: "odd", metadata: JSON.stringify({ purchaseConstraints: { purchaseStartDate: "2026-12 20:00" } }) };
  await withApi({ "GET /v1/vx-shop-items": () => json(200, { items: [odd], total: 1 }), "GET /v1/vx-shop-items/check-product-id": () => json(200, { available: false }) }, async () => {
    const r = await run(dir, { action: "upsert", productId: "odd", name: "n", price: 1, stock: 1 });
    assert.match(r.hint, /stock 100, sale state unknown\)/);
  });
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
      // Created selling (here scheduled): the deploy-first moment has passed — said as such (PR #77 re-review 3, note 1).
      assert.match(done.next[1], /^The item is scheduled already\. If the game is published and the code that grants it is not live yet, purchases made now are paid but not granted: tell the user at once/);
      assert.ok(!done.next.some((n) => /before the sale starts/.test(n)), "no 'before the sale starts' once it has started");
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
