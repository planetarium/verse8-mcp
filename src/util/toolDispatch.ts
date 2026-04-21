import * as crypto from "node:crypto";
import { appendAuditLine, projectDirDigest } from "./auditLog.js";
import { safeErrorHint } from "./redact.js";

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
    const rec = result as ToolResultLike | undefined;
    const ok =
      rec && typeof rec === "object" && typeof rec.ok === "boolean"
        ? rec.ok !== false
        : true;
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
    return result;
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
