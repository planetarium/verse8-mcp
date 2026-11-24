// INV-13: Failure results carry no known secret shape — backend clients
// redact a failed response body BEFORE it is cut for a hint.
//
// Redacting after the cut misses JSON-keyed shapes: `"access_token":"…` cut
// before its closing quote no longer matches, and the head of the value
// leaks. Each case below places such a value across the client's own cut
// length and checks that no part of it comes back.
//
// Runs against dist/ with globalThis.fetch stubbed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { v8Request, getVerse, verifyToken, deviceToken } from "../../dist/api/v8MemeApi.js";
import { redactHead } from "../../dist/util/redact.js";
import { runNewProjectStart, _resetNewProjectStateForTests } from "../../dist/tools/newProject.js";
import { apiFail } from "../../dist/tools/creatorOps.js";
import { gatewayGet } from "../../dist/api/gameserverGateway.js";
import { uploadVerseImage } from "../../dist/api/verse8Web.js";
import { uploadAttachment } from "../../dist/api/agent8Backend.js";
import { discoverAllProxiedTools, callProxiedTool, resetProxyCaches } from "../../dist/proxy/forward.js";

// Base URLs, proxy allow-lists and tokens come from VERSE8_* env; a developer
// shell (VERSE8_MCP_PROXIES=none, a staging host) must not change the result.
const savedEnv = {};
before(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VERSE8_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
});
after(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("VERSE8_")) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const SECRET = "eyJstraddlesTheCut0123456789abcdef";
const LEAKED_HEAD = SECRET.slice(0, 6);

/** A JSON body whose access_token value starts 14 chars before `cut`. */
function straddling(cut) {
  const prefix = '{"pad":"';
  const key = '","access_token":"';
  const pad = "x".repeat(cut - 14 - prefix.length - key.length);
  const body = `${prefix}${pad}${key}${SECRET}"}`;
  assert.equal(body.indexOf(SECRET), cut - 14);
  return body;
}

/** `fields` plus a pad and an access_token whose value starts 14 chars before `cut` once serialized. */
function straddlingObject(cut, fields) {
  const probe = JSON.stringify({ ...fields, pad: "", access_token: SECRET }).indexOf(SECRET);
  const obj = { ...fields, pad: "x".repeat(cut - 14 - probe), access_token: SECRET };
  assert.equal(JSON.stringify(obj).indexOf(SECRET), cut - 14);
  return obj;
}

async function withFetch(handler, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

const fail = (body, status = 500) => async () => new Response(body, { status });

test("INV-13: v8-meme-api creator call — the 300-char hint carries no part of the secret", async () => {
  await withFetch(fail(straddling(300)), async () => {
    const r = await v8Request("GET", "/v1/anything", { token: "t" });
    assert.equal(r.ok, false);
    const out = apiFail("load x", r);
    assert.ok(!out.hint.includes(LEAKED_HEAD), out.hint);
  });
});

test("INV-13: v8-meme-api verse and verify bodies are redacted whole", async () => {
  // deploy / deploy-status cut these bodies to 200 / 300 chars.
  await withFetch(fail(straddling(200)), async () => {
    const verse = await getVerse("v", "t");
    assert.equal(verse.ok, false);
    assert.ok(!verse.body.includes(LEAKED_HEAD), verse.body);
    const verify = await verifyToken("t");
    assert.equal(verify.ok, false);
    assert.ok(!verify.body.includes(LEAKED_HEAD), verify.body);
  });
});

test("INV-13: game-server gateway — the 300-char error carries no part of the secret", async () => {
  await withFetch(fail(straddling(300)), async () => {
    const r = await gatewayGet("verse", "/db/collections", "t");
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes(LEAKED_HEAD), r.error);
  });
});

test("INV-13: verse media upload — the 200-char hint carries no part of the secret", async () => {
  await withFetch(fail(straddling(200)), async () => {
    const r = await uploadVerseImage({ file: new Blob([new Uint8Array([1])]), filename: "a.png", token: "t" });
    assert.equal(r.ok, false);
    assert.ok(!r.hint.includes(LEAKED_HEAD), r.hint);
  });
});

test("INV-13: attachment upload — the 200-char hint carries no part of the secret", async () => {
  await withFetch(fail(straddling(200)), async () => {
    const r = await uploadAttachment({
      file: new Blob([new Uint8Array([1])], { type: "image/png" }),
      filename: "a.png",
      cdnPath: "assets/images",
      verse: "v1",
      token: "t",
    });
    assert.equal(r.ok, false);
    assert.ok(!r.hint.includes(LEAKED_HEAD), r.hint);
  });
});

test("INV-13: redactHead redacts before it cuts", () => {
  const body = straddling(500);
  assert.ok(body.slice(0, 500).includes(LEAKED_HEAD), "fixture straddles the cut");
  const out = redactHead(body, 500);
  assert.ok(!out.includes(LEAKED_HEAD), out);
  assert.ok(out.length <= 500);
});

test("INV-13: new project — a 2xx startcall body that fails the shape check is redacted before the cut", async () => {
  // No template.name → the hint quotes the serialized body, cut to 500.
  process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";
  try {
    const cases = [
      // whole body serialized → `startcall response missing template.name`
      ["missing template.name", straddlingObject(500, {})],
      // only `template` serialized → `startcall template missing githubRepo or path`
      ["template missing githubRepo/path", { template: straddlingObject(500, { name: "t" }) }],
    ];
    for (const [label, payload] of cases) {
      _resetNewProjectStateForTests();
      await withFetch(async () => new Response(JSON.stringify(payload), { status: 200 }), async () => {
        const r = await runNewProjectStart({ userRequest: "a game" });
        assert.equal(r.ok, false, label);
        assert.equal(r.error, "startcall_failed", label);
        assert.ok(!r.hint.includes(LEAKED_HEAD), `${label}: ${r.hint}`);
      });
    }
  } finally {
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("INV-13: backend error strings picked out of a JSON body are redacted in the client", async () => {
  const pat = "glpat-leakInErrorField0123456789";
  await withFetch(async () => new Response(JSON.stringify({ error: `denied for ${pat}` }), { status: 403 }), async () => {
    const r = await gatewayGet("verse", "/db/collections", "t");
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.ok(!r.error.includes(pat), r.error);
    assert.match(r.error, /^denied for glpat-\*\*\*$/);
  });
  await withFetch(
    async () => new Response(JSON.stringify({ error: "access_denied", error_description: `bad ${pat}` }), { status: 400 }),
    async () => {
      const r = await deviceToken("dc");
      assert.equal(r.ok, false);
      assert.equal(r.error.error, "access_denied");
      assert.ok(!r.error.error_description.includes(pat), r.error.error_description);
    },
  );
});

test("INV-13: proxied tool call — the 500-char hint carries no part of the secret", async () => {
  process.env.VERSE8_MCP_PROXIES = "all";
  resetProxyCaches();
  const rpc = async (_url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      });
    }
    if (msg.method === "notifications/initialized") return new Response("", { status: 202 });
    if (msg.method === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "leaky_tool", inputSchema: { type: "object" } }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(straddling(500), { status: 500 });
  };
  try {
    await withFetch(rpc, async () => {
      await discoverAllProxiedTools("t");
      const r = await callProxiedTool("leaky_tool", {}, "t");
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "upstream_http_500");
      assert.ok(!r.hint.includes(LEAKED_HEAD), r.hint);
    });
  } finally {
    resetProxyCaches();
    delete process.env.VERSE8_MCP_PROXIES;
  }
});
