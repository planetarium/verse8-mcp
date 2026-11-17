import { createHash, randomUUID } from "node:crypto";

export const ROUTER_SCOPES = {
  "message/send": "a2a:message.send",
  "message/stream": "a2a:message.stream",
  "tasks/get": "a2a:task.read",
  "tasks/cancel": "a2a:task.cancel",
  "tasks/resubscribe": "a2a:task.resubscribe",
} as const;
export type RouterMethod = keyof typeof ROUTER_SCOPES;
const ACCESS = "urn:ietf:params:oauth:token-type:access_token";
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const MAX_BYTES = 32 * 1024 * 1024;
const TOKEN_BYTES = 64 * 1024;
export class RouterError extends Error {
  constructor(readonly code: string, readonly dispatched = false) { super(code); }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** This trust anchor is operator configuration, never a tool argument or remote discovery hint. */
export function routerOrigin(): string {
  try {
    const raw = process.env.VERSE8_ROUTER_URL;
    if (!raw) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch { throw new RouterError("router_not_configured"); }
}

async function readBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new RouterError("router_invalid_response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new RouterError("router_response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
const tokens = new Map<string, { value: string; expiresAt: number }>();
export function clearRouterTokenCache(): void { tokens.clear(); }
async function exchange(origin: string, resource: string, scope: string, source: string): Promise<string> {
  const key = createHash("sha256").update(JSON.stringify([origin, resource, scope, source])).digest("hex");
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 5000) return cached.value;
  tokens.delete(key);
  try {
    const response = await fetch(`${origin}/api/verse8/token`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: GRANT, subject_token_type: ACCESS, requested_token_type: ACCESS,
        subject_token: source, resource, scope }).toString(),
    });
    if (!response.ok) { await response.body?.cancel(); throw new RouterError(response.status < 500 ? "router_access_denied" : "router_unavailable"); }
    const data: unknown = JSON.parse(await readBody(response, TOKEN_BYTES));
    if (!object(data) || data.token_type !== "Bearer" || data.issued_token_type !== ACCESS ||
        typeof data.access_token !== "string" || !/^vicoop-v8-[A-Za-z0-9_-]+$/.test(data.access_token) ||
        typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 300 ||
        typeof data.scope !== "string" || !data.scope.split(" ").includes(scope)) throw new RouterError("router_invalid_response");
    if (tokens.size >= 64) tokens.delete(tokens.keys().next().value!);
    tokens.set(key, { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  } catch (e) {
    if (e instanceof RouterError) throw e;
    // Never expose fetch errors, response text or credentials.
    throw new RouterError("router_unavailable");
  }
}

export interface RouterReply { results: Record<string, unknown>[]; requestId: string; }
/** No automatic resource retry: an interrupted message may already have executed. */
export async function invokeRouter(pool: string, method: RouterMethod, params: Record<string, unknown>, source: string,
  onResult?: (result: Record<string, unknown>) => void): Promise<RouterReply> {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(pool)) throw new RouterError("invalid_input");
  const origin = routerOrigin();
  const resource = `${origin}/api/a2a/${encodeURIComponent(pool)}`;
  const token = await exchange(origin, resource, ROUTER_SCOPES[method], source);
  const requestId = randomUUID();
  const results: Record<string, unknown>[] = [];
  const accept = (raw: string): void => {
    if (raw === "[DONE]") return;
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { throw new RouterError("router_invalid_response", true); }
    if (!object(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== requestId) throw new RouterError("router_invalid_response", true);
    if (envelope.error !== undefined) throw new RouterError("router_request_failed", true);
    if (!object(envelope.result) || !["task", "message", "status-update", "artifact-update"].includes(String(envelope.result.kind))) throw new RouterError("router_invalid_response", true);
    results.push(envelope.result);
    onResult?.(envelope.result);
  };
  try {
    const response = await fetch(resource, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "A2A-Version": "0.3" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) clearRouterTokenCache();
      await response.body?.cancel();
      throw new RouterError(response.status === 401 || response.status === 403 ? "router_access_denied" : "router_request_failed", true);
    }
    const stream = method === "message/stream" || method === "tasks/resubscribe";
    if (!stream) accept(await readBody(response, MAX_BYTES));
    else {
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) throw new RouterError("router_invalid_response", true);
      const reader = response.body?.getReader();
      if (!reader) throw new RouterError("router_invalid_response", true);
      const decoder = new TextDecoder();
      let buffer = "", total = 0;
      const drain = () => {
        // Normalize CRLF only once complete lines are available.
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const event = buffer.slice(0, end);
          const separator = /^\r?\n\r?\n/.exec(buffer.slice(end))![0].length;
          buffer = buffer.slice(end + separator);
          const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) accept(data);
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BYTES) throw new RouterError("router_response_too_large", true);
          buffer += decoder.decode(value, { stream: true }); drain();
        }
        buffer += decoder.decode(); drain();
        if (buffer.trim()) throw new RouterError("router_interrupted", true);
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
    if (!results.length) throw new RouterError("router_interrupted", true);
    return { results, requestId };
  } catch (e) {
    if (e instanceof RouterError) throw new RouterError(e.code, true);
    throw new RouterError("router_interrupted", true);
  }
}
