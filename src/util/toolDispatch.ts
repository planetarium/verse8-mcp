import * as crypto from "node:crypto";
import { appendAuditLine, projectDirDigest } from "./auditLog.js";
import { redactValue, safeErrorHint } from "./redact.js";

/**
 * Correlation-id + duration + audit sink wrapper for MCP tool handlers
 * (M3.3, AC-OBSERVABILITY-1). Schema-parse failures and unknown_tool
 * dispatches are intentionally NOT wrapped — they never invoke a runner.
 * Thrown errors are audited then re-thrown so the outer catch still
 * routes through safeErrorHint.
 */

export interface DispatchContext {
  correlationId: string;
  startedAt: number;
}

export interface DispatchOptions {
  projectDir?: string;
}

export interface ToolResultLike {
  ok?: boolean;
  error?: string;
  hint?: string;
}

const nowMs = Date.now;

export async function dispatchTool<T extends ToolResultLike | unknown>(
  name: string,
  runner: (ctx: DispatchContext) => Promise<T>,
  opts: DispatchOptions = {},
): Promise<T> {
  const ctx: DispatchContext = {
    correlationId: crypto.randomUUID(),
    startedAt: nowMs(),
  };
  const digest =
    opts.projectDir && opts.projectDir.length > 0
      ? projectDirDigest(opts.projectDir)
      : undefined;

  try {
    const result = await runner(ctx);
    const durationMs = nowMs() - ctx.startedAt;
    let rec = result as ToolResultLike | undefined;
    const ok =
      rec && typeof rec === "object" && typeof rec.ok === "boolean"
        ? rec.ok !== false
        : true;
    // INV-13: Failure results carry no known secret shape. Hints quote
    // backend bodies, git stderr and URLs from many call sites; redacting
    // here, where every local tool result leaves for the host, covers them
    // all. Success results are the tool's real output (asset URLs with a
    // `?token=` query, for one) and pass through untouched.
    if (!ok) rec = redactValue(rec);
    appendAuditLine({
      ts: new Date(ctx.startedAt).toISOString(),
      tool: name,
      outcome: ok ? "ok" : "error",
      durationMs,
      correlationId: ctx.correlationId,
      projectDirDigest: digest,
      error: ok ? undefined : (rec as { error?: string })?.error,
      hint: ok ? undefined : (rec as { hint?: string })?.hint,
    });
    return rec as T;
  } catch (e) {
    const durationMs = nowMs() - ctx.startedAt;
    appendAuditLine({
      ts: new Date(ctx.startedAt).toISOString(),
      tool: name,
      outcome: "error",
      durationMs,
      correlationId: ctx.correlationId,
      projectDirDigest: digest,
      error: "tool_exception",
      hint: safeErrorHint(e),
    });
    throw e;
  }
}
