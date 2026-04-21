/**
 * Central secret-shape redactor.
 *
 * Single source of truth for stripping known credential / token shapes from
 * any string before it lands on stderr, in an MCP envelope, in an audit log,
 * or in a thrown error message. Local helpers in newProject.ts /
 * agent8Backend.ts / proxy/imageMcp.ts are migrated to this module by
 * US-M0-3 / US-M0-6 so the redaction policy lives in exactly one place.
 *
 * Usage:
 *   safeHint(someString)        — for arbitrary strings (stderr, hints, JSON bodies).
 *   safeErrorHint(unknownThing) — for catch-block values; never throws.
 *
 * Adding a new shape: append to SECRET_SHAPES. Each entry must be idempotent
 * (replacement matches the pattern only when followed by another secret —
 * the canonical replacement strings used here do NOT match any pattern).
 */

export interface SecretShape {
  /** Stable id used in tests and the shape registry. */
  name: string;
  /** Regex with the `g` flag (and `i` where case-insensitive). */
  pattern: RegExp;
  /** Static replacement string OR replacer function. */
  replace: string | ((match: string, ...groups: string[]) => string);
}

/**
 * Order matters: more specific shapes (oauth2 URL) come BEFORE generic
 * fallbacks (glpat anywhere) so the URL form gets a clean `oauth2:***@`
 * envelope and we don't double-mark inside it.
 */
export const SECRET_SHAPES: SecretShape[] = [
  // GitLab clone-URL form: https://oauth2:<PAT>@host/...
  // Strip the entire userinfo section so the host stays visible but the
  // credential is gone.
  {
    name: "oauth2-url-userinfo",
    pattern: /oauth2:[^@\s]+@/g,
    replace: "oauth2:***@",
  },
  // GitLab Personal Access Tokens (also used by gitlab.verse8.io).
  {
    name: "glpat",
    pattern: /glpat-[A-Za-z0-9_-]+/g,
    replace: "glpat-***",
  },
  // HTTP Authorization header: `Bearer <token>`.
  {
    name: "bearer",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=\-]+/gi,
    replace: "Bearer [REDACTED]",
  },
  // OAuth / OIDC token JSON shapes — used by v8-meme-api device-flow
  // responses and by upstream MCP service envelopes.
  {
    name: "access_token-json",
    pattern: /"access_token"\s*:\s*"[^"]*"/g,
    replace: '"access_token":"[REDACTED]"',
  },
  {
    name: "refresh_token-json",
    pattern: /"refresh_token"\s*:\s*"[^"]*"/g,
    replace: '"refresh_token":"[REDACTED]"',
  },
  {
    name: "id_token-json",
    pattern: /"id_token"\s*:\s*"[^"]*"/g,
    replace: '"id_token":"[REDACTED]"',
  },
  // RFC 8628 device-flow correlation. Not strictly a secret long-term but
  // valid for ~30min, so treat as sensitive.
  {
    name: "device_code-json",
    pattern: /"device_code"\s*:\s*"[^"]*"/g,
    replace: '"device_code":"[REDACTED]"',
  },
  // Generic fallback — `token: "..."` outside a JSON context (e.g. logged
  // as a key=value pair). Only matches when the token appears to be opaque
  // and ≥16 chars to avoid false positives on the literal word "token".
  {
    name: "token-keyvalue",
    pattern: /\btoken["'\s:=]+([A-Za-z0-9._~+/=\-]{16,})/gi,
    replace: (match, body: string) => match.replace(body, "[REDACTED]"),
  },
];

/**
 * Redact every known secret shape from `input`. Idempotent — running it
 * twice produces the same output as running it once.
 */
export function safeHint(input: string): string {
  if (typeof input !== "string") return input;
  if (input.length === 0) return input;
  let out = input;
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape.pattern, shape.replace as string);
  }
  return out;
}

/**
 * Best-effort hint extractor for catch-block values. Never throws — accepts
 * Error, string, undefined, null, and arbitrary objects. The returned
 * string has every known secret shape redacted.
 */
export function safeErrorHint(e: unknown): string {
  if (e === undefined || e === null) return "";
  if (typeof e === "string") return safeHint(e);
  if (e instanceof Error) {
    return safeHint(e.message ?? "");
  }
  // Last resort — try toString() inside a try/catch; some objects throw
  // on conversion (Symbol, Object.create(null) without a prototype, …).
  try {
    return safeHint(String(e));
  } catch {
    return "";
  }
}
