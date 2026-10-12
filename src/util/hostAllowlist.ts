/**
 * Low-level URL parser for env-override host policy decisions. **Policy
 * lives with the caller** — this helper only normalises the URL shape.
 * Each caller (`isAllowedOverrideHost` in proxy/registry, `isAllowedApiBase`
 * in v8MemeApi, etc.) declares its own scheme + domain allow-list
 * explicitly. Centralising URL parsing removes duplicated `new URL(...)` +
 * lowercase + loopback checks; keeping predicates separate prevents
 * accidental policy widening across trust boundaries (Architect Scenario 3).
 */

export interface ParsedOverrideHost {
  host: string;
  protocol: string;
  isHttp: boolean;
  isLoopback: boolean;
}

// INV-3: URL overrides are host-validated
export function parseOverrideHost(url: string): ParsedOverrideHost | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Node wraps IPv6 hostnames in `[...]`; strip so direct string compare works.
  const rawHost = parsed.hostname.toLowerCase();
  const host =
    rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost;
  return {
    host,
    protocol: parsed.protocol,
    isHttp: parsed.protocol === "http:" || parsed.protocol === "https:",
    isLoopback: host === "localhost" || host === "127.0.0.1" || host === "::1",
  };
}
