// verse8_credits (balance + tool-usage charges) and the jam credit top-up
// that runs right before a proxied *_generate call. fetch is mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { formatCreditUsd } from "../../dist/api/credit.js";
import {
  creditShortfallNote,
  isAssetGenerationTool,
  runCredits,
  topupJamCreditBeforeGeneration,
} from "../../dist/tools/credits.js";
import { createServer } from "../../dist/server.js";
import { resetProxyCaches } from "../../dist/proxy/forward.js";

const TOKEN = "test-token-credits";

function json(status, body) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "mcp-session-id": "s1" },
  });
}

/** A Verse8 project folder (marker + gitlab.verse8.io origin). */
function verseProject(jam) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-credits-"));
  fs.mkdirSync(path.join(dir, ".verse8"));
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ version: 1 }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git"], { cwd: dir });
  if (jam === "MSU") fs.mkdirSync(path.join(dir, "src", "__system__", "maple"), { recursive: true });
  if (jam === "9C") {
    fs.mkdirSync(path.join(dir, "PROJECT"));
    fs.writeFileSync(path.join(dir, "PROJECT", "NineChronicles.md"), "# 9C\n");
  }
  return dir;
}

/** Runs `f` with VERSE8_* cleared, a token set and fetch routed to `route`. */
async function withApi(route, f) {
  const saved = {};
  for (const k of Object.keys(process.env)) if (k.startsWith("VERSE8_")) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.VERSE8_ACCESS_TOKEN = TOKEN;
  process.env.VERSE8_MCP_PROXIES = "image";
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    return route(call);
  };
  resetProxyCaches();
  try {
    return await f(calls);
  } finally {
    globalThis.fetch = savedFetch;
    resetProxyCaches();
    for (const k of Object.keys(process.env)) if (k.startsWith("VERSE8_")) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("formatCreditUsd shows USD like the web: cents from one cent up, exact below", () => {
  assert.equal(formatCreditUsd("12345678900"), "12.35");
  assert.equal(formatCreditUsd("10000000000"), "10.00");
  assert.equal(formatCreditUsd("1000000"), "0.001");
  assert.equal(formatCreditUsd("10000000"), "0.01");
  assert.equal(formatCreditUsd("0"), "0.00");
  assert.equal(formatCreditUsd("-5000000000"), "-5.00");
  assert.equal(formatCreditUsd(""), null);
  assert.equal(formatCreditUsd("1.5"), null);
  assert.equal(formatCreditUsd(undefined), null);
});

test("verse8_credits reads the balance and toolUsage events and shows the billed amounts", async () => {
  await withApi(
    ({ url }) => {
      if (url.pathname === "/v1/credit/user") return json(200, { id: "u1", credits: "7250000000" });
      if (url.pathname === "/v1/credit/user/events")
        return json(200, {
          total: 41,
          page: 2,
          limit: 5,
          events: [
            {
              id: 9,
              eventType: "toolUsage",
              createdAt: "2026-11-20T01:02:03.000Z",
              toolUsageEvent: { requestedToolName: "image_asset_generate", actualToolName: "image-gen", usageCount: 2 },
              creditAmount: "-40000000",
              creditAmountUsd: "-0.04",
            },
            { id: 8, eventType: "toolUsage", toolUsageEvent: { requestedToolName: "sfx_generate", usageCount: 1 }, creditAmountUsd: "-0.50" },
          ],
        });
      return json(404, {});
    },
    async (calls) => {
      const r = await runCredits({ page: 2, limit: 5 }, os.tmpdir());
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.balanceUsd, "7.25");
      assert.deepEqual(r.toolUsage, {
        total: 41,
        page: 2,
        limit: 5,
        events: [
          { tool: "image-gen", usageCount: 2, amountUsd: "0.04", at: "2026-11-20T01:02:03.000Z" },
          { tool: "sfx_generate", usageCount: 1, amountUsd: "0.50", at: null },
        ],
      });
      assert.equal(r.settingsUrl, "https://verse8.io/settings");
      const ev = calls.find((c) => c.url.pathname === "/v1/credit/user/events");
      assert.equal(ev.url.host, "v8-meme-api.verse8.io");
      assert.equal(ev.url.searchParams.get("eventType"), "toolUsage");
      assert.equal(ev.url.searchParams.get("page"), "2");
      assert.equal(ev.url.searchParams.get("limit"), "5");
      assert.ok(calls.every((c) => c.method === "GET" && c.headers.Authorization === `Bearer ${TOKEN}`));
    },
  );
});

test("verse8_credits: a failed balance read is an upstream_error, not a $0.00 balance", async () => {
  await withApi(
    ({ url }) => (url.pathname === "/v1/credit/user" ? json(500, { message: "boom" }) : json(200, { events: [] })),
    async () => {
      const r = await runCredits({}, os.tmpdir());
      assert.equal(r.ok, false);
      assert.equal(r.error, "upstream_error");
      assert.equal(r.status, 500);
    },
  );
});

test("verse8_credits without a login asks for one", async () => {
  await withApi(() => json(200, {}), async (calls) => {
    delete process.env.VERSE8_ACCESS_TOKEN;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-credits-xdg-"));
    let r;
    try {
      r = await runCredits({ projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "verse8-credits-nologin-")) });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_logged_in");
    assert.equal(calls.length, 0);
  });
});

test("only upstream *_generate tools count as asset generation", () => {
  for (const n of ["image_asset_generate", "music_generate", "claythis_3d_generate", "spritesheet_variation_generate"]) {
    assert.equal(isAssetGenerationTool(n), true, n);
  }
  for (const n of ["asset_wait", "skybox_status", "ui_theme_list", "cinematic_asset_result", "verse8_credits"]) {
    assert.equal(isAssetGenerationTool(n), false, n);
  }
});

for (const [jam, route, name] of [
  ["MSU", "/v1/msu/credit/topup", "MapleStory Universe"],
  ["9C", "/v1/nine-chronicles/credit/topup", "Nine Chronicles"],
]) {
  test(`${jam} project: top-up is POSTed to ${route} and a real top-up adds one line`, async () => {
    const dir = verseProject(jam);
    await withApi(
      () => json(200, { toppedUp: true, balanceBefore: "1500000000", balanceAfter: "10000000000", delta: "8500000000" }),
      async (calls) => {
        const line = await topupJamCreditBeforeGeneration(dir, TOKEN);
        assert.equal(line, `Topped up ${name} jam credits by $8.50 (balance now $10.00).`);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, "POST");
        assert.equal(calls[0].url.href, `https://v8-meme-api.verse8.io${route}`);
        assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(calls[0].body, undefined);
      },
    );
  });
}

test("MSU wins when a project matches both jams", async () => {
  const dir = verseProject("MSU");
  fs.mkdirSync(path.join(dir, "PROJECT"));
  fs.writeFileSync(path.join(dir, "PROJECT", "NineChronicles.md"), "# 9C\n");
  await withApi(() => json(200, { toppedUp: false }), async (calls) => {
    await topupJamCreditBeforeGeneration(dir, TOKEN);
    assert.deepEqual(calls.map((c) => c.url.pathname), ["/v1/msu/credit/topup"]);
  });
});

test("top-up stays silent when nothing was added, the account is refused, or the network fails", async () => {
  const dir = verseProject("MSU");
  for (const reply of [
    () => json(200, { toppedUp: false, delta: "0", balanceBefore: "9000000000", balanceAfter: "9000000000" }),
    () => json(403, { message: "MSU phone verification required" }),
    () => json(200, {}),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    await withApi(reply, async (calls) => {
      assert.equal(await topupJamCreditBeforeGeneration(dir, TOKEN), null);
      assert.equal(calls.length, 1);
    });
  }
});

test("no top-up call for a project outside every jam or a folder that is not a Verse8 project", async () => {
  const plain = verseProject(null);
  const notVerse = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-credits-plain-"));
  fs.mkdirSync(path.join(notVerse, "src", "__system__", "maple"), { recursive: true });
  // An MSU project reached through `..` — projectDir is unvalidated tool input here.
  const dotted = `${verseProject("MSU")}${path.sep}src${path.sep}..`;
  await withApi(() => json(200, { toppedUp: true }), async (calls) => {
    assert.equal(await topupJamCreditBeforeGeneration(plain, TOKEN), null);
    assert.equal(await topupJamCreditBeforeGeneration(notVerse, TOKEN), null);
    assert.equal(await topupJamCreditBeforeGeneration(dotted, TOKEN), null);
    assert.equal(calls.length, 0);
  });
});

test("credit shortfall note carries the balance and the settings link; other failures get none", async () => {
  await withApi(({ url }) => (url.pathname === "/v1/credit/user" ? json(200, { credits: "30000000" }) : json(404, {})), async () => {
    const note = await creditShortfallNote(0, "Error: insufficient credits for image generation", TOKEN);
    assert.match(note, /balance \$0\.03/);
    assert.match(note, /https:\/\/verse8\.io\/settings/);
    assert.match(await creditShortfallNote(402, "payment required", TOKEN), /Not enough Verse8 credits/);
    assert.equal(await creditShortfallNote(500, "model timed out", TOKEN), null);
  });
});

/** Mock of v8-meme-api + one proxied MCP service exposing `tools`. */
function platform({ tools, callResult, topup, credits = "30000000" }) {
  const order = [];
  const route = ({ url, body }) => {
    if (url.host === "v8-meme-api.verse8.io") {
      order.push(url.pathname);
      if (url.pathname.endsWith("/credit/topup")) return json(200, topup);
      if (url.pathname === "/v1/credit/user") return json(200, { credits });
      return json(404, {});
    }
    const msg = JSON.parse(body);
    const rpc = (result) => json(200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return rpc({});
    if (msg.method === "notifications/initialized") return new Response("", { status: 202 });
    if (msg.method === "tools/list") return rpc({ tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
    order.push(`tools/call:${msg.params.name}`);
    return rpc(callResult);
  };
  return { order, route };
}

async function callTool(name, args) {
  const call = createServer()._requestHandlers.get("tools/call");
  return call({ method: "tools/call", params: { name, arguments: args } }, {});
}

test("proxied *_generate in a jam project: top-up runs before the generation and its line is appended", async () => {
  const dir = verseProject("MSU");
  const p = platform({
    tools: ["image_asset_generate", "asset_wait"],
    callResult: { content: [{ type: "text", text: '{"jobId":"j1"}' }] },
    topup: { toppedUp: true, balanceBefore: "0", balanceAfter: "10000000000", delta: "10000000000" },
  });
  await withApi(p.route, async () => {
    const r = await callTool("image_asset_generate", { prompt: "a sword", projectDir: dir });
    assert.equal(r.isError, false);
    assert.deepEqual(p.order, ["/v1/msu/credit/topup", "tools/call:image_asset_generate"]);
    assert.equal(r.content.length, 2);
    assert.equal(r.content[0].text, '{"jobId":"j1"}');
    assert.equal(r.content[1].text, "Topped up MapleStory Universe jam credits by $10.00 (balance now $10.00).");

    p.order.length = 0;
    const wait = await callTool("asset_wait", { jobId: "j1", projectDir: dir });
    assert.deepEqual(p.order, ["tools/call:asset_wait"]);
    assert.equal(wait.content.length, 1);
  });
});

test("proxied generation that fails for lack of credits gets the balance and the settings link", async () => {
  const dir = verseProject(null);
  const p = platform({
    tools: ["sfx_generate"],
    callResult: { content: [{ type: "text", text: "Insufficient credits" }], isError: true },
    topup: { toppedUp: true },
    credits: "30000000",
  });
  await withApi(p.route, async () => {
    const r = await callTool("sfx_generate", { prompt: "boom", projectDir: dir });
    assert.equal(r.isError, true);
    assert.deepEqual(p.order, ["tools/call:sfx_generate", "/v1/credit/user"]);
    assert.equal(r.content.length, 2);
    assert.match(r.content[1].text, /^Not enough Verse8 credits \(balance \$0\.03\)\. Add credits in the browser at https:\/\/verse8\.io\/settings/);
  });
});

test("verse8_credits is listed once logged in", async () => {
  await withApi(() => json(200, { tools: [] }), async () => {
    const { tools } = await createServer()._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    const t = tools.find((x) => x.name === "verse8_credits");
    assert.ok(t);
    assert.ok(t.description.length <= 2048);
  });
});
