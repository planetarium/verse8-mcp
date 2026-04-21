import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { safeHint } from "./redact.js";

/**
 * Rotating JSONL audit log (M3.1). Writer never throws — a failing
 * audit path must not break the tool call. Never records raw projectDir;
 * callers pass a pre-computed digest via `projectDirDigest()`.
 */

const MAX_LOG_BYTES = 1 * 1024 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface AuditEntry {
  ts: string;
  tool: string;
  outcome: "ok" | "error";
  durationMs: number;
  correlationId: string;
  projectDirDigest?: string;
  error?: string;
  hint?: string;
}

export function projectDirDigest(projectDir: string): string {
  return crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 12);
}

export function getAuditLogPath(): string {
  const override = process.env.VERSE8_AUDIT_LOG_PATH;
  if (typeof override === "string" && override.length > 0) return override;
  const xdg = process.env.XDG_STATE_HOME;
  const base =
    typeof xdg === "string" && xdg.length > 0
      ? xdg
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "verse8", "mcp.log");
}

function rotateIfNeeded(logPath: string): void {
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;
  const rotated = `${logPath}.1`;
  try {
    fs.rmSync(rotated, { force: true });
  } catch {
    /* best-effort */
  }
  try {
    fs.renameSync(logPath, rotated);
  } catch {
    /* best-effort */
  }
}

function ensureDir(logPath: string): void {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

function redactedEntry(entry: AuditEntry): AuditEntry {
  const clone: AuditEntry = { ...entry };
  if (typeof clone.hint === "string") clone.hint = safeHint(clone.hint);
  if (typeof clone.error === "string") clone.error = safeHint(clone.error);
  return clone;
}

export function appendAuditLine(entry: AuditEntry): void {
  try {
    const logPath = getAuditLogPath();
    ensureDir(logPath);
    rotateIfNeeded(logPath);
    const line = JSON.stringify(redactedEntry(entry)) + "\n";
    let fd: number | undefined;
    try {
      fd = fs.openSync(logPath, "a", FILE_MODE);
      fs.writeSync(fd, line);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      fs.chmodSync(logPath, FILE_MODE);
    } catch {
      /* best-effort */
    }
  } catch {
    /* audit writes are best-effort; never break the caller */
  }
}

export function _auditMaxBytesForTests(): number {
  return MAX_LOG_BYTES;
}
