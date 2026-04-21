import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { evaluateExpiry, runStatus } from "../../dist/tools/status.js";

test("evaluateExpiry: undefined exp returns no warning, no expiresAt", () => {
  const out = evaluateExpiry(undefined);
  assert.equal(out.expiresSoon, false);
  assert.equal(out.expiresAt, undefined);
});

test("evaluateExpiry: exp 3 days in future → expiresSoon=true", () => {
  const now = Date.now();
  const threeDaysSec = Math.floor((now + 3 * 86400 * 1000) / 1000);
  const out = evaluateExpiry(threeDaysSec, now);
  assert.equal(out.expiresSoon, true);
  assert.ok(typeof out.expiresAt === "string");
  assert.match(out.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("evaluateExpiry: exp 30 days in future → expiresSoon=false, expiresAt set", () => {
  const now = Date.now();
  const thirtyDaysSec = Math.floor((now + 30 * 86400 * 1000) / 1000);
  const out = evaluateExpiry(thirtyDaysSec, now);
  assert.equal(out.expiresSoon, false);
  assert.ok(typeof out.expiresAt === "string");
});

test("evaluateExpiry: exp in the past (already expired) → expiresSoon=false (no warn on already-expired)", () => {
  const now = Date.now();
  const pastSec = Math.floor((now - 86400 * 1000) / 1000);
  const out = evaluateExpiry(pastSec, now);
  assert.equal(out.expiresSoon, false);
  assert.ok(typeof out.expiresAt === "string");
});

async function startVerifyMock(respond) {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/auth/verify") {
      const { status, body } = respond();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
      }),
  };
}

function isolatedCwd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-expires-"));
  const prevTok = process.env.VERSE8_ACCESS_TOKEN;
  const prevApi = process.env.VERSE8_API_URL;
  process.env.VERSE8_ACCESS_TOKEN = "test-token-abc";
  return {
    tmp,
    cleanup: () => {
      if (prevTok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
      else process.env.VERSE8_ACCESS_TOKEN = prevTok;
      if (prevApi === undefined) delete process.env.VERSE8_API_URL;
      else process.env.VERSE8_API_URL = prevApi;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

test("runStatus: token with exp < 7d emits warnings:['token_expires_soon'] and ok:true", async () => {
  const env = isolatedCwd();
  const expSec = Math.floor((Date.now() + 3 * 86400 * 1000) / 1000);
  const mock = await startVerifyMock(() => ({
    status: 200,
    body: JSON.stringify({
      userUid: 1,
      handle: "test",
      walletAddress: "0x0000000000000000000000000000000000000001",
      exp: expSec,
    }),
  }));
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runStatus(env.tmp);
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.warnings));
    assert.ok(result.warnings.includes("token_expires_soon"));
    assert.ok(typeof result.tokenExpiresAt === "string");
  } finally {
    await mock.close();
    env.cleanup();
  }
});

test("runStatus: token with exp > 7d does NOT emit token_expires_soon warning", async () => {
  const env = isolatedCwd();
  const expSec = Math.floor((Date.now() + 30 * 86400 * 1000) / 1000);
  const mock = await startVerifyMock(() => ({
    status: 200,
    body: JSON.stringify({
      userUid: 1,
      handle: "test",
      walletAddress: "0x0000000000000000000000000000000000000001",
      exp: expSec,
    }),
  }));
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runStatus(env.tmp);
    assert.equal(result.ok, true);
    assert.ok(!result.warnings || !result.warnings.includes("token_expires_soon"));
    assert.ok(typeof result.tokenExpiresAt === "string");
  } finally {
    await mock.close();
    env.cleanup();
  }
});

test("runStatus: profile with no exp field → no warning, no tokenExpiresAt", async () => {
  const env = isolatedCwd();
  const mock = await startVerifyMock(() => ({
    status: 200,
    body: JSON.stringify({
      userUid: 1,
      handle: "test",
      walletAddress: "0x0000000000000000000000000000000000000001",
    }),
  }));
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runStatus(env.tmp);
    assert.equal(result.ok, true);
    assert.ok(!result.warnings || !result.warnings.includes("token_expires_soon"));
    assert.equal(result.tokenExpiresAt, undefined);
  } finally {
    await mock.close();
    env.cleanup();
  }
});
