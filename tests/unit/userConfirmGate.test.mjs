// INV-16: A user-confirmation action writes nothing without the user's "Run".
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

import { CONFIRM_SCHEMA, RUN_RULES, confirmMessage, planGate, planId, runConditionOf } from "../../dist/tools/creatorOps.js";
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
const WITH_LIMITS = { metadata: JSON.stringify({ purchaseConstraints: { maxPurchasePerUser: 2 } }) };
const makeItems = () => [
  item(7),
  item(8, { isActive: false }),
  item(9, { isArchived: true }),
  item(10, { isArchived: true, isActive: false }),
  item(12, WITH_LIMITS),
  item(13, { isActive: false, ...WITH_LIMITS }),
];

async function withShop(f) {
  const items = makeItems();
  const verse = { verseId: VERSE, verseShortId: "abc", isOwner: true, title: "Old title", description: "d", tag: ["RPG"], visibility: "Private", allowRemix: false };
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (u, init = {}) => {
    const { pathname } = new URL(u);
    const method = init.method ?? "GET";
    calls.push({ method, path: pathname });
    if (pathname === "/v1/verse/verseId") return json(200, verse);
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
    return await f(calls, items, verse);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}

const run = (dir, input, host) =>
  input.action === "update"
    ? runVerseOps(verseOpsInputSchema.parse({ projectDir: dir, ...input }), dir, host)
    : runVxShop(vxShopInputSchema.parse({ projectDir: dir, ...input }), dir, host);
// Where a refusal sends the user: the per-game creator page on the create host, and the tab.
const PAGE = `https://create[.]verse8[.]io/creations/${VERSE}`;
const SHOP_PORTAL = new RegExp(`VX Shop tab: ${PAGE} [(]open the "VX Shop" tab[)]`);
const GAME_PORTAL = new RegExp(`General tab: ${PAGE} [(]the "Visibility" select[)]`);
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

const LIMITS = '\\{"maxPurchasePerUser":2\\}';
/** [name, input, what the prompt must show, what it must not]. Items 12 (on sale) and 13 (hidden) have purchase limits. */
const SHOWS_ALL = [
  [
    "start a sale and remove the purchase limits",
    { action: "upsert", itemId: 13, isActive: true, clearPurchaseConstraints: true },
    [/Start selling/, /Price: 300 VX/, new RegExp(`ALL purchase limits REMOVED \\(now ${LIMITS}\\)`)],
  ],
  [
    "reprice a live item and remove the purchase limits",
    { action: "upsert", itemId: 12, price: 350, clearPurchaseConstraints: true },
    [/300 → 350 VX/, new RegExp(`ALL purchase limits REMOVED \\(now ${LIMITS}\\)`)],
  ],
  [
    "reprice a live item and change the purchase limits",
    { action: "upsert", itemId: 12, price: 350, purchaseConstraints: { maxPurchasePerUser: 9 } },
    [new RegExp(`purchase limits: ${LIMITS} → \\{"maxPurchasePerUser":9\\}`)],
  ],
  [
    "reprice a live item, limits kept: the re-sent limits are not a change",
    { action: "upsert", itemId: 12, price: 350 },
    [/300 → 350 VX/],
    [/purchase limits/, /also changes/],
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
    [/purchase limits: \{"maxPurchasePerUser":1\}/, /description: "A gem"/, /imageUrl: "<upload:item\.png>"/, /metadata: "\{\\"tier\\":2\}"/],
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
