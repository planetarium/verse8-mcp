// INV-13: Failure results carry no known secret shape — backend clients
// redact a failed response body BEFORE it is cut for a hint.
//
// Redacting after the cut misses JSON-keyed shapes: `"access_token":"…` cut
// before its closing quote no longer matches, and the head of the value
// leaks. Each case below places such a value across the client's own cut
// length and checks that no part of it comes back.
//
// Runs against dist/ with globalThis.fetch stubbed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { v8Request, getVerse, verifyToken } from "../../dist/api/v8MemeApi.js";
import { apiFail } from "../../dist/tools/creatorOps.js";
import { gatewayGet } from "../../dist/api/gameserverGateway.js";
import { uploadVerseImage } from "../../dist/api/verse8Web.js";
import { uploadAttachment } from "../../dist/api/agent8Backend.js";
import { discoverAllProxiedTools, callProxiedTool, resetProxyCaches } from "../../dist/proxy/forward.js";

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

test("INV-13: proxied tool call — the 500-char hint carries no part of the secret", async () => {
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
  }
});
