import * as fs from "node:fs";
import * as path from "node:path";
import { parseOverrideHost } from "../util/hostAllowlist.js";

/**
 * Verse8 operates 9 MCP services (image, spritesheet, cinematic, audio,
 * skybox, ui, claythis, crossramp, vectorsearch). verse8-mcp proxies them
 * on the host LLM's behalf. Users can selectively enable/disable proxies
 * via env var or project config — unwanted ones shouldn't clutter the
 * tools/list output.
 *
 * Config precedence (first match wins):
 *   1. env VERSE8_MCP_PROXIES — comma-separated allow-list (opt-in)
 *   2. env VERSE8_MCP_PROXIES_DISABLED — block-list (opt-out)
 *   3. <projectDir>/.verse8/project.json { "disabledMcpProxies": [...] }
 *   4. Default: all services enabled
 *
 * Service URLs can be overridden individually via per-service env vars
 * (VERSE8_IMAGE_MCP_URL, VERSE8_AUDIO_MCP_URL, ...) for dev / staging.
 */

export interface VerseMcpService {
  /** Stable lowercase key — used in config lists. */
  key: string;
  /** Display label that matches the V8 commit metadata mcpServers array. */
  label: string;
  defaultUrl: string;
  envUrlOverride: string;
  description: string;
  /** Recommended HTTP timeout (ms). */
  timeout: number;
}

export const VERSE8_MCP_SERVICES: VerseMcpService[] = [
  {
    key: "image",
    label: "Image",
    defaultUrl: "https://mcp-image-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_IMAGE_MCP_URL",
    description: "2D game asset generation in various styles.",
    timeout: 120_000,
  },
  {
    key: "spritesheet",
    label: "Spritesheet",
    defaultUrl: "https://mcp-spritesheet-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_SPRITESHEET_MCP_URL",
    description: "Sprite sheets for animated game objects.",
    timeout: 180_000,
  },
  {
    key: "cinematic",
    label: "Cinematic",
    defaultUrl: "https://mcp-cinematic-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_CINEMATIC_MCP_URL",
    description: "Text-to-cutscene video generation.",
    timeout: 180_000,
  },
  {
    key: "audio",
    label: "Audio",
    defaultUrl: "https://mcp-audio-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_AUDIO_MCP_URL",
    description: "Music and sound-effect generation.",
    timeout: 180_000,
  },
  {
    key: "skybox",
    label: "Skybox",
    defaultUrl: "https://mcp-skybox-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_SKYBOX_MCP_URL",
    description: "360° environment / skybox generation.",
    timeout: 120_000,
  },
  {
    key: "ui",
    label: "UI",
    defaultUrl: "https://mcp-ui-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_UI_MCP_URL",
    description: "CSS theme styling for game UIs.",
    timeout: 60_000,
  },
  {
    key: "claythis",
    label: "Claythis",
    defaultUrl: "https://mcp-claythis-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_CLAYTHIS_MCP_URL",
    description: "2D image → 3D asset conversion.",
    timeout: 180_000,
  },
  {
    key: "crossramp",
    label: "Crossramp",
    defaultUrl: "https://mcp-crossramp-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_CROSSRAMP_MCP_URL",
    description: "Deploy games and ERC20 tokens on testnet.",
    timeout: 120_000,
  },
  {
    key: "vectorsearch",
    label: "Vectorsearch",
    defaultUrl: "https://mcp-vectorsearch-svc.verse8.io/mcp",
    envUrlOverride: "VERSE8_VECTORSEARCH_MCP_URL",
    description: "Vector DB search over codebase / resources.",
    timeout: 60_000,
  },
];

export type ResolutionSource =
  | "default"
  | "env-allowlist"
  | "env-blocklist"
  | "project-blocklist";

export interface ResolvedService {
  key: string;
  label: string;
  url: string;
  timeout: number;
  enabled: boolean;
  description: string;
}

export interface ResolvedServiceSet {
  services: ResolvedService[];
  source: ResolutionSource;
  enabled: string[];
  disabled: string[];
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function readProjectDisabled(projectDir: string | undefined): string[] {
  if (!projectDir) return [];
  try {
    const raw = fs.readFileSync(
      path.join(projectDir, ".verse8", "project.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      disabledMcpProxies?: unknown;
    };
    if (!Array.isArray(parsed.disabledMcpProxies)) return [];
    return parsed.disabledMcpProxies
      .filter((v): v is string => typeof v === "string")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Host allow-list check for http(s) URL env overrides. Only verse8.io
 * subdomains and localhost loopbacks are accepted — anything else is
 * rejected (with stderr diagnostic) and we fall back to the default URL.
 *
 * Without this check a malicious environment (`VERSE8_IMAGE_MCP_URL=
 * https://evil.example.com/mcp`) would siphon the user's Bearer token on
 * every proxy call.
 */
export function isAllowedOverrideHost(url: string): boolean {
  const p = parseOverrideHost(url);
  if (!p) return false;
  // Non-http schemes (file://, unix://) would fail at fetch transport;
  // accept them so test fixtures and local dev can pass through.
  if (!p.isHttp) return true;
  if (p.isLoopback) return true;
  return p.host === "verse8.io" || p.host.endsWith(".verse8.io");
}

function resolveUrl(service: VerseMcpService): string {
  const override = process.env[service.envUrlOverride];
  if (!override || override.length === 0) return service.defaultUrl;
  if (!isAllowedOverrideHost(override)) {
    console.error(
      `[verse8-registry] rejecting ${service.envUrlOverride}=${override} — host not on .verse8.io allow-list. Using default ${service.defaultUrl}.`,
    );
    return service.defaultUrl;
  }
  return override;
}

/**
 * Parse VERSE8_PROXY_REQUEST_TIMEOUT_MS (milliseconds).
 * Returns undefined when unset / unparseable. Values below 5000 are
 * clamped to 5000 (5 sec minimum) to prevent accidental 0-timeout.
 */
export function parseProxyTimeout(): number | undefined {
  const raw = process.env.VERSE8_PROXY_REQUEST_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(n, 5_000);
}

/**
 * Compute which MCP proxies are active for this process. Pass `projectDir`
 * when the caller knows the verse8 project root (from cwd detection) so the
 * per-project disable list can be honored.
 *
 * Timeout precedence: per-service timeout → VERSE8_PROXY_REQUEST_TIMEOUT_MS
 * env var (when set, it acts as a floor — services with lower timeouts
 * are raised to this value). This lets users guarantee a minimum timeout
 * for all upstream proxy calls (e.g. VERSE8_PROXY_REQUEST_TIMEOUT_MS=120000
 * for a 2-minute floor).
 */
export function resolveMcpServices(
  projectDir?: string,
): ResolvedServiceSet {
  const proxiesEnvRaw = process.env.VERSE8_MCP_PROXIES;
  const allowList = parseCsv(proxiesEnvRaw);
  const blockList = parseCsv(process.env.VERSE8_MCP_PROXIES_DISABLED);
  const projectBlock = readProjectDisabled(projectDir);
  const globalTimeout = parseProxyTimeout();

  // "none" sentinel OR explicit empty string — a user who set the env
  // explicitly but wants no proxies at all. Distinct from "unset" (undefined)
  // which falls through to the default-enable-all branch.
  const explicitlyEmpty = proxiesEnvRaw !== undefined && allowList.length === 0;
  const wantsNone =
    explicitlyEmpty || (allowList.length === 1 && allowList[0] === "none");
  // "all" sentinel — explicit opt-in for everything (equivalent to unset).
  const wantsAll = allowList.length === 1 && allowList[0] === "all";

  let source: ResolutionSource = "default";
  if (wantsNone) {
    source = "env-allowlist";
  } else if (allowList.length > 0 && !wantsAll) {
    source = "env-allowlist";
  } else if (blockList.length > 0) {
    source = "env-blocklist";
  } else if (projectBlock.length > 0) {
    source = "project-blocklist";
  }

  const services: ResolvedService[] = VERSE8_MCP_SERVICES.map((s) => {
    let enabled: boolean;
    if (wantsNone) {
      enabled = false;
    } else if (allowList.length > 0 && !wantsAll) {
      enabled = allowList.includes(s.key);
    } else if (blockList.includes(s.key)) {
      enabled = false;
    } else if (projectBlock.includes(s.key)) {
      enabled = false;
    } else {
      enabled = true;
    }
    return {
      key: s.key,
      label: s.label,
      url: resolveUrl(s),
      timeout: globalTimeout ? Math.max(s.timeout, globalTimeout) : s.timeout,
      description: s.description,
      enabled,
    };
  });

  return {
    services,
    source,
    enabled: services.filter((s) => s.enabled).map((s) => s.key),
    disabled: services.filter((s) => !s.enabled).map((s) => s.key),
  };
}

export function isKnownServiceKey(key: string): boolean {
  return VERSE8_MCP_SERVICES.some((s) => s.key === key.toLowerCase());
}
