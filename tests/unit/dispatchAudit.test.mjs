import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServer } from "../../dist/server.js";

function getHandler(server, methodName) {
  const map = server._requestHandlers;
  assert.ok(map, "server._requestHandlers not present — SDK shape changed?");
  const handler = map.get(methodName);
  assert.ok(handler, `no handler registered for ${methodName}`);
  return handler;
}

async function withIsolatedAuditLog(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-dispatch-audit-"));
  const logPath = path.join(dir, "mcp.log");
  const prev = process.env.VERSE8_AUDIT_LOG_PATH;
  const prevToken = process.env.VERSE8_ACCESS_TOKEN;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.VERSE8_AUDIT_LOG_PATH = logPath;
  delete process.env.VERSE8_ACCESS_TOKEN;
  // Isolate from developer's real token.
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  const origCwd = process.cwd();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-dispatch-cwd-"));
  process.chdir(cwd);
  try {
    return await fn({ logPath, dir, cwd });
  } finally {
    process.chdir(origCwd);
    if (prev === undefined) delete process.env.VERSE8_AUDIT_LOG_PATH;
    else process.env.VERSE8_AUDIT_LOG_PATH = prev;
    if (prevToken !== undefined) process.env.VERSE8_ACCESS_TOKEN = prevToken;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function readLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test("AC-OBSERVABILITY-1: verse8_status dispatch emits exactly one audit line", async () => {
  await withIsolatedAuditLog(async ({ logPath }) => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    const result = await handler(
      {
        method: "tools/call",
        params: { name: "verse8_status", arguments: {} },
      },
      {},
    );
    assert.ok(result);
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].tool, "verse8_status");
    assert.ok(typeof lines[0].correlationId === "string");
    assert.ok(lines[0].correlationId.length > 0);
    assert.ok(typeof lines[0].durationMs === "number");
    // verse8_status with no token returns ok:false, error:not_logged_in
    assert.equal(lines[0].outcome, "error");
    assert.equal(lines[0].error, "not_logged_in");
    // projectDirDigest must be the 12-hex digest, never the raw cwd.
    assert.match(lines[0].projectDirDigest, /^[0-9a-f]{12}$/);
  });
});

test("AC-OBSERVABILITY-1: schema-parse failure does NOT emit an audit line", async () => {
  await withIsolatedAuditLog(async ({ logPath }) => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    // verse8_login_complete requires device_code — omitting it triggers a
    // ZodError BEFORE the runner is invoked.
    await handler(
      {
        method: "tools/call",
        params: { name: "verse8_login_complete", arguments: {} },
      },
      {},
    );
    const lines = readLines(logPath);
    assert.equal(lines.length, 0);
  });
});

test("AC-OBSERVABILITY-1: unknown_tool (no-token path) emits zero audit lines", async () => {
  await withIsolatedAuditLog(async ({ logPath }) => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    await handler(
      {
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} },
      },
      {},
    );
    const lines = readLines(logPath);
    assert.equal(lines.length, 0);
  });
});

test("AC-OBSERVABILITY-3: projectDirDigest in audit line is sha256 prefix, not raw path", async () => {
  await withIsolatedAuditLog(async ({ logPath, cwd }) => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    await handler(
      {
        method: "tools/call",
        params: { name: "verse8_status", arguments: {} },
      },
      {},
    );
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    // Raw cwd must not appear anywhere in the audit line.
    const raw = JSON.stringify(lines[0]);
    assert.ok(!raw.includes(cwd), `raw cwd leaked into audit line: ${raw}`);
  });
});

test("AC-OBSERVABILITY-1: verse8_bootstrap dispatch emits exactly one audit line", async () => {
  await withIsolatedAuditLog(async ({ logPath }) => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    const result = await handler(
      {
        method: "tools/call",
        params: { name: "verse8_bootstrap", arguments: {} },
      },
      {},
    );
    assert.ok(result);
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].tool, "verse8_bootstrap");
    assert.ok(typeof lines[0].correlationId === "string");
    assert.equal(lines[0].outcome, "ok");
    assert.match(lines[0].projectDirDigest, /^[0-9a-f]{12}$/);
  });
});

test("dispatch: sequential calls accumulate one audit line each", async () => {
  await withIsolatedAuditLog(async ({ logPath }) => {
    const server = createServer();
    const handler = getHandler(server, "tools/call");
    for (let i = 0; i < 3; i++) {
      await handler(
        {
          method: "tools/call",
          params: { name: "verse8_status", arguments: {} },
        },
        {},
      );
    }
    const lines = readLines(logPath);
    assert.equal(lines.length, 3);
    const cids = new Set(lines.map((l) => l.correlationId));
    assert.equal(cids.size, 3, "correlation ids must be unique per call");
  });
});
