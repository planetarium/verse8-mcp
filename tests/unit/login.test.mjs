import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { runLoginStart, runLoginComplete } from "../../dist/tools/login.js";

async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function isolateEnv() {
  const prevApi = process.env.VERSE8_API_URL;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevToken = process.env.VERSE8_ACCESS_TOKEN;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-login-"));
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  delete process.env.VERSE8_ACCESS_TOKEN;
  return {
    tmp,
    restore: () => {
      if (prevApi === undefined) delete process.env.VERSE8_API_URL;
      else process.env.VERSE8_API_URL = prevApi;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevToken !== undefined) process.env.VERSE8_ACCESS_TOKEN = prevToken;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

test("runLoginStart: happy path returns verification_uri + user_code + device_code", async () => {
  const env = isolateEnv();
  const mock = await startMockServer(async (req, res) => {
    if (req.url === "/v1/auth/device/authorize") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          device_code: "dev-abc-xyz",
          user_code: "CODE-1234",
          verification_uri: "https://verse8.io/login",
          verification_uri_complete: "https://verse8.io/login?user_code=CODE-1234",
          expires_in: 1800,
          interval: 5,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runLoginStart();
    assert.equal(result.ok, true);
    assert.equal(result.device_code, "dev-abc-xyz");
    assert.equal(result.user_code, "CODE-1234");
    assert.ok(result.verification_uri.startsWith("https://"));
  } finally {
    await mock.close();
    env.restore();
  }
});

test("runLoginComplete: success writes token at XDG_CONFIG_HOME/verse8/token with mode 0600", async () => {
  const env = isolateEnv();
  const mock = await startMockServer(async (req, res) => {
    if (req.url === "/v1/auth/device/token") {
      const body = await readBody(req);
      assert.match(body, /dev-code-happy/);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "fresh-access-token-xyz",
          token_type: "bearer",
          expires_in: 3600,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runLoginComplete({
      device_code: "dev-code-happy",
      max_wait_seconds: 10,
    });
    assert.equal(result.ok, true);
    assert.equal(
      result.saved_to,
      path.join(env.tmp, "xdg", "verse8", "token"),
    );
    const saved = fs.readFileSync(result.saved_to, "utf8");
    assert.equal(saved, "fresh-access-token-xyz");
    const mode = fs.statSync(result.saved_to).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await mock.close();
    env.restore();
  }
});

test("runLoginComplete: access_denied returns structured error (no token written)", async () => {
  const env = isolateEnv();
  const mock = await startMockServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "access_denied", error_description: "user declined" }),
    );
  });
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runLoginComplete({
      device_code: "dev-code-denied",
      max_wait_seconds: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "access_denied");
    assert.match(result.hint, /user rejected/);
    const tokenPath = path.join(env.tmp, "xdg", "verse8", "token");
    assert.equal(fs.existsSync(tokenPath), false);
  } finally {
    await mock.close();
    env.restore();
  }
});

test("runLoginComplete: expired_token returns structured error with restart hint", async () => {
  const env = isolateEnv();
  const mock = await startMockServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "expired_token", error_description: "device code expired" }),
    );
  });
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runLoginComplete({
      device_code: "dev-code-expired",
      max_wait_seconds: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "expired_token");
    assert.match(result.hint, /verse8_login_start/);
  } finally {
    await mock.close();
    env.restore();
  }
});

test("runLoginComplete: unknown HTTP error returns structured error (forwarded code)", async () => {
  const env = isolateEnv();
  const mock = await startMockServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "server_error", error_description: "oops" }),
    );
  });
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runLoginComplete({
      device_code: "dev-code-server-err",
      max_wait_seconds: 10,
    });
    assert.equal(result.ok, false);
    // Non-listed codes are forwarded verbatim.
    assert.equal(result.error, "server_error");
  } finally {
    await mock.close();
    env.restore();
  }
});

test("runLoginComplete: login_timeout when deadline exceeds authorization_pending loop", async () => {
  const env = isolateEnv();
  const mock = await startMockServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "authorization_pending",
        error_description: "still pending",
      }),
    );
  });
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runLoginComplete({
      device_code: "dev-code-timeout",
      max_wait_seconds: 5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "login_timeout");
    assert.match(result.hint, /device_code is still valid/);
  } finally {
    await mock.close();
    env.restore();
  }
});

test("runLoginStart: device_authorize_failed surfaces structured error on upstream 500", async () => {
  const env = isolateEnv();
  const mock = await startMockServer((req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  process.env.VERSE8_API_URL = mock.baseUrl;
  try {
    const result = await runLoginStart();
    assert.equal(result.ok, false);
    assert.equal(result.error, "device_authorize_failed");
  } finally {
    await mock.close();
    env.restore();
  }
});
