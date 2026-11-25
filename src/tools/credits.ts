import * as path from "node:path";
import { z } from "zod";
import {
  formatCreditUsd,
  getToolUsageEvents,
  getUserCredit,
  requestJamTopup,
  type CreditEvent,
} from "../api/credit.js";
import { getVerse8WebBaseUrl } from "../api/verse8Web.js";
import { resolveJamProject } from "../context/msuProject.js";
import { loadToken } from "../context/token.js";
import { detectVerseProject } from "../context/verseProject.js";
import { LOGIN_HINT } from "../util/hints.js";
import { safeErrorHint } from "../util/redact.js";
import { isSafeAbsPath } from "../util/safePath.js";
import { isCreditInsufficientError } from "./projectClone.js";
import { projectDirField } from "./verseContext.js";

/**
 * `verse8_credits` — the account's credit balance and what the asset tools
 * actually charged, from the same endpoints as the web settings page. Prices
 * are not hard-coded here: the web's price table is a static list on its own
 * page, while the usage events carry the amount that was really billed.
 * Buying credits is a browser checkout, so the tool only points at it.
 */

export const creditsInputSchema = z
  .object({
    page: z.number().int().min(1).max(1000).optional().describe("Tool-usage page, 1-based (default 1)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Tool-usage events per page (default 20, the web page size)."),
    projectDir: projectDirField.optional(),
  })
  .strict();

export type CreditsInput = z.infer<typeof creditsInputSchema>;

/** Where the user adds credits — the web settings page opens on its Credit section. */
export function creditSettingsUrl(): string {
  return `${getVerse8WebBaseUrl()}/settings`;
}

export interface ToolCharge {
  tool: string | null;
  usageCount: number | null;
  /** Unsigned USD, as the web lists it. */
  amountUsd: string;
  at: string | null;
}

/** Same amount the web shows for an event (verse8-vibe `getEventAmountUsd`). */
export function toolCharge(event: CreditEvent): ToolCharge {
  const fromRaw = formatCreditUsd(event.creditAmount);
  const amount =
    fromRaw !== null ? fromRaw.replace(/^-/, "") : (event.creditAmountUsd ?? "0.00").replace("-", "");
  const usage = event.toolUsageEvent ?? null;
  return {
    tool: usage?.actualToolName ?? usage?.requestedToolName ?? null,
    usageCount: typeof usage?.usageCount === "number" ? usage.usageCount : null,
    amountUsd: amount,
    at: event.createdAt ?? null,
  };
}

export type CreditsResult =
  | {
      ok: true;
      balanceUsd: string;
      toolUsage: { total: number; page: number; limit: number; events: ToolCharge[] };
      settingsUrl: string;
      hint: string;
    }
  | { ok: false; error: "not_logged_in" | "upstream_error" | "upstream_unreachable"; hint: string; status?: number };

export async function runCredits(input: CreditsInput, serverCwd: string = process.cwd()): Promise<CreditsResult> {
  const token = loadToken(path.resolve(input.projectDir ?? serverCwd));
  if (!token) return { ok: false, error: "not_logged_in", hint: LOGIN_HINT };
  const page = input.page ?? 1;
  const limit = input.limit ?? 20;
  const settingsUrl = creditSettingsUrl();
  try {
    const [balance, events] = await Promise.all([getUserCredit(token), getToolUsageEvents(token, page, limit)]);
    if (!balance.ok) {
      return {
        ok: false,
        error: "upstream_error",
        status: balance.status,
        hint: `GET /v1/credit/user failed: HTTP ${balance.status} ${balance.body.slice(0, 200)}`,
      };
    }
    if (!events.ok) {
      return {
        ok: false,
        error: "upstream_error",
        status: events.status,
        hint: `GET /v1/credit/user/events failed: HTTP ${events.status} ${events.body.slice(0, 200)}`,
      };
    }
    const list = Array.isArray(events.data.events) ? events.data.events : [];
    return {
      ok: true,
      balanceUsd: formatCreditUsd(balance.data.credits ?? "0") ?? "0.00",
      toolUsage: {
        total: typeof events.data.total === "number" ? events.data.total : list.length,
        page: typeof events.data.page === "number" ? events.data.page : page,
        limit: typeof events.data.limit === "number" ? events.data.limit : limit,
        events: list.map(toolCharge),
      },
      settingsUrl,
      hint: `Amounts are USD. Credits are bought in the browser at ${settingsUrl} — this tool cannot buy them.`,
    };
  } catch (e) {
    return { ok: false, error: "upstream_unreachable", hint: safeErrorHint(e) };
  }
}

// ── Asset-tool hooks (called by the proxy branch in server.ts) ─────────────

/** Proxied tools that spend credits: every upstream `*_generate` tool. */
export function isAssetGenerationTool(name: string): boolean {
  return name.endsWith("_generate");
}

const TOPUP_TIMEOUT_MS = 10_000;

/**
 * The web container calls the jam top-up around every prompt (agent8
 * apps/container-agent/src/credit/jam-topup.ts). Locally only asset
 * generation spends credits, so this runs right before it. Only a Verse8
 * project is scanned — the scan walks the whole folder, and the server's cwd
 * may be anything. Never throws: a refusal (no phone verification / agreement,
 * balance above $5) or a network error just returns null. Returns one line for
 * the tool result when credit was actually added, since nobody is looking at
 * a balance screen locally.
 */
export async function topupJamCreditBeforeGeneration(projectDir: string, token: string): Promise<string | null> {
  try {
    // projectDir comes straight from the proxied call's arguments here, not
    // through a schema, so it gets the same check every local tool applies.
    if (!isSafeAbsPath(projectDir) || !detectVerseProject(projectDir).isVerse) return null;
    const jam = resolveJamProject(projectDir);
    if (!jam) return null;
    const r = await requestJamTopup(jam, token, AbortSignal.timeout(TOPUP_TIMEOUT_MS));
    if (!r.ok || r.data.toppedUp !== true) return null;
    const added = formatCreditUsd(r.data.delta);
    const after = formatCreditUsd(r.data.balanceAfter);
    const jamName = jam === "MSU" ? "MapleStory Universe" : "Nine Chronicles";
    return `Topped up ${jamName} jam credits${added ? ` by $${added}` : ""}${after ? ` (balance now $${after})` : ""}.`;
  } catch {
    return null;
  }
}

/**
 * When a proxied call failed for lack of credits, the line to add: current
 * balance (if it can be read) and where to buy more. Null when the failure is
 * about something else.
 */
export async function creditShortfallNote(status: number, failureText: string, token: string): Promise<string | null> {
  if (!isCreditInsufficientError(status, failureText)) return null;
  const url = creditSettingsUrl();
  let balance: string | null = null;
  try {
    const r = await getUserCredit(token);
    if (r.ok) balance = formatCreditUsd(r.data.credits ?? "0");
  } catch {
    balance = null;
  }
  return `Not enough Verse8 credits${balance !== null ? ` (balance $${balance})` : ""}. Add credits in the browser at ${url}, then retry. verse8_credits lists what recent tool calls cost.`;
}
