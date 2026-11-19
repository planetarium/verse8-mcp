import { randomUUID } from "node:crypto";
import { clearExchangeTokenCache, exchangeToken } from "../auth/tokenExchange.js";
import { configuredEndpoint, IpAssetError, isRecord, readBody } from "../util/ipAssetHttp.js";

export const A2A_SCOPES = {
  "message/send": "a2a:message.send",
  "message/stream": "a2a:message.stream",
  "tasks/get": "a2a:task.read",
  "tasks/cancel": "a2a:task.cancel",
  "tasks/resubscribe": "a2a:task.resubscribe",
} as const;
export type A2AMethod = keyof typeof A2A_SCOPES;
const MAX_BYTES = 32 * 1024 * 1024;

export interface A2AReply { resource: string; results: Record<string, unknown>[]; requestId: string; }
/** No automatic resource retry: an interrupted message may already have executed. */
export async function invokeA2A(pool: string, method: A2AMethod, params: Record<string, unknown>, source: string,
  onResult?: (result: Record<string, unknown>) => void): Promise<A2AReply> {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(pool)) throw new IpAssetError("invalid_input");
  const base = configuredEndpoint("VERSE8_A2A_BASE_URL").replace(/\/$/, "");
  const resource = `${base}/${encodeURIComponent(pool)}`;
  const token = await exchangeToken(resource, A2A_SCOPES[method], source);
  const requestId = randomUUID();
  const results: Record<string, unknown>[] = [];
  const accept = (raw: string): void => {
    if (raw === "[DONE]") return;
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { throw new IpAssetError("a2a_invalid_response", true); }
    if (!isRecord(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== requestId) throw new IpAssetError("a2a_invalid_response", true);
    if (envelope.error !== undefined) throw new IpAssetError("a2a_request_failed", true);
    if (!isRecord(envelope.result) || !["task", "message", "status-update", "artifact-update"].includes(String(envelope.result.kind))) throw new IpAssetError("a2a_invalid_response", true);
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
      if (response.status === 401 || response.status === 403) clearExchangeTokenCache();
      await response.body?.cancel();
      throw new IpAssetError(response.status === 401 || response.status === 403 ? "a2a_access_denied" : "a2a_request_failed", true);
    }
    const stream = method === "message/stream" || method === "tasks/resubscribe";
    if (!stream) accept(await readBody(response, MAX_BYTES, "a2a"));
    else {
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) throw new IpAssetError("a2a_invalid_response", true);
      const reader = response.body?.getReader();
      if (!reader) throw new IpAssetError("a2a_invalid_response", true);
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
          if (total > MAX_BYTES) throw new IpAssetError("a2a_response_too_large", true);
          buffer += decoder.decode(value, { stream: true }); drain();
        }
        buffer += decoder.decode(); drain();
        if (buffer.trim()) throw new IpAssetError("a2a_interrupted", true);
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
    if (!results.length) throw new IpAssetError("a2a_interrupted", true);
    return { results, requestId, resource };
  } catch (e) {
    if (e instanceof IpAssetError) throw new IpAssetError(e.code, true);
    throw new IpAssetError("a2a_interrupted", true);
  }
}
