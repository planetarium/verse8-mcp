import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { redactHead, safeErrorHint, safeHint } from "../util/redact.js";
import { LOGIN_HINT } from "../util/hints.js";
import { getCreateBaseUrl } from "./preview.js";

/**
 * Shared pieces of the creator-operation tools (verse8_verse, verse8_vxshop):
 * error mapping for v8-meme-api answers, the plan gate every changing
 * action goes through, and the table of what each action needs to run
 * (RUN_RULES) with the user confirmation the gate asks for.
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
      ? `${what}: the Verse8 login was rejected. To log in again: ${LOGIN_HINT}.`
      : `${what} failed: HTTP ${r.status} ${message}`;
  return opFail(error, hint, { status: r.status });
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
// runs after the values changed. Nor does it show that the user saw the
// preview — actions where that matters also ask the user (run conditions,
// below).

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
    "Changing actions: omit it to preview (nothing changes; the preview returns a planId). After the user approves, call again with the same arguments plus that planId to run it. Refused when the arguments or the current values changed since the preview. Actions whose preview says runCondition user_confirm then ask the user in the host's own prompt and run only if they choose Run.",
  );

/** Text returned with every preview. */
export const PLAN_NEXT =
  "Nothing was changed. Show `changes` (and any `warnings`) to the user; after they approve, call again with the same arguments plus this planId. It is refused if the arguments or these current values change in between.";

/** Added to the preview of a user-confirm action. */
export const CONFIRM_NEXT =
  "This action costs money, changes what is public, affects other people or is hard to undo, so the planId alone does not run it: when called with the planId, the host shows the user the `confirmation` text and it runs only if they choose Run there. You cannot answer that prompt for them.";

// ── run conditions ──
//
// What it takes for an action to run. Three conditions:
//
//   immediate     reads, and changes to local files only — these never come
//                 through planGate.
//   preview       can be undone and costs nothing: the planId of its own
//                 preview is enough (above).
//   user_confirm  costs money, changes what is public, affects other people,
//                 or is hard to undo: after the planId matched, the user is
//                 asked in the host's own prompt (MCP elicitation) and it
//                 runs only on their "Run". The answer comes from the host
//                 to this server; it does not pass through the agent.
//
// RUN_RULES is the one table of it: every op that calls planGate has a row,
// and an op without a row does not run. A row may decide by the plan — the
// same parts the planId hashes — so the condition cannot differ from what
// the preview showed.

export type RunCondition = "immediate" | "preview" | "user_confirm";
type GatedCondition = Exclude<RunCondition, "immediate">;

/** What the confirmation prompt says. Every value comes from the plan. */
export interface ConfirmText {
  /** The question, e.g. "Start selling this VX Shop item?". */
  question: string;
  /** What it acts on. */
  target: string;
  /** The amount or the values that change. */
  change: string;
  /** Whether and how it can be undone. */
  undo: string;
}

export interface RunRule {
  condition: GatedCondition | ((p: Plan) => GatedCondition);
  /** Required for a rule that can answer user_confirm. */
  confirm?: (p: Plan) => ConfirmText;
  /** Where the same thing is done on the web, for hosts that cannot ask. */
  portal?: () => string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const quoted = (v: unknown): string => JSON.stringify(String(v ?? ""));
const vxShopPortal = (): string => `the game's creator page, VX Shop tab (${getCreateBaseUrl()}/creator)`;
const SALE_UNDO = "Undo: you can stop the sale or change the price again; purchases already made stay as they are";

/** An edit starts a sale when it turns isActive on; it reprices a live item when the price changes on one that is on sale and stays so. */
function vxEditKind(p: Plan): { startsSale: boolean; repricesLive: boolean } {
  const body = rec(p.body);
  const state = rec(p.state);
  const startsSale = body.isActive === true;
  const onSale = state.isActive === true && state.isArchived !== true && body.isActive !== false;
  return { startsSale, repricesLive: "price" in body && onSale };
}

function vxEditConfirm(p: Plan): ConfirmText {
  const body = rec(p.body);
  const state = rec(p.state);
  const { startsSale } = vxEditKind(p);
  const priceChanges = "price" in body;
  const others = Object.keys(body).filter((k) => k !== "price" && k !== "isActive" && k !== "purchaseConstraints").sort();
  const price = priceChanges ? `Price: ${state.price} → ${body.price} VX` : `Price: ${state.price} VX`;
  return {
    question: startsSale
      ? priceChanges
        ? "Start selling this VX Shop item at a new price?"
        : "Start selling this VX Shop item?"
      : "Change the price of a VX Shop item that is on sale?",
    target: `Item: ${quoted(state.name)} (item ${p.target.itemId}) in verse ${p.target.verseId}`,
    change:
      (startsSale ? `${price}; buyers can purchase it from now on` : `${price} for every buyer from now on`) +
      (others.length > 0 ? `; also changes ${others.join(", ")}` : ""),
    undo: SALE_UNDO,
  };
}

export const RUN_RULES: Readonly<Record<string, RunRule>> = {
  "verse8_verse.update": { condition: "preview" },
  "verse8_verse.release_note_update": { condition: "preview" },
  "verse8_verse.comment_pin": { condition: "preview" },
  "verse8_verse.comment_delete": { condition: "preview" },
  "verse8_vxshop.dispute": { condition: "preview" },
  // Creating an item on sale starts a sale; created hidden it is a preview.
  "verse8_vxshop.upsert.create": {
    condition: (p) => (rec(p.body).isActive === true ? "user_confirm" : "preview"),
    confirm: (p) => {
      const b = rec(p.body);
      return {
        question: "Create this VX Shop item and start selling it?",
        target: `Item: ${quoted(b.name)} (productId ${b.productId}) in verse ${p.target.verseId}`,
        change: `Price: ${b.price} VX, stock ${b.stock}; buyers can purchase it from now on`,
        undo: SALE_UNDO,
      };
    },
    portal: vxShopPortal,
  },
  "verse8_vxshop.upsert.edit": {
    condition: (p) => {
      const k = vxEditKind(p);
      return k.startsSale || k.repricesLive ? "user_confirm" : "preview";
    },
    confirm: vxEditConfirm,
    portal: vxShopPortal,
  },
  // Restoring an item whose on-sale flag is set puts it back on sale.
  "verse8_vxshop.archive": {
    condition: (p) => (rec(p.body).isArchived === false && rec(p.state).isActive === true ? "user_confirm" : "preview"),
    confirm: (p) => {
      const s = rec(p.state);
      return {
        question: "Restore this VX Shop item and put it back on sale?",
        target: `Item: ${quoted(s.name)} (item ${p.target.itemId}) in verse ${p.target.verseId}`,
        change: `Price: ${s.price} VX; buyers can purchase it from now on`,
        undo: "Undo: you can archive it again; purchases already made stay as they are",
      };
    },
    portal: vxShopPortal,
  },
};

/** The run condition of a plan, or null when its op has no row in RUN_RULES. */
export function runConditionOf(p: Plan): GatedCondition | null {
  if (!Object.prototype.hasOwnProperty.call(RUN_RULES, p.op)) return null;
  const c = RUN_RULES[p.op].condition;
  return typeof c === "function" ? c(p) : c;
}

// ── user confirmation ──
//
// Rules measured on Claude Code 2.1.332 and Codex CLI 0.164.0-alpha
// (2026-11-25):
//  - the message is ONE line: Claude Code shows the first three lines of a
//    multi-line message and folds the rest;
//  - the FIRST choice is Cancel: Codex opens the prompt with the cursor on
//    the first choice, so a single Enter accepts it;
//  - only an accept that carries the Run choice runs. Decline, cancel, any
//    other value, a prompt that could not be shown — nothing runs.

export const CONFIRM_CANCEL = "Cancel";
export const CONFIRM_RUN = "Run";
/** The form sent with the prompt: one required choice, Cancel first. */
export const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {
    choice: { type: "string" as const, title: "Choice", enum: [CONFIRM_CANCEL, CONFIRM_RUN] },
  },
  required: ["choice"],
};
export type ConfirmSchema = typeof CONFIRM_SCHEMA;

/** The host side of a confirmation: what the MCP connection offers. */
export interface ConfirmHost {
  /** Whether the host declared elicitation when it connected. */
  canAsk: boolean;
  /** Show the prompt and return the host's answer (`action`, and `content` on accept). */
  ask(message: string, schema: ConfirmSchema): Promise<{ action?: unknown; content?: unknown }>;
}

const MAX_CONFIRM_CHARS = 600;
/** Any whitespace run becomes one space (`\s` covers the line and paragraph separators; NEL is added). */
const oneLine = (s: string): string => s.replace(/[\s\x85]+/g, " ").trim();

/** The one-line prompt of a user-confirm plan, or null when its rule has no text for it. */
export function confirmMessage(p: Plan): string | null {
  const text = Object.prototype.hasOwnProperty.call(RUN_RULES, p.op) ? RUN_RULES[p.op].confirm?.(p) : undefined;
  if (!text) return null;
  const line = oneLine(`${text.question} ${[text.target, text.change, text.undo].join(" / ")}`);
  return line.length > MAX_CONFIRM_CHARS ? `${line.slice(0, MAX_CONFIRM_CHARS - 1)}…` : line;
}

function portalOf(p: Plan): string {
  const where = RUN_RULES[p.op]?.portal?.() ?? `the Verse8 web (${getCreateBaseUrl()})`;
  return `To do it anyway, the user can do the same on ${where}.`;
}

/** Ask the user. Resolves to null when they chose Run, otherwise to the refusal. */
async function askUser(p: Plan, message: string, host: ConfirmHost | undefined): Promise<OpFail | null> {
  if (!host || !host.canAsk) {
    return opFail(
      "confirm_unavailable",
      `Nothing was changed: this action runs only after the user confirms it in the host's own prompt, and this host does not offer one (it did not declare MCP elicitation). ${portalOf(p)}`,
      { confirmation: message },
    );
  }
  let answer: { action?: unknown; content?: unknown };
  try {
    answer = await host.ask(message, CONFIRM_SCHEMA);
  } catch (e) {
    return opFail(
      "confirm_unavailable",
      `Nothing was changed: the confirmation prompt could not be shown or answered (${safeErrorHint(e)}). ${portalOf(p)}`,
      { confirmation: message },
    );
  }
  const action = typeof answer?.action === "string" ? answer.action : "none";
  if (action === "accept" && rec(answer.content).choice === CONFIRM_RUN) return null;
  return opFail(
    "user_cancelled",
    `Nothing was changed: the user cancelled it at the confirmation prompt. Do not call again unless the user asks for it. (Runs without a person at the terminal, such as claude -p or the Agent SDK, cancel the prompt by themselves.) ${portalOf(p)}`,
    { answer: action === "accept" ? "accept_without_run" : action },
  );
}

/**
 * INV-16: A user-confirmation action writes nothing without the user's "Run".
 * The gate every changing action goes through. Without planId: the preview,
 * with its planId. With a matching planId: approved — run it, uploading the
 * returned file bytes — but a user_confirm action first asks the user
 * through `host` and is approved only on their "Run". Otherwise the refusal.
 * An op with no row in RUN_RULES is refused either way.
 */
export async function planGate<T extends { action: string }>(
  p: Plan,
  given: string | undefined,
  preview: T,
  host?: ConfirmHost,
): Promise<(T & { ok: true; dryRun: true; planId: string; next: string; runCondition: GatedCondition; confirmation?: string }) | OpFail | PlanApproved> {
  const condition = runConditionOf(p);
  if (condition === null) {
    return opFail("op_not_classified", `Nothing was changed: '${p.op}' has no run condition (RUN_RULES), so it does not run. This is a bug in @verse8/mcp.`);
  }
  const message = condition === "user_confirm" ? confirmMessage(p) : null;
  if (condition === "user_confirm" && message === null) {
    return opFail("op_not_classified", `Nothing was changed: '${p.op}' needs the user's confirmation but has no confirmation text (RUN_RULES). This is a bug in @verse8/mcp.`);
  }
  if (given === undefined) {
    return {
      ok: true,
      ...preview,
      dryRun: true,
      planId: planId(p),
      runCondition: condition,
      ...(message === null ? { next: PLAN_NEXT } : { confirmation: message, next: `${PLAN_NEXT} ${CONFIRM_NEXT}` }),
    };
  }
  const checked = checkPlan(p, given);
  if (!isApproved(checked) || message === null) return checked;
  const refused = await askUser(p, message, host);
  return refused ?? checked;
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
