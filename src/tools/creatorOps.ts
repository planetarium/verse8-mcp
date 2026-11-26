import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { redactHead, safeErrorHint, safeHint } from "../util/redact.js";
import { getCreateBaseUrl } from "./preview.js";
import { getVerse8WebBaseUrl } from "../api/verse8Web.js";
import { rejectedTokenHint, type TokenWhere } from "../context/token.js";

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
//                 through planGate / confirmGate.
//   preview       can be undone and costs nothing: the planId of its own
//                 preview is enough (above).
//   user_confirm  costs money, changes what is public, affects other people,
//                 or is hard to undo: after the planId matched, the user is
//                 asked in the host's own prompt (MCP elicitation) and it
//                 runs only on their "Run". The answer comes from the host
//                 to this server; it does not pass through the agent.
//
// RUN_RULES is the one table of it: every op that calls planGate (or, for a
// tool without a planId, confirmGate) has a row,
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
  /**
   * Other changes of the same request, each `field: current → new`. Shown
   * after `change` as far as the prompt has room; what does not fit is
   * counted in the prompt, never cut silently. The target, `change` and
   * `undo` are kept whole first.
   */
  also?: string[];
  /** Words before `also` (default "also changes"). */
  alsoLabel?: string;
}

export interface RunRule {
  condition: GatedCondition | ((p: Plan) => GatedCondition);
  /** Required for a rule that can answer user_confirm. */
  confirm?: (p: Plan) => ConfirmText;
  /** Where the same thing is done on the web, for hosts that cannot ask. */
  portal?: (p: Plan) => string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/**
 * Text as a prompt may carry it. Format characters go first (bidi
 * overrides, zero-width characters, the byte-order mark: they reorder or
 * hide what the user reads), then any whitespace run becomes one space
 * (`\s` covers the line and paragraph separators; NEL is added), then the
 * remaining control characters go. A game title, an item name or a comment
 * comes from outside and can hold any of them.
 */
const oneLine = (s: string): string => s.replace(/\p{Cf}/gu, "").replace(/[\s\x85]+/g, " ").replace(/\p{Cc}/gu, "").trim();
/** The same, for every string inside a value (keys too), before it is written out as JSON. */
function cleaned(v: unknown): unknown {
  if (typeof v === "string") return oneLine(v);
  if (Array.isArray(v)) return v.map(cleaned);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [oneLine(k), cleaned(x)]));
  return v;
}
/** One value in full, never cut — for the values the user is agreeing to (purchase limits, sale dates). */
function full(v: unknown): string {
  if (v === null || v === undefined) return "none";
  const c = cleaned(v);
  return typeof c === "string" ? JSON.stringify(c) : canonicalJson(c);
}
const MAX_VALUE_CHARS = 80;
/**
 * One value as the prompt shows it: a string quoted, anything else as
 * canonical JSON, nothing as "none". Cut at MAX_VALUE_CHARS so one long
 * value (a description) cannot push the other changes out of the prompt.
 */
function shown(v: unknown): string {
  const s = full(v);
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s;
}
/**
 * `current → new`, each cut like `shown`. Two long values that differ only
 * past the cut would read as the same text on both sides, so that case is
 * said in words instead of looking like no change.
 */
function arrow(from: unknown, to: unknown): string {
  const a = shown(from);
  const b = shown(to);
  return a === b && full(from) !== full(to) ? `${a} → ${b} (they differ past the part shown — see the preview)` : `${a} → ${b}`;
}
/** Create-body fields the prompt already names in its own words (or that only repeat the target). */
const CREATE_SHOWN = new Set(["verseId", "productId", "name", "price", "stock", "isActive", "purchaseConstraints"]);
// The web pages a refusal points to. Addresses as the portal serves them
// (verse8-vibe: the creator host rewrites `/creations/<id>` to the per-game
// creator page, which looks the game up by the same id this server uses;
// its tabs are General / Analytics / Server / VX Shop and carry no address
// of their own, so the tab is named in words).
const creatorPage = (p: Plan): string => `${getCreateBaseUrl()}/creations/${encodeURIComponent(String(p.target.verseId ?? ""))}`;
const vxShopPortal = (p: Plan): string =>
  `the game's creator page, VX Shop tab: ${creatorPage(p)} (open the "VX Shop" tab and use the item's edit dialog — the on/off switch and Restore on that tab send no purchase limits, and the server then removes the item's limits)`;
const visibilityPortal = (p: Plan): string => `the game's creator page, General tab: ${creatorPage(p)} (the "Visibility" select)`;

// Who can see a game, narrowest first. A change is widening when it moves
// to a later entry; a value this list does not know is treated as widening.
// No current value (a game not published yet, or a record without one)
// counts as the narrowest: nobody but the owner sees it now.
// This is the one rule for every action that sends a visibility to the
// server — the game page update and the deploy's publish.
const VISIBILITY_ORDER = ["Private", "Unlisted", "Public"];
const VISIBILITY_MEANS: Record<string, string> = {
  Private: "only you can open it",
  Unlisted: "anyone with the link can play, not listed",
  Public: "listed on Verse8 for everyone",
};
function widensVisibility(p: Plan): boolean {
  const from = rec(p.state).visibility ?? null;
  const to = rec(p.body).visibility;
  if (to === undefined || to === from) return false;
  const a = from === null ? 0 : VISIBILITY_ORDER.indexOf(String(from));
  const b = VISIBILITY_ORDER.indexOf(String(to));
  return a < 0 || b < 0 || b > a;
}
const userTags = (v: unknown): unknown => (Array.isArray(v) ? v.filter((t) => !(typeof t === "string" && t.startsWith("__"))) : v);
const DEPLOY_OP = "verse8_deploy.publish";
function visibilityConfirm(p: Plan): ConfirmText {
  const body = rec(p.body);
  const state = rec(p.state);
  const known = state.visibility !== null && state.visibility !== undefined;
  const from = known ? String(state.visibility) : state.published === false ? "not published yet" : "not set";
  const to = String(body.visibility);
  const review = (!known || from === "Private") && Array.isArray(state.tag) && state.tag.includes("__review_required");
  // Everything else the same request changes, with its current and new value.
  const also = Object.keys(body)
    .filter((k) => k !== "visibility" && k !== "sendNotificationToFollowers")
    .sort()
    .map((k) => `${k}: ${arrow(k === "tag" ? userTags(state[k]) : state[k], body[k])}`);
  return {
    question: p.op === DEPLOY_OP ? "Deploy this game so that more people can see it?" : "Make this game visible to more people?",
    target: `Game: ${shown(state.title)} (verse ${p.target.verseId})`,
    change:
      `Visibility: ${from} → ${to} (${VISIBILITY_MEANS[to] ?? "more people can see it"})` +
      (p.op === DEPLOY_OP ? "; applied when this deploy publishes the new build" : "") +
      (review ? "; this starts a Verse8 review and the game may stay hidden until it passes" : ""),
    also,
    undo: `Undo: you can set it ${known ? `back to ${from}` : "to Private afterwards"}; people who opened or saw it meanwhile have seen it`,
  };
}
const deployPortal = (p: Plan): string =>
  `the web after deploying without widening it — pass visibility "Private" on a first deploy, or leave visibility out on an update — then use the game's creator page, General tab: ${creatorPage(p)} (the "Visibility" select)`;
// The portal deletes a comment from the comment panel of the game's own
// page, with the trash button next to the comment (verse8-vibe
// CommentOverlay). The page takes the verse id and redirects to its short
// address.
const commentPortal = (p: Plan): string =>
  `the game's page: ${getVerse8WebBaseUrl()}/${encodeURIComponent(String(p.target.verseId ?? ""))} (open the comments and press the trash button next to the comment)`;
const SALE_UNDO = "Undo: you can stop the sale or change the price again; purchases already made stay as they are";

// ── when a VX Shop item can be bought ──
//
// The server sells an item when it is active, not archived, has stock, and
// now is inside its purchase dates (g2-sync vxShop.service
// createConfirmedPurchase / validatePurchaseConstraints). One function
// reads that from an item's values, and every shop rule asks it about the
// item before and after the change:
//
//   0  cannot be bought, and will not become buyable by itself
//   1  scheduled: everything is set, the start date is still ahead
//   2  can be bought now
//
// A change that raises the level starts a sale — whichever field does it:
// the on-sale flag, a restore, stock from 0, a start date removed, an end
// date extended. The per-user / per-period count limits are not part of
// it: they bound how much one buyer gets, not whether the item is on sale.

interface VxSaleValues {
  isActive: unknown;
  isArchived: unknown;
  stock: unknown;
  limits: Record<string, unknown>;
}
type SaleLevel = 0 | 1 | 2;
/** Milliseconds of a date value, or null when there is none (or it does not parse — then it bounds nothing). */
function dateOf(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
export function vxSaleLevel(v: VxSaleValues, now: number = Date.now()): SaleLevel {
  if (v.isActive !== true || v.isArchived === true) return 0;
  if (!(Number(v.stock) >= 1)) return 0;
  const end = dateOf(v.limits.purchaseEndDate);
  if (end !== null && now > end) return 0;
  const start = dateOf(v.limits.purchaseStartDate);
  return start !== null && now < start ? 1 : 2;
}
/** The sale values of a shop plan's item before and after it runs. */
function vxBeforeAfter(p: Plan): { before: VxSaleValues; after: VxSaleValues } {
  const body = rec(p.body);
  const state = rec(p.state);
  if (p.op === "verse8_vxshop.upsert.create") {
    return {
      before: { isActive: false, isArchived: false, stock: 0, limits: {} },
      after: { isActive: body.isActive, isArchived: false, stock: body.stock, limits: rec(body.purchaseConstraints) },
    };
  }
  const before: VxSaleValues = { isActive: state.isActive, isArchived: state.isArchived, stock: state.stock, limits: rec(state.purchaseConstraints) };
  if (p.op === "verse8_vxshop.archive") return { before, after: { ...before, isArchived: body.isArchived } };
  return {
    before,
    after: {
      isActive: "isActive" in body ? body.isActive : state.isActive,
      isArchived: state.isArchived,
      stock: "stock" in body ? body.stock : state.stock,
      // An edit's body always carries the limits it keeps; absent means removed.
      limits: rec(body.purchaseConstraints),
    },
  };
}
/** Whether a shop plan opens purchases (the level rises), and whether it reprices an item that is on sale or scheduled and stays so. */
export function vxSaleKind(p: Plan, now: number = Date.now()): { opens: boolean; reprices: boolean; after: VxSaleValues; level: SaleLevel } {
  const { before, after } = vxBeforeAfter(p);
  const from = vxSaleLevel(before, now);
  const level = vxSaleLevel(after, now);
  return { opens: level > from, reprices: "price" in rec(p.body) && from >= 1 && level >= 1, after, level };
}
/** "buyers can purchase it from <when> [until <end>]" — the dates in full, as the server will apply them. */
function saleWindow(after: VxSaleValues, level: SaleLevel): string {
  const from = level === 1 ? `from ${full(after.limits.purchaseStartDate)}` : "from now on";
  const end = after.limits.purchaseEndDate;
  return `buyers can purchase it ${from}${end === undefined || end === null ? "" : ` until ${full(end)}`}`;
}
/** Each purchase limit that differs, `key: current → new`, in full. */
function limitChanges(now: Record<string, unknown>, to: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(now), ...Object.keys(to)])].sort();
  return keys
    .filter((k) => canonicalJson(now[k] ?? null) !== canonicalJson(to[k] ?? null))
    .map((k) => `${k}: ${full(now[k])} → ${full(to[k])}`);
}

function vxEditConfirm(p: Plan): ConfirmText {
  const body = rec(p.body);
  const state = rec(p.state);
  const { opens, after, level } = vxSaleKind(p);
  const priceChanges = "price" in body;
  const price = priceChanges ? `Price: ${state.price} → ${body.price} VX` : `Price: ${state.price} VX`;
  // What decides whether and how it sells is part of `change`, in full:
  // the price, the stock when it changes, every purchase limit that
  // changes. The body always carries the limits (re-sent when kept), so
  // they are compared with the current ones; absent means removed.
  const core: string[] = [opens ? `${price}; ${saleWindow(after, level)}` : `${price} for every buyer from now on`];
  if ("stock" in body) core.push(`stock: ${full(state.stock)} → ${full(body.stock)}`);
  const limitsNow = rec(state.purchaseConstraints);
  const limitsTo = rec(body.purchaseConstraints);
  const limits = limitChanges(limitsNow, limitsTo);
  if (limits.length > 0) {
    core.push(`${Object.keys(limitsTo).length === 0 ? "ALL purchase limits REMOVED" : "purchase limits"} (${limits.join(", ")})`);
  }
  // Everything else the request changes, each with its current and new value.
  const also = Object.keys(body)
    .filter((k) => !["price", "isActive", "stock", "purchaseConstraints"].includes(k))
    .sort()
    .map((k) => `${k}: ${arrow(state[k], body[k])}`);
  return {
    question: opens
      ? priceChanges
        ? "Start selling this VX Shop item at a new price?"
        : "Start selling this VX Shop item?"
      : "Change the price of a VX Shop item that is on sale?",
    target: `Item: ${shown(state.name)} (item ${p.target.itemId}) in verse ${p.target.verseId}`,
    change: core.join("; "),
    also,
    undo: SALE_UNDO,
  };
}

export const RUN_RULES: Readonly<Record<string, RunRule>> = {
  // Widening who can see the game (Private → Unlisted / Public, Unlisted →
  // Public) asks the user; narrowing it and every other edit is a preview.
  "verse8_verse.update": {
    condition: (p) => (widensVisibility(p) ? "user_confirm" : "preview"),
    confirm: visibilityConfirm,
    portal: visibilityPortal,
  },
  // The deploy's publish sends a visibility too: the same rule decides. It
  // has no planId (confirmGate, below); "preview" here means its own dryRun.
  [DEPLOY_OP]: {
    condition: (p) => (widensVisibility(p) ? "user_confirm" : "preview"),
    confirm: visibilityConfirm,
    portal: deployPortal,
  },
  "verse8_verse.release_note_update": { condition: "preview" },
  // Pinning can be undone (unpin) and changes nothing for anyone else.
  "verse8_verse.comment_pin": { condition: "preview" },
  // A deleted comment cannot be restored, and it is someone else's.
  "verse8_verse.comment_delete": {
    condition: "user_confirm",
    confirm: (p) => {
      const s = rec(p.state);
      return {
        question: "Delete this comment for good?",
        target: `Comment ${p.target.commentId} by ${shown(s.author)} on verse ${p.target.verseId}`,
        change: `Deletes: ${shown(s.content)}` + (s.pinned === true ? "; it is the pinned comment" : ""),
        undo: "Undo: none — a deleted comment cannot be restored, and it counts against the commenter's moderation record",
      };
    },
    portal: commentPortal,
  },
  // Answering a dispute sends the buyer a message; it moves no money and
  // changes nothing public (refunds are not part of it).
  "verse8_vxshop.dispute": { condition: "preview" },
  // The three shop rows share one test (vxSaleKind): does the change open
  // purchases, or reprice an item buyers can buy or are about to?
  // Created sellable it starts a sale; created hidden, without stock or
  // past its end date it is a preview.
  "verse8_vxshop.upsert.create": {
    condition: (p) => (vxSaleKind(p).opens ? "user_confirm" : "preview"),
    confirm: (p) => {
      const b = rec(p.body);
      const { after, level } = vxSaleKind(p);
      const limits = Object.keys(after.limits).sort().map((k) => `${k}: ${full(after.limits[k])}`);
      return {
        question: "Create this VX Shop item and start selling it?",
        target: `Item: ${shown(b.name)} (productId ${shown(b.productId)}) in verse ${p.target.verseId}`,
        change:
          `Price: ${b.price} VX, stock ${b.stock}; ${saleWindow(after, level)}` +
          (limits.length === 0 ? "; no purchase limits" : `; purchase limits (${limits.join(", ")})`),
        // Every other value the request sets.
        also: Object.keys(b).filter((k) => !CREATE_SHOWN.has(k)).sort().map((k) => `${k}: ${shown(b[k])}`),
        alsoLabel: "with",
        undo: SALE_UNDO,
      };
    },
    portal: vxShopPortal,
  },
  "verse8_vxshop.upsert.edit": {
    condition: (p) => {
      const k = vxSaleKind(p);
      return k.opens || k.reprices ? "user_confirm" : "preview";
    },
    confirm: vxEditConfirm,
    portal: vxShopPortal,
  },
  // Restoring an item that can then be bought puts it back on sale.
  "verse8_vxshop.archive": {
    condition: (p) => (vxSaleKind(p).opens ? "user_confirm" : "preview"),
    confirm: (p) => {
      const s = rec(p.state);
      const { after, level } = vxSaleKind(p);
      return {
        question: "Restore this VX Shop item and put it back on sale?",
        target: `Item: ${shown(s.name)} (item ${p.target.itemId}) in verse ${p.target.verseId}`,
        change: `Price: ${s.price} VX, stock ${full(s.stock)}; ${saleWindow(after, level)}`,
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
  /**
   * Whether the host has cancelled the tool call that is asking. Checked
   * after the answer: a "Run" that arrives for a call the host already gave
   * up on (its tool timeout) must not write.
   */
  isCancelled?(): boolean;
}

const MAX_CONFIRM_CHARS = 1200;
/**
 * The one-line prompt of a user-confirm plan, or null when its rule has no
 * text for it. Space goes first to the question, the target, `change` and
 * the undo note; `also` gets what is left, and what does not fit is counted
 * ("N more … not shown here") so the user knows the prompt is not all of it.
 */
export function confirmMessage(p: Plan): string | null {
  const text = Object.prototype.hasOwnProperty.call(RUN_RULES, p.op) ? RUN_RULES[p.op].confirm?.(p) : undefined;
  if (!text) return null;
  const head = oneLine(`${text.question} ${text.target} / ${text.change}`);
  const tail = ` / ${oneLine(text.undo)}`;
  const also = (text.also ?? []).map(oneLine).filter((s) => s.length > 0);
  const label = text.alsoLabel ?? "also changes";
  const withAlso = (n: number): string => {
    const left = also.length - n;
    const note = left === 0 ? "" : `${n === 0 ? "" : " "}(${left} more change${left === 1 ? "" : "s"} not shown here — see the preview)`;
    return n === 0 && left === 0 ? "" : `; ${label} ${also.slice(0, n).join("; ")}${note}`;
  };
  for (let n = also.length; n >= 0; n--) {
    const line = `${head}${withAlso(n)}${tail}`;
    if (line.length <= MAX_CONFIRM_CHARS) return line;
  }
  // Even without `also` it is too long (a rule's own text has no bound when
  // the server holds very long values): cut the middle, keep the undo note,
  // and say so.
  const rest = `${withAlso(0)} (cut — see the preview)${tail}`;
  return `${head.slice(0, Math.max(0, MAX_CONFIRM_CHARS - rest.length - 1))}…${rest}`;
}

function portalOf(p: Plan): string {
  const where = RUN_RULES[p.op]?.portal?.(p) ?? `the Verse8 web (${getCreateBaseUrl()})`;
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
  let cancelled = true;
  try {
    cancelled = host.isCancelled?.() ?? false;
  } catch {
    /* cannot tell: treat as cancelled */
  }
  if (cancelled) {
    return opFail(
      "confirm_unavailable",
      `Nothing was changed: the host cancelled this tool call while the confirmation prompt was open (a tool timeout shorter than the time it took to answer), so the answer was not used. Raise the host's tool timeout for this server, or: ${portalOf(p)}`,
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

/** What a plan needs to run: its condition and, for user_confirm, the prompt. The refusal when its op is not in RUN_RULES. */
function runRequirement(p: Plan): { ok: true; condition: GatedCondition; message: string | null } | OpFail {
  const condition = runConditionOf(p);
  if (condition === null) {
    return opFail("op_not_classified", `Nothing was changed: '${p.op}' has no run condition (RUN_RULES), so it does not run. This is a bug in @verse8/mcp.`);
  }
  const message = condition === "user_confirm" ? confirmMessage(p) : null;
  if (condition === "user_confirm" && message === null) {
    return opFail("op_not_classified", `Nothing was changed: '${p.op}' needs the user's confirmation but has no confirmation text (RUN_RULES). This is a bug in @verse8/mcp.`);
  }
  return { ok: true, condition, message };
}

/** A confirmation that was not needed, or that the user answered with "Run". */
export interface ConfirmPassed {
  confirmed: true;
  runCondition: GatedCondition;
  /** The prompt text of a user_confirm plan. */
  confirmation?: string;
}

export function isConfirmed(g: unknown): g is ConfirmPassed {
  return typeof g === "object" && g !== null && (g as { confirmed?: unknown }).confirmed === true;
}

/**
 * INV-17: A user-confirmation action writes nothing without the user's "Run".
 * The same table and the same prompt for a tool that has no planId of its
 * own (verse8_deploy, whose preview is its dryRun). `ask: false` only
 * reports the condition and the prompt text, for that preview. Otherwise a
 * user_confirm plan asks through `host` and passes only on "Run"; a preview
 * plan passes as it is; an op with no row is refused.
 */
export async function confirmGate(
  p: Plan,
  host: ConfirmHost | undefined,
  opts: { ask: boolean; reread?: Reread } = { ask: true },
): Promise<ConfirmPassed | OpFail> {
  const need = runRequirement(p);
  if (!need.ok) return need;
  const out = { confirmed: true as const, runCondition: need.condition, ...(need.message === null ? {} : { confirmation: need.message }) };
  if (need.message === null || !opts.ask) return out;
  const refused = await askUser(p, need.message, host);
  if (refused) return refused;
  const still = await sameAfterRun(p, planId(p), opts.reread);
  return isApproved(still) ? out : still;
}

// ── what the user saw is what runs ──
//
// The planId is checked before the prompt opens, and a prompt can stay open
// for minutes. So after "Run" the target is read again and the plan built
// again: it runs only if that plan is the one the prompt was written from.
// A price edited on the web meanwhile, limits changed, a game renamed or
// made public — any of it ends in plan_mismatch with nothing written.

/** Reads the target again and returns the plan the action would have now, or the failure of that read. */
export type Reread = () => Promise<Plan | OpFail>;

/** Lets a tool's own code be run again up to the point where it has its plan. */
export interface PlanProbe {
  plan?: Plan;
}
/** What a tool returns when it was only asked for its plan. */
export const PROBED: OpFail = { ok: false, error: "plan_mismatch", hint: "plan probe" };

/** A Reread made from running the tool's code again with a probe. */
export function rereadWith(run: (probe: PlanProbe) => Promise<unknown>): Reread {
  return async () => {
    const probe: PlanProbe = {};
    const r = rec(await run(probe));
    if (probe.plan) return probe.plan;
    const why = typeof r.hint === "string" ? `: ${typeof r.error === "string" ? `${r.error} — ` : ""}${r.hint}` : "";
    return opFail("plan_mismatch", `the target is no longer as the preview showed it${why}`);
  };
}

const AFTER_PROMPT = "Nothing was changed: it changed while the confirmation prompt was open, so the user's Run was not used —";
const AFTER_UPLOAD = "The record was not changed (the media file is already uploaded and unused): it changed while the upload ran —";

/** The plan a re-read gives, or the failure of that read. */
async function readAgain(reread: Reread): Promise<Plan | OpFail> {
  try {
    const fresh = await reread();
    return "op" in fresh && typeof fresh.op === "string" ? (fresh as Plan) : (fresh as OpFail);
  } catch (e) {
    return opFail("plan_mismatch", safeErrorHint(e));
  }
}
const isPlan = (x: Plan | OpFail): x is Plan => "op" in x && typeof x.op === "string";
/** A plan_mismatch that says when the change happened. */
function changedDuring(when: string, mark: Record<string, unknown>, r: OpFail, rePreview: boolean): OpFail {
  return { ...r, error: "plan_mismatch", hint: safeHint(`${when} ${r.hint.replace(/^Nothing was changed: /, "")}${rePreview ? ` ${RE_PREVIEW}` : ""}`), ...mark };
}

/** Approved (with freshly hashed file bytes) when the plan read again is still `id`; otherwise plan_mismatch. */
async function sameAfterRun(p: Plan, id: string, reread: Reread | undefined): Promise<PlanApproved | OpFail> {
  if (!reread) {
    return opFail("op_not_classified", `Nothing was changed: '${p.op}' asks the user but gives no way to read its target again after the answer. This is a bug in @verse8/mcp.`);
  }
  const mark = { afterConfirmation: true };
  const fresh = await readAgain(reread);
  if (!isPlan(fresh)) return changedDuring(AFTER_PROMPT, mark, fresh, true);
  const again = checkPlan(fresh, id);
  return isApproved(again) ? again : changedDuring(AFTER_PROMPT, mark, again, false);
}

/**
 * The same check for the other wait inside a run: a local image or video is
 * uploaded after the gate and before the write, and a large one takes a
 * while. The write re-sends values read before that (the visibility, the
 * purchase limits), so the target is read once more after the upload.
 * Only what was read from the server is compared: the local files were
 * hashed at the gate and those bytes are what was uploaded, whatever the
 * file on disk is by now.
 */
export async function planStillHolds(p: Plan, reread: Reread): Promise<PlanApproved | OpFail> {
  const mark = { afterUpload: true };
  const fresh = await readAgain(reread);
  if (!isPlan(fresh)) return changedDuring(AFTER_UPLOAD, mark, fresh, true);
  const serverSide = (x: Plan): Plan => ({ ...x, files: {} });
  const again = checkPlan(serverSide(fresh), planId(serverSide(p)));
  return isApproved(again) ? again : changedDuring(AFTER_UPLOAD, mark, again, false);
}

/**
 * INV-17: A user-confirmation action writes nothing without the user's "Run".
 * The gate every changing action goes through. Without planId: the preview,
 * with its planId. With a matching planId: approved — run it, uploading the
 * returned file bytes — but a user_confirm action first asks the user
 * through `host` and is approved only on their "Run", and only if the plan
 * built from `reread` after that answer is still the same one. Otherwise
 * the refusal. An op with no row in RUN_RULES is refused either way.
 */
export async function planGate<T extends { action: string }>(
  p: Plan,
  given: string | undefined,
  preview: T,
  host?: ConfirmHost,
  reread?: Reread,
): Promise<(T & { ok: true; dryRun: true; planId: string; next: string; runCondition: GatedCondition; confirmation?: string }) | OpFail | PlanApproved> {
  const need = runRequirement(p);
  if (!need.ok) return need;
  const { condition, message } = need;
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
  return refused ?? (await sameAfterRun(p, given, reread));
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
