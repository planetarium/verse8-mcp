import * as path from "node:path";
import { safeHint } from "../util/redact.js";

/**
 * Shared pieces of the creator-operation tools (verse8_verse, verse8_vxshop):
 * error mapping for v8-meme-api answers and the confirm gate every changing
 * action goes through.
 */

export type OpFail = { ok: false; error: string; hint: string; status?: number; [k: string]: unknown };

export function opFail(error: string, hint: string, extras: Record<string, unknown> = {}): OpFail {
  return { ok: false, error, hint: safeHint(hint), ...extras };
}

/** Map a non-2xx v8-meme-api answer to an error envelope. */
export function apiFail(what: string, r: { status: number; body: string }): OpFail {
  let message = r.body.slice(0, 300);
  try {
    const j = JSON.parse(r.body) as { message?: unknown; error?: unknown };
    const m = Array.isArray(j.message) ? j.message.join("; ") : j.message ?? j.error;
    if (typeof m === "string" && m.length > 0) message = m;
  } catch {
    /* not JSON */
  }
  const error =
    r.status === 400
      ? "bad_request"
      : r.status === 401
        ? "unauthorized"
        : r.status === 403
          ? "forbidden"
          : r.status === 404
            ? "not_found"
            : r.status === 429
              ? "rate_limited"
              : "upstream_error";
  const hint =
    r.status === 401
      ? `${what}: the Verse8 login was rejected. Re-login with verse8_login_start.`
      : `${what} failed: HTTP ${r.status} ${message}`;
  return opFail(error, hint, { status: r.status });
}

/** Absolute path of a media input given relative to projectDir. */
export function mediaPath(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(projectDir, p);
}

/** Text of the confirm gate, returned with every preview. */
export const CONFIRM_NEXT =
  "Nothing was changed. Show `changes` (and any `warnings`) to the user; after they approve, call again with the same arguments plus confirm: true.";

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

/** One entry per field whose value actually changes. */
export function diff(fields: Array<[string, unknown, unknown]>): Change[] {
  const out: Change[] = [];
  for (const [field, from, to] of fields) {
    if (to === undefined) continue;
    if (JSON.stringify(from ?? null) === JSON.stringify(to)) continue;
    out.push({ field, from: from ?? null, to });
  }
  return out;
}
