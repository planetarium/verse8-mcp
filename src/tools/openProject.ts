import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { loadToken } from "../context/token.js";
import { safeHint } from "../util/redact.js";
import { isSafeAbsPath } from "../util/safePath.js";
import { LOGIN_HINT } from "../util/hints.js";
import {
  buildWebEditorLink,
  deriveProjectPathFromOrigin,
  getCreateBaseUrl,
} from "./preview.js";
import {
  checkCloneTargetLocal,
  cloneAndAttach,
  grantCloneAccess,
  type CloneAndAttachResult,
  type GrantCloneAccessResult,
} from "./projectClone.js";

/**
 * `verse8_open_project` — bring an existing Verse8 game that is not cloned
 * here yet onto this machine: grant a project token → `git clone` →
 * attach, in one call. Never creates a project and never overwrites a folder.
 */

export const openProjectInputSchema = z
  .object({
    project: z.string().min(1),
    targetDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "targetDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
      })
      .optional(),
  })
  .strict();

export type OpenProjectInput = z.infer<typeof openProjectInputSchema>;

export type ProjectRefSource = "path" | "editor_url" | "gitlab_url";

export type ResolveProjectRefResult =
  | { ok: true; projectPath: string; source: ProjectRefSource }
  | { ok: false; error: "invalid_input" | "environment_mismatch"; hint: string };

const GITLAB_HOST = "gitlab.verse8.io";
const EDITOR_PATHNAME = "/creator/editor";
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

const ACCEPTED_FORMS =
  "Pass one of: a project path like `owner/game-slug`, the web editor URL (`<create host>/creator/editor?chat=owner/game-slug`), or `https://gitlab.verse8.io/owner/game-slug`.";

function normalizeProjectPath(raw: string): string | null {
  // GitLab page paths put `/-/` between the project and the page
  // (`owner/slug/-/tree/develop`, `/-/blob/…`, `/-/merge_requests/…`); `-` is
  // never a project path segment, so everything from it on is dropped.
  const projectPart = raw.trim().split(/\/-(?:\/|$)/)[0];
  const trimmed = projectPart.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (trimmed.length === 0) return null;
  const segments = trimmed.split("/");
  if (segments.length < 2) return null;
  for (const s of segments) {
    if (!SEGMENT_RE.test(s) || s === "." || s === "..") return null;
  }
  return segments.join("/");
}

/**
 * Turn the user's verbatim `project` string into a GitLab project path.
 *
 * Accepts a bare `owner/slug` path, the web editor URL of the environment
 * this server is configured for (`VERSE8_CREATE_URL`), or a gitlab.verse8.io
 * URL (GitLab is shared by every environment). An editor URL of a different
 * environment is `environment_mismatch` rather than a silent switch: the
 * login token belongs to one environment, so a switch would fail auth later.
 */
export function resolveProjectRef(
  raw: string,
  createBaseUrl: string = getCreateBaseUrl(),
): ResolveProjectRefResult {
  const input = raw.trim();
  const invalid = (why: string): ResolveProjectRefResult => ({
    ok: false,
    error: "invalid_input",
    hint: safeHint(`${why} ${ACCEPTED_FORMS}`),
  });

  // A host typed without a scheme ("create.verse8.io/creator/editor?...").
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : /^[^/\s]*\.verse8\.io(\/|\?|$)/i.test(input)
      ? `https://${input}`
      : null;

  if (withScheme === null) {
    const projectPath = normalizeProjectPath(input);
    if (!projectPath) {
      return invalid("`project` is not a valid project path (need at least `owner/slug`; letters, digits, `.`, `_`, `-`).");
    }
    return { ok: true, projectPath, source: "path" };
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return invalid("`project` looks like a URL but could not be parsed.");
  }
  if (url.username || url.password) {
    // Never echo the value — it carries credentials.
    return invalid("`project` URL must not contain credentials.");
  }
  const host = url.hostname.toLowerCase();

  if (host === GITLAB_HOST) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return invalid("gitlab.verse8.io URL has malformed percent-encoding.");
    }
    const projectPath = normalizeProjectPath(decoded);
    if (!projectPath) return invalid("gitlab.verse8.io URL has no `owner/slug` path.");
    return { ok: true, projectPath, source: "gitlab_url" };
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  const chat = url.searchParams.get("chat");
  const isEditorUrl = pathname === EDITOR_PATHNAME && chat !== null;
  if (!isEditorUrl) {
    return invalid(`URL is not a Verse8 web editor URL (expected \`${EDITOR_PATHNAME}?chat=...\`).`);
  }

  let createHost = "";
  try {
    createHost = new URL(createBaseUrl).hostname.toLowerCase();
  } catch {
    /* fall through to mismatch */
  }
  if (host !== createHost) {
    return {
      ok: false,
      error: "environment_mismatch",
      hint: safeHint(
        `The editor URL is on ${host}, but this MCP server is configured for ${createHost || "<unknown>"} (VERSE8_CREATE_URL). The login token belongs to one environment, so the project cannot be opened here. Point the server at the matching environment (the VERSE8_*_URL settings in the MCP server's env) and log in again, or pass the project path instead if the project lives in this environment.`,
      ),
    };
  }

  // The editor appends its own query to the path inside `chat`
  // (`chat=owner%2Fslug%3Fkey%3Dvalue`) — keep only the path part.
  const projectPath = normalizeProjectPath(chat.split(/[?#]/)[0]);
  if (!projectPath) return invalid("The editor URL's `chat` value is not an `owner/slug` path.");
  return { ok: true, projectPath, source: "editor_url" };
}

type WithProjectPath<T> = T extends { ok: false } ? T & { projectPath: string } : never;

export type OpenProjectResult =
  | {
      ok: true;
      projectDir: string;
      projectPath: string;
      gitUrl: string;
      branch: string;
      tokenExpiresAt?: string;
      webEditor: { url: string };
      nextCallRequires: { projectDir: string };
    }
  | Extract<ResolveProjectRefResult, { ok: false }>
  | { ok: false; error: "not_logged_in"; hint: string }
  | { ok: false; error: "open_in_flight"; hint: string; projectPath: string }
  | {
      ok: false;
      error: "invalid_parent" | "missing_git";
      hint: string;
      projectPath: string;
    }
  | {
      ok: false;
      error: "clone_target_exists";
      hint: string;
      projectPath: string;
      projectDir: string;
    }
  | WithProjectPath<GrantCloneAccessResult>
  | Exclude<CloneAndAttachResult, { ok: true }>;

const inFlightOpens = new Set<string>();

/** Test-only helper to reset process-local state between cases. */
export function _resetOpenProjectStateForTests(): void {
  inFlightOpens.clear();
}

function targetExists(projectDir: string, projectPath: string): OpenProjectResult {
  // Only a repository ROOT can be attached. `git remote get-url` walks up, so
  // a plain subfolder inside some other clone of the same project would
  // otherwise look like a match.
  const isRepoRoot = fs.existsSync(path.join(projectDir, ".git"));
  const sameProject =
    isRepoRoot && deriveProjectPathFromOrigin(projectDir) === projectPath;
  return {
    ok: false,
    error: "clone_target_exists",
    hint: sameProject
      ? `${projectDir} already exists and is a clone of ${projectPath}. Nothing was overwritten. To use it, call verse8_attach({projectDir: ${JSON.stringify(projectDir)}}) — it is idempotent.`
      : `${projectDir} already exists and is not a clone of ${projectPath}. Nothing was overwritten. Pass a different targetDir, or move that folder away first.`,
    projectPath,
    projectDir,
  };
}

export async function runOpenProject(
  input: OpenProjectInput,
  cwd: string = process.cwd(),
): Promise<OpenProjectResult> {
  const ref = resolveProjectRef(input.project);
  if (!ref.ok) return ref;
  const { projectPath } = ref;

  const token = loadToken(cwd);
  if (!token) {
    return {
      ok: false,
      error: "not_logged_in",
      hint: LOGIN_HINT,
    };
  }

  if (inFlightOpens.has(projectPath)) {
    return {
      ok: false,
      error: "open_in_flight",
      hint: `a previous verse8_open_project for ${projectPath} is still running. Wait for it to finish before retrying.`,
      projectPath,
    };
  }
  inFlightOpens.add(projectPath);

  try {
    const parentDir = path.resolve(input.targetDir ?? cwd);

    // Check the folder BEFORE asking the backend for a token: every POST
    // mints a fresh 30-day project token and the backend caps active tokens
    // per project, so a local failure after it wastes a slot.
    // cloneAndAttach re-checks with the backend's slug afterwards.
    const local = checkCloneTargetLocal(parentDir);
    if (!local.ok) return { ...local, projectPath };
    const expectedDir = path.join(parentDir, projectPath.split("/").pop() as string);
    if (fs.existsSync(expectedDir)) return targetExists(expectedDir, projectPath);

    // A project the user does not own comes back here as the backend's
    // own status + body (token_check_failed / token_grant_failed).
    const access = await grantCloneAccess(projectPath, token);
    if (!access.ok) return { ...access, projectPath };

    const cloned = await cloneAndAttach({
      projectPath,
      projectId: undefined,
      cloneCommand: access.cloneCommand,
      parentDir,
      token,
    });
    if (!cloned.ok) return cloned;

    return {
      ok: true,
      projectDir: cloned.projectDir,
      projectPath,
      gitUrl: access.gitUrl ?? "",
      branch: cloned.branch,
      tokenExpiresAt: access.tokenExpiresAt,
      webEditor: { url: buildWebEditorLink(projectPath).url },
      nextCallRequires: { projectDir: cloned.projectDir },
    };
  } finally {
    inFlightOpens.delete(projectPath);
  }
}
