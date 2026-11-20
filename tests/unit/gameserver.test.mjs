// verse8_gameserver: read-only access to the game-server gateway's developer
// API (status, database, error log, log stream). fetch is mocked; every call
// must be a GET with the Verse8 login as Bearer.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getGatewayBaseUrl, parseSseFrame } from "../../dist/api/gameserverGateway.js";
import { gameserverInputSchema, runGameserver } from "../../dist/tools/gameserver.js";
import { createServer, GAMESERVER_TOOL } from "../../dist/server.js";

const VERSE = "0xabcdef0000000000000000000000000000000001-1700000000000";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-gs-"));
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${VERSE}\n`);
  return dir;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Route table keyed by pathname (+ "?" + search when given); records every call. */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? "GET", auth: init.headers?.Authorization });
    const route = routes[u.pathname];
    if (!route) return json(404, { error: "Not found" });
    return route(u, init);
  };
  return { fn, calls };
}

async function withMocks(routes, f, { token = "tok-123" } = {}) {
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN, url: process.env.VERSE8_GAMESERVER_URL };
  const m = mockFetch(routes);
  globalThis.fetch = m.fn;
  if (token) process.env.VERSE8_ACCESS_TOKEN = token;
  else delete process.env.VERSE8_ACCESS_TOKEN;
  delete process.env.VERSE8_GAMESERVER_URL;
  try {
    return await f(m.calls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
    if (saved.url === undefined) delete process.env.VERSE8_GAMESERVER_URL;
    else process.env.VERSE8_GAMESERVER_URL = saved.url;
  }
}

const P = (v, sub) => `/v1/verses/${v}${sub}`;
const run = (dir, input) => runGameserver(gameserverInputSchema.parse({ projectDir: dir, ...input }), dir);

test("getGatewayBaseUrl: default, https *.verse8.io and loopback overrides; anything else falls back", () => {
  assert.equal(getGatewayBaseUrl({}), "https://gs-gateway.verse8.io");
  assert.equal(getGatewayBaseUrl({ VERSE8_GAMESERVER_URL: "https://gs-gateway-asia.production.verse8.io/" }), "https://gs-gateway-asia.production.verse8.io");
  assert.equal(getGatewayBaseUrl({ VERSE8_GAMESERVER_URL: "http://127.0.0.1:4000" }), "http://127.0.0.1:4000");
  assert.equal(getGatewayBaseUrl({ VERSE8_GAMESERVER_URL: "http://gs.verse8.io" }), "https://gs-gateway.verse8.io");
  assert.equal(getGatewayBaseUrl({ VERSE8_GAMESERVER_URL: "https://evil.example.com" }), "https://gs-gateway.verse8.io");
  assert.equal(getGatewayBaseUrl({ VERSE8_GAMESERVER_URL: "https://verse8.io.evil.com" }), "https://gs-gateway.verse8.io");
});

test("parseSseFrame: event/data/id, multi-line data, comments ignored", () => {
  assert.deepEqual(parseSseFrame('id: 1-0\nevent: log\ndata: {"a":1}'), { event: "log", data: '{"a":1}', id: "1-0" });
  assert.deepEqual(parseSseFrame("data: a\ndata: b"), { event: "message", data: "a\nb", id: undefined });
  assert.equal(parseSseFrame(":ok"), null);
});

test("status (prod): server-view + overview, GET with Bearer", async () => {
  const dir = project();
  await withMocks(
    {
      [P(VERSE, "/server-view")]: () => json(200, { version: "v2", embedUrl: null }),
      [P(VERSE, "/overview")]: () => json(200, { verseId: VERSE, state: "running", players: 3, rooms: 1 }),
    },
    async (calls) => {
      const r = await run(dir, { action: "status", target: "prod" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.version, "v2");
      assert.equal(r.overview.players, 3);
      assert.ok(calls.every((c) => c.method === "GET" && c.auth === "Bearer tok-123"));
      assert.equal(calls[0].url.origin, "https://gs-gateway.verse8.io");
    },
  );
});

test("items (preview): -preview suffix, default limit 20, field search sends type", async () => {
  const dir = project();
  const pv = `${VERSE}-preview`;
  await withMocks(
    {
      [P(pv, "/db/collections/playlog_1/items")]: (u) =>
        json(200, { source: "firestore", items: [{ id: "a", data: { n: 1 } }], nextCursor: null, total: 1, q: u.search }),
    },
    async (calls) => {
      const r = await run(dir, { action: "items", target: "preview", collectionId: "playlog_1", field: "n", value: "1", valueType: "number" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.verse, pv);
      assert.equal(r.items.length, 1);
      const q = calls[0].url.searchParams;
      assert.equal(q.get("limit"), "20");
      assert.equal(q.get("field"), "n");
      assert.equal(q.get("type"), "number");
      assert.equal(q.get("cursor"), null);
    },
  );
});

test("items: id-prefix search sends no type; cursor is forwarded", async () => {
  const dir = project();
  await withMocks(
    { [P(VERSE, "/db/collections/c/items")]: () => json(200, { items: [], nextCursor: null, total: 0 }) },
    async (calls) => {
      await run(dir, { action: "items", target: "prod", collectionId: "c", value: "abc", cursor: "doc9", limit: 5 });
      const q = calls[0].url.searchParams;
      assert.equal(q.get("value"), "abc");
      assert.equal(q.get("type"), null);
      assert.equal(q.get("cursor"), "doc9");
      assert.equal(q.get("limit"), "5");
    },
  );
});

test("items without collectionId / user without account → invalid_input, no request", async () => {
  const dir = project();
  await withMocks({}, async (calls) => {
    assert.equal((await run(dir, { action: "items", target: "prod" })).error, "invalid_input");
    assert.equal((await run(dir, { action: "user", target: "prod" })).error, "invalid_input");
    assert.equal(calls.length, 0);
  });
});

test("schema rejects path-like ids before any request", () => {
  assert.throws(() => gameserverInputSchema.parse({ action: "items", target: "prod", collectionId: "a/b" }));
  assert.throws(() => gameserverInputSchema.parse({ action: "user", target: "prod", account: "../x" }));
  assert.throws(() => gameserverInputSchema.parse({ action: "status", target: "prod", verseId: "a/b" }));
  assert.throws(() => gameserverInputSchema.parse({ action: "delete", target: "prod" }));
});

test("user (assets) and users list hit the right routes", async () => {
  const dir = project();
  await withMocks(
    {
      [P(VERSE, "/db/assets/0xAbC")]: () => json(200, { source: "redis", fields: { gold: 5 } }),
      [P(VERSE, "/db/users")]: () => json(200, { accounts: ["0xAbC"], nextCursor: null, total: 1 }),
    },
    async (calls) => {
      const u = await run(dir, { action: "user", target: "prod", account: "0xAbC", kind: "assets" });
      assert.deepEqual(u.state.fields, { gold: 5 });
      const l = await run(dir, { action: "users", target: "prod", kind: "assets" });
      assert.deepEqual(l.accounts, ["0xAbC"]);
      assert.equal(calls[1].url.searchParams.get("kind"), "assets");
    },
  );
});

test("403 from the gateway → forbidden with an owner hint", async () => {
  const dir = project();
  await withMocks(
    { [P(VERSE, "/db/collections")]: () => json(403, { error: "You are not the owner of this verse" }) },
    async () => {
      const r = await run(dir, { action: "collections", target: "prod" });
      assert.equal(r.ok, false);
      assert.equal(r.error, "forbidden");
      assert.equal(r.status, 403);
      assert.match(r.hint, /owner/);
    },
  );
});

test("errors / logs on a v1 verse → logs_unavailable instead of an empty list", async () => {
  const dir = project();
  await withMocks({ [P(VERSE, "/server-view")]: () => json(200, { version: "v1", embedUrl: null }) }, async (calls) => {
    for (const action of ["errors", "logs"]) {
      const r = await run(dir, { action, target: "prod" });
      assert.equal(r.error, "logs_unavailable");
      assert.equal(r.version, "v1");
    }
    assert.ok(calls.every((c) => c.url.pathname.endsWith("/server-view")));
  });
});

test("errors on v2: limit capped at 50", async () => {
  const dir = project();
  await withMocks(
    {
      [P(VERSE, "/server-view")]: () => json(200, { version: "v2" }),
      [P(VERSE, "/recent-errors")]: () => json(200, { verseId: VERSE, entries: [{ level: "error", message: "boom" }] }),
    },
    async (calls) => {
      const r = await run(dir, { action: "errors", target: "prod", limit: 200 });
      assert.equal(r.entries[0].message, "boom");
      assert.equal(calls[1].url.searchParams.get("limit"), "50");
    },
  );
});

test("logs on v2: reads SSE `log` events with ids, stops at the line limit", async () => {
  const dir = project();
  const sse = [
    ":ok\n\n",
    'id: 1-0\nevent: log\ndata: {"timestamp":1,"level":"log","message":"hello","source":"lobby"}\n\n',
    'id: 2-0\nevent: log\ndata: {"timestamp":2,"level":"error","message":"boom","source":"room"}\n\n',
    'id: 3-0\nevent: log\ndata: {"timestamp":3,"level":"log","message":"third"}\n\n',
  ];
  await withMocks(
    {
      [P(VERSE, "/server-view")]: () => json(200, { version: "v2" }),
      [P(VERSE, "/logs/stream")]: () =>
        new Response(
          new ReadableStream({
            start(ctl) {
              for (const s of sse) ctl.enqueue(new TextEncoder().encode(s));
              // stays open, like the real stream
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    },
    async (calls) => {
      const r = await run(dir, { action: "logs", target: "prod", limit: 2, level: "info", followSeconds: 2 });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.entries.map((e) => e.message), ["hello", "boom"]);
      assert.equal(r.entries[0].id, "1-0");
      assert.equal(r.truncated, true);
      assert.equal(calls[1].url.searchParams.get("level"), "info");
    },
  );
});

test("no login → not_logged_in; no verse in .env → missing_verse_env", async () => {
  const dir = project();
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-gs-xdg-"));
  try {
    await withMocks({}, async () => {
      assert.equal((await run(dir, { action: "status", target: "prod" })).error, "not_logged_in");
    }, { token: null });
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-gs-noenv-"));
  await withMocks({}, async () => {
    assert.equal((await run(empty, { action: "status", target: "prod" })).error, "missing_verse_env");
  });
});

test("tools/list: verse8_gameserver is listed with a token; description under 2,048 chars; action enum advertised", async () => {
  const saved = process.env.VERSE8_ACCESS_TOKEN;
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => json(503, {}); // image MCP discovery
  try {
    const { tools } = await createServer()._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    const t = tools.find((x) => x.name === "verse8_gameserver");
    assert.ok(t);
    assert.ok(t.description.length <= 2048, `${t.description.length}`);
    assert.match(t.description, /READ-ONLY/);
    assert.deepEqual(t.inputSchema.properties.action.enum, ["status", "collections", "items", "users", "user", "global", "errors", "logs"]);
    assert.deepEqual(t.inputSchema.required.sort(), ["action", "target"]);
    assert.equal(GAMESERVER_TOOL.name, "verse8_gameserver");
  } finally {
    globalThis.fetch = savedFetch;
    if (saved === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved;
  }
});

test("logs on v2: an open stream with fewer lines than the limit returns after followSeconds", async () => {
  const dir = project();
  await withMocks(
    {
      [P(VERSE, "/server-view")]: () => json(200, { version: "v2" }),
      [P(VERSE, "/logs/stream")]: () =>
        new Response(
          new ReadableStream({
            start(ctl) {
              ctl.enqueue(new TextEncoder().encode('id: 9-0\r\nevent: log\r\ndata: {"level":"warn","message":"only"}\r\n\r\n'));
            },
          }),
          { status: 200 },
        ),
    },
    async () => {
      const started = Date.now();
      const r = await run(dir, { action: "logs", target: "prod", followSeconds: 1, limit: 10 });
      const took = Date.now() - started;
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.entries.map((e) => e.message), ["only"]);
      assert.equal(r.truncated, false);
      assert.ok(took >= 900 && took < 5000, `took ${took}ms`);
    },
  );
});
