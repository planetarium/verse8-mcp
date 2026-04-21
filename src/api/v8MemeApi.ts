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

export interface CreateProjectSuccess {
  cloneUrl: string;
  projectId: string;
  [k: string]: unknown;
}

export interface CreateProjectNotYetAvailable {
  error: "not_yet_available";
  hint: string;
}

export interface CreateProjectInput {
  gameType: string;
  title: string;
  preset: string;
}

import { parseOverrideHost } from "../util/hostAllowlist.js";

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

function isStubProjects(): boolean {
  return process.env.VERSE8_STUB_PROJECTS === "1";
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
  throw new Error(`device/authorize failed: HTTP ${status} ${raw}`);
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

  const err = (data && "error" in data ? data : { error: `http_${status}`, error_description: raw }) as DeviceTokenPending;
  return { ok: false, error: err, status };
}

export async function verifyToken(token: string): Promise<{ ok: true; profile: VerifyResponse } | { ok: false; status: number; body: string }> {
  const { status, data, raw } = await getJson<VerifyResponse>(
    `${getBaseUrl()}/v1/auth/verify`,
    token,
  );
  if (status === 200 && data) return { ok: true, profile: data };
  return { ok: false, status, body: raw };
}

export async function createProject(
  input: CreateProjectInput,
  token: string,
): Promise<
  | { ok: true; project: CreateProjectSuccess }
  | { ok: false; notYetAvailable: true; hint: string }
  | { ok: false; status: number; body: string }
> {
  if (isStubProjects()) {
    return {
      ok: false,
      notYetAvailable: true,
      hint: "backend API pending — use gitlab.verse8.io UI to create the repo, then clone locally",
    };
  }

  const { status, data, raw } = await postJson<CreateProjectSuccess>(
    `${getBaseUrl()}/v1/projects`,
    input,
    token,
  );

  if (status === 404 || status === 501) {
    return {
      ok: false,
      notYetAvailable: true,
      hint: "backend API pending — use gitlab.verse8.io UI to create the repo, then clone locally",
    };
  }

  if (status >= 200 && status < 300 && data && typeof data.cloneUrl === "string" && typeof data.projectId === "string") {
    return { ok: true, project: data };
  }

  return { ok: false, status, body: raw };
}
