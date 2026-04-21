import { resolveMcpServices, type ResolvedService } from "./registry.js";
import { safeHint } from "../util/redact.js";

/**
 * Stateless HTTP proxy to Verse8 MCP services (JSON-RPC 2.0).
 *
 * Discovers tools from all enabled services via initialize/tools/list,
 * caches per-service session IDs, and retries once on session expiry.
 * First-discovery-wins on tool-name collisions across services.
 * (M1b-4 — canonical home; back-compat shim lives in imageMcp.ts.)
 */

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Tool entry enriched with its owning service (for routing call()s). */
export interface ProxiedTool extends UpstreamTool {
  serviceKey: string;
  serviceLabel: string;
  serviceUrl: string;
}

interface ServiceCacheEntry {
  tools: UpstreamTool[];
  sessionId: string | null;
  url: string;
  serviceKey: string;
}

// Per-service cache — keyed by resolved URL so env overrides are honored.
const serviceCache: Map<string, ServiceCacheEntry> = new Map();
const discoveryInFlight: Map<string, Promise<UpstreamTool[]>> = new Map();
// Tool-name → owning service URL, populated as services discover.
const toolOwner: Map<string, string> = new Map();

function jsonRpcHeaders(
  token: string,
  sessionId?: string | null,
): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

async function postRpc(
  url: string,
  body: unknown,
  token: string,
  sessionId?: string | null,
): Promise<{
  status: number;
  json: any;
  sessionId: string | null;
  raw: string;
}> {
  const res = await fetch(url, {
    method: "POST",
    headers: jsonRpcHeaders(token, sessionId),
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json: any = null;
  if (raw.length > 0) {
    try {
      json = JSON.parse(raw);
    } catch {
      // Could be an SSE envelope — extract `data:` line payloads.
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          try {
            json = JSON.parse(line.slice(5).trim());
            break;
          } catch {
            /* keep looking */
          }
        }
      }
    }
  }
  const sid = res.headers.get("mcp-session-id");
  return { status: res.status, json, sessionId: sid, raw };
}

async function discoverServiceTools(
  service: ResolvedService,
  token: string,
): Promise<UpstreamTool[]> {
  const cached = serviceCache.get(service.url);
  if (cached) return cached.tools;
  const inFlight = discoveryInFlight.get(service.url);
  if (inFlight) return inFlight;

  const task = (async (): Promise<UpstreamTool[]> => {
    try {
      const init = await postRpc(
        service.url,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "verse8-mcp-proxy", version: "0.1.0" },
          },
        },
        token,
        null,
      );
      if (init.status < 200 || init.status >= 300) {
        console.error(
          `[verse8-proxy:${service.key}] initialize failed: HTTP ${init.status}`,
        );
        return [];
      }
      const sessionId = init.sessionId;
      await postRpc(
        service.url,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        token,
        sessionId,
      );
      const list = await postRpc(
        service.url,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        token,
        sessionId,
      );
      if (list.status < 200 || list.status >= 300) {
        console.error(
          `[verse8-proxy:${service.key}] tools/list failed: HTTP ${list.status}`,
        );
        return [];
      }
      const tools = (list.json?.result?.tools ?? []) as UpstreamTool[];
      serviceCache.set(service.url, {
        tools,
        sessionId,
        url: service.url,
        serviceKey: service.key,
      });
      for (const t of tools) {
        if (!toolOwner.has(t.name)) {
          toolOwner.set(t.name, service.url);
        }
      }
      return tools;
    } catch (e) {
      console.error(
        `[verse8-proxy:${service.key}] discovery error: ${(e as Error).message}`,
      );
      return [];
    } finally {
      discoveryInFlight.delete(service.url);
    }
  })();

  discoveryInFlight.set(service.url, task);
  return task;
}

/**
 * Discover tools from ALL enabled services, deduplicating by tool name.
 * First-discovery-wins on name collisions (e.g. `asset_wait`). Returns an
 * array annotated with each tool's owning service so callers can route
 * back to the correct upstream.
 */
export async function discoverAllProxiedTools(
  token: string | null,
  projectDir?: string,
): Promise<ProxiedTool[]> {
  if (!token) return [];
  const { services } = resolveMcpServices(projectDir);
  const enabled = services.filter((s) => s.enabled);

  const perServiceResults = await Promise.all(
    enabled.map(async (s) => ({ service: s, tools: await discoverServiceTools(s, token) })),
  );

  const seen = new Set<string>();
  const combined: ProxiedTool[] = [];
  for (const { service, tools } of perServiceResults) {
    for (const t of tools) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      combined.push({
        ...t,
        serviceKey: service.key,
        serviceLabel: service.label,
        serviceUrl: service.url,
      });
    }
  }
  return combined;
}

/**
 * Back-compat alias: prior versions proxied only the image service.
 * New callers should use discoverAllProxiedTools() directly.
 */
export async function discoverImageTools(
  token: string | null,
): Promise<UpstreamTool[]> {
  return discoverAllProxiedTools(token);
}

/**
 * Does the upstream response indicate "the session-id you echoed is no
 * longer valid, please reinit"? Checks both the HTTP status (4xx) and the
 * JSON-RPC error body. Signals we recognize:
 *   - message contains "session" (case-insensitive) anywhere — covers
 *     "No valid session ID provided", "session expired", "invalid session"
 *   - upstream returned 400/401/404 with a body mentioning session
 */
function isSessionExpiredResponse(resp: {
  status: number;
  json: any;
  raw: string;
}): boolean {
  const bodyMentionsSession =
    typeof resp.raw === "string" && /session/i.test(resp.raw);
  const jsonMessage =
    typeof resp.json?.error?.message === "string"
      ? resp.json.error.message
      : "";
  if (/session/i.test(jsonMessage)) return true;
  if (
    (resp.status === 400 || resp.status === 401 || resp.status === 404) &&
    bodyMentionsSession
  ) {
    return true;
  }
  return false;
}

async function postToolsCall(
  url: string,
  name: string,
  args: unknown,
  token: string,
  sessionId: string | null,
): Promise<{ status: number; json: any; sessionId: string | null; raw: string }> {
  return postRpc(
    url,
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args ?? {} },
    },
    token,
    sessionId,
  );
}

/**
 * Forward a `tools/call` to whichever service owns `name`. Returns the raw
 * JSON-RPC result envelope. If the tool name wasn't discovered from any
 * enabled service, returns an `unknown_tool` error.
 *
 * Retries ONCE on an "expired session" signal: evicts the cached session,
 * re-runs discovery (initialize → notifications/initialized → tools/list)
 * to obtain a fresh mcp-session-id, then re-issues the tools/call. Two
 * consecutive session-error replies surface verbatim.
 */
export async function callProxiedTool(
  name: string,
  args: unknown,
  token: string,
): Promise<
  | { ok: true; result: unknown; serviceKey: string }
  | {
      ok: false;
      error: string;
      hint?: string;
      upstream?: unknown;
      serviceKey?: string;
    }
> {
  const url = toolOwner.get(name);
  if (!url) {
    return {
      ok: false,
      error: "unknown_tool",
      hint: `tool '${name}' was not discovered from any enabled proxy service`,
    };
  }
  let cacheEntry = serviceCache.get(url);
  let serviceKey = cacheEntry?.serviceKey;
  let sessionId = cacheEntry?.sessionId ?? null;

  const runCall = async () => {
    try {
      return { ok: true as const, resp: await postToolsCall(url, name, args, token, sessionId) };
    } catch (e) {
      evictServiceCache(url);
      return {
        ok: false as const,
        error: "upstream_unreachable",
        hint: (e as Error).message,
      };
    }
  };

  let first = await runCall();
  if (!first.ok) {
    return { ok: false, error: first.error, hint: first.hint, serviceKey };
  }
  let resp = first.resp;

  // Session-expiry retry: evict cache, rediscover to get a fresh session,
  // then re-issue the same tools/call exactly once.
  if (isSessionExpiredResponse(resp)) {
    evictServiceCache(url);
    const { services } = resolveMcpServices();
    const match = services.find((s) => s.url === url && s.enabled);
    if (match) {
      await discoverServiceTools(match, token);
      cacheEntry = serviceCache.get(url);
      sessionId = cacheEntry?.sessionId ?? null;
      serviceKey = cacheEntry?.serviceKey ?? serviceKey;
      const second = await runCall();
      if (!second.ok) {
        return { ok: false, error: second.error, hint: second.hint, serviceKey };
      }
      resp = second.resp;
    }
    // If the service no longer resolves (e.g. disabled mid-session) or
    // rediscovery failed, fall through and let the first response surface
    // as-is — the caller sees the original upstream message.
  }

  if (resp.status < 200 || resp.status >= 300) {
    return {
      ok: false,
      error: `upstream_http_${resp.status}`,
      // Trim and redact via the central registry. The previous inline
      // regex only covered the Bearer header; safeHint catches PATs,
      // oauth2 URLs, and JSON token fields too. (US-M0-6.)
      hint: safeHint(resp.raw.slice(0, 500)),
      serviceKey,
    };
  }

  if (resp.json && resp.json.error) {
    return {
      ok: false,
      error: "upstream_error",
      hint: resp.json.error.message || "upstream returned JSON-RPC error",
      upstream: resp.json.error,
      serviceKey,
    };
  }

  return { ok: true, result: resp.json?.result, serviceKey: serviceKey ?? "?" };
}

/** Back-compat alias used by server.ts before the multi-service refactor. */
export async function callImageTool(
  name: string,
  args: unknown,
  token: string,
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; error: string; hint?: string; upstream?: unknown }
> {
  const r = await callProxiedTool(name, args, token);
  if (r.ok) return { ok: true, result: r.result };
  return {
    ok: false,
    error: r.error,
    hint: r.hint,
    upstream: (r as { upstream?: unknown }).upstream,
  };
}

/**
 * Drop all cached state for a single upstream URL (used when a service goes
 * unreachable mid-session so the next tools/list re-attempts discovery).
 */
function evictServiceCache(url: string): void {
  serviceCache.delete(url);
  discoveryInFlight.delete(url);
  for (const [toolName, owner] of toolOwner) {
    if (owner === url) toolOwner.delete(toolName);
  }
}

/**
 * Clear all per-service discovery caches and tool ownership. Public API —
 * call after a token change (re-login) so stale session IDs and tool schemas
 * tied to the previous account are discarded.
 */
export function resetProxyCaches(): void {
  serviceCache.clear();
  discoveryInFlight.clear();
  toolOwner.clear();
}

/** Test-only alias — kept for back-compat with the smoke suite. */
export function _resetImageProxyCacheForTests(): void {
  resetProxyCaches();
}
