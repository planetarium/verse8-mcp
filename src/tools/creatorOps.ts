import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { redactHead, safeHint } from "../util/redact.js";
import { rejectedTokenHint, type TokenWhere } from "../context/token.js";

/**
 * Shared pieces of the creator-operation tools (verse8_verse, verse8_vxshop):
 * error mapping for v8-meme-api answers and the plan gate every changing
 * action goes through.
 */

export type OpFail = { ok: false; error: string; hint: string; status?: number; [k: string]: unknown };

export function opFail(error: string, hint: string, extras: Record<string, unknown> = {}): OpFail {
  return { ok: false, error, hint: safeHint(hint), ...extras };
}

/** Map a non-2xx v8-meme-api answer to an error envelope. */
export function apiFail(what: string, r: { status: number; body: string }): OpFail {
  let message = redactHead(r.body, 300);
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
      ? // What to do about it depends on where the token came from, which
        // only the tool's entry point knows: withRejectedTokenHint adds it.
        `${what}: the Verse8 login was rejected (HTTP 401).`
      : `${what} failed: HTTP ${r.status} ${message}`;
  return opFail(error, hint, { status: r.status });
}

/**
 * Finish a tool result at the tool's entry point: when it is an `apiFail`
 * 401, append what to do about the rejected token, by the source of the
 * token this call used. The source travels with the call (`where`), not in
 * shared state, so a concurrent call from another folder cannot change it.
 */
export function withRejectedTokenHint<T extends { ok: boolean }>(result: T, where: TokenWhere): T {
  const r = result as unknown as OpFail;
  if (r.ok !== false || r.error !== "unauthorized" || r.status !== 401) return result;
  return { ...result, hint: safeHint(`${r.hint} ${rejectedTokenHint(where)}.`) };
}

/** Absolute path of a media input given relative to projectDir. */
export function mediaPath(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(projectDir, p);
}

// ── plan gate ──
//
// A changing action runs only with the planId its own preview returned.
// The planId is a hash of what the preview showed: the action, its target,
// the body that will be sent, the current values read for it, and the
// content of local files to upload. Running recomputes all of it from a
// fresh read and refuses when the hash differs — so nothing runs without a
// preview, and nothing runs that differs from the preview the user saw.
// Nothing is stored: the same arguments + the same current values give the
// same planId, across calls and server restarts.
//
// It binds the run to the preview; it is not a secret. It does not stop a
// host that recomputes the hash itself, only one that skips the preview or
// runs after the values changed.

/** Canonical JSON: object keys sorted at every level, undefined members dropped (as JSON.stringify does). */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export interface Plan {
  /** Tool and action, e.g. "verse8_vxshop.upsert.edit". */
  op: string;
  /** What the action changes, e.g. { verseId, itemId }. */
  target: Record<string, unknown>;
  /** The request that will be sent; local uploads appear as `<upload:path>`. */
  body: unknown;
  /** Current values read for this call that the result depends on. Keys must depend only on the arguments. */
  state?: Record<string, unknown>;
  /** Local files uploaded when it runs (field → absolute path); their content is part of the plan. */
  files?: Record<string, string>;
}

const PLAN_VERSION = "v1";
const PART_HEX = 4;
const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

function readOrNull(p: string): Buffer<ArrayBuffer> | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/**
 * The named parts of a plan, and the bytes of each local file as read for
 * its hash. A run uploads exactly these bytes, never a second read of the
 * path, so the file cannot change between the check and the upload. Files
 * are read whole, as the upload does anyway (≤4 MB images, ≤10 MiB videos).
 */
function planParts(p: Plan): { parts: Array<[string, unknown]>; bytes: Record<string, Buffer<ArrayBuffer>> } {
  const parts: Array<[string, unknown]> = [["op", p.op], ["target", p.target], ["body", p.body ?? null]];
  const bytes: Record<string, Buffer<ArrayBuffer>> = {};
  for (const k of Object.keys(p.state ?? {}).sort()) parts.push([`state.${k}`, p.state?.[k] ?? null]);
  for (const k of Object.keys(p.files ?? {}).sort()) {
    const b = readOrNull(p.files?.[k] ?? "");
    if (b) bytes[k] = b;
    parts.push([`file.${k}`, b ? sha256(b) : "unreadable"]);
  }
  return { parts, bytes };
}

const partHash = ([name, value]: [string, unknown]): string => sha256(`${name}\n${canonicalJson(value)}`).slice(0, PART_HEX);

/**
 * `v1.<32 hex over every part>.<4 hex per part>`. The per-part hashes only
 * name what changed in a refusal; the full hash is what is checked.
 */
function planIdOf(parts: Array<[string, unknown]>): string {
  const all = sha256(`verse8-plan/${PLAN_VERSION}\n${canonicalJson(parts)}`).slice(0, 32);
  return `${PLAN_VERSION}.${all}.${parts.map(partHash).join("")}`;
}

export function planId(p: Plan): string {
  return planIdOf(planParts(p).parts);
}

/** A planId that matched: run it, uploading `files` (field → the bytes that were hashed). */
export interface PlanApproved {
  approved: true;
  files: Record<string, Buffer<ArrayBuffer>>;
}

export function isApproved(g: unknown): g is PlanApproved {
  return typeof g === "object" && g !== null && (g as { approved?: unknown }).approved === true;
}

const PLAN_ID_RE = new RegExp(`^${PLAN_VERSION}\\.[0-9a-f]{32}\\.((?:[0-9a-f]{${PART_HEX}})+)$`);
const RE_PREVIEW = "Get a fresh preview (call again without planId), show it to the user, and run with the planId it returns.";

/** Approved (with the hashed file bytes) when `given` is this plan's id; otherwise the refusal, naming what differs. */
export function checkPlan(p: Plan, given: string): PlanApproved | OpFail {
  const { parts, bytes } = planParts(p);
  if (planIdOf(parts) === given) return { approved: true, files: bytes };
  const m = PLAN_ID_RE.exec(given);
  if (!m) return opFail("plan_mismatch", `Nothing was changed: planId is not one a preview of this tool returned. ${RE_PREVIEW}`);
  const old = m[1].match(new RegExp(`.{${PART_HEX}}`, "g")) ?? [];
  const differs = parts.filter((part, i) => old[i] !== partHash(part));
  const changed = differs.map(([name, value]) =>
    name.startsWith("state.") ? { part: name, now: value } : { part: name },
  );
  const reasons: string[] = [];
  const names = differs.map(([n]) => n);
  if (names.includes("op")) reasons.push("the planId is for another action");
  else if (names.includes("target")) reasons.push("the planId is for another target");
  else {
    if (names.includes("body") || old.length !== parts.length) reasons.push("the arguments differ from the preview's");
    const st = names.filter((n) => n.startsWith("state.")).map((n) => n.slice(6));
    if (st.length > 0) reasons.push(`the current ${st.join(", ")} changed since the preview (see changed[].now)`);
    const fl = names.filter((n) => n.startsWith("file.")).map((n) => n.slice(5));
    if (fl.length > 0) reasons.push(`the local file of ${fl.join(", ")} changed since the preview`);
  }
  if (reasons.length === 0) reasons.push("the plan differs from the preview's");
  return opFail("plan_mismatch", `Nothing was changed: ${reasons.join("; ")}. ${RE_PREVIEW}`, { changed });
}

/** The `planId` input of verse8_verse / verse8_vxshop. */
export const planIdField = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Changing actions: omit it to preview (nothing changes; the preview returns a planId). After the user approves, call again with the same arguments plus that planId to run it. Refused when the arguments or the current values changed since the preview.",
  );

/** Text returned with every preview. */
export const PLAN_NEXT =
  "Nothing was changed. Show `changes` (and any `warnings`) to the user; after they approve, call again with the same arguments plus this planId. It is refused if the arguments or these current values change in between.";

/**
 * The gate every changing action goes through. Without planId: the preview,
 * with its planId. With a matching planId: approved — run it, uploading the
 * returned file bytes. Otherwise the refusal.
 */
export function planGate<T extends { action: string }>(
  p: Plan,
  given: string | undefined,
  preview: T,
): (T & { ok: true; dryRun: true; planId: string; next: string }) | OpFail | PlanApproved {
  if (given === undefined) return { ok: true, ...preview, dryRun: true, planId: planId(p), next: PLAN_NEXT };
  return checkPlan(p, given);
}

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
