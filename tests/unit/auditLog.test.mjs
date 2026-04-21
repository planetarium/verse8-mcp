import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendAuditLine,
  getAuditLogPath,
  projectDirDigest,
} from "../../dist/util/auditLog.js";

function freshLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-audit-"));
  const log = path.join(dir, "mcp.log");
  process.env.VERSE8_AUDIT_LOG_PATH = log;
  return { dir, log };
}

function cleanup(dir) {
  delete process.env.VERSE8_AUDIT_LOG_PATH;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test("projectDirDigest: deterministic 12-hex prefix of sha256(path)", () => {
  const a = projectDirDigest("/tmp/foo/bar");
  const b = projectDirDigest("/tmp/foo/bar");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(projectDirDigest("/tmp/foo/baz"), a);
});

test("appendAuditLine: writes a single JSONL entry to VERSE8_AUDIT_LOG_PATH", () => {
  const { dir, log } = freshLogPath();
  try {
    appendAuditLine({
      ts: "2026-04-21T00:00:00Z",
      tool: "verse8_attach",
      outcome: "ok",
      durationMs: 42,
      correlationId: "cid-1",
      projectDirDigest: projectDirDigest("/tmp/x"),
    });
    const raw = fs.readFileSync(log, "utf8");
    assert.ok(raw.endsWith("\n"));
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.tool, "verse8_attach");
    assert.equal(parsed.outcome, "ok");
    assert.equal(parsed.durationMs, 42);
    assert.equal(parsed.correlationId, "cid-1");
    assert.match(parsed.projectDirDigest, /^[0-9a-f]{12}$/);
  } finally {
    cleanup(dir);
  }
});

test("appendAuditLine: file mode is 0600 after write", () => {
  const { dir, log } = freshLogPath();
  try {
    appendAuditLine({
      ts: "2026-04-21T00:00:00Z",
      tool: "verse8_status",
      outcome: "ok",
      durationMs: 1,
      correlationId: "cid-mode",
    });
    const mode = fs.statSync(log).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    cleanup(dir);
  }
});

test("appendAuditLine: rotates at 1MB threshold (drops prior .1)", () => {
  const { dir, log } = freshLogPath();
  try {
    // Seed a stale .1 and a current log over the threshold so the next
    // write rotates.
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(`${log}.1`, "stale\n");
    const filler = "x".repeat(1024 * 1024 + 10);
    fs.writeFileSync(log, filler);

    appendAuditLine({
      ts: "2026-04-21T00:00:01Z",
      tool: "verse8_checkpoint",
      outcome: "ok",
      durationMs: 3,
      correlationId: "cid-rot",
    });

    // Post-write: .1 = prior bigfile content, log = single fresh JSONL entry.
    const rotated = fs.readFileSync(`${log}.1`, "utf8");
    assert.equal(rotated.length, filler.length);
    const current = fs.readFileSync(log, "utf8");
    assert.ok(current.endsWith("\n"));
    const lines = current.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.correlationId, "cid-rot");
  } finally {
    cleanup(dir);
  }
});

test("appendAuditLine: non-fatal when dir cannot be created (does not throw)", () => {
  const prev = process.env.VERSE8_AUDIT_LOG_PATH;
  // Point at a path under a regular file so mkdir fails.
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-audit-fail-"));
  const blocker = path.join(sentinelDir, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  process.env.VERSE8_AUDIT_LOG_PATH = path.join(blocker, "nested", "mcp.log");
  try {
    assert.doesNotThrow(() =>
      appendAuditLine({
        ts: "2026-04-21T00:00:02Z",
        tool: "verse8_attach",
        outcome: "error",
        durationMs: 7,
        correlationId: "cid-fail",
        error: "attach_failed",
      }),
    );
  } finally {
    if (prev === undefined) delete process.env.VERSE8_AUDIT_LOG_PATH;
    else process.env.VERSE8_AUDIT_LOG_PATH = prev;
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("appendAuditLine: redacts token-shaped values in entry.hint", () => {
  const { dir, log } = freshLogPath();
  try {
    appendAuditLine({
      ts: "2026-04-21T00:00:03Z",
      tool: "verse8_new_project_confirm",
      outcome: "error",
      durationMs: 500,
      correlationId: "cid-redact",
      error: "clone_failed",
      hint:
        "git clone https://oauth2:glpat-leakAbCdEfGh@gitlab.verse8.io/u/p.git failed; Bearer eyJtokenXyzPayload",
    });
    const raw = fs.readFileSync(log, "utf8").trim();
    assert.doesNotMatch(raw, /glpat-leakAbCdEfGh/);
    assert.doesNotMatch(raw, /eyJtokenXyzPayload/);
    assert.match(raw, /oauth2:\*\*\*@/);
    assert.match(raw, /Bearer \[REDACTED\]/);
  } finally {
    cleanup(dir);
  }
});

test("getAuditLogPath: respects VERSE8_AUDIT_LOG_PATH override", () => {
  const prev = process.env.VERSE8_AUDIT_LOG_PATH;
  const prevXdg = process.env.XDG_STATE_HOME;
  try {
    process.env.VERSE8_AUDIT_LOG_PATH = "/tmp/custom/verse8.log";
    assert.equal(getAuditLogPath(), "/tmp/custom/verse8.log");
    delete process.env.VERSE8_AUDIT_LOG_PATH;
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    assert.equal(getAuditLogPath(), "/tmp/xdg-state/verse8/mcp.log");
    delete process.env.XDG_STATE_HOME;
    const fallback = getAuditLogPath();
    assert.match(fallback, /\/verse8\/mcp\.log$/);
    assert.ok(fallback.includes("/.local/state/"));
  } finally {
    if (prev === undefined) delete process.env.VERSE8_AUDIT_LOG_PATH;
    else process.env.VERSE8_AUDIT_LOG_PATH = prev;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
});
