// INV-17: A user-confirmation action writes nothing without the user's "Run".
// The user confirmation of the plan gate (creatorOps RUN_RULES): an action
// that starts a sale or reprices an item on sale runs only after the user
// chose "Run" in the host's own prompt (MCP elicitation), asked after the
// planId matched. fetch is mocked; the host is a stub, and at the end a real
// MCP client over an in-memory transport.
//  - decline / cancel / any other answer / a host that cannot ask → no write
//  - the prompt is one line and its first choice is "Cancel"
//  - an op without a row in RUN_RULES does not run

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { CONFIRM_SCHEMA, RUN_RULES, confirmGate, confirmMessage, planGate, planId, runConditionOf } from "../../dist/tools/creatorOps.js";
import * as creatorOps from "../../dist/tools/creatorOps.js";
import { runVerseOps, verseOpsInputSchema } from "../../dist/tools/verseOps.js";
import { runVxShop, vxShopInputSchema } from "../../dist/tools/vxShop.js";
import { createServer } from "../../dist/server.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";
const SRC_TOOLS = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "src", "tools");

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-confirm-"));
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  fs.writeFileSync(path.join(dir, "item.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  return dir;
}
const json = (status, body) => new Response(JSON.stringify(body), { status });
const item = (id, extra = {}) => ({
  id, verseId: VERSE, productId: `p${id}`, name: `Item ${id}`, price: 300, stock: 100, soldCount: 0, imageUrl: null, description: "d",
  metadata: null, isActive: true, isArchived: false, ...extra,
});

// 7: on sale. 8: hidden. 9: archived with the on-sale flag set. 10: archived, hidden.
// 12: on sale, with purchase limits. 13: hidden, with purchase limits.
const FUTURE = "2999-12-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const RICH_LIMITS = { maxPurchasePerPeriod: 5, maxPurchasePerUser: 10, purchaseEndDate: "2999-12-31T00:00:00.000Z", purchasePeriodDays: 1, purchaseStartDate: "2020-01-01T00:00:00.000Z" };
const WITH_LIMITS = { metadata: JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 2 } }) };
const MIXED_LIMITS = { metadata: JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 2, maxPurchasePerPeriod: 1, purchasePeriodDays: 7 } }) };
const MIXED_SHOWN = /purchase limits \(maxPurchasePerPeriod: 1, maxPurchasePerUser: 2 → 3, purchasePeriodDays: 7\)/;
const makeItems = () => [
  item(7),
  item(8, { isActive: false }),
  item(9, { isArchived: true }),
  item(10, { isArchived: true, isActive: false }),
  item(12, WITH_LIMITS),
  item(13, { isActive: false, ...WITH_LIMITS }),
  // 14: on sale, every kind of limit set. 15: on-sale flag set but the sale
  // starts in the future. 16: on-sale flag set, the sale ended. 17: on-sale
  // flag set, no stock.
  item(14, { price: 100, metadata: JSON.stringify({ purchaseConstraints: RICH_LIMITS }) }),
  item(15, { metadata: JSON.stringify({ purchaseConstraints: { purchaseStartDate: FUTURE } }) }),
  item(16, { metadata: JSON.stringify({ purchaseConstraints: { purchaseEndDate: PAST } }) }),
  item(17, { stock: 0 }),
  // 18: hidden, no stock.
  item(18, { isActive: false, stock: 0 }),
  // 19: on-sale flag set, both dates ahead but the start after the end: a window that never opens.
  item(19, { metadata: JSON.stringify({ purchaseConstraints: { purchaseStartDate: "2999-12-01T00:00:00.000Z", purchaseEndDate: "2999-06-01T00:00:00.000Z" } }) }),
  // 20: hidden, 21: on sale, 22: archived with the on-sale flag set — each with three count limits (#66 review: mixed changes).
  item(20, { isActive: false, ...MIXED_LIMITS }),
  item(21, MIXED_LIMITS),
  item(22, { isArchived: true, ...MIXED_LIMITS }),
];

async function withShop(f) {
  const items = makeItems();
  const verse = { verseId: VERSE, verseShortId: "abc", isOwner: true, title: "Old title", description: "d", tag: ["RPG"], visibility: "Private", allowRemix: false };
  const comments = [1, 2].map((id) => ({ id, userUid: "9", userHandle: "ana", userDisplayName: "Ana", content: id === 1 ? "first!" : "second", parentCommentId: null, likes: 0, isDeleted: false, createdAt: "t" }));
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (u, init = {}) => {
    const { pathname } = new URL(u);
    const method = init.method ?? "GET";
    calls.push({ method, path: pathname });
    if (pathname === "/v1/verse/verseId") return json(200, verse);
    if (method === "GET" && pathname === `/v1/verse/${VERSE}/comments`) return json(200, { pinnedComment: null, comments, page: 1, limit: 100, total: comments.length });
    if (method === "DELETE" && /^\/v1\/verse\/[^/]+\/comments\/\d+$/.test(pathname)) return new Response(null, { status: 204 });
    if (method === "POST" && /^\/v1\/verse\/[^/]+\/comments\/\d+\/pin$/.test(pathname)) return json(201, { isPinned: true });
    if (method === "GET" && pathname === "/v1/vx-shop-items/sales") return json(200, { sales: [{ id: 55, shopItemId: 7, status: "completed", disputeStatus: "REQUEST", disputeMessage: "not received" }], total: 1 });
    if (method === "PUT" && pathname === "/v1/vx-shop-items/sales/55/dispute") return json(200, { success: true });
    if (method === "POST" && pathname === `/v1/verse/update/${VERSE}`) return json(201, { ...verse, ...JSON.parse(init.body) });
    if (method === "GET" && pathname === "/v1/vx-wallet") return json(200, { isSeller: true, balance: 0 });
    if (method === "GET" && pathname === "/v1/vx-shop-items") return json(200, { items, total: items.length });
    if (method === "GET" && pathname === "/v1/vx-shop-items/check-product-id") return json(200, { available: true });
    if (method === "POST" && pathname === "/api/upload") return json(200, { publicUrl: "https://contents.verse8.io/vx-shop/x/i.png" });
    if (method === "POST" && pathname === "/v1/vx-shop-items") return json(201, { ...item(11), ...JSON.parse(init.body) });
    const m = /^\/v1\/vx-shop-items\/(\d+)$/.exec(pathname);
    if (method === "PUT" && m) return json(200, { ...items.find((i) => i.id === Number(m[1])), ...JSON.parse(init.body) });
    return json(599, { message: `unrouted ${method} ${pathname}` });
  };
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  try {
    return await f(calls, items, verse, comments);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}

const run = (dir, input, host) =>
  ["update", "comment_delete", "comment_pin"].includes(input.action)
    ? runVerseOps(verseOpsInputSchema.parse({ projectDir: dir, ...input }), dir, host)
    : runVxShop(vxShopInputSchema.parse({ projectDir: dir, ...input }), dir, host);
// Where a refusal sends the user: the per-game creator page on the create host, and the tab.
const PAGE = `https://create[.]verse8[.]io/creations/${VERSE}`;
const PROMPT_HOST = "If the limits or the stock must hold exactly, run it from a host that can show the confirmation prompt instead[)]";
const SHOP_PORTAL = new RegExp(`VX Shop tab: ${PAGE} [(]open the "VX Shop" tab and use the item's edit dialog — the on/off switch on that tab sends no purchase limits, and the server then removes the item's limits[.] The dialog saves the stock it read when it was opened, so units sold while it is open come back: save it promptly[.] ${PROMPT_HOST}`);
// An archived item has only Restore on that tab, no edit dialog; restored, it sells without its limits until they are set again.
const ARCHIVED_PORTAL = new RegExp(`VX Shop tab: ${PAGE} [(]open the "VX Shop" tab, switch on "Include Archived" and use Restore on the item — an archived item has no edit dialog there[.] Restore sends no purchase limits and the server then removes the item's limits: the item sells without limits until you set them again in its edit dialog[.] ${PROMPT_HOST}`);
// A new item has no edit dialog yet: the tab's "Add New Item".
const CREATE_PORTAL = new RegExp(`VX Shop tab: ${PAGE} [(]open the "VX Shop" tab and use "Add New Item"[)]`);
const GAME_PORTAL = new RegExp(`General tab: ${PAGE} [(]the "Visibility" select[)]`);
const COMMENT_PORTAL = new RegExp(`the game's page: https://verse8[.]io/${VERSE} [(]open the comments and press the trash button next to the comment[)]`);
const writes = (calls) => calls.filter((c) => c.method !== "GET");

/** A host that can ask and answers with `answer` (a value, or a function that may throw). */
function hostThat(answer, { canAsk = true } = {}) {
  const asked = [];
  return {
    asked,
    canAsk,
    ask: async (message, schema) => {
      asked.push({ message, schema });
      return typeof answer === "function" ? answer() : answer;
    },
  };
}
const RUN = { action: "accept", content: { choice: "Run" } };

/** Every action that needs the user's confirmation, with what its prompt must show. */
const CONFIRMED = [
  {
    name: "create on sale",
    input: { action: "upsert", productId: "gem", name: "Gems", price: 120, stock: 5, isActive: true, imagePath: "item.png" },
    shows: [/Gems/, /productId "gem"/, /120 VX/, new RegExp(VERSE)],
    upload: true,
    portal: CREATE_PORTAL,
  },
  {
    name: "edit: put a hidden item on sale",
    input: { action: "upsert", itemId: 8, isActive: true },
    shows: [/Item 8/, /item 8\b/, /300 VX/, new RegExp(VERSE), /Start selling/],
  },
  {
    name: "edit: change the price of an item on sale",
    input: { action: "upsert", itemId: 7, price: 350 },
    shows: [/Item 7/, /300 → 350 VX/, new RegExp(VERSE), /on sale/],
  },
  {
    name: "edit: put on sale at a new price, renaming it",
    input: { action: "upsert", itemId: 8, isActive: true, price: 90, name: "Renamed" },
    shows: [/Item 8/, /300 → 90 VX/, /also changes name: "Item 8" → "Renamed"/],
  },
  {
    name: "restore an archived item whose on-sale flag is set",
    input: { action: "archive", itemId: 9, archived: false },
    shows: [/Item 9/, /300 VX/, new RegExp(VERSE), /back on sale/],
    portal: ARCHIVED_PORTAL,
  },
  {
    name: "game: Private → Public",
    input: { action: "update", visibility: "Public" },
    shows: [/Make this game visible to more people\?/, /Game: "Old title"/, new RegExp(VERSE), /Visibility: Private → Public \(listed on Verse8 for everyone\)/, /set it back to Private/],
    portal: GAME_PORTAL,
  },
  {
    name: "game: Private → Unlisted, renaming it",
    input: { action: "update", visibility: "Unlisted", title: "New title" },
    shows: [/Game: "Old title"/, /Visibility: Private → Unlisted \(anyone with the link can play, not listed\)/, /also changes title: "Old title" → "New title"/],
    portal: GAME_PORTAL,
  },
  {
    name: "delete a comment",
    input: { action: "comment_delete", commentId: 1 },
    shows: [/Delete this comment for good\?/, /Comment 1 by "ana"/, new RegExp(VERSE), /Deletes: "first!"/, /Undo: none — a deleted comment cannot be restored/],
    portal: COMMENT_PORTAL,
  },
];

/** Answers that are not the user choosing "Run". */
const NOT_RUN = [
  ["decline", { action: "decline" }],
  ["cancel", { action: "cancel" }],
  ["accept with the Cancel choice", { action: "accept", content: { choice: "Cancel" } }],
  ["accept without content", { action: "accept" }],
  ["accept with another value", { action: "accept", content: { choice: "run" } }],
  ["accept with a non-string choice", { action: "accept", content: { choice: true } }],
  ["an unknown action", { action: "approved", content: { choice: "Run" } }],
  ["an empty answer", {}],
];

for (const k of CONFIRMED) {
  test(`${k.name}: the preview says user_confirm and shows the one-line prompt; nothing is asked or written`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const host = hostThat(RUN);
      const pre = await run(dir, k.input, host);
      assert.equal(pre.ok, true, JSON.stringify(pre));
      assert.equal(pre.dryRun, true);
      assert.equal(pre.runCondition, "user_confirm");
      assert.doesNotMatch(pre.confirmation, /[\r\n]/, "the prompt is one line");
      for (const re of k.shows) assert.match(pre.confirmation, re);
      assert.match(pre.confirmation, /Undo: /, "says whether it can be undone");
      assert.match(pre.next, /chooses? Run/);
      assert.equal(host.asked.length, 0);
      assert.deepEqual(writes(calls), []);
    });
  });

  test(`${k.name}: the user chooses Run → asked once with the preview's text, Cancel first; one write`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const host = hostThat(RUN);
      const pre = await run(dir, k.input, host);
      const done = await run(dir, { ...k.input, planId: pre.planId }, host);
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(done.dryRun, false);
      assert.equal(host.asked.length, 1);
      assert.equal(host.asked[0].message, pre.confirmation);
      assert.doesNotMatch(host.asked[0].message, /[\r\n]/);
      assert.deepEqual(host.asked[0].schema.properties.choice.enum, ["Cancel", "Run"]);
      assert.deepEqual(host.asked[0].schema.required, ["choice"]);
      assert.equal(writes(calls).filter((c) => c.path !== "/api/upload").length, 1);
    });
  });

  for (const [label, answer] of NOT_RUN) {
    test(`${k.name}: ${label} → user_cancelled, no write${k.upload ? ", no upload" : ""}`, async () => {
      const dir = project();
      await withShop(async (calls) => {
        const host = hostThat(answer);
        const pre = await run(dir, k.input, host);
        const r = await run(dir, { ...k.input, planId: pre.planId }, host);
        assert.equal(r.ok, false);
        assert.equal(r.error, "user_cancelled", JSON.stringify(r));
        assert.match(r.hint, /Nothing was changed/);
        assert.match(r.hint, k.portal ?? SHOP_PORTAL, "says where to do it on the web");
        assert.equal(host.asked.length, 1);
        assert.deepEqual(writes(calls), []);
      });
    });
  }

  test(`${k.name}: a host that did not declare elicitation, or no host → confirm_unavailable with the web address, no write`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const mute = hostThat(RUN, { canAsk: false });
      const pre = await run(dir, k.input, mute);
      for (const host of [mute, undefined]) {
        const r = await run(dir, { ...k.input, planId: pre.planId }, host);
        assert.equal(r.error, "confirm_unavailable", JSON.stringify(r));
        assert.match(r.hint, /Nothing was changed/);
        assert.match(r.hint, k.portal ?? SHOP_PORTAL);
        assert.equal(r.confirmation, pre.confirmation);
      }
      assert.equal(mute.asked.length, 0, "a host that cannot ask is not asked");
      assert.deepEqual(writes(calls), []);
    });
  });

  test(`${k.name}: the prompt fails (timeout, transport) → confirm_unavailable, no write`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const host = hostThat(() => {
        throw new Error("Request timed out");
      });
      const pre = await run(dir, k.input, host);
      const r = await run(dir, { ...k.input, planId: pre.planId }, host);
      assert.equal(r.error, "confirm_unavailable", JSON.stringify(r));
      assert.match(r.hint, /Request timed out/);
      assert.deepEqual(writes(calls), []);
    });
  });

  test(`${k.name}: a planId that does not match → plan_mismatch before anyone is asked`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const host = hostThat(RUN);
      const r = await run(dir, { ...k.input, planId: `v1.${"0".repeat(32)}.${"0".repeat(16)}` }, host);
      assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
      assert.equal(host.asked.length, 0);
      assert.deepEqual(writes(calls), []);
    });
  });
}

test("the confirmation is asked about fresh values: the item went on sale after a price preview → plan_mismatch, not a silent run", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    const input = { action: "upsert", itemId: 8, price: 90 };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "preview", "a hidden item's price is a preview-level change");
    items[1].isActive = true;
    const host = hostThat(RUN);
    const r = await run(dir, { ...input, planId: pre.planId }, host);
    assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
    assert.ok(r.changed.some((c) => c.part === "state.isActive"));
    assert.equal(host.asked.length, 0);
    assert.deepEqual(writes(calls), []);
  });
});

/** Changes that stay preview-level: they run with the planId alone, no host. */
const PREVIEW_ONLY = [
  ["create hidden", { action: "upsert", productId: "gem", name: "Gems", price: 120, stock: 5 }],
  ["edit the price of a hidden item", { action: "upsert", itemId: 8, price: 90 }],
  ["edit the price of an archived item", { action: "upsert", itemId: 9, price: 90 }],
  ["stop selling", { action: "upsert", itemId: 7, isActive: false }],
  ["stop selling and reprice in one edit", { action: "upsert", itemId: 7, isActive: false, price: 90 }],
  ["rename an item on sale", { action: "upsert", itemId: 7, name: "Renamed" }],
  ["archive an item on sale", { action: "archive", itemId: 7 }],
  ["restore a hidden item", { action: "archive", itemId: 10, archived: false }],
  // Kept at preview on purpose: pinning is undone by unpinning; a dispute
  // answer is a message to the buyer and moves no money.
  ["pin a comment", { action: "comment_pin", commentId: 1 }],
  ["answer a buyer's dispute", { action: "dispute", saleId: 55, disputeStatus: "RESOLVED", responseMessage: "Sent again" }],
];
for (const [name, input] of PREVIEW_ONLY) {
  test(`preview-level: ${name} → runs with the planId alone, the user is not asked`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const host = hostThat({ action: "decline" });
      const pre = await run(dir, input, host);
      assert.equal(pre.runCondition, "preview", JSON.stringify(pre));
      assert.equal(pre.confirmation, undefined);
      const done = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(host.asked.length, 0);
      assert.equal(writes(calls).length, 1);
    });
  });
}

test("the prompt stays one line whatever the item is called, and is capped", () => {
  const plan = (name) => ({
    op: "verse8_vxshop.upsert.create",
    target: { verseId: VERSE, productId: "gem" },
    body: { verseId: VERSE, productId: "gem", name, price: 5, stock: 1, isActive: true },
  });
  // Line separator, paragraph separator, next-line: built by code so the
  // file itself carries no such character.
  const SEPS = [0x2028, 0x2029, 0x85].map((c) => String.fromCharCode(c));
  const m = confirmMessage(plan(`Free gift\n\nPrice: 0 VX\r\n${SEPS[0]}really${SEPS[1]}${SEPS[2]}\tfree`));
  assert.equal(/[\r\n\t]/.test(m) || SEPS.some((c) => m.includes(c)), false, JSON.stringify(m));
  assert.match(m, /Price: 5 VX, stock 1/);
  const long = confirmMessage(plan("x".repeat(5000)));
  assert.ok(long.length <= 1200, `${long.length}`);
  assert.match(long, /^Create this VX Shop item and start selling it\?/);
});

// ── the prompt shows every value the request changes, not only the price ──

const LIMITS_GONE = /ALL purchase limits REMOVED [(]maxPurchasePerUser: 2 → none[)]/;
/** [name, input, what the prompt must show, what it must not]. Items 12 (on sale) and 13 (hidden) have purchase limits. */
const SHOWS_ALL = [
  [
    "start a sale and remove the purchase limits",
    { action: "upsert", itemId: 13, isActive: true, clearPurchaseConstraints: true },
    [/Start selling/, /Price: 300 VX/, LIMITS_GONE],
  ],
  [
    "reprice a live item and remove the purchase limits",
    { action: "upsert", itemId: 12, price: 350, clearPurchaseConstraints: true },
    [/300 → 350 VX/, LIMITS_GONE],
  ],
  [
    "reprice a live item and change the purchase limits",
    { action: "upsert", itemId: 12, price: 350, purchaseConstraints: { maxPurchasePerUser: 9 } },
    [/purchase limits [(]maxPurchasePerUser: 2 → 9[)]/],
  ],
  [
    // Shown as they stand (#66), never as a change.
    "reprice a live item, limits kept: the re-sent limits are shown, not as a change",
    { action: "upsert", itemId: 12, price: 350 },
    [/300 → 350 VX/, /; purchase limits \(maxPurchasePerUser: 2\)/],
    [/maxPurchasePerUser: 2 →/, /REMOVED/, /also changes/],
  ],
  [
    "start a sale and change every other field",
    { action: "upsert", itemId: 8, isActive: true, name: "Renamed", stock: 3, description: "new text", imageUrl: "https://img.example/i.png", metadata: { rarity: "epic" } },
    [
      /name: "Item 8" → "Renamed"/,
      /stock: 100 → 3/,
      /description: "d" → "new text"/,
      /imageUrl: none → "https:\/\/img\.example\/i\.png"/,
      /metadata: none → "\{\\"rarity\\":\\"epic\\"\}"/,
    ],
  ],
  [
    "start a sale with a local image: the upload is named",
    { action: "upsert", itemId: 8, isActive: true, imagePath: "item.png" },
    [/imageUrl: none → "<upload:item\.png>"/],
  ],
  [
    "create on sale with limits, description, image and metadata",
    { action: "upsert", productId: "gem", name: "Gems", price: 120, stock: 5, isActive: true, purchaseConstraints: { maxPurchasePerUser: 1 }, description: "A gem", imagePath: "item.png", metadata: { tier: 2 } },
    [/purchase limits [(]maxPurchasePerUser: 1[)]/, /description: "A gem"/, /imageUrl: "<upload:item.png>"/, /metadata: "{\\"tier\\":2}"/],
    [/no purchase limits/],
  ],
  [
    "create on sale without limits says so",
    { action: "upsert", productId: "gem", name: "Gems", price: 120, stock: 5, isActive: true },
    [/no purchase limits/],
  ],
  [
    "a very long description does not push the limit removal or the undo note out",
    { action: "upsert", itemId: 12, price: 350, clearPurchaseConstraints: true, description: "y".repeat(5000), name: "n".repeat(255) },
    [/ALL purchase limits REMOVED/, /description: "d" → "y+…/, /Undo: /],
  ],
];
for (const [name, input, shows, hides = []] of SHOWS_ALL) {
  test(`prompt shows the values: ${name}`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const host = hostThat({ action: "cancel" });
      const pre = await run(dir, input, host);
      assert.equal(pre.runCondition, "user_confirm", JSON.stringify(pre));
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(r.error, "user_cancelled");
      const asked = host.asked[0].message;
      assert.equal(asked, pre.confirmation);
      for (const re of shows) assert.match(asked, re);
      for (const re of hides) assert.doesNotMatch(asked, re);
      assert.match(asked, /Undo: /);
      assert.doesNotMatch(asked, /[\r\n]/);
      // Every field the preview lists as changing is named in the prompt.
      for (const c of pre.changes ?? []) {
        const label = c.field === "purchaseConstraints" ? "purchase limits" : c.field === "isActive" ? "Start selling" : c.field === "price" ? "Price: " : `${c.field}: `;
        assert.ok(asked.includes(label), `${c.field} is in changes but not in the prompt: ${asked}`);
      }
      assert.deepEqual(writes(calls), []);
    });
  });
}

// ── a call the host already cancelled ──

test("the host cancelled the tool call while the prompt was open → a late Run is not used, no write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const input = { action: "upsert", itemId: 7, price: 350 };
    for (const isCancelled of [() => true, () => { throw new Error("no signal"); }]) {
      const host = { ...hostThat(RUN), isCancelled };
      const pre = await run(dir, input, host);
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(r.error, "confirm_unavailable", JSON.stringify(r));
      assert.match(r.hint, /cancelled this tool call/);
    }
    assert.deepEqual(writes(calls), []);
  });
});

test("the form: one required choice, Cancel first, Run second", () => {
  assert.deepEqual(CONFIRM_SCHEMA.properties.choice.enum, ["Cancel", "Run"]);
  assert.deepEqual(CONFIRM_SCHEMA.required, ["choice"]);
});

// ── game visibility: only a widening change asks ──

/** [current, new, asks the user]. */
const VISIBILITY_MOVES = [
  ["Private", "Unlisted", true],
  ["Private", "Public", true],
  ["Unlisted", "Public", true],
  ["Public", "Unlisted", false],
  ["Public", "Private", false],
  ["Unlisted", "Private", false],
];
for (const [from, to, asks] of VISIBILITY_MOVES) {
  test(`game visibility ${from} → ${to}: ${asks ? "user_confirm — declined → no write, Run → one write" : "preview-level, runs with the planId alone"}`, async () => {
    const dir = project();
    await withShop(async (calls, _items, verse) => {
      verse.visibility = from;
      const input = { action: "update", visibility: to };
      const host = hostThat({ action: "decline" });
      const pre = await run(dir, input, host);
      assert.equal(pre.runCondition, asks ? "user_confirm" : "preview", JSON.stringify(pre));
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      if (!asks) {
        assert.equal(pre.confirmation, undefined);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(host.asked.length, 0);
        assert.equal(writes(calls).length, 1);
        return;
      }
      assert.match(pre.confirmation, new RegExp(`Game: "Old title" .*Visibility: ${from} → ${to} `));
      assert.equal(r.error, "user_cancelled", JSON.stringify(r));
      assert.deepEqual(writes(calls), []);
      const done = await run(dir, { ...input, planId: pre.planId }, hostThat(RUN));
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(writes(calls).length, 1);
    });
  });
}

test("game update that keeps the visibility (title only, on a Public game) is preview-level", async () => {
  const dir = project();
  await withShop(async (calls, _items, verse) => {
    verse.visibility = "Public";
    const pre = await run(dir, { action: "update", title: "New title" });
    assert.equal(pre.runCondition, "preview");
    assert.equal((await run(dir, { action: "update", title: "New title", planId: pre.planId })).ok, true);
    assert.equal(writes(calls).length, 1);
  });
});

test("game visibility: the title is bound — renamed on the web after the preview → plan_mismatch before anyone is asked", async () => {
  const dir = project();
  await withShop(async (calls, _items, verse) => {
    const host = hostThat(RUN);
    const pre = await run(dir, { action: "update", visibility: "Public" }, host);
    verse.title = "Renamed on the web";
    const r = await run(dir, { action: "update", visibility: "Public", planId: pre.planId }, host);
    assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
    assert.ok(r.changed.some((c) => c.part === "state.title"));
    assert.equal(host.asked.length, 0);
    assert.deepEqual(writes(calls), []);
  });
});

test("game visibility: the prompt says when going visible starts a review; system tags are not shown as a tag change", async () => {
  const dir = project();
  await withShop(async (_calls, _items, verse) => {
    verse.tag = ["RPG", "__review_required"];
    const pre = await run(dir, { action: "update", visibility: "Public", tags: ["RPG", "Arcade"] });
    assert.match(pre.confirmation, /starts a Verse8 review/);
    assert.match(pre.confirmation, /also changes tag: \["RPG"\] → \["RPG","Arcade"\]/);
    assert.doesNotMatch(pre.confirmation, /__review_required/);
  });
});

test("game visibility: a value the order does not know counts as widening", () => {
  const plan = (from, to) => ({ op: "verse8_verse.update", target: { verseId: VERSE }, body: { visibility: to }, state: { visibility: from, title: "T" } });
  assert.equal(runConditionOf(plan("Private", "Friends")), "user_confirm");
  assert.equal(runConditionOf(plan("Hidden", "Private")), "user_confirm");
  assert.equal(runConditionOf(plan("Public", "Public")), "preview");
  assert.equal(runConditionOf({ op: "verse8_verse.update", target: { verseId: VERSE }, body: { title: "x" }, state: { visibility: "Private" } }), "preview");
});

// ── the table ──

test("RUN_RULES: every op a tool builds a plan for has a row, and every user_confirm row has a prompt and a web address", () => {
  const ops = new Set();
  for (const f of fs.readdirSync(SRC_TOOLS).filter((n) => n.endsWith(".ts") && n !== "creatorOps.ts")) {
    for (const m of fs.readFileSync(path.join(SRC_TOOLS, f), "utf8").matchAll(/\bop: "([^"]+)"/g)) ops.add(m[1]);
  }
  assert.ok(ops.size >= 8, [...ops].join(", "));
  assert.deepEqual([...ops].filter((op) => !Object.hasOwn(RUN_RULES, op)), []);
  assert.deepEqual(Object.keys(RUN_RULES).filter((op) => !ops.has(op)), [], "rows for ops no tool has");
  for (const [op, rule] of Object.entries(RUN_RULES)) {
    if (rule.condition === "preview") continue;
    assert.equal(typeof rule.confirm, "function", op);
    assert.equal(typeof rule.portal, "function", op);
  }
});

test("an op without a row does not run: refused at preview and with its own planId; inherited names are not rows", async () => {
  for (const op of ["verse8_vxshop.refund", "toString", "constructor", "__proto__"]) {
    const plan = { op, target: { verseId: VERSE }, body: { amount: 1 } };
    assert.equal(runConditionOf(plan), null, op);
    const host = hostThat(RUN);
    const pre = await planGate(plan, undefined, { action: "x" }, host);
    assert.equal(pre.error, "op_not_classified", op);
    assert.equal(pre.planId, undefined);
    const r = await planGate(plan, planId(plan), { action: "x" }, host);
    assert.equal(r.error, "op_not_classified", op);
    assert.equal(r.approved, undefined);
    assert.equal(host.asked.length, 0);
  }
});

// ── through a real MCP connection ──

async function connect(clientCapabilities, onElicit) {
  const server = createServer();
  const client = new Client({ name: "test-host", version: "0" }, { capabilities: clientCapabilities });
  const seen = [];
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(req.params);
      return onElicit(req.params);
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const callShop = async (args) => JSON.parse((await client.callTool({ name: "verse8_vxshop", arguments: args })).content[0].text);
  return { callShop, client, seen, close: () => client.close() };
}

test("MCP host without the elicitation capability: sale start is refused with the web address, no write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const host = await connect({});
    try {
      const args = { projectDir: dir, action: "upsert", itemId: 8, isActive: true };
      const pre = await host.callShop(args);
      assert.equal(pre.runCondition, "user_confirm", JSON.stringify(pre));
      const r = await host.callShop({ ...args, planId: pre.planId });
      assert.equal(r.error, "confirm_unavailable", JSON.stringify(r));
      assert.match(r.hint, SHOP_PORTAL);
      assert.deepEqual(writes(calls), []);
    } finally {
      await host.close();
    }
  });
});

test("MCP host with elicitation: the request is a one-line form with Cancel first; cancel → no write, Run → one write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    let answer = { action: "cancel" };
    const host = await connect({ elicitation: { form: {} } }, () => answer);
    try {
      const args = { projectDir: dir, action: "upsert", itemId: 7, price: 350 };
      const pre = await host.callShop(args);
      const cancelled = await host.callShop({ ...args, planId: pre.planId });
      assert.equal(cancelled.error, "user_cancelled", JSON.stringify(cancelled));
      assert.deepEqual(writes(calls), []);
      assert.equal(host.seen.length, 1);
      assert.equal(host.seen[0].message, pre.confirmation);
      assert.doesNotMatch(host.seen[0].message, /[\r\n]/);
      assert.equal(host.seen[0].requestedSchema.properties.choice.enum[0], "Cancel");

      answer = { action: "decline" };
      assert.equal((await host.callShop({ ...args, planId: pre.planId })).error, "user_cancelled");
      assert.deepEqual(writes(calls), []);

      answer = RUN;
      const done = await host.callShop({ ...args, planId: pre.planId });
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(writes(calls).length, 1);
      assert.equal(host.seen.length, 3);
    } finally {
      await host.close();
    }
  });
});

test("MCP host cancels the tool call while the prompt is open, then answers Run → no write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const gaveUp = new AbortController();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The host's tool timeout fires while the user is still reading; the
    // user picks Run afterwards.
    const host = await connect({ elicitation: { form: {} } }, async () => {
      gaveUp.abort();
      await sleep(50);
      return RUN;
    });
    try {
      const args = { projectDir: dir, action: "upsert", itemId: 7, price: 350 };
      const pre = await host.callShop(args);
      await assert.rejects(host.client.callTool({ name: "verse8_vxshop", arguments: { ...args, planId: pre.planId } }, undefined, { signal: gaveUp.signal }));
      await sleep(300);
      assert.equal(host.seen.length, 1, "the prompt was open when the call was cancelled");
      assert.deepEqual(writes(calls), []);
    } finally {
      await host.close();
    }
  });
});

// ── the same gate for a tool without a planId (verse8_deploy) ──

test("confirmGate: one rule for every action that sends a visibility — deploy and game page update agree on what widens", async () => {
  const VALUES = [null, "Private", "Unlisted", "Public"];
  for (const from of VALUES) {
    for (const to of VALUES.slice(1)) {
      const parts = { target: { verseId: VERSE }, body: { visibility: to }, state: { visibility: from, title: "T" } };
      const deploy = runConditionOf({ op: "verse8_deploy.publish", ...parts });
      assert.equal(deploy, runConditionOf({ op: "verse8_verse.update", ...parts }), `${from} → ${to}`);
      const widens = VALUES.indexOf(to) > Math.max(1, VALUES.indexOf(from));
      assert.equal(deploy, widens ? "user_confirm" : "preview", `${from} → ${to}`);
    }
  }
});

test("confirmGate: asks only for a user_confirm plan, passes only on Run, reports without asking when told to, refuses an unlisted op", async () => {
  const widening = { op: "verse8_deploy.publish", target: { verseId: VERSE }, body: { visibility: "Public" }, state: { visibility: "Private", published: true, title: "T" } };
  const kept = { ...widening, body: { visibility: "Private" } };

  const yes = hostThat(RUN);
  const passed = await confirmGate(widening, yes, { ask: true, reread: async () => widening });
  assert.equal(passed.confirmed, true, JSON.stringify(passed));
  assert.equal(passed.runCondition, "user_confirm");
  assert.equal(yes.asked.length, 1);
  assert.equal(yes.asked[0].message, passed.confirmation);
  assert.doesNotMatch(passed.confirmation, /[\r\n]/);

  const no = hostThat({ action: "decline" });
  const same = { ask: true, reread: async () => widening };
  assert.equal((await confirmGate(widening, no, same)).error, "user_cancelled");
  assert.equal((await confirmGate(widening, undefined, same)).error, "confirm_unavailable");
  assert.equal((await confirmGate(widening, { ...hostThat(RUN), isCancelled: () => true }, same)).error, "confirm_unavailable");

  const silent = hostThat({ action: "decline" });
  const reported = await confirmGate(widening, silent, { ask: false });
  assert.equal(reported.confirmed, true);
  assert.equal(reported.runCondition, "user_confirm");
  assert.ok(reported.confirmation);
  const preview = await confirmGate(kept, silent);
  assert.equal(preview.confirmed, true);
  assert.equal(preview.runCondition, "preview");
  assert.equal(preview.confirmation, undefined);
  assert.equal(silent.asked.length, 0);

  const unlisted = await confirmGate({ ...widening, op: "verse8_deploy.unpublish" }, hostThat(RUN));
  assert.equal(unlisted.error, "op_not_classified");
  assert.equal(unlisted.confirmed, undefined);
});

// ═══ what the user saw is what runs (review of 8c40473) ═══

// ── purchase limits and sale dates are shown key by key, in full ──

test("limits: a change to purchasePeriodDays beside a price change is visible (the limits used to be one cut JSON, identical on both sides)", async () => {
  const dir = project();
  await withShop(async () => {
    const pre = await run(dir, { action: "upsert", itemId: 14, price: 200, purchaseConstraints: { ...RICH_LIMITS, purchasePeriodDays: 30 } });
    assert.equal(pre.runCondition, "user_confirm", JSON.stringify(pre));
    assert.match(pre.confirmation, /Price: 100 → 200 VX/);
    // The key that changes with both values, the kept ones with theirs (#66).
    assert.match(pre.confirmation, /purchase limits \(maxPurchasePerPeriod: 5, maxPurchasePerUser: 10, purchaseEndDate: "2999-12-31T00:00:00\.000Z", purchasePeriodDays: 1 → 30, purchaseStartDate: "2020-01-01T00:00:00\.000Z"\)/);
    assert.doesNotMatch(pre.confirmation, /…/, "nothing is cut");
  });
});

test("limits: every changed key is listed in full; a removed key reads → none", async () => {
  const dir = project();
  await withShop(async () => {
    const to = { maxPurchasePerUser: 10, purchaseEndDate: "2999-06-30T00:00:00.000Z", purchasePeriodDays: 7, maxPurchasePerPeriod: 5 };
    const pre = await run(dir, { action: "upsert", itemId: 14, price: 200, purchaseConstraints: to });
    for (const part of [
      'purchaseEndDate: "2999-12-31T00:00:00.000Z" → "2999-06-30T00:00:00.000Z"',
      "purchasePeriodDays: 1 → 7",
      'purchaseStartDate: "2020-01-01T00:00:00.000Z" → none',
    ]) assert.ok(pre.confirmation.includes(part), `${part} missing in: ${pre.confirmation}`);
    assert.ok(pre.confirmation.includes("maxPurchasePerUser: 10,"), "an unchanged key is listed with its value");
    assert.doesNotMatch(pre.confirmation, /maxPurchasePerUser: 10 →/, "…not as a change");
  });
});

test("create on sale: the start date is in the prompt — two start dates give two prompts, and a future start is not 'from now on'", async () => {
  const dir = project();
  await withShop(async () => {
    const base = { action: "upsert", productId: "gem", name: "Gems", price: 120, stock: 5, isActive: true };
    const a = await run(dir, { ...base, purchaseConstraints: { purchaseStartDate: "2999-12-01" } });
    const b = await run(dir, { ...base, purchaseConstraints: { purchaseStartDate: "2999-06-01", purchaseEndDate: "2999-09-01" } });
    assert.equal(a.runCondition, "user_confirm");
    assert.notEqual(a.confirmation, b.confirmation);
    // A date without a time zone is marked UTC wherever the prompt shows it: that is how it is applied.
    assert.match(a.confirmation, /buyers can purchase it from "2999-12-01" UTC;/);
    assert.match(a.confirmation, /purchase limits \(purchaseStartDate: "2999-12-01" UTC\)/);
    assert.match(b.confirmation, /buyers can purchase it from "2999-06-01" UTC until "2999-09-01" UTC;/);
    const local = await run(dir, { ...base, purchaseConstraints: { purchaseStartDate: "2999-12-01T20:00:00" } });
    assert.match(local.confirmation, /from "2999-12-01T20:00:00" UTC;/, "20:00 is not the user's local evening");
    const zoned = await run(dir, { ...base, purchaseConstraints: { purchaseStartDate: "2999-12-01T20:00:00+09:00" } });
    assert.match(zoned.confirmation, /from "2999-12-01T20:00:00\+09:00";/, "a date that names its zone is shown as it is");
    assert.doesNotMatch(zoned.confirmation, /UTC/);
    for (const m of [a.confirmation, b.confirmation]) assert.doesNotMatch(m, /from now on/);
    const open = await run(dir, { ...base, purchaseConstraints: { purchaseStartDate: PAST, purchaseEndDate: FUTURE } });
    assert.match(open.confirmation, new RegExp(`buyers can purchase it from now on until "${FUTURE}";`));
  });
});

// ── one test for "can it be bought": the sale level before and after ──

test("vxSaleLevel: what the creator sets — on-sale flag, archive flag, purchase dates; the stock is not part of it", () => {
  const { vxSaleLevel } = creatorOps;
  const now = Date.parse("2026-11-26T00:00:00Z");
  const v = (x = {}) => ({ isActive: true, isArchived: false, limits: {}, ...x });
  assert.equal(vxSaleLevel(v(), now), 2);
  assert.equal(vxSaleLevel(v({ isActive: false }), now), 0);
  assert.equal(vxSaleLevel(v({ isArchived: true }), now), 0);
  // The server moves the stock by itself (purchases, refunds, reservations): an item on sale with none left is still on sale.
  assert.equal(vxSaleLevel(v({ stock: 0 }), now), 2);
  assert.equal(vxSaleLevel(v({ limits: { purchaseStartDate: "2026-11-27" } }), now), 1, "scheduled");
  assert.equal(vxSaleLevel(v({ limits: { purchaseStartDate: "2026-11-25" } }), now), 2);
  assert.equal(vxSaleLevel(v({ limits: { purchaseEndDate: "2026-11-25" } }), now), 0, "ended");
  assert.equal(vxSaleLevel(v({ limits: { purchaseEndDate: "2026-11-27" } }), now), 2);
  // Count limits bound how much one buyer gets, not whether it sells.
  assert.equal(vxSaleLevel(v({ limits: { maxPurchasePerUser: 1, maxPurchasePerPeriod: 1, purchasePeriodDays: 1 } }), now), 2);
});

/** [name, input, run condition, what the prompt shows]. Item numbers as in makeItems. */
const OPENS_PURCHASES = [
  ["remove a future start date", { action: "upsert", itemId: 15, clearPurchaseConstraints: true }, "user_confirm", [/Start selling/, /from now on/, /ALL purchase limits REMOVED \(purchaseStartDate: ".*" → none\)/]],
  ["move a future start date into the past", { action: "upsert", itemId: 15, purchaseConstraints: { purchaseStartDate: PAST } }, "user_confirm", [/from now on/, /purchaseStartDate: /]],
  ["extend an end date that has passed", { action: "upsert", itemId: 16, purchaseConstraints: { purchaseEndDate: FUTURE } }, "user_confirm", [new RegExp(`from now on until "${FUTURE}"`)]],
  ["remove an end date that has passed", { action: "upsert", itemId: 16, clearPurchaseConstraints: true }, "user_confirm", [/Start selling/, /from now on/]],
  ["stock 0 → 5 on an item whose on-sale flag is set", { action: "upsert", itemId: 17, stock: 5 }, "user_confirm", [/Start selling/, /stock: 0 → 5/]],
  ["turn the on-sale flag on with a future start date", { action: "upsert", itemId: 8, isActive: true, purchaseConstraints: { purchaseStartDate: FUTURE } }, "user_confirm", [new RegExp(`from "${FUTURE}"`)]],
  ["reprice an item that is scheduled", { action: "upsert", itemId: 15, price: 90 }, "user_confirm", [/Change the price/, /300 → 90 VX/]],
  // Stock 0 does not take an item off sale: a refund or an expired
  // reservation brings stock back without the creator, and a reservation
  // already taken is paid at stock 0.
  ["on-sale flag on with stock 0", { action: "upsert", itemId: 8, isActive: true, stock: 0 }, "user_confirm", [/Start selling/, /whenever it has stock, buyers can purchase it from now on/]],
  ["on-sale flag on for an item that has no stock", { action: "upsert", itemId: 18, isActive: true }, "user_confirm", [/Start selling/]],
  ["reprice an item on sale with no stock", { action: "upsert", itemId: 17, price: 90 }, "user_confirm", [/Change the price/, /300 → 90 VX; whenever it has stock, buyers can purchase it from now on/]],
  ["reprice a scheduled item: the new price applies from its start date, not from now on", { action: "upsert", itemId: 15, price: 80 }, "user_confirm", [new RegExp(`300 → 80 VX; whenever it has stock, buyers can purchase it from "${FUTURE}"`)]],
  // The prompt names the item, its price and its purchase limits even when the edit leaves the limits as they are (#66).
  ["start selling a hidden item: name, price and its unchanged limits", { action: "upsert", itemId: 13, isActive: true }, "user_confirm", [/Start selling/, /Item: "?Item 13"?/, /Price: 300 VX;/, /; purchase limits \(maxPurchasePerUser: 2\)/]],
  ["start selling a hidden item that has no limits: says so", { action: "upsert", itemId: 8, isActive: true }, "user_confirm", [/Start selling/, /; no purchase limits/]],
  ["reprice an item on sale: its unchanged limits are shown", { action: "upsert", itemId: 12, price: 90 }, "user_confirm", [/Change the price/, /300 → 90 VX/, /; purchase limits \(maxPurchasePerUser: 2\)/]],
  ["restore an archived item on sale: name, price and its limits", { action: "archive", itemId: 9, archived: false }, "user_confirm", [/Restore this VX Shop item/, /Item: "?Item 9"?/, /Price: 300 VX;/, /; no purchase limits/]],
  // One limit changes, two stay: the changed one reads current → new, the kept ones their value (#66 review).
  ["start selling while changing one of three limits: the kept two are shown", { action: "upsert", itemId: 20, isActive: true, purchaseConstraints: { maxPurchasePerUser: 3, maxPurchasePerPeriod: 1, purchasePeriodDays: 7 } }, "user_confirm", [/Start selling/, MIXED_SHOWN]],
  ["reprice an item on sale while changing one of three limits: the kept two are shown", { action: "upsert", itemId: 21, price: 90, purchaseConstraints: { maxPurchasePerUser: 3, maxPurchasePerPeriod: 1, purchasePeriodDays: 7 } }, "user_confirm", [/Change the price/, /300 → 90 VX/, MIXED_SHOWN]],
  ["restore an archived item with three limits: all three are shown", { action: "archive", itemId: 22, archived: false }, "user_confirm", [/Restore this VX Shop item/, /purchase limits \(maxPurchasePerPeriod: 1, maxPurchasePerUser: 2, purchasePeriodDays: 7\)/]],
  // Not a sale start: the item does not come on sale.
  ["on-sale flag on an archived, hidden item", { action: "upsert", itemId: 10, isActive: true }, "preview"],
  ["stock 0 → 5 on a hidden item", { action: "upsert", itemId: 18, stock: 5 }, "preview"],
  ["stock 3 → 5 on an item on sale (not from 0)", { action: "upsert", itemId: 7, stock: 5 }, "preview"],
  ["rename an item that is scheduled", { action: "upsert", itemId: 15, name: "Renamed" }, "preview"],
  ["reprice an item whose sale ended", { action: "upsert", itemId: 16, price: 90 }, "preview"],
  ["raise a count limit on an item on sale", { action: "upsert", itemId: 14, purchaseConstraints: { ...RICH_LIMITS, maxPurchasePerUser: 99 } }, "preview"],
  ["remove the count limits of an item on sale", { action: "upsert", itemId: 12, clearPurchaseConstraints: true }, "preview"],
  ["create with the on-sale flag and no stock yet", { action: "upsert", productId: "gem", name: "Gems", price: 1, stock: 0, isActive: true }, "user_confirm", [/Create this VX Shop item and start selling it/, /stock 0/]],
  ["create with the on-sale flag but an end date that has passed", { action: "upsert", productId: "gem", name: "Gems", price: 1, stock: 5, isActive: true, purchaseConstraints: { purchaseEndDate: PAST } }, "preview"],
];
for (const [name, input, condition, shows = []] of OPENS_PURCHASES) {
  test(`opens purchases? ${name} → ${condition}`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const host = hostThat({ action: "decline" });
      const pre = await run(dir, input, host);
      assert.equal(pre.ok, true, JSON.stringify(pre));
      assert.equal(pre.runCondition, condition, pre.confirmation);
      for (const re of shows) assert.match(pre.confirmation, re);
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      if (condition === "preview") {
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(host.asked.length, 0);
        assert.equal(writes(calls).length, 1);
      } else {
        assert.equal(r.error, "user_cancelled");
        assert.deepEqual(writes(calls), []);
      }
    });
  });
}

test("restore: an archived item is asked about when its on-sale flag is set — with or without stock — and not when it is hidden", async () => {
  const dir = project();
  await withShop(async (_calls, items) => {
    assert.equal((await run(dir, { action: "archive", itemId: 9, archived: false })).runCondition, "user_confirm");
    items.find((i) => i.id === 9).stock = 0;
    const soldOut = await run(dir, { action: "archive", itemId: 9, archived: false });
    assert.equal(soldOut.runCondition, "user_confirm", "stock 0 comes back by itself (refund, expired reservation): restoring puts it on sale");
    assert.match(soldOut.confirmation, /whenever it has stock, buyers can purchase it from now on/);
    assert.doesNotMatch(soldOut.confirmation, /stock \d|stock: /, "the stock count is not in the prompt");
    assert.equal((await run(dir, { action: "archive", itemId: 10, archived: false })).runCondition, "preview", "hidden");
  });
});

// ── a value that changes while the prompt is open ──

/** A host whose user answers Run, but only after `meanwhile` happened (someone edited it on the web). */
function hostAfter(meanwhile) {
  return hostThat(() => {
    meanwhile();
    return RUN;
  });
}

/** [name, input, what changes while the prompt is open, the plan part named in the refusal (or null when the re-read itself fails)]. */
const MEANWHILE = [
  ["sale start: the price is raised on the web", { action: "upsert", itemId: 8, isActive: true }, ({ items }) => { items.find((i) => i.id === 8).price = 900; }, "state.price"],
  ["sale start: the purchase limits are changed on the web", { action: "upsert", itemId: 13, isActive: true }, ({ items }) => { items.find((i) => i.id === 13).metadata = JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 50 } }); }, "state.purchaseConstraints"],
  ["repricing: the item is renamed on the web", { action: "upsert", itemId: 7, price: 350 }, ({ items }) => { items.find((i) => i.id === 7).name = "Something else"; }, "state.name"],
  ["repricing: the price already became the new one (nothing left to change)", { action: "upsert", itemId: 7, price: 350 }, ({ items }) => { items.find((i) => i.id === 7).price = 350; }, null],
  ["restore: the price is changed on the web", { action: "archive", itemId: 9, archived: false }, ({ items }) => { items.find((i) => i.id === 9).price = 900; }, "state.price"],
  ["restore: it was restored on the web meanwhile", { action: "archive", itemId: 9, archived: false }, ({ items }) => { items.find((i) => i.id === 9).isArchived = false; }, null],
  ["create on sale: the local image is replaced", { action: "upsert", productId: "gem", name: "Gems", price: 120, stock: 5, isActive: true, imagePath: "item.png" }, ({ dir }) => { fs.writeFileSync(path.join(dir, "item.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])); }, "file.imagePath"],
  ["game visibility: the game is renamed on the web", { action: "update", visibility: "Public" }, ({ verse }) => { verse.title = "Another game"; }, "state.title"],
  ["game visibility: it was set to Unlisted on the web", { action: "update", visibility: "Public" }, ({ verse }) => { verse.visibility = "Unlisted"; }, "state.visibility"],
  ["game visibility: it is already Public (nothing left to change)", { action: "update", visibility: "Public" }, ({ verse }) => { verse.visibility = "Public"; }, null],
  ["comment deletion: the comment is edited", { action: "comment_delete", commentId: 1 }, ({ comments }) => { comments[0].content = "edited to something harmless"; }, "state.content"],
  ["comment deletion: the comment is already deleted", { action: "comment_delete", commentId: 1 }, ({ comments }) => { comments[0].isDeleted = true; }, null],
];
for (const [name, input, meanwhile, part] of MEANWHILE) {
  test(`changed while the prompt was open — ${name} → plan_mismatch after Run, no write`, async () => {
    const dir = project();
    await withShop(async (calls, items, verse, comments) => {
      const pre = await run(dir, input);
      assert.equal(pre.runCondition, "user_confirm", JSON.stringify(pre));
      const host = hostAfter(() => meanwhile({ items, verse, comments, dir }));
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(host.asked.length, 1, "the planId matched and the user was asked");
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
      assert.equal(r.afterConfirmation, true);
      assert.match(r.hint, /^Nothing was changed: it changed while the confirmation prompt was open/);
      assert.match(r.hint, /fresh preview/);
      if (part) assert.ok(r.changed.some((c) => c.part === part), JSON.stringify(r.changed));
      assert.deepEqual(writes(calls), [], "no write, no upload");
    });
  });
}

test("nothing changed while the prompt was open → Run runs once", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const input = { action: "upsert", itemId: 8, isActive: true };
    const pre = await run(dir, input);
    const done = await run(dir, { ...input, planId: pre.planId }, hostAfter(() => {}));
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(writes(calls).length, 1);
  });
});

test("the gate refuses a user_confirm plan that cannot be read again after the answer (planGate and confirmGate)", async () => {
  const plan = { op: "verse8_verse.comment_delete", target: { verseId: VERSE, commentId: 1 }, body: null, state: { content: "x", pinned: false, author: "a" } };
  const host = hostThat(RUN);
  const r = await planGate(plan, planId(plan), { action: "comment_delete" }, host);
  assert.equal(r.error, "op_not_classified", JSON.stringify(r));
  assert.equal(r.approved, undefined);
  const deploy = { op: "verse8_deploy.publish", target: { verseId: VERSE }, body: { visibility: "Public" }, state: { visibility: "Private", published: true, title: "T" } };
  const d = await confirmGate(deploy, host);
  assert.equal(d.error, "op_not_classified", JSON.stringify(d));
  assert.equal(d.confirmed, undefined);
  assert.equal(host.asked.length, 0, "the user is not asked for an answer that could not be used");
  // And with a re-read that now gives another plan, or says the target is gone:
  for (const reread of [
    async () => ({ ...deploy, state: { ...deploy.state, visibility: "Unlisted" } }),
    async () => ({ ok: false, error: "plan_mismatch", hint: "gone" }),
  ]) {
    const x = await confirmGate(deploy, hostThat(RUN), { ask: true, reread });
    assert.equal(x.error, "plan_mismatch", JSON.stringify(x));
    assert.equal(x.afterConfirmation, true);
    assert.equal(x.confirmed, undefined);
  }
});

test("a re-read that fails for its own reason keeps that reason: a rejected login or a server error is not reported as plan_mismatch", async () => {
  const deploy = { op: "verse8_deploy.publish", target: { verseId: VERSE }, body: { visibility: "Public" }, state: { visibility: "Private", published: true, title: "T" } };
  // As rereadWith hands them over: the second run's own failure, marked.
  const { rereadWith } = creatorOps;
  const cases = [
    [{ ok: false, error: "unauthorized", status: 401, hint: "GET /v1/verse/verseId: the Verse8 login was rejected." }, "unauthorized"],
    [{ ok: false, error: "upstream_error", status: 503, hint: "GET /v1/verse/verseId failed: HTTP 503" }, "upstream_error"],
    [{ ok: false, error: "upstream_unreachable", hint: "fetch failed" }, "upstream_unreachable"],
    [{ ok: false, error: "rate_limited", status: 429, hint: "slow down" }, "rate_limited"],
  ];
  for (const [failure, code] of cases) {
    const x = await confirmGate(deploy, hostThat(RUN), { ask: true, reread: rereadWith(async () => failure) });
    assert.equal(x.error, code, JSON.stringify(x));
    assert.equal(x.status, failure.status);
    assert.equal(x.afterConfirmation, true);
    assert.equal(x.confirmed, undefined);
    assert.match(x.hint, /^Nothing was changed: the target could not be read again before the write/);
    assert.doesNotMatch(x.hint, /fresh preview/, "not told to preview again for an error that is not a change");
    assert.equal(x.rereadFailed, undefined);
  }
  // A re-read that throws is an unreachable API, not a changed target.
  const thrown = await confirmGate(deploy, hostThat(RUN), { ask: true, reread: async () => { throw new Error("network"); } });
  assert.equal(thrown.error, "upstream_unreachable", JSON.stringify(thrown));
  // Failures that do mean the target changed stay plan_mismatch.
  for (const error of ["not_found", "invalid_input", "product_id_taken"]) {
    const x = await confirmGate(deploy, hostThat(RUN), { ask: true, reread: rereadWith(async () => ({ ok: false, error, hint: "h" })) });
    assert.equal(x.error, "plan_mismatch", error);
    assert.match(x.hint, /fresh preview/);
  }
});

test("through a tool: the login is rejected on the re-read after Run → unauthorized with where the token came from, no write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const input = { action: "upsert", itemId: 7, price: 350 };
    const pre = await run(dir, input);
    const inner = globalThis.fetch;
    let reject = false;
    globalThis.fetch = async (u, init = {}) => (reject ? new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }) : inner(u, init));
    try {
      const host = hostThat(() => { reject = true; return RUN; });
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(r.error, "unauthorized", JSON.stringify(r));
      assert.equal(r.status, 401);
      assert.match(r.hint, /VERSE8_ACCESS_TOKEN|token/i);
      assert.doesNotMatch(r.hint, /fresh preview/);
    } finally {
      globalThis.fetch = inner;
    }
    assert.deepEqual(writes(calls), []);
  });
});

test("the host cancels the call while the target is read again after Run → no write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const input = { action: "upsert", itemId: 7, price: 350 };
    const pre = await run(dir, input);
    // Not cancelled when the answer arrives; cancelled by the time the re-read is done.
    let checks = 0;
    const host = { ...hostThat(RUN), isCancelled: () => ++checks > 1 };
    const r = await run(dir, { ...input, planId: pre.planId }, host);
    assert.equal(r.error, "confirm_unavailable", JSON.stringify(r));
    assert.match(r.hint, /cancelled this tool call/);
    assert.equal(checks, 2, "checked after the answer and again after the re-read");
    assert.deepEqual(writes(calls), []);
  });
});

// ── the prompt keeps its target, core values and undo note whatever else is in it ──

test("a visibility change with many other changes: Undo stays, the rest is counted, not cut silently", () => {
  const body = { visibility: "Public" };
  const state = { visibility: "Private", title: "T".repeat(300) };
  for (let i = 0; i < 20; i++) {
    body[`field${String(i).padStart(2, "0")}`] = `new ${"n".repeat(200)}`;
    state[`field${String(i).padStart(2, "0")}`] = `old ${"o".repeat(200)}`;
  }
  const m = confirmMessage({ op: "verse8_verse.update", target: { verseId: VERSE }, body, state });
  assert.ok(m.length <= 1200, `${m.length}`);
  assert.match(m, /^Make this game visible to more people\? Game: "T+… \(verse /);
  assert.match(m, /Visibility: Private → Public \(listed on Verse8 for everyone\)/);
  assert.match(m, / \/ Undo: you can set it back to Private; people who opened or saw it meanwhile have seen it$/);
  const shownFields = m.match(/field\d\d: /g).length;
  assert.ok(shownFields >= 1 && shownFields < 20, `${shownFields}`);
  assert.ok(m.includes(`(${20 - shownFields} more changes not shown here — see the preview)`), m.slice(-260));
});

test("when everything fits nothing is marked as left out; when even the core is too long the cut is said and Undo stays", () => {
  const few = confirmMessage({ op: "verse8_verse.update", target: { verseId: VERSE }, body: { visibility: "Public", title: "New" }, state: { visibility: "Private", title: "Old" } });
  assert.doesNotMatch(few, /not shown here|cut —/);
  assert.match(few, /; also changes title: "Old" → "New" \/ Undo: /);
  const huge = confirmMessage({
    op: "verse8_vxshop.upsert.create",
    target: { verseId: VERSE, productId: "gem" },
    body: { verseId: VERSE, productId: "gem", name: "Gems", price: 5, stock: 1, isActive: true, description: "d", purchaseConstraints: { purchaseStartDate: "9".repeat(4000) } },
  });
  assert.ok(huge.length <= 1200, `${huge.length}`);
  assert.match(huge, /\(cut — see the preview\) \/ Undo: you can stop the sale/);
  assert.match(huge, /1 more change not shown here/);
  assert.match(huge, /^Create this VX Shop item and start selling it\? Item: "Gems"/);
});

// ── no control or format characters reach the prompt ──

test("bidi overrides, zero-width and other control / format characters in a title, item name or comment are dropped", () => {
  const bad = [0x202e, 0x202d, 0x2066, 0x2069, 0x200b, 0x200d, 0xfeff, 0x00ad, 0x061c, 0x007f, 0x009b, 0x0000, 0x001b].map((c) => String.fromCodePoint(c));
  const dirty = (s) => bad.join("") + s.split("").join(bad[4]) + bad[0];
  const plans = [
    { op: "verse8_verse.update", target: { verseId: VERSE }, body: { visibility: "Public", description: dirty("desc") }, state: { visibility: "Private", title: dirty("Title"), description: dirty("old") } },
    { op: "verse8_vxshop.upsert.create", target: { verseId: VERSE, productId: "gem" }, body: { productId: "gem", name: dirty("Gems"), price: 5, stock: 1, isActive: true, description: dirty("d") } },
    { op: "verse8_vxshop.upsert.edit", target: { verseId: VERSE, itemId: 7 }, body: { isActive: true, name: dirty("New") }, state: { name: dirty("Old"), price: 5, stock: 1, isActive: false, isArchived: false, purchaseConstraints: { purchaseStartDate: dirty("2999-01-01") } } },
    { op: "verse8_vxshop.archive", target: { verseId: VERSE, itemId: 7 }, body: { isArchived: false }, state: { name: dirty("Old"), price: 5, stock: 1, isActive: true, isArchived: true } },
    { op: "verse8_verse.comment_delete", target: { verseId: VERSE, commentId: 1 }, body: null, state: { content: dirty("spam"), author: dirty("ana"), pinned: false } },
    { op: "verse8_deploy.publish", target: { verseId: VERSE }, body: { visibility: "Public" }, state: { visibility: null, published: false, title: dirty("Title") } },
  ];
  for (const p of plans) {
    const m = confirmMessage(p);
    assert.ok(m, p.op);
    assert.doesNotMatch(m, /[\p{Cc}\p{Cf}]/u, `${p.op}: ${JSON.stringify(m)}`);
  }
  assert.match(confirmMessage(plans[0]), /Game: "Title" /);
  assert.match(confirmMessage(plans[4]), /by "ana" .* Deletes: "spam"/);
});

// ── answers and capabilities as a real MCP host sends them ──

test("MCP host answers accept with a choice outside the form, or with no choice → user_cancelled (not 'the prompt could not be shown'), no write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    let answer;
    const host = await connect({ elicitation: { form: {} } }, () => answer);
    try {
      const args = { projectDir: dir, action: "upsert", itemId: 7, price: 350 };
      const pre = await host.callShop(args);
      for (answer of [{ action: "accept", content: { choice: "Other" } }, { action: "accept", content: {} }, { action: "accept", content: { choice: "run" } }]) {
        const r = await host.callShop({ ...args, planId: pre.planId });
        assert.equal(r.error, "user_cancelled", JSON.stringify(r));
        assert.equal(r.answer, "accept_without_run");
      }
      assert.equal(host.seen.length, 3);
      assert.deepEqual(writes(calls), []);
    } finally {
      await host.close();
    }
  });
});

test("MCP host that declares only url elicitation cannot show the form: not asked, confirm_unavailable says so; an empty declaration counts as form", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const args = { projectDir: dir, action: "upsert", itemId: 7, price: 350 };
    const urlOnly = await connect({ elicitation: { url: {} } });
    try {
      const pre = await urlOnly.callShop(args);
      const r = await urlOnly.callShop({ ...args, planId: pre.planId });
      assert.equal(r.error, "confirm_unavailable", JSON.stringify(r));
      assert.match(r.hint, /does not offer one/);
      assert.deepEqual(writes(calls), []);
    } finally {
      await urlOnly.close();
    }
    const legacy = await connect({ elicitation: {} }, () => ({ action: "cancel" }));
    try {
      const pre = await legacy.callShop(args);
      assert.equal((await legacy.callShop({ ...args, planId: pre.planId })).error, "user_cancelled");
      assert.equal(legacy.seen.length, 1, "asked");
    } finally {
      await legacy.close();
    }
  });
});

test("MCP: verse8_verse is wired to the host too — widening visibility and deleting a comment open the prompt; cancel → no write, Run → one write", async () => {
  const dir = project();
  await withShop(async (calls) => {
    let answer = { action: "cancel" };
    const host = await connect({ elicitation: { form: {} } }, () => answer);
    const callVerse = async (args) => JSON.parse((await host.client.callTool({ name: "verse8_verse", arguments: { projectDir: dir, ...args } })).content[0].text);
    try {
      for (const args of [{ action: "update", visibility: "Public" }, { action: "comment_delete", commentId: 1 }]) {
        const before = host.seen.length;
        const pre = await callVerse(args);
        assert.equal(pre.runCondition, "user_confirm", JSON.stringify(pre));
        answer = { action: "cancel" };
        const cancelled = await callVerse({ ...args, planId: pre.planId });
        assert.equal(cancelled.error, "user_cancelled", JSON.stringify(cancelled));
        assert.equal(host.seen.length, before + 1, "the host was asked");
        assert.equal(host.seen.at(-1).message, pre.confirmation);
        const w = writes(calls).length;
        answer = RUN;
        const done = await callVerse({ ...args, planId: pre.planId });
        assert.equal(done.ok, true, JSON.stringify(done));
        assert.equal(writes(calls).length, w + 1);
      }
    } finally {
      await host.close();
    }
  });
});

test("two long values that differ only past the cut are not shown as the same text on both sides", () => {
  const a = `${"x".repeat(200)}A`;
  const b = `${"x".repeat(200)}B`;
  const edit = confirmMessage({
    op: "verse8_vxshop.upsert.edit",
    target: { verseId: VERSE, itemId: 7 },
    body: { isActive: true, description: b },
    state: { name: "Item", price: 5, stock: 1, isActive: false, isArchived: false, purchaseConstraints: null, description: a },
  });
  assert.match(edit, /description: "x+… → "x+… \(they differ past the part shown — see the preview\)/);
  const game = confirmMessage({ op: "verse8_verse.update", target: { verseId: VERSE }, body: { visibility: "Public", description: b }, state: { visibility: "Private", title: "T", description: a } });
  assert.match(game, /description: "x+… → "x+… \(they differ past the part shown — see the preview\)/);
  const short = confirmMessage({ op: "verse8_verse.update", target: { verseId: VERSE }, body: { visibility: "Public", description: "new" }, state: { visibility: "Private", title: "T", description: "old" } });
  assert.doesNotMatch(short, /differ past/);
});

// ── values read before a media upload are not written after it ──

/** Runs `f` with a fetch that calls `during` when the media upload request arrives. */
async function withUploadHook(during, f) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => {
    if (new URL(u).pathname === "/api/upload") during();
    return inner(u, init);
  };
  try {
    return await f();
  } finally {
    globalThis.fetch = inner;
  }
}

test("game page update with a cover upload: the game is set to Private on the web while the upload runs → the update is not sent (it would put the old visibility back)", async () => {
  const dir = project();
  await withShop(async (calls, _items, verse) => {
    verse.visibility = "Public";
    const input = { action: "update", title: "New title", thumbnailPath: "item.png" };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "preview");
    assert.equal(pre.publishBody.visibility, "Public", "the body re-sends the visibility read for the preview");
    const r = await withUploadHook(() => { verse.visibility = "Private"; }, () => run(dir, { ...input, planId: pre.planId }));
    assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
    assert.equal(r.afterUpload, true);
    assert.match(r.hint, /^The record was not changed \(the media file is already uploaded and unused\): it changed while the upload ran/);
    assert.ok(r.changed.some((c) => c.part === "state.visibility" && c.now === "Private"), JSON.stringify(r.changed));
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload"], "the upload ran, the update did not");
  });
});

test("shop item edit with an image upload: the purchase limits are changed on the web while the upload runs → the edit is not sent (it would put the old limits back)", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    const input = { action: "upsert", itemId: 12, name: "Renamed", imagePath: "item.png" };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "preview");
    assert.deepEqual(pre.body.purchaseConstraints, { maxPurchasePerUser: 2 });
    const r = await withUploadHook(
      () => { items.find((i) => i.id === 12).metadata = JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 1 } }); },
      () => run(dir, { ...input, planId: pre.planId }),
    );
    assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
    assert.equal(r.afterUpload, true);
    assert.ok(r.changed.some((c) => c.part === "state.purchaseConstraints"), JSON.stringify(r.changed));
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload"]);
  });
});

test("an upload during which nothing changed on the server → the write goes out (a local file edited after the gate does not stop it: its hashed bytes were uploaded)", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const input = { action: "upsert", itemId: 12, name: "Renamed", imagePath: "item.png" };
    const pre = await run(dir, input);
    const r = await withUploadHook(
      () => { fs.writeFileSync(path.join(dir, "item.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 5, 5, 5])); },
      () => run(dir, { ...input, planId: pre.planId }),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload", "/v1/vx-shop-items/12"]);
  });
});

// ═══ values the server changes are not held against the request (second review, fe70de3) ═══

// The stock moves with every purchase, reservation and refund. A request
// that does not change the stock must not fail because someone bought one.

/** [name, input, whether the user is asked]. Item 7 is on sale with stock 100. */
const WHILE_SELLING = [
  ["stop selling", { action: "upsert", itemId: 7, isActive: false }, false],
  ["edit the description", { action: "upsert", itemId: 7, description: "new text" }, false],
  ["archive", { action: "archive", itemId: 7 }, false],
  ["change the price", { action: "upsert", itemId: 7, price: 350 }, true],
  ["restore an archived item", { action: "archive", itemId: 9, archived: false }, true],
];
for (const [name, input, asks] of WHILE_SELLING) {
  test(`a unit is sold after the preview (stock 100 → 99): ${name} still runs`, async () => {
    const dir = project();
    await withShop(async (calls, items) => {
      const host = hostThat(RUN);
      const pre = await run(dir, input, host);
      assert.equal(pre.runCondition, asks ? "user_confirm" : "preview", JSON.stringify(pre));
      items.find((i) => i.id === input.itemId).stock = 99;
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(host.asked.length, asks ? 1 : 0);
      assert.equal(writes(calls).length, 1);
    });
  });
}
for (const [name, input] of WHILE_SELLING.filter((c) => c[2])) {
  test(`a unit is sold while the prompt is open (stock 100 → 99): ${name} still runs on Run`, async () => {
    const dir = project();
    await withShop(async (calls, items) => {
      const pre = await run(dir, input);
      const host = hostAfter(() => { items.find((i) => i.id === input.itemId).stock = 99; });
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(host.asked.length, 1);
      assert.equal(writes(calls).length, 1);
    });
  });
}

test("a unit is sold while an image uploads (stock 100 → 99): the edit is still sent, and its body carries the uploaded image URL", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    const input = { action: "upsert", itemId: 12, name: "Renamed", imagePath: "item.png" };
    const pre = await run(dir, input);
    let put = null;
    const inner = globalThis.fetch;
    globalThis.fetch = async (u, init = {}) => {
      if (new URL(u).pathname === "/v1/vx-shop-items/12" && init.method === "PUT") put = JSON.parse(init.body);
      return inner(u, init);
    };
    try {
      const r = await withUploadHook(() => { items.find((i) => i.id === 12).stock = 99; }, () => run(dir, { ...input, planId: pre.planId }));
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      globalThis.fetch = inner;
    }
    assert.deepEqual(put, { name: "Renamed", imageUrl: "https://contents.verse8.io/vx-shop/x/i.png", purchaseConstraints: { maxPurchasePerUser: 2 } });
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload", "/v1/vx-shop-items/12"]);
  });
});

test("the stock is held only when the request changes it: a refill planned at stock 0 is refused once the stock is no longer 0", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    const input = { action: "upsert", itemId: 17, stock: 5 };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "user_confirm");
    assert.match(pre.confirmation, /stock: 0 → 5/);
    items.find((i) => i.id === 17).stock = 2;
    const r = await run(dir, { ...input, planId: pre.planId }, hostThat(RUN));
    assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
    assert.ok(r.changed.some((c) => c.part === "state.stock" && c.now === 2));
    assert.deepEqual(writes(calls), []);
  });
});

test("no plan of an edit or an archive holds the stock unless the request changes it (a planId does not move when a unit is sold)", async () => {
  const dir = project();
  await withShop(async (_calls, items) => {
    for (const input of [
      { action: "upsert", itemId: 7, price: 350 },
      { action: "upsert", itemId: 7, isActive: false },
      { action: "upsert", itemId: 8, isActive: true },
      { action: "archive", itemId: 7 },
      { action: "archive", itemId: 9, archived: false },
    ]) {
      const item = items.find((i) => i.id === input.itemId);
      const before = (await run(dir, input)).planId;
      item.stock -= 1;
      item.soldCount += 1;
      assert.equal((await run(dir, input)).planId, before, JSON.stringify(input));
    }
  });
});

// ── a rule that reads the clock is decided again at every step ──

test("purchase dates without an offset are read as UTC, as the server reads them (not in this machine's time zone)", () => {
  const { dateOf, vxSaleLevel } = creatorOps;
  assert.equal(dateOf("2026-12-01T20:00:00"), Date.parse("2026-12-01T20:00:00Z"));
  assert.equal(dateOf("2026-12-01 20:00"), Date.parse("2026-12-01T20:00:00Z"));
  assert.equal(dateOf("2026-12-01T20:00:00.250"), Date.parse("2026-12-01T20:00:00.250Z"));
  assert.equal(dateOf("2026-12-01"), Date.parse("2026-12-01T00:00:00Z"));
  // An explicit offset is kept.
  assert.equal(dateOf("2026-12-01T20:00:00+09:00"), Date.parse("2026-12-01T11:00:00Z"));
  assert.equal(dateOf("2026-12-01T20:00:00Z"), Date.parse("2026-12-01T20:00:00Z"));
  assert.equal(dateOf("not a date"), null);
  assert.equal(dateOf(undefined), null);
  // One minute before / after a start written without an offset, by the server's clock.
  const v = { isActive: true, isArchived: false, limits: { purchaseStartDate: "2026-12-01T20:00:00" } };
  assert.equal(vxSaleLevel(v, Date.parse("2026-12-01T19:59:00Z")), 1);
  assert.equal(vxSaleLevel(v, Date.parse("2026-12-01T20:01:00Z")), 2);
});

/**
 * The distance of every "soon" date in these tests, and a third of every
 * jump: wide enough that a slow machine cannot cross a date by itself
 * between two lines of a test.
 */
const HOUR = 3_600_000;
/** Makes Date.now() jump forward by `ms` on jump(ms), until restore(). */
function clockJump() {
  const real = Date.now;
  let shift = 0;
  Date.now = () => real() + shift;
  return { jump: (ms) => { shift += ms; }, restore: () => { Date.now = real; } };
}

test("an end date passes while the image uploads: extending it now re-opens an ended sale → stopped, the user was not asked", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    // On sale now, ending in an hour.
    const soon = new Date(Date.now() + HOUR).toISOString();
    items.find((i) => i.id === 12).metadata = JSON.stringify({ purchaseConstraints: { purchaseEndDate: soon } });
    const input = { action: "upsert", itemId: 12, purchaseConstraints: { purchaseEndDate: FUTURE }, imagePath: "item.png" };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "preview", "extending the end of a sale that is still running is not a start");
    const clock = clockJump();
    try {
      const r = await withUploadHook(() => clock.jump(3 * HOUR), () => run(dir, { ...input, planId: pre.planId }));
      assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
      assert.equal(r.afterUpload, true);
      assert.equal(r.runCondition, "user_confirm");
      assert.match(r.hint, /a sale date passed, so this change now needs the user's own confirmation, and this run was started without one/);
      assert.match(r.hint, /It would now ask: Start selling this VX Shop item\?/);
    } finally {
      clock.restore();
    }
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload"], "the edit was not sent");
  });
});

test("an end date passes while the prompt is open: the user was asked and saw these values, and nothing can ask more than that → Run runs", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    const soon = new Date(Date.now() + HOUR).toISOString();
    items.find((i) => i.id === 12).metadata = JSON.stringify({ purchaseConstraints: { purchaseEndDate: soon } });
    // A repricing of an item on sale: asked as "change the price of an item on sale".
    const input = { action: "upsert", itemId: 12, price: 350, purchaseConstraints: { purchaseEndDate: FUTURE } };
    const pre = await run(dir, input);
    assert.match(pre.confirmation, /^Change the price of a VX Shop item that is on sale\?/);
    const clock = clockJump();
    try {
      const host = hostAfter(() => clock.jump(3 * HOUR));
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(host.asked.length, 1);
      // The prompt they answered showed the price and the new end date in full.
      assert.ok(host.asked[0].message.includes("Price: 300 → 350 VX") && host.asked[0].message.includes(`→ "${FUTURE}"`), host.asked[0].message);
    } finally {
      clock.restore();
    }
    assert.equal(writes(calls).length, 1);
  });
});

// ── after the upload the local file is not looked at again ──

test("the local image is moved away while it uploads: its checked bytes are already sent, the edit goes out", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const input = { action: "upsert", itemId: 12, name: "Renamed", imagePath: "item.png" };
    const pre = await run(dir, input);
    const r = await withUploadHook(() => fs.rmSync(path.join(dir, "item.png")), () => run(dir, { ...input, planId: pre.planId }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload", "/v1/vx-shop-items/12"]);
  });
});

test("the local cover is moved away while it uploads: the game page update goes out", async () => {
  const dir = project();
  await withShop(async (calls, _items, verse) => {
    verse.visibility = "Public";
    const input = { action: "update", title: "New title", thumbnailPath: "item.png" };
    const pre = await run(dir, input);
    const r = await withUploadHook(() => fs.rmSync(path.join(dir, "item.png")), () => run(dir, { ...input, planId: pre.planId }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(writes(calls).length, 2);
  });
});

// ── the web hint for an archived item ──

test("the web hint for an archived item names Restore and what it does to the limits; for other items the edit dialog", async () => {
  const dir = project();
  await withShop(async () => {
    const mute = hostThat(RUN, { canAsk: false });
    const restore = { action: "archive", itemId: 9, archived: false };
    const r = await run(dir, { ...restore, planId: (await run(dir, restore)).planId }, mute);
    assert.match(r.hint, ARCHIVED_PORTAL);
    assert.doesNotMatch(r.hint, /use the item's edit dialog —/);
    const edit = { action: "upsert", itemId: 8, isActive: true };
    const e = await run(dir, { ...edit, planId: (await run(dir, edit)).planId }, mute);
    assert.match(e.hint, SHOP_PORTAL);
  });
});

// ═══ third review (ebf0897): the sale test as the server decides it, and the clock ═══

// ── a start date after the end date is a window that never opens ──

test("vxSaleLevel: a start after the end is not on sale and not scheduled — the server refuses every purchase of it", () => {
  const { vxSaleLevel } = creatorOps;
  const now = Date.parse("2026-11-26T00:00:00Z");
  const v = (limits) => ({ isActive: true, isArchived: false, limits });
  assert.equal(vxSaleLevel(v({ purchaseStartDate: "2027-12-01", purchaseEndDate: "2027-06-01" }), now), 0, "both ahead, reversed");
  assert.equal(vxSaleLevel(v({ purchaseStartDate: "2026-12-01", purchaseEndDate: "2026-11-27" }), now), 0, "ends before it starts");
  assert.equal(vxSaleLevel(v({ purchaseStartDate: "2026-11-27", purchaseEndDate: "2026-12-01" }), now), 1, "in order: scheduled");
  assert.equal(vxSaleLevel(v({ purchaseStartDate: "2026-11-01", purchaseEndDate: "2026-12-01" }), now), 2);
  assert.equal(vxSaleLevel(v({ purchaseStartDate: "2026-12-01", purchaseEndDate: "2026-12-01" }), now), 1, "the same instant is a window (the server allows start ≤ now ≤ end)");
});

test("an item whose start is after its end: moving the start before the end schedules a sale → asked; repricing it is a preview", async () => {
  const dir = project();
  await withShop(async (calls) => {
    const fix = { action: "upsert", itemId: 19, purchaseConstraints: { purchaseStartDate: "2999-01-01T00:00:00.000Z", purchaseEndDate: "2999-06-01T00:00:00.000Z" } };
    const host = hostThat({ action: "decline" });
    const pre = await run(dir, fix, host);
    assert.equal(pre.runCondition, "user_confirm", JSON.stringify(pre));
    assert.match(pre.confirmation, /^Start selling this VX Shop item\?/);
    assert.match(pre.confirmation, /from "2999-01-01T00:00:00.000Z" until "2999-06-01T00:00:00.000Z"/);
    assert.equal((await run(dir, { ...fix, planId: pre.planId }, host)).error, "user_cancelled");
    assert.deepEqual(writes(calls), []);
    // As it is, it cannot be bought: a new price reaches no buyer.
    const reprice = await run(dir, { action: "upsert", itemId: 19, price: 90 });
    assert.equal(reprice.runCondition, "preview");
    // Turning the flag on for a hidden item with such dates opens nothing either.
    const reversed = { purchaseStartDate: "2999-12-01T00:00:00.000Z", purchaseEndDate: "2999-06-01T00:00:00.000Z" };
    assert.equal((await run(dir, { action: "upsert", itemId: 8, isActive: true, purchaseConstraints: reversed })).runCondition, "preview");
    assert.equal((await run(dir, { action: "upsert", productId: "gem", name: "Gems", price: 1, stock: 5, isActive: true, purchaseConstraints: reversed })).runCondition, "preview");
  });
});

// ── dates without a time zone, on a machine that is not in UTC ──

test("purchase dates without a time zone are UTC on a machine in Asia/Seoul too (a tab between date and time included)", async () => {
  const { spawnSync } = await import("node:child_process");
  const mod = url.pathToFileURL(path.resolve(SRC_TOOLS, "..", "..", "dist", "tools", "creatorOps.js")).href;
  const script = `
    const { dateOf, vxSaleLevel } = await import(${JSON.stringify(mod)});
    const naive = new Date("2026-12-01T20:00:00").getTime();
    const utc = Date.parse("2026-12-01T20:00:00Z");
    console.log(JSON.stringify({
      offsetHours: (utc - naive) / 3600000,
      t: dateOf("2026-12-01T20:00:00") === utc,
      space: dateOf("2026-12-01 20:00:00") === utc,
      tab: dateOf("2026-12-01\\t20:00") === utc,
      zoned: dateOf("2026-12-01T20:00:00+09:00") === Date.parse("2026-12-01T11:00:00Z"),
      // 19:59 UTC is 04:59 the next morning in Seoul: read in local time the sale would look open already.
      before: vxSaleLevel({ isActive: true, isArchived: false, limits: { purchaseStartDate: "2026-12-01T20:00:00" } }, Date.parse("2026-12-01T19:59:00Z")),
      after: vxSaleLevel({ isActive: true, isArchived: false, limits: { purchaseStartDate: "2026-12-01T20:00:00" } }, Date.parse("2026-12-01T20:01:00Z")),
    }));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: "Asia/Seoul" }, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.equal(r.offsetHours, 9, "the child really runs in Asia/Seoul — otherwise this test proves nothing");
  assert.deepEqual({ t: r.t, space: r.space, tab: r.tab, zoned: r.zoned, before: r.before, after: r.after }, { t: true, space: true, tab: true, zoned: true, before: 1, after: 2 });
});

// ── a start date that passes is not a change; an end date that passes is ──

/** Sets item `id` on sale from an hour from now (scheduled), optionally until `end`. */
const startsSoon = (items, id, extra = {}) => {
  const soon = new Date(Date.now() + HOUR).toISOString();
  items.find((i) => i.id === id).metadata = JSON.stringify({ purchaseConstraints: { purchaseStartDate: soon, ...extra } });
  return soon;
};

test("the start date passes while the prompt is open: the prompt would now say 'from now on', which is what the user agreed to → Run runs", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    const soon = startsSoon(items, 12);
    const input = { action: "upsert", itemId: 12, price: 350 };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "user_confirm");
    assert.match(pre.confirmation, /^Change the price of a VX Shop item that is scheduled for sale\?/);
    assert.ok(pre.confirmation.includes(`buyers can purchase it from "${soon}"`), pre.confirmation);
    const clock = clockJump();
    try {
      const host = hostAfter(() => clock.jump(3 * HOUR));
      const r = await run(dir, { ...input, planId: pre.planId }, host);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(host.asked.length, 1);
      // Asked again now, the same plan reads "on sale … from now on": only the clock moved.
      const now = await run(dir, input);
      assert.equal(now.planId, pre.planId);
      assert.match(now.confirmation, /^Change the price of a VX Shop item that is on sale\?.*from now on/);
    } finally {
      clock.restore();
    }
    assert.equal(writes(calls).length, 1);
  });
});

test("the start date passes while an image uploads: a confirmed sale start is still sent, the uploaded file is not left unused", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    startsSoon(items, 13);
    items.find((i) => i.id === 13).isActive = false;
    const input = { action: "upsert", itemId: 13, isActive: true, imagePath: "item.png" };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "user_confirm");
    const clock = clockJump();
    try {
      const r = await withUploadHook(() => clock.jump(3 * HOUR), () => run(dir, { ...input, planId: pre.planId }, hostThat(RUN)));
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      clock.restore();
    }
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload", "/v1/vx-shop-items/13"]);
  });
});

test("a run the user confirmed is not stopped by a date that passes, during the prompt or during the upload (an end date here)", async () => {
  const dir = project();
  for (const during of ["prompt", "upload"]) {
    await withShop(async (calls, items) => {
      const soon = new Date(Date.now() + HOUR).toISOString();
      items.find((i) => i.id === 12).metadata = JSON.stringify({ purchaseConstraints: { purchaseEndDate: soon } });
      // Asked (a repricing that also extends the end); once the old end has passed the same write re-opens the sale.
      const input = { action: "upsert", itemId: 12, price: 350, purchaseConstraints: { purchaseEndDate: FUTURE }, imagePath: "item.png" };
      const pre = await run(dir, input);
      assert.equal(pre.runCondition, "user_confirm");
      const clock = clockJump();
      try {
        const host = during === "prompt" ? hostAfter(() => clock.jump(3 * HOUR)) : hostThat(RUN);
        const r = await withUploadHook(() => { if (during === "upload") clock.jump(3 * HOUR); }, () => run(dir, { ...input, planId: pre.planId }, host));
        assert.equal(r.ok, true, `${during}: ${JSON.stringify(r)}`);
      } finally {
        clock.restore();
      }
      assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload", "/v1/vx-shop-items/12"], during);
    });
  }
});

// ═══ fourth review (42f2c47): one rule for the time that passes; one reader for dates ═══

// ── the run is held to the confirmation it actually got ──

test("not asked, and it comes to need asking: a scheduled start moved to an earlier day arrives while the image uploads → stopped", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    // Scheduled for the far future; the edit moves the start to an hour from now.
    items.find((i) => i.id === 12).metadata = JSON.stringify({ purchaseConstraints: { purchaseStartDate: FUTURE } });
    const sooner = new Date(Date.now() + HOUR).toISOString();
    const input = { action: "upsert", itemId: 12, purchaseConstraints: { purchaseStartDate: sooner }, imagePath: "item.png" };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "preview", "scheduled before and after: nobody is asked");
    const clock = clockJump();
    try {
      const r = await withUploadHook(() => clock.jump(3 * HOUR), () => run(dir, { ...input, planId: pre.planId }));
      // Written now, it would put the item on sale at once.
      assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
      assert.equal(r.afterUpload, true);
      assert.equal(r.runCondition, "user_confirm");
      assert.match(r.hint, /this run was started without one/);
      assert.match(r.hint, /It would now ask: Start selling this VX Shop item\?.*from now on/);
    } finally {
      clock.restore();
    }
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload"], "the edit was not sent");
  });
});

for (const [name, newStart] of [["removes the start date", undefined], ["moves the start date into the past", "2020-01-01T00:00:00.000Z"]]) {
  test(`asked, and the old end date passes while the prompt is open: an edit that ${name} and extends the end → it was confirmed, so it runs`, async () => {
    const dir = project();
    await withShop(async (calls, items) => {
      // Scheduled: opens in half an hour, closes in an hour.
      const at = (ms) => new Date(Date.now() + ms).toISOString();
      items.find((i) => i.id === 12).metadata = JSON.stringify({ purchaseConstraints: { purchaseStartDate: at(HOUR / 2), purchaseEndDate: at(HOUR) } });
      const input = { action: "upsert", itemId: 12, purchaseConstraints: { ...(newStart ? { purchaseStartDate: newStart } : {}), purchaseEndDate: FUTURE } };
      const pre = await run(dir, input);
      assert.equal(pre.runCondition, "user_confirm");
      assert.match(pre.confirmation, /^Start selling this VX Shop item\?/);
      const clock = clockJump();
      try {
        const host = hostAfter(() => clock.jump(3 * HOUR));
        const r = await run(dir, { ...input, planId: pre.planId }, host);
        assert.equal(r.ok, true, JSON.stringify(r));
        // The prompt they answered is the one a preview would still give now.
        assert.equal((await run(dir, input)).confirmation, host.asked[0].message);
      } finally {
        clock.restore();
      }
      assert.equal(writes(calls).length, 1);
    });
  });
}

test("not asked, and it still would not ask: a start date arriving during the upload of a description edit does not stop it", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    startsSoon(items, 12);
    const input = { action: "upsert", itemId: 12, description: "new text", imagePath: "item.png" };
    const pre = await run(dir, input);
    assert.equal(pre.runCondition, "preview");
    const clock = clockJump();
    try {
      const r = await withUploadHook(() => clock.jump(3 * HOUR), () => run(dir, { ...input, planId: pre.planId }));
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      clock.restore();
    }
    assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload", "/v1/vx-shop-items/12"]);
  });
});

// ── purchase dates are read in one form only ──

test("readPurchaseDate: only YYYY-MM-DD[THH:MM[:SS[.sss]]][Z|±HH:MM]; everything else is not read at all", () => {
  const { readPurchaseDate, dateOf } = creatorOps;
  const ok = {
    "2026-12-01": ["2026-12-01T00:00:00Z", true],
    "2026-12-01T20:00": ["2026-12-01T20:00:00Z", true],
    "2026-12-01 20:00:05": ["2026-12-01T20:00:05Z", true],
    "2026-12-01T20:00:05.5": ["2026-12-01T20:00:05.500Z", true],
    "2026-12-01T20:00:05.250Z": ["2026-12-01T20:00:05.250Z", false],
    "2026-12-01 20:00+09:00": ["2026-12-01T11:00:00Z", false],
    "2026-12-01T20:00:00-05:30": ["2026-12-02T01:30:00Z", false],
    "2028-02-29": ["2028-02-29T00:00:00Z", true],
  };
  for (const [text, [iso, zoneless]] of Object.entries(ok)) {
    assert.deepEqual(readPurchaseDate(text), { ms: Date.parse(iso), zoneless }, text);
  }
  const refused = [
    "2026-12 20:00", // the server takes it; JavaScript reads it in local time
    "+2026-12-01 20:00", // a signed year: the same
    "+002026-12-01T20:00:00Z",
    "2026-12",
    "2026",
    "12/01/2026",
    "Dec 1, 2026 20:00",
    "2026-12-01T20",
    "2026-12-01T20:00:00+0900",
    "2026-12-01T20:00:00z",
    "2026-12-01Z", // a time zone only after a time
    "2026-12-01+09:00",
    " 2026-12-01",
    "2026-12-01 ",
    "2026-13-01",
    "2026-02-30",
    "2026-02-29", // not a leap year
    "2026-12-01T24:00",
    "2026-12-01T20:60",
    "2026-12-01T20:00:00+24:00",
    "2026-12-01T20:00:00.2505",
    "20261201",
    "1796083200000",
    "",
  ];
  for (const text of refused) {
    assert.equal(readPurchaseDate(text), null, JSON.stringify(text));
    assert.equal(dateOf(text), null, JSON.stringify(text));
  }
  for (const v of [1796083200000, null, undefined, {}, true]) assert.equal(readPurchaseDate(v), null);
});

test("verse8_vxshop: a purchase date in another form is refused as invalid_input, on create and on edit, before anything is read or written", async () => {
  const dir = project();
  await withShop(async (calls) => {
    for (const bad of ["2026-12 20:00", "+2026-12-01 20:00", "2026-02-30"]) {
      for (const key of ["purchaseStartDate", "purchaseEndDate"]) {
        const create = await run(dir, { action: "upsert", productId: "gem", name: "Gems", price: 1, stock: 5, isActive: true, purchaseConstraints: { [key]: bad } });
        assert.equal(create.error, "invalid_input", `${key} ${bad}: ${JSON.stringify(create)}`);
        assert.match(create.hint, new RegExp(`purchaseConstraints\\.${key} must be a calendar date written as YYYY-MM-DD`));
        assert.match(create.hint, /without Z or an offset it is UTC/);
        const edit = await run(dir, { action: "upsert", itemId: 12, purchaseConstraints: { [key]: bad } });
        assert.equal(edit.error, "invalid_input", `${key} ${bad}`);
      }
    }
    assert.deepEqual(calls, [], "no request at all");
    // The accepted form still goes through, sent as it was given.
    const fine = await run(dir, { action: "upsert", itemId: 12, purchaseConstraints: { purchaseEndDate: "2999-12-01 20:00" } });
    assert.equal(fine.ok, true, JSON.stringify(fine));
  });
});

test("the review's case: on a machine in Asia/Seoul an end date '2026-12 20:00' is not read at all (it used to be read 9 hours early and make a sale start a preview)", async () => {
  const { spawnSync } = await import("node:child_process");
  const mod = url.pathToFileURL(path.resolve(SRC_TOOLS, "..", "..", "dist", "tools", "creatorOps.js")).href;
  const script = `
    const { dateOf, vxSaleLevel, purchaseDateProblem } = await import(${JSON.stringify(mod)});
    const limits = { purchaseStartDate: "2026-12-01T15:00:00Z", purchaseEndDate: "2026-12 20:00" };
    console.log(JSON.stringify({
      offsetHours: (Date.parse("2026-12-01T20:00:00Z") - new Date("2026-12-01T20:00:00").getTime()) / 3600000,
      // What JavaScript makes of it here: 11:00 UTC, before the 15:00 UTC start. The server (UTC) reads 20:00.
      jsReadsBeforeStart: new Date("2026-12 20:00").getTime() < Date.parse(limits.purchaseStartDate),
      end: dateOf(limits.purchaseEndDate),
      signed: dateOf("+2026-12-01 20:00"),
      problem: purchaseDateProblem(limits),
    }));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: "Asia/Seoul" }, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.equal(r.offsetHours, 9, "the child really runs in Asia/Seoul");
  assert.equal(r.jsReadsBeforeStart, true, "the trap is real on this runtime");
  assert.equal(r.end, null);
  assert.equal(r.signed, null);
  assert.match(r.problem, /purchaseConstraints\.purchaseEndDate must be/);
});

test("an item that already holds a purchase date this server cannot read: its sale state is unknown, so a change that leaves it switched on asks; one that hides or archives it does not", async () => {
  const dir = project();
  await withShop(async (calls, items) => {
    items.find((i) => i.id === 12).metadata = JSON.stringify({ purchaseConstraints: { purchaseEndDate: "2026-12 20:00" } });
    const edit = await run(dir, { action: "upsert", itemId: 12, description: "new text" });
    assert.equal(edit.runCondition, "user_confirm", JSON.stringify(edit));
    assert.match(edit.confirmation, /until "2026-12 20:00" \(a purchase date of this item is in a form this server cannot read, so its real sale window may differ\)/);
    assert.doesNotMatch(edit.confirmation, /2026-12 20:00" UTC/, "not marked UTC: it was not read");
    // Replacing it with a readable one is asked too: what it was before is not known.
    assert.equal((await run(dir, { action: "upsert", itemId: 12, purchaseConstraints: { purchaseEndDate: FUTURE } })).runCondition, "user_confirm");
    assert.equal((await run(dir, { action: "upsert", itemId: 12, isActive: false })).runCondition, "preview");
    assert.equal((await run(dir, { action: "archive", itemId: 12 })).runCondition, "preview");
    assert.deepEqual(writes(calls), []);
  });
});

// ── the second read after an upload keeps its own failure too ──

for (const [status, code] of [[401, "unauthorized"], [503, "upstream_error"]]) {
  test(`the re-read after an image upload answers ${status} → ${code}, not plan_mismatch; the edit is not sent`, async () => {
    const dir = project();
    await withShop(async (calls) => {
      const input = { action: "upsert", itemId: 12, name: "Renamed", imagePath: "item.png" };
      const pre = await run(dir, input);
      const inner = globalThis.fetch;
      let failing = false;
      globalThis.fetch = async (u, init = {}) => {
        const p = new URL(u).pathname;
        if (p === "/api/upload") {
          const res = await inner(u, init);
          failing = true;
          return res;
        }
        return failing ? new Response(JSON.stringify({ message: "nope" }), { status }) : inner(u, init);
      };
      try {
        const r = await run(dir, { ...input, planId: pre.planId });
        assert.equal(r.error, code, JSON.stringify(r));
        assert.equal(r.status, status);
        assert.equal(r.afterUpload, true);
        assert.match(r.hint, /^The record was not changed \(the media file is already uploaded and unused\): the target could not be read again before the write/);
        assert.doesNotMatch(r.hint, /fresh preview/);
        if (status === 401) assert.match(r.hint, /token/i, "says where the rejected token came from");
      } finally {
        globalThis.fetch = inner;
      }
      assert.deepEqual(writes(calls).map((c) => c.path), ["/api/upload"]);
    });
  });
}

// ── wording that no longer claims "on sale" / "from now on" where it is not so ──

test("previews of a price change and of the on-sale flag do not say 'from now on' or 'goes on sale': the item may be hidden, archived or scheduled", async () => {
  const dir = project();
  await withShop(async () => {
    const price = await run(dir, { action: "upsert", itemId: 10, price: 90 });
    assert.equal(price.runCondition, "preview", "archived and hidden");
    assert.ok(price.warnings.some((w) => w === "Price changes from 300 to 90 VX for every purchase made after this edit."), JSON.stringify(price.warnings));
    const flag = await run(dir, { action: "upsert", itemId: 10, isActive: true });
    assert.ok(flag.warnings.some((w) => /^The on-sale flag is turned on: the item sells whenever it has stock, is not archived and is inside its purchase dates\.$/.test(w)), JSON.stringify(flag.warnings));
    const created = await run(dir, { action: "upsert", productId: "gem", name: "Gems", price: 5, stock: 1, isActive: true, purchaseConstraints: { purchaseStartDate: FUTURE } });
    for (const w of [...price.warnings, ...flag.warnings, ...created.warnings]) assert.doesNotMatch(w, /from now on|immediately|goes on sale/);
  });
});
