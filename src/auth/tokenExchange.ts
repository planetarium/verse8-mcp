import { createHash } from "node:crypto";
import { configuredEndpoint, IpAssetError, isRecord, readBody } from "../util/ipAssetHttp.js";

const ACCESS = "urn:ietf:params:oauth:token-type:access_token";
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const TOKEN_BYTES = 64 * 1024;
const tokens = new Map<string, { value: string; expiresAt: number }>();
export function clearExchangeTokenCache(): void { tokens.clear(); }
export async function exchangeToken(resource: string, scope: string, source: string): Promise<string> {
  const endpoint = configuredEndpoint("VERSE8_TOKEN_EXCHANGE_URL");
  const key = createHash("sha256").update(JSON.stringify([endpoint, resource, scope, source])).digest("hex");
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 5000) return cached.value;
  tokens.delete(key);
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: GRANT, subject_token_type: ACCESS, requested_token_type: ACCESS,
        subject_token: source, resource, scope }).toString(),
    });
    if (!response.ok) { await response.body?.cancel(); throw new IpAssetError(response.status < 500 ? "token_exchange_access_denied" : "token_exchange_unavailable"); }
    const raw = await readBody(response, TOKEN_BYTES, "token_exchange");
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new IpAssetError("token_exchange_invalid_response"); }
    if (!isRecord(data) || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer" ||
        data.issued_token_type !== ACCESS || typeof data.access_token !== "string" ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(data.access_token) || /\s/.test(data.access_token) ||
        typeof data.scope !== "string" || !data.scope.split(" ").includes(scope) ||
        typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0 || data.expires_in > 300) {
      throw new IpAssetError("token_exchange_invalid_response");
    }
    if (tokens.size >= 64) tokens.delete(tokens.keys().next().value!);
    tokens.set(key, { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  } catch (e) {
    if (e instanceof IpAssetError) throw e;
    // Never expose fetch errors, response text or credentials.
    throw new IpAssetError("token_exchange_unavailable");
  }
}
