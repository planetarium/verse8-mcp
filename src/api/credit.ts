import { v8Request } from "./v8MemeApi.js";
import type { JamProject } from "../context/msuProject.js";

/**
 * Credit endpoints on v8-meme-api (g2-sync), the same ones the web settings
 * page reads (verse8-vibe `src/services/api/paymentApi.ts`):
 *   - GET  /v1/credit/user                          → { credits }
 *   - GET  /v1/credit/user/events?eventType=...     → { total, page, limit, events }
 *   - POST /v1/msu/credit/topup                     → { toppedUp, balanceBefore, balanceAfter, delta }
 *   - POST /v1/nine-chronicles/credit/topup         → same, plus an optional `reason`
 *
 * Credit amounts are integer strings in 1e-9 USD units (1 USD = 1e9).
 */

const UNITS_PER_USD = 1_000_000_000n;

/**
 * USD string for a raw credit amount, the way the web shows it
 * (verse8-vibe `formatCreditUsd`): two decimals from one cent up, the exact
 * value below a cent so cheap tool calls do not read "0.00". The sign is
 * kept. Returns null for anything that is not an integer string.
 */
export function formatCreditUsd(raw: unknown): string | null {
  const text = typeof raw === "number" && Number.isInteger(raw) ? String(raw) : raw;
  if (typeof text !== "string" || !/^-?\d+$/.test(text.trim())) return null;
  const value = BigInt(text.trim());
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const integer = abs / UNITS_PER_USD;
  const fraction = (abs % UNITS_PER_USD).toString().padStart(9, "0");
  let out: string;
  if (integer > 0n || fraction.slice(0, 2) !== "00") {
    // Round half up on the third decimal without going through a float.
    const cents = (abs * 100n + UNITS_PER_USD / 2n) / UNITS_PER_USD;
    out = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  } else {
    const significant = fraction.replace(/0+$/, "");
    out = significant ? `0.${significant}` : "0.00";
  }
  return negative && out !== "0.00" ? `-${out}` : out;
}

export type CreditApiResult<T> = { ok: true; data: T } | { ok: false; status: number; body: string };

async function getCredit<T>(
  pathname: string,
  token: string,
  query?: Record<string, string | number | undefined>,
): Promise<CreditApiResult<T>> {
  const r = await v8Request<T>("GET", pathname, { token, query });
  if (!r.ok) return { ok: false, status: r.status, body: r.body };
  if (r.data === null || typeof r.data !== "object") {
    return { ok: false, status: r.status, body: "empty or non-JSON response" };
  }
  return { ok: true, data: r.data };
}

export interface UserCredit {
  credits?: string;
  [k: string]: unknown;
}

export async function getUserCredit(token: string): Promise<CreditApiResult<UserCredit>> {
  return getCredit<UserCredit>("/v1/credit/user", token);
}

export interface ToolUsageEvent {
  requestedToolName?: string;
  actualToolName?: string;
  usageCount?: number;
  [k: string]: unknown;
}

export interface CreditEvent {
  id?: number;
  eventType?: string;
  description?: string;
  createdAt?: string;
  toolUsageEvent?: ToolUsageEvent | null;
  /** Raw amount; omitted when the event has no credit transaction. */
  creditAmount?: string;
  /** Same amount pre-rounded to two decimals by the credit service. */
  creditAmountUsd?: string;
  [k: string]: unknown;
}

export interface CreditEventsPage {
  total?: number;
  page?: number;
  limit?: number;
  events?: CreditEvent[];
}

export async function getToolUsageEvents(
  token: string,
  page: number,
  limit: number,
): Promise<CreditApiResult<CreditEventsPage>> {
  return getCredit<CreditEventsPage>("/v1/credit/user/events", token, { eventType: "toolUsage", page, limit });
}

export const JAM_TOPUP_PATHS: Record<Exclude<JamProject, null>, string> = {
  MSU: "/v1/msu/credit/topup",
  "9C": "/v1/nine-chronicles/credit/topup",
};

export interface JamTopupResponse {
  toppedUp?: boolean;
  balanceBefore?: string;
  balanceAfter?: string;
  delta?: string;
  reason?: string;
}

/**
 * POST the jam's top-up route with no body (the user is the Bearer token).
 * The server decides: it only adds credit at or below $5 and refuses users
 * without the jam's phone verification / agreement (403).
 */
export async function requestJamTopup(
  jam: Exclude<JamProject, null>,
  token: string,
  signal?: AbortSignal,
): Promise<CreditApiResult<JamTopupResponse>> {
  const r = await v8Request<JamTopupResponse>("POST", JAM_TOPUP_PATHS[jam], { token, signal });
  if (!r.ok) return { ok: false, status: r.status, body: r.body };
  return { ok: true, data: r.data ?? {} };
}
