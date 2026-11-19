export class IpAssetError extends Error {
  constructor(readonly code: string, readonly dispatched = false) { super(code); }
}
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Both endpoints are operator configuration. Tool inputs cannot override them. */
export function configuredEndpoint(setting: "VERSE8_TOKEN_EXCHANGE_URL" | "VERSE8_A2A_BASE_URL"): string {
  try {
    const url = new URL(process.env[setting] ?? "");
    if (url.protocol !== "https:" || url.username || url.password || /[?#]/.test(url.href)) throw new Error();
    return url.href;
  } catch {
    throw new IpAssetError(setting === "VERSE8_TOKEN_EXCHANGE_URL" ? "token_exchange_not_configured" : "a2a_not_configured");
  }
}

export async function readBody(response: Response, limit: number, phase: "a2a" | "token_exchange"): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new IpAssetError(`${phase}_invalid_response`);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new IpAssetError(`${phase}_response_too_large`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
