import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { deviceAuthorize, deviceToken } from "../api/v8MemeApi.js";
import { getConfigTokenPath } from "../context/token.js";
import { resetProxyCaches } from "../proxy/forward.js";
import { atomicWriteFileSync } from "../util/atomicWrite.js";

/**
 * RFC 8628 device flow, split into two tools.
 *
 *   1. `verse8_login_start()` — request a device code. Returns the
 *      verification URL + user code **immediately** so the host LLM can show
 *      them to the user before any polling begins.
 *   2. `verse8_login_complete({device_code, max_wait_seconds?})` — block up
 *      to max_wait_seconds polling the token endpoint. On success, write the
 *      access token to ${XDG_CONFIG_HOME or ~/.config}/verse8/token.
 *
 * Why split: the previous single blocking tool returned the URL only after
 * its 120s window expired, so by the time the user saw the URL the
 * corresponding device_code was orphaned (the polling loop had already
 * terminated). Splitting the flow lets the LLM surface the URL in its first
 * response turn, then invoke complete once the user confirms.
 */

export const loginStartInputSchema = z.object({}).strict();

export const loginCompleteInputSchema = z
  .object({
    device_code: z
      .string()
      .min(1)
      .describe("device_code returned by verse8_login_start"),
    max_wait_seconds: z
      .number()
      .int()
      .min(5)
      .max(1800)
      .default(120)
      .describe("max seconds to poll before returning login_timeout"),
  })
  .strict();

export interface LoginStartResult {
  ok: true;
  device_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  user_code: string;
  expires_in: number;
  interval: number;
  next: string;
}

export interface LoginStartError {
  ok: false;
  error: string;
  hint?: string;
}

export interface LoginCompleteOk {
  ok: true;
  saved_to: string;
  profile_hint: string;
}

export interface LoginCompleteError {
  ok: false;
  error: string;
  hint?: string;
  verification_uri?: string;
  user_code?: string;
}

export async function runLoginStart(): Promise<LoginStartResult | LoginStartError> {
  let auth;
  try {
    auth = await deviceAuthorize();
  } catch (e) {
    return { ok: false, error: "device_authorize_failed", hint: (e as Error).message };
  }

  const verificationUri = auth.verification_uri_complete || auth.verification_uri;
  // Best-effort stderr diagnostics for non-MCP hosts; never stdout.
  console.error(`[verse8-login-start] Open: ${verificationUri}`);
  console.error(`[verse8-login-start] Code: ${auth.user_code}`);

  return {
    ok: true,
    device_code: auth.device_code,
    verification_uri: auth.verification_uri,
    verification_uri_complete: auth.verification_uri_complete,
    user_code: auth.user_code,
    expires_in: auth.expires_in,
    interval: auth.interval,
    next: "Display verification_uri_complete + user_code to the user, wait for them to confirm they have approved in the browser, then call verse8_login_complete with the same device_code.",
  };
}

export async function runLoginComplete(
  input: z.infer<typeof loginCompleteInputSchema>,
): Promise<LoginCompleteOk | LoginCompleteError> {
  const deviceCode = input.device_code;
  const maxWaitMs = (input.max_wait_seconds ?? 120) * 1000;
  const deadline = Date.now() + maxWaitMs;
  let interval = 5;

  while (Date.now() < deadline) {
    const resp = await deviceToken(deviceCode);
    if (resp.ok) {
      const tokenPath = getConfigTokenPath();
      try {
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(tokenPath, resp.token.access_token, { mode: 0o600 });
      } catch (e) {
        return {
          ok: false,
          error: "token_write_failed",
          hint: (e as Error).message,
        };
      }
      // New identity → proxy caches keyed by URL may hold stale session IDs
      // and tool schemas tied to the previous bearer. Drop them so the next
      // tools/list rediscovers under the new credentials.
      resetProxyCaches();
      return {
        ok: true,
        saved_to: tokenPath,
        profile_hint: "Call verse8_status to see the logged-in profile.",
      };
    }

    const code = resp.error.error;
    if (code === "authorization_pending") {
      await sleep(interval * 1000);
      continue;
    }
    if (code === "slow_down") {
      interval += 5;
      await sleep(interval * 1000);
      continue;
    }
    if (code === "expired_token") {
      return {
        ok: false,
        error: "expired_token",
        hint: "device_code expired (30-min window). Call verse8_login_start again to get a fresh code.",
      };
    }
    if (code === "access_denied") {
      return {
        ok: false,
        error: "access_denied",
        hint: "user rejected the authorization in the browser",
      };
    }
    return {
      ok: false,
      error: code || `http_${resp.status}`,
      hint: resp.error.error_description,
    };
  }

  return {
    ok: false,
    error: "login_timeout",
    hint: `no authorization received within ${input.max_wait_seconds}s. The device_code is still valid for ~30 minutes — call verse8_login_complete again with the same device_code if the user is still authorizing.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
