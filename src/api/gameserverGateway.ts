/**
 * Read-only client for the Agent8 game-server gateway's developer API
 * (`/v1/verses/:verse/*`, agent8-gameserver-runtime apps/gateway/src/dev-api).
 * The same API backs the web creator page's Server tab.
 *
 * Auth: `Authorization: Bearer <Verse8 login token>`. The gateway verifies it
 * with the platform auth service and admits only the verse owner (the verse
 * id must start with the token's wallet address); preview verses need the
 * token too. Only GET routes are wrapped here — the same API also has PUT /
 * DELETE routes for the verse database, which this MCP does not expose.
 *
 * Base URL: env `VERSE8_GAMESERVER_URL` (default https://gs-gateway.verse8.io,
 * the host @agent8/gameserver clients connect to). Overrides are limited to
 * *.verse8.io and loopback because the token is sent there.
 */

import { parseOverrideHost } from "../util/hostAllowlist.js";
import { safeHint } from "../util/redact.js";

export const DEFAULT_GAMESERVER_URL = "https://gs-gateway.verse8.io";

/** Ids the gateway accepts in a path segment (verse, collection, item, account). */
export const GATEWAY_ID = /^[A-Za-z0-9._-]+$/;

function isAllowedGatewayBase(url: string): boolean {
  const p = parseOverrideHost(url);
  if (!p || !p.isHttp) return false;
  if (p.isLoopback) return true;
  return p.protocol === "https:" && (p.host === "verse8.io" || p.host.endsWith(".verse8.io"));
}

export function getGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VERSE8_GAMESERVER_URL;
  if (!override) return DEFAULT_GAMESERVER_URL;
  if (!isAllowedGatewayBase(override)) {
    console.error(
      `[verse8-gameserver] rejecting VERSE8_GAMESERVER_URL=${override} — host not on the https *.verse8.io / loopback allow-list. Using ${DEFAULT_GAMESERVER_URL}.`,
    );
    return DEFAULT_GAMESERVER_URL;
  }
  return override.replace(/\/+$/, "");
}

export type GatewayResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const REQUEST_TIMEOUT_MS = 20_000;

/** GET `/v1/verses/<verse><subpath>` and parse JSON. Never throws on HTTP status. */
export async function gatewayGet<T>(
  verse: string,
  subpath: string,
  token: string,
  query: Record<string, string | number | undefined> = {},
): Promise<GatewayResult<T>> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const url = `${getGatewayBaseUrl()}/v1/verses/${encodeURIComponent(verse)}${subpath}${qs.toString() ? `?${qs.toString()}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (res.ok && data !== null) return { ok: true, status: res.status, data: data as T };
  const msg =
    data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : safeHint(raw).slice(0, 300); // INV-13: redact before the cut
  return { ok: false, status: res.status, error: msg };
}

export interface GameLogEntry {
  id?: string;
  timestamp?: number | string;
  level?: string;
  message?: string;
  source?: "lobby" | "room";
  account?: string;
  [k: string]: unknown;
}

/**
 * Read the SSE log stream (`/logs/stream`) for `seconds`, then disconnect.
 * A fresh connection replays the most recent lines (the gateway backfills ~100),
 * then follows. Returns the parsed `log` events in order.
 */
export async function gatewayReadLogStream(
  verse: string,
  token: string,
  opts: { level?: string; seconds: number; maxEntries: number },
): Promise<GatewayResult<{ entries: GameLogEntry[]; truncated: boolean }>> {
  const qs = new URLSearchParams();
  if (opts.level) qs.set("level", opts.level);
  const url = `${getGatewayBaseUrl()}/v1/verses/${encodeURIComponent(verse)}/logs/stream${qs.toString() ? `?${qs.toString()}` : ""}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.seconds * 1000);
  const entries: GameLogEntry[] = [];
  let truncated = false;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      let msg = safeHint(raw).slice(0, 300);
      try {
        const j = JSON.parse(raw) as { error?: unknown };
        if (typeof j.error === "string") msg = j.error;
      } catch {
        /* not JSON */
      }
      return { ok: false, status: res.status, error: msg };
    }
    const decoder = new TextDecoder();
    let buf = "";
    const reader = res.body.getReader();
    // Resolve a pending read when time is up, whether or not the fetch
    // implementation tears the body down on abort.
    const stopped = new Promise<{ done: true; value: undefined }>((resolve) =>
      ctl.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true }),
    );
    try {
      reading: for (;;) {
        const { value, done } = await Promise.race([reader.read(), stopped]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let m: RegExpExecArray | null;
        while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
          const frame = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          const ev = parseSseFrame(frame);
          if (ev && ev.event === "log") {
            try {
              const entry = JSON.parse(ev.data) as GameLogEntry;
              if (ev.id) entry.id = ev.id;
              entries.push(entry);
            } catch {
              /* skip malformed */
            }
            if (entries.length >= opts.maxEntries) {
              truncated = true;
              ctl.abort();
              break reading;
            }
          }
        }
      }
    } catch (e) {
      if (!ctl.signal.aborted) throw e;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
    return { ok: true, status: res.status, data: { entries, truncated } };
  } catch (e) {
    if (ctl.signal.aborted) return { ok: true, status: 200, data: { entries, truncated } };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse one SSE frame (lines up to a blank line). Comments (`:`) yield null. */
export function parseSseFrame(frame: string): { event: string; data: string; id?: string } | null {
  let event = "message";
  const data: string[] = [];
  let id: string | undefined;
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}
