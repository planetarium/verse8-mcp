import { execFileSync } from "node:child_process";
import { z } from "zod";
import { gatewayGet } from "../api/gameserverGateway.js";
import { getVerse } from "../api/v8MemeApi.js";
import { rejectedTokenHintForLastLoad } from "../context/token.js";
import { redactHead, safeErrorHint } from "../util/redact.js";
import { projectDirField, resolveVerseContext, verseIdField } from "./verseContext.js";

/**
 * `verse8_deploy_status` — what is live: the published commit (playUrl
 * `sha` / `buildAt`), the latest release note, how the local checkout
 * relates to that commit, and the prod / preview game server state.
 * Read-only.
 */

export const deployStatusInputSchema = z
  .object({
    projectDir: projectDirField,
    verseId: verseIdField,
  })
  .strict();

export type DeployStatusInput = z.infer<typeof deployStatusInputSchema>;

/** Not served by any API today — said in every answer so nobody guesses. */
export const SERVER_UPLOAD_TIME_NOTE =
  "Not available: the game-server gateway exposes no upload time for server.js (that needs a backend endpoint). verse8_deploy and the web editor upload server.js to prod on every publish, so publishedAt is the last prod server upload as long as publishes only go through them. Preview uploads are not recorded anywhere.";

export interface PlayUrlInfo {
  sha: string | null;
  buildAt: string | null;
}

/** `sha` and `buildAt` (ms epoch) from a published playUrl. */
export function parsePlayUrl(playUrl: string | undefined | null): PlayUrlInfo {
  if (!playUrl) return { sha: null, buildAt: null };
  try {
    const u = new URL(playUrl);
    const sha = u.searchParams.get("sha");
    const ms = Number(u.searchParams.get("buildAt"));
    return {
      sha: sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null,
      buildAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
    };
  } catch {
    return { sha: null, buildAt: null };
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    // --no-optional-locks: a read-only status must not refresh (rewrite) the index.
    return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface LocalRelation {
  head: string | null;
  /** The published sha exists in this clone. */
  publishedCommitKnown: boolean;
  /** HEAD contains the published commit. */
  publishedIsAncestorOfHead: boolean | null;
  /** Commits on HEAD after the published one. */
  commitsSincePublished: number | null;
  uncommittedPaths: number;
}

export function relateLocalToPublished(cwd: string, sha: string | null): LocalRelation {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all", "--", "."]);
  const uncommittedPaths = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
  if (!sha || !head) {
    return { head, publishedCommitKnown: false, publishedIsAncestorOfHead: null, commitsSincePublished: null, uncommittedPaths };
  }
  const known = git(cwd, ["cat-file", "-e", `${sha}^{commit}`]) !== null;
  if (!known) {
    return { head, publishedCommitKnown: false, publishedIsAncestorOfHead: null, commitsSincePublished: null, uncommittedPaths };
  }
  const ancestor = git(cwd, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null;
  const count = ancestor ? Number(git(cwd, ["rev-list", "--count", `${sha}..HEAD`])) : null;
  return {
    head,
    publishedCommitKnown: true,
    publishedIsAncestorOfHead: ancestor,
    commitsSincePublished: count !== null && Number.isFinite(count) ? count : null,
    uncommittedPaths,
  };
}

async function serverState(verse: string, token: string): Promise<Record<string, unknown>> {
  try {
    const view = await gatewayGet<{ version?: string | null }>(verse, "/server-view", token);
    if (!view.ok) return { verse, error: `HTTP ${view.status}: ${view.error}` };
    const overview = await gatewayGet<{ state?: string }>(verse, "/overview", token);
    return {
      verse,
      version: view.data.version ?? null,
      state: overview.ok ? overview.data.state ?? null : null,
    };
  } catch (e) {
    return { verse, error: safeErrorHint(e) };
  }
}

export type DeployStatusResult =
  | { ok: true; verseId: string; published: boolean; [k: string]: unknown }
  | { ok: false; error: string; hint: string; status?: number };

export async function runDeployStatus(
  input: DeployStatusInput,
  serverCwd: string = process.cwd(),
): Promise<DeployStatusResult> {
  const ctx = resolveVerseContext(input, serverCwd);
  if (!ctx.ok) return ctx;
  let verse;
  try {
    verse = await getVerse(ctx.verseId, ctx.token);
  } catch (e) {
    return { ok: false, error: "upstream_unreachable", hint: safeErrorHint(e) };
  }
  const [prodServer, previewServer] = await Promise.all([
    serverState(ctx.verseId, ctx.token),
    serverState(`${ctx.verseId}-preview`, ctx.token),
  ]);
  const gameServer = { prod: prodServer, preview: previewServer, serverCodeUploadedAt: null, serverCodeUploadedAtNote: SERVER_UPLOAD_TIME_NOTE };

  if (!verse.ok) {
    if (verse.status === 404) {
      return {
        ok: true,
        verseId: ctx.verseId,
        published: false,
        hint: "This verse has never been published (verse8_deploy makes the first deploy).",
        local: relateLocalToPublished(ctx.projectDir, null),
        gameServer,
      };
    }
    const error = verse.status === 401 ? "unauthorized" : verse.status === 403 ? "forbidden" : "upstream_error";
    return { ok: false, error, status: verse.status, hint: `GET /v1/verse/verseId failed: HTTP ${verse.status} ${redactHead(verse.body, 200)}${verse.status === 401 ? `. ${rejectedTokenHintForLastLoad()}.` : ""}` };
  }

  const v = verse.data;
  const { sha, buildAt } = parsePlayUrl(v.playUrl);
  const note = v.latestReleaseNote as Record<string, unknown> | null | undefined;
  return {
    ok: true,
    verseId: ctx.verseId,
    published: true,
    isOwner: v.isOwner ?? null,
    title: v.title ?? null,
    visibility: v.visibility ?? null,
    reviewStatus: (v.reviewStatus as string | undefined) ?? null,
    publishedSha: sha,
    publishedAt: buildAt,
    playUrl: v.playUrl ?? null,
    latestReleaseNote: note
      ? {
          buildVersion: note.buildVersion ?? null,
          title: note.title ?? null,
          releaseTypes: note.releaseTypes ?? null,
          createdAt: note.createdAt ?? null,
          reviewStatus: note.reviewStatus ?? null,
        }
      : null,
    local: relateLocalToPublished(ctx.projectDir, sha),
    gameServer,
  };
}
