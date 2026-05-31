/**
 * Thin fetch wrappers for the agent8-backend project-creation API.
 *
 * The other Verse8 auth base (`v8-meme-api.verse8.io`) lives in `v8MemeApi.ts`.
 * This module talks to a different service: `agent8-backend.verse8.io`, which
 * owns the 4-step "propose template → create project → grant token" flow
 * consumed by `verse8_new_project_{start,confirm}`.
 *
 * Base URL is resolved from `VERSE8_AGENT8_BACKEND_URL`, host-validated via
 * the local `isAllowedAgent8BackendBase` predicate so a malicious env cannot
 * siphon the user's Bearer token to an arbitrary origin. Policy is declared
 * here rather than imported from the proxy registry so this module's
 * allow-set can drift independently from upstream MCP proxy URLs.
 */

import { parseOverrideHost } from "../util/hostAllowlist.js";
import { safeHint } from "../util/redact.js";

const DEFAULT_AGENT8_BACKEND_URL = "https://agent8-backend.verse8.io";

function isAllowedAgent8BackendBase(url: string): boolean {
  const p = parseOverrideHost(url);
  if (!p) return false;
  if (!p.isHttp) return true;
  if (p.isLoopback) return true;
  return p.host === "verse8.io" || p.host.endsWith(".verse8.io");
}

export function getAgent8BackendBaseUrl(): string {
  const override = process.env.VERSE8_AGENT8_BACKEND_URL;
  if (!override || override.length === 0) return DEFAULT_AGENT8_BACKEND_URL;
  if (!isAllowedAgent8BackendBase(override)) {
    console.error(
      `[agent8-backend] rejecting VERSE8_AGENT8_BACKEND_URL=${override} — host not on .verse8.io allow-list. Using default ${DEFAULT_AGENT8_BACKEND_URL}.`,
    );
    return DEFAULT_AGENT8_BACKEND_URL;
  }
  return override;
}

export interface StartCallTemplate {
  name: string;
  label?: string;
  description?: string;
  githubRepo?: string;
  path?: string;
  tags?: string[];
  [k: string]: unknown;
}

export interface StartCallBody {
  templateName: string;
  title?: string;
  projectRepo?: string;
  nextActionSuggestion?: string;
  template: StartCallTemplate;
  [k: string]: unknown;
}

export interface SelectTemplateBody {
  project: {
    id: number | string;
    name?: string;
    path: string;
    description?: string;
    [k: string]: unknown;
  };
  commit?: {
    id?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface GetAccessTokenBody {
  hasToken: boolean;
  tokens?: Array<{
    id?: number | string;
    name?: string;
    expiresAt?: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export interface CreateAccessTokenBody {
  token: string;
  gitUrl: string;
  cloneCommand: string;
  expiresAt: string;
  expiresInDays?: number;
  scopes?: string[];
  accessLevel?: string | number;
  [k: string]: unknown;
}

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; body: string };

/**
 * Parse a response body that may be plain JSON, JSON wrapped in SSE
 * `data: { ... }` framing, or any prefix/suffix garbage around a single
 * JSON object. Returns the decoded value or `undefined` when nothing JSON
 * is recoverable.
 *
 * Motivation: upstream agent8-backend responses have been observed to be
 * either raw JSON OR JSON wrapped in an SSE envelope with a leading
 * `data:` line, especially after recent server-side changes. A brittle
 * `JSON.parse(raw)` would fail on the SSE shape and we'd fall through to
 * a `body: raw` branch that downstream callers treat as a hard failure
 * even though the payload is present.
 */
export function tolerantJsonParse<T>(raw: string): T | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through to SSE / embedded-object scan */
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload) as T;
    } catch {
      /* keep scanning subsequent data: lines */
    }
  }
  // Last resort — find the outermost balanced `{ ... }` substring and try
  // parsing it. Handles cases where the response has HTML preamble or
  // whitespace garbage around a JSON object.
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1)) as T;
    } catch {
      /* give up */
    }
  }
  return undefined;
}

async function postJson<T>(
  url: string,
  body: unknown,
  token: string,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Network failure (refused, DNS, bad-port, TLS) — return structured
    // error envelope so the calling tool can convert to its discriminated
    // failure code instead of crashing the MCP dispatcher.
    return { ok: false, status: 0, body: safeHint(`fetch failed: ${(e as Error).message}`) };
  }
  const raw = await res.text();
  if (res.status >= 200 && res.status < 300) {
    const data = tolerantJsonParse<T>(raw);
    if (data !== undefined) {
      return { ok: true, data, status: res.status };
    }
    return { ok: false, status: res.status, body: raw };
  }
  return { ok: false, status: res.status, body: raw };
}

async function getJson<T>(url: string, token: string): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { ok: false, status: 0, body: safeHint(`fetch failed: ${(e as Error).message}`) };
  }
  const raw = await res.text();
  if (res.status >= 200 && res.status < 300) {
    const data = tolerantJsonParse<T>(raw);
    if (data !== undefined) {
      return { ok: true, data, status: res.status };
    }
    return { ok: false, status: res.status, body: raw };
  }
  return { ok: false, status: res.status, body: raw };
}

/**
 * Step 1 — POST /api/startcall
 * Returns a template proposal for the user's free-form request.
 */
export async function startCall(
  message: string,
  token: string,
): Promise<ApiResult<StartCallBody>> {
  return postJson<StartCallBody>(
    `${getAgent8BackendBaseUrl()}/api/startcall`,
    { message },
    token,
  );
}

export interface SelectTemplateParams {
  templateName: string;
  repo: string;
  path: string;
  title: string;
  projectRepo: string;
}

/**
 * Step 2 — GET /api/select-template?...
 * Creates the GitLab project from the chosen template.
 */
export async function selectTemplate(
  params: SelectTemplateParams,
  token: string,
): Promise<ApiResult<SelectTemplateBody>> {
  const qs = new URLSearchParams({
    templateName: params.templateName,
    repo: params.repo,
    path: params.path,
    title: params.title,
    projectRepo: params.projectRepo,
  });
  return getJson<SelectTemplateBody>(
    `${getAgent8BackendBaseUrl()}/api/select-template?${qs.toString()}`,
    token,
  );
}

/**
 * Step 3 — GET /api/gitlab/project-access-token?projectPath=...
 * Checks whether a usable GitLab PAT already exists for the project.
 */
export async function getProjectAccessToken(
  projectPath: string,
  token: string,
): Promise<ApiResult<GetAccessTokenBody>> {
  const qs = new URLSearchParams({ projectPath });
  return getJson<GetAccessTokenBody>(
    `${getAgent8BackendBaseUrl()}/api/gitlab/project-access-token?${qs.toString()}`,
    token,
  );
}

/**
 * Step 4 — POST /api/gitlab/project-access-token {projectPath}
 * Mints a new 30-day GitLab PAT and returns `{token, gitUrl, cloneCommand}`.
 */
export async function createProjectAccessToken(
  projectPath: string,
  token: string,
): Promise<ApiResult<CreateAccessTokenBody>> {
  return postJson<CreateAccessTokenBody>(
    `${getAgent8BackendBaseUrl()}/api/gitlab/project-access-token`,
    { projectPath },
    token,
  );
}

export interface UploadAttachmentInput {
  file: Blob;
  filename: string;
  cdnPath: string;
  verse: string;
  token: string;
}

export type UploadAttachmentResult =
  | { ok: true; url: string; status: number }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "insufficient_credits"
        | "forbidden"
        | "bad_request"
        | "upload_failed"
        | "upload_response_malformed";
      status: number;
      hint: string;
    };

function classifyUploadStatus(
  status: number,
):
  | "unauthorized"
  | "insufficient_credits"
  | "forbidden"
  | "bad_request"
  | "upload_failed" {
  if (status === 401) return "unauthorized";
  if (status === 402) return "insufficient_credits";
  if (status === 403) return "forbidden";
  if (status >= 400 && status < 500) return "bad_request";
  return "upload_failed";
}

/**
 * POST /api/upload-attachment — multipart file upload to the Verse8 CDN.
 *
 * The backend is a thin proxy to the gameserver: it validates the extension
 * against ATTACHMENT_EXTS, renames the file with a UUID prefix, and forwards
 * the bytes. Returns {ok:true,url} on 2xx with a `url` field, or a
 * discriminated failure envelope otherwise.
 *
 * Error shape notes:
 *   - Middleware 401/402/403 responses are plain text (not JSON).
 *   - Handler 400/500 responses are JSON {success:false, error}.
 *   - Network / JSON-parse failures are mapped to upload_failed.
 *
 * This function does NOT call meme-api's /v1/activity/upload-asset — that
 * bookkeeping endpoint is out of scope for the MCP tool.
 */
export async function uploadAttachment(
  input: UploadAttachmentInput,
): Promise<UploadAttachmentResult> {
  const form = new FormData();
  form.append("file", input.file, input.filename);
  form.append("path", input.cdnPath);
  form.append("verse", input.verse);

  let res: Response;
  try {
    res = await fetch(`${getAgent8BackendBaseUrl()}/api/upload-attachment`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}` },
      body: form,
    });
  } catch (e) {
    return {
      ok: false,
      error: "upload_failed",
      status: 0,
      hint: safeHint(`fetch failed: ${(e as Error).message}`),
    };
  }

  const raw = await res.text();

  if (res.status >= 200 && res.status < 300) {
    const data = tolerantJsonParse<{ success?: boolean; url?: string; error?: string }>(raw);
    if (!data || typeof data.url !== "string" || data.url.length === 0) {
      return {
        ok: false,
        error: "upload_response_malformed",
        status: res.status,
        hint: safeHint(`expected {success,url} JSON; got: ${raw.slice(0, 200)}`),
      };
    }
    return { ok: true, url: data.url, status: res.status };
  }

  const code = classifyUploadStatus(res.status);
  return {
    ok: false,
    error: code,
    status: res.status,
    hint: safeHint(raw.slice(0, 200) || `HTTP ${res.status}`),
  };
}

/**
 * Parse a `cloneCommand` string emitted by the backend into the pieces we
 * need to call `git clone` via `execFileSync` with an argv array (so the
 * embedded PAT never touches a shell).
 *
 * The command shape looks like:
 *   git clone -b develop https://oauth2:glpat-...@gitlab.verse8.io/u/proj.git proj
 * but the parser also accepts `--branch`, other unknown flags, and a missing
 * trailing slug (which is then derived from the URL tail).
 */
export interface ParsedCloneCommand {
  url: string;
  branch: string;
  slug: string;
  passthroughFlags: string[];
}

export function parseCloneCommand(cmd: string): ParsedCloneCommand {
  if (typeof cmd !== "string") {
    throw new Error(
      `cloneCommand is not a string (got ${cmd === null ? "null" : typeof cmd}) — the backend response likely omitted the field`,
    );
  }
  const raw = cmd.trim();
  if (raw.length === 0) {
    throw new Error(
      "cloneCommand is empty — the backend response likely omitted the field",
    );
  }
  if (!raw.toLowerCase().startsWith("git")) {
    throw new Error(`cloneCommand does not start with 'git': ${truncate(cmd)}`);
  }
  const tokens = raw.split(/\s+/).slice(1);
  if (tokens[0] !== "clone") {
    throw new Error(`cloneCommand is not a git clone: ${truncate(cmd)}`);
  }
  const args = tokens.slice(1);

  let url: string | null = null;
  let branch: string | null = null;
  let slug: string | null = null;
  const passthroughFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "-b" || tok === "--branch") {
      const next = args[i + 1];
      if (!next) {
        throw new Error(`cloneCommand missing value for ${tok}`);
      }
      branch = next;
      i += 1;
      continue;
    }
    if (tok.startsWith("--branch=")) {
      branch = tok.slice("--branch=".length);
      continue;
    }
    if (tok.startsWith("-")) {
      // Unknown flag — may have a value in the next token. We cannot know
      // without a flag registry, so pass through as-is and let the next
      // iteration pick up either the value or the next flag/positional.
      passthroughFlags.push(tok);
      continue;
    }
    // Accept any `<scheme>://…` URL token. Production only ever returns
    // https://oauth2:<PAT>@gitlab.verse8.io/…, but test fixtures point at
    // file:// bare repos and staging environments may vary.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) {
      if (!url) {
        url = tok;
        continue;
      }
    }
    // Non-flag, non-URL token. If we already have a URL, this is the slug.
    // Otherwise defer — we may still encounter the URL later.
    if (url && !slug) {
      slug = tok;
      continue;
    }
    // No URL yet and no slot — treat as passthrough so we don't silently drop.
    passthroughFlags.push(tok);
  }

  if (!url) {
    throw new Error(`cloneCommand has no URL token: ${truncate(cmd)}`);
  }
  if (!branch) {
    throw new Error(`cloneCommand has no -b/--branch: ${truncate(cmd)}`);
  }
  if (!slug) {
    slug = deriveSlugFromUrl(url);
  }
  if (!slug) {
    throw new Error(`cloneCommand has no slug and URL has no tail: ${truncate(cmd)}`);
  }

  return { url, branch, slug, passthroughFlags };
}

function deriveSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    if (!tail) return null;
    return tail.replace(/\.git$/i, "");
  } catch {
    return null;
  }
}

function truncate(s: string): string {
  // Redact every known secret shape via the central util/redact registry,
  // then trim to 200 chars to keep error hints scannable. (US-M0-3.)
  const redacted = safeHint(s);
  return redacted.length > 200 ? redacted.slice(0, 200) + "…" : redacted;
}
