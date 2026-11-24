/**
 * Thin fetch wrappers for the v8-meme-api backend.
 *
 * Base URL resolves from env `VERSE8_API_URL` (default https://v8-meme-api.verse8.io).
 *
 * These helpers return parsed JSON on success or a typed error shape so the
 * MCP tools can translate to structured LLM-facing error envelopes.
 */

export interface DeviceAuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface DeviceTokenPending {
  error:
    | "authorization_pending"
    | "slow_down"
    | "expired_token"
    | "access_denied"
    | string;
  error_description?: string;
}

export interface VerifyResponse {
  userUid?: number | string;
  handle?: string;
  displayName?: string;
  email?: string;
  walletAddress?: string;
  tier?: string;
  totalPoints?: number;
  role?: string;
  isActivated?: boolean;
  exp?: number;
  [k: string]: unknown;
}

import { parseOverrideHost } from "../util/hostAllowlist.js";
import { safeHint } from "../util/redact.js";

const DEFAULT_API_BASE = "https://v8-meme-api.verse8.io";

/**
 * Host allow-list for VERSE8_API_URL. Bearer tokens are sent to this base
 * on every auth-related call; a malicious env override could redirect the
 * token anywhere. Accept only *.verse8.io hosts plus localhost loopback.
 *
 * Policy is enumerated explicitly here (not delegated to the proxy registry)
 * so the auth-base allow-set can drift independently from the proxy
 * services if requirements ever diverge.
 */
function isAllowedApiBase(url: string): boolean {
  const p = parseOverrideHost(url);
  if (!p) return false;
  if (!p.isHttp) return true;
  if (p.isLoopback) return true;
  return p.host === "verse8.io" || p.host.endsWith(".verse8.io");
}

function getBaseUrl(): string {
  const override = process.env.VERSE8_API_URL;
  if (!override || override.length === 0) return DEFAULT_API_BASE;
  if (!isAllowedApiBase(override)) {
    console.error(
      `[verse8-api] rejecting VERSE8_API_URL=${override} — host not on .verse8.io allow-list. Using default ${DEFAULT_API_BASE}.`,
    );
    return DEFAULT_API_BASE;
  }
  return override;
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<{ status: number; data: T | null; raw: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data: T | null = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = null;
    }
  }
  return { status: res.status, data, raw };
}

async function getJson<T>(url: string, token?: string): Promise<{ status: number; data: T | null; raw: string }> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { method: "GET", headers });
  const raw = await res.text();
  let data: T | null = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = null;
    }
  }
  return { status: res.status, data, raw };
}

export async function deviceAuthorize(): Promise<DeviceAuthorizeResponse> {
  const { status, data, raw } = await postJson<DeviceAuthorizeResponse>(
    `${getBaseUrl()}/v1/auth/device/authorize`,
    {},
  );
  if (status >= 200 && status < 300 && data) return data;
  throw new Error(`device/authorize failed: HTTP ${status} ${safeHint(raw)}`);
}

export async function deviceToken(
  deviceCode: string,
): Promise<{ ok: true; token: DeviceTokenSuccess } | { ok: false; error: DeviceTokenPending; status: number }> {
  const { status, data, raw } = await postJson<DeviceTokenSuccess | DeviceTokenPending>(
    `${getBaseUrl()}/v1/auth/device/token`,
    { device_code: deviceCode },
  );

  if ((status === 200 || status === 201) && data && "access_token" in data && typeof data.access_token === "string") {
    return { ok: true, token: data as DeviceTokenSuccess };
  }

  // INV-13: backend text either way — redact the description.
  const err = (
    data && "error" in data
      ? {
          ...data,
          ...(typeof data.error_description === "string" ? { error_description: safeHint(data.error_description) } : {}),
        }
      : { error: `http_${status}`, error_description: safeHint(raw) }
  ) as DeviceTokenPending;
  return { ok: false, error: err, status };
}

export async function verifyToken(token: string): Promise<{ ok: true; profile: VerifyResponse } | { ok: false; status: number; body: string }> {
  const { status, data, raw } = await getJson<VerifyResponse>(
    `${getBaseUrl()}/v1/auth/verify`,
    token,
  );
  if (status === 200 && data) return { ok: true, profile: data };
  return { ok: false, status, body: safeHint(raw) };
}

/**
 * Verse record as returned by GET /v1/verse/verseId. Only the fields the
 * deploy tool reads are typed; the backend returns many more.
 */
export interface VerseInfo {
  verseId: string;
  title?: string;
  description?: string;
  shortDescription?: string;
  imageUrl?: string;
  videoUrl?: string;
  playUrl?: string;
  category?: string;
  tag?: string[];
  isPublic?: boolean;
  visibility?: "Public" | "Unlisted" | "Private";
  allowRemix?: boolean;
  isMobileSupported?: boolean;
  isOwner?: boolean;
  [k: string]: unknown;
}

export type VerseApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; body: string };

function toVerseResult<T>(r: { status: number; data: T | null; raw: string }): VerseApiResult<T> {
  if (r.status >= 200 && r.status < 300 && r.data) {
    return { ok: true, status: r.status, data: r.data };
  }
  return { ok: false, status: r.status, body: safeHint(r.raw) };
}

/**
 * GET /v1/verse/verseId?verseId= — 404 means the verse has never been
 * published (first deploy); 200 means update. Sends the token so the
 * response carries `isOwner`.
 */
export async function getVerse(verseId: string, token: string): Promise<VerseApiResult<VerseInfo>> {
  const qs = new URLSearchParams({ verseId });
  return toVerseResult(await getJson<VerseInfo>(`${getBaseUrl()}/v1/verse/verseId?${qs.toString()}`, token));
}

/** GET /v1/verse/id-available — `reason` is deleted | invalid | blocked when unavailable. */
export async function checkVerseIdAvailable(
  verseId: string,
  token: string,
): Promise<VerseApiResult<{ verseId: string; available: boolean; reason?: string }>> {
  const qs = new URLSearchParams({ verseId });
  return toVerseResult(await getJson(`${getBaseUrl()}/v1/verse/id-available?${qs.toString()}`, token));
}

/**
 * POST /v1/verse/create — first deploy. Production guards this route with
 * a Cloudflare Turnstile / App Check bot check; a headless call without
 * `x-turnstile-token` is rejected with 403.
 */
export async function createVerse(body: Record<string, unknown>, token: string): Promise<VerseApiResult<VerseInfo>> {
  return toVerseResult(await postJson<VerseInfo>(`${getBaseUrl()}/v1/verse/create`, body, token));
}

/** POST /v1/verse/update/:verseId — update deploy (owner only, no bot check). */
export async function updateVerse(
  verseId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<VerseApiResult<VerseInfo>> {
  return toVerseResult(
    await postJson<VerseInfo>(`${getBaseUrl()}/v1/verse/update/${encodeURIComponent(verseId)}`, body, token),
  );
}

export type V8Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Generic JSON call to v8-meme-api for the creator tools. Any 2xx is `ok`,
 * including 204 with an empty body (`data: null`) — unlike `toVerseResult`.
 * `query` values that are undefined / "" are left out.
 */
export async function v8Request<T>(
  method: V8Method,
  pathname: string,
  opts: { token?: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
): Promise<{ ok: true; status: number; data: T | null } | { ok: false; status: number; body: string }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const url = `${getBaseUrl()}${pathname}${qs.toString() ? `?${qs.toString()}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const raw = await res.text();
  if (res.status >= 200 && res.status < 300) {
    let data: T | null = null;
    if (raw.length > 0) {
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = null;
      }
    }
    return { ok: true, status: res.status, data };
  }
  // INV-13: redact the whole body here: callers cut it for a hint, and a JSON
  // shape cut before its closing quote no longer matches.
  return { ok: false, status: res.status, body: safeHint(raw) };
}
