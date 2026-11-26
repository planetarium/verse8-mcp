import * as path from "node:path";
import { z } from "zod";
import { resolveToken, type TokenResolution } from "../context/token.js";
import { getVerse, updateVerse, v8Request, verifyToken, type VerseInfo } from "../api/v8MemeApi.js";
import { safeErrorHint } from "../util/redact.js";
import { LOGIN_HINT } from "../util/hints.js";
import { apiFail, checkPlan, diff, isApproved, mediaPath, opFail, planGate, planIdField, withRejectedTokenHint, type ConfirmHost, type OpFail, type Plan } from "./creatorOps.js";
import { RELEASE_NOTE_TYPES, WEB_PUBLISH_FORM } from "./deploy.js";
import { uploadLocalMedia, validateLocalMedia } from "./uploadThumbnail.js";
import { projectDirField, resolveVerseContext, verseIdField } from "./verseContext.js";

/**
 * `verse8_verse` — the creator page's game operations without a rebuild:
 * read the verse and the creator's games, edit the listing (title, texts,
 * tags, cover, preview video, flags), read and edit release notes.
 *
 * Changing actions preview by default and only call the API with the
 * planId their preview returned (creatorOps plan gate). An update that
 * widens the visibility, and deleting a comment, also need the user's own
 * confirmation in the host's prompt (creatorOps RUN_RULES). Every listing
 * update re-sends the current `visibility`:
 * the backend's update DTO defaults `isPublic` to true, so a body without
 * `visibility` would make a Private / Unlisted game Public
 * (g2-sync verseUpdate.dto.ts isPublic default + verse.service.ts
 * visibility resolution).
 */

const ACTIONS = [
  "get", "mine", "update", "release_notes", "release_note_update", "analytics",
  "comments", "comment_pin", "comment_delete",
] as const;
const REPORT_TYPES = ["dau", "mau", "sessions", "avgSessionDuration", "realtimeUsers"] as const;
const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
/** The web's default chart interval and range per report (verse8-vibe src/constants/analytics.ts). */
const DAY_MS = 86_400_000;
export const CHART_DEFAULTS: Record<(typeof REPORT_TYPES)[number], { interval: (typeof INTERVALS)[number]; rangeMs: number }> = {
  realtimeUsers: { interval: "15m", rangeMs: 7 * DAY_MS },
  dau: { interval: "4h", rangeMs: 90 * DAY_MS },
  mau: { interval: "1d", rangeMs: 365 * DAY_MS },
  sessions: { interval: "4h", rangeMs: 90 * DAY_MS },
  avgSessionDuration: { interval: "1d", rangeMs: 365 * DAY_MS },
};

export const verseOpsInputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        "get: this verse's listing, visibility, review status, latest release note. mine: your games (paged). update: edit the listing without a rebuild (preview unless planId). release_notes: release-note history (paged). release_note_update: edit one release note (preview unless planId). analytics: DAU / MAU / sessions / avg session summary, plus a chart when reportType is given. comments: comment list with the pinned one. comment_pin: pin / unpin a comment (preview unless planId). comment_delete: delete a comment (preview unless planId; irreversible).",
      ),
    projectDir: projectDirField,
    verseId: verseIdField,
    planId: planIdField,
    page: z.number().int().min(1).optional().describe("mine / release_notes: page (default 1)."),
    limit: z.number().int().min(1).max(100).optional().describe("mine / release_notes: page size (default 20 / 10)."),
    // update
    title: z.string().min(WEB_PUBLISH_FORM.TITLE_MIN).max(WEB_PUBLISH_FORM.TITLE_MAX).optional().describe("update: title (4–50)."),
    shortDescription: z.string().max(WEB_PUBLISH_FORM.SHORT_DESCRIPTION_MAX).optional().describe("update: one-line preview text (≤100)."),
    description: z.string().max(WEB_PUBLISH_FORM.DESCRIPTION_MAX).optional().describe("update: full description (≤1000)."),
    tags: z
      .array(z.string().min(1).max(50))
      .min(1)
      .max(WEB_PUBLISH_FORM.TAGS_MAX)
      .optional()
      .describe("update: user tags (1–5, no `__` prefix). System tags already on the verse are kept by the server."),
    thumbnailPath: z.string().min(1).optional().describe("update: local cover image (png/jpg/gif/webp ≤4 MB), uploaded when it runs."),
    imageUrl: z.string().url().optional().describe("update: already-hosted cover image URL."),
    videoPath: z.string().min(1).optional().describe("update: local preview video (mp4 ≤10 MiB), uploaded when it runs."),
    videoUrl: z.string().url().optional().describe("update: already-hosted preview video URL."),
    clearVideo: z.boolean().optional().describe("update: remove the preview video."),
    allowRemix: z.boolean().optional().describe("update: allow remixes (Spin)."),
    isMobileSupported: z.boolean().optional().describe("update: mark as playable on mobile."),
    orientation: z.enum(["landscape", "portrait", "auto"]).optional().describe("update: screen orientation; auto lets the device decide."),
    visibility: z
      .enum(["Public", "Unlisted", "Private"])
      .optional()
      .describe("update: Public (listed), Unlisted (link only) or Private (owner only). Omitted = keep the current one."),
    // release notes
    buildVersion: z.number().int().min(1).optional().describe("release_note_update: the note's build version (from release_notes)."),
    releaseNoteId: z.number().int().min(1).optional().describe("release_note_update: the note's id (alternative to buildVersion)."),
    releaseNoteTitle: z.string().min(1).max(WEB_PUBLISH_FORM.RELEASE_NOTE_TITLE_MAX).optional().describe("release_note_update: title (≤50)."),
    releaseNoteTypes: z
      .array(z.enum(RELEASE_NOTE_TYPES))
      .min(1)
      .max(WEB_PUBLISH_FORM.RELEASE_NOTE_TYPES_MAX)
      .optional()
      .describe("release_note_update: 1–3 types."),
    releaseNoteDescription: z.string().min(1).max(WEB_PUBLISH_FORM.RELEASE_NOTE_DESCRIPTION_MAX).optional().describe("release_note_update: body (≤1000)."),
    releaseNoteImagePath: z.string().min(1).optional().describe("release_note_update: local image, uploaded when it runs."),
    releaseNoteImageUrl: z.string().url().max(500).optional().describe("release_note_update: already-hosted image URL."),
    clearReleaseNoteImage: z.boolean().optional().describe("release_note_update: remove the note's image."),
    // analytics
    reportType: z.enum(REPORT_TYPES).optional().describe("analytics: also return this metric's time series."),
    startDate: z.string().min(1).max(40).optional().describe("analytics chart: ISO 8601 start (default: the web's range for the metric)."),
    endDate: z.string().min(1).max(40).optional().describe("analytics chart: ISO 8601 end (default now)."),
    interval: z.enum(INTERVALS).optional().describe("analytics chart: bucket size (default: the web's for the metric)."),
    // comments
    sortBy: z.enum(["popular", "latest", "top"]).optional().describe("comments: order (default popular)."),
    commentId: z.number().int().min(1).optional().describe("comment_pin / comment_delete: the comment (from comments)."),
    pinned: z.boolean().optional().describe("comment_pin: true pins (replacing any other pin), false unpins. Default true."),
  })
  .strict();

export type VerseOpsInput = z.infer<typeof verseOpsInputSchema>;
export type VerseOpsResult = { ok: true; action: VerseOpsInput["action"]; [k: string]: unknown } | OpFail;

/** The listing fields an agent needs; drops ad units, admin flags, rewritten URLs' noise. */
export function summarizeVerse(v: VerseInfo): Record<string, unknown> {
  const pick = [
    "verseId", "verseShortId", "title", "shortDescription", "description", "imageUrl", "videoUrl", "playUrl",
    "tag", "visibility", "isPublic", "reviewStatus", "allowRemix", "isMobileSupported", "orientation", "category",
    "createdAt", "isOwner", "sessions", "likeSize", "commentSize", "spinCount", "dau", "mau", "realtimeUsers",
    "latestReleaseNote",
  ];
  const out: Record<string, unknown> = {};
  for (const k of pick) if (v[k] !== undefined) out[k] = v[k];
  return out;
}

async function loadOwnedVerse(verseId: string, token: string): Promise<{ ok: true; verse: VerseInfo } | OpFail> {
  const r = await getVerse(verseId, token);
  if (!r.ok) {
    if (r.status === 404) return opFail("not_found", `Verse ${verseId} is not published (or not visible to this login). Publish it first with verse8_deploy.`, { status: 404 });
    return apiFail("GET /v1/verse/verseId", r);
  }
  if (r.data.isOwner === false) return opFail("forbidden", `This login does not own ${verseId}.`, { status: 403 });
  return { ok: true, verse: r.data };
}

export async function runVerseOps(input: VerseOpsInput, serverCwd: string = process.cwd(), host?: ConfirmHost): Promise<VerseOpsResult> {
  // One token lookup for the whole call; its source goes into any 401 hint.
  const auth = resolveToken(path.resolve(input.projectDir ?? serverCwd));
  return withRejectedTokenHint(await runVerseOpsWith(input, serverCwd, auth, host), auth);
}

async function runVerseOpsWith(input: VerseOpsInput, serverCwd: string, auth: TokenResolution, host: ConfirmHost | undefined): Promise<VerseOpsResult> {
  const ctx = resolveVerseContext(input, serverCwd, auth);
  if (!ctx.ok && !(input.action === "mine" && ctx.error === "missing_verse_env")) return ctx as OpFail;
  try {
    switch (input.action) {
      case "get": {
        if (!ctx.ok) return ctx as OpFail;
        const v = await loadOwnedVerse(ctx.verseId, ctx.token);
        if (!v.ok) return v;
        return { ok: true, action: "get", verse: summarizeVerse(v.verse) };
      }
      case "mine": {
        // Needs only the login, not a verse in .env.
        const token = auth.token;
        if (!token) return opFail("not_logged_in", LOGIN_HINT);
        const r = await v8Request<{ total: number; page: number; limit: number; items: VerseInfo[] }>("GET", "/v1/verse/my", {
          token,
          query: { page: input.page ?? 1, limit: input.limit ?? 20, includeReview: "true" },
        });
        if (!r.ok) return apiFail("GET /v1/verse/my", r);
        const d = r.data ?? { total: 0, page: 1, limit: 20, items: [] };
        return {
          ok: true,
          action: "mine",
          total: d.total,
          page: d.page,
          limit: d.limit,
          items: (d.items ?? []).map((v) => {
            const note = v.latestReleaseNote as Record<string, unknown> | null | undefined;
            return {
              verseId: v.verseId,
              verseShortId: v.verseShortId,
              title: v.title,
              visibility: v.visibility,
              reviewStatus: v.reviewStatus ?? null,
              createdAt: v.createdAt,
              sessions: v.sessions,
              likeSize: v.likeSize,
              latestReleaseNote: note
                ? { buildVersion: note.buildVersion, createdAt: note.createdAt, reviewStatus: note.reviewStatus ?? null, reviewerNote: note.reviewerNote ?? null }
                : null,
            };
          }),
        };
      }
      case "update":
        if (!ctx.ok) return ctx as OpFail;
        return await runUpdate(input, ctx.projectDir, ctx.verseId, ctx.token, host);
      case "release_notes": {
        if (!ctx.ok) return ctx as OpFail;
        const r = await v8Request<Record<string, unknown>>("GET", `/v1/verse/${encodeURIComponent(ctx.verseId)}/release-notes`, {
          query: { page: input.page ?? 1, limit: input.limit ?? 10 },
        });
        if (!r.ok) return apiFail("GET release-notes", r);
        return { ok: true, action: "release_notes", verseId: ctx.verseId, ...(r.data ?? {}) };
      }
      case "release_note_update":
        if (!ctx.ok) return ctx as OpFail;
        return await runReleaseNoteUpdate(input, ctx.projectDir, ctx.verseId, ctx.token);
      case "analytics":
        if (!ctx.ok) return ctx as OpFail;
        return await runAnalytics(input, ctx.verseId, ctx.token);
      case "comments": {
        if (!ctx.ok) return ctx as OpFail;
        const r = await v8Request<CommentPage>("GET", `/v1/verse/${encodeURIComponent(ctx.verseId)}/comments`, {
          token: ctx.token,
          query: { page: input.page ?? 1, limit: input.limit ?? 20, sortBy: input.sortBy },
        });
        if (!r.ok) return apiFail("GET comments", r);
        const d = r.data ?? { comments: [], page: 1, limit: 20, total: 0 };
        return {
          ok: true,
          action: "comments",
          verseId: ctx.verseId,
          total: d.total,
          page: d.page,
          limit: d.limit,
          pinnedComment: d.pinnedComment ? presentComment(d.pinnedComment) : null,
          comments: (d.comments ?? []).map(presentComment),
        };
      }
      case "comment_pin":
      case "comment_delete":
        if (!ctx.ok) return ctx as OpFail;
        return await runCommentChange(input, ctx.verseId, ctx.token, host);
    }
  } catch (e) {
    return opFail("upstream_unreachable", safeErrorHint(e));
  }
}

async function runUpdate(input: VerseOpsInput, projectDir: string, verseId: string, token: string, host: ConfirmHost | undefined): Promise<VerseOpsResult> {
  if (input.thumbnailPath && input.imageUrl) return opFail("invalid_input", "Pass either thumbnailPath or imageUrl, not both.");
  if ([input.videoPath, input.videoUrl, input.clearVideo ? "x" : undefined].filter(Boolean).length > 1) {
    return opFail("invalid_input", "Pass only one of videoPath, videoUrl, clearVideo.");
  }
  const reserved = (input.tags ?? []).filter((t) => t.startsWith("__"));
  if (reserved.length > 0) return opFail("invalid_input", `Tags starting with '__' are reserved: ${reserved.join(", ")}`);
  for (const [field, kind] of [["thumbnailPath", "image"], ["videoPath", "video"]] as const) {
    const p = input[field];
    if (!p) continue;
    const check = validateLocalMedia(mediaPath(projectDir, p), kind);
    if (!check.ok) return opFail(check.error, `${field}: ${check.hint}`, { field });
  }

  const owned = await loadOwnedVerse(verseId, token);
  if (!owned.ok) return owned;
  const cur = owned.verse;
  if (!cur.visibility) {
    return opFail("upstream_error", "The verse record has no visibility; refusing to send an update that could change it.");
  }
  const currentUserTags = (cur.tag ?? []).filter((t) => !t.startsWith("__"));
  const orientation = input.orientation === undefined ? undefined : input.orientation === "auto" ? null : input.orientation;
  const changes = diff([
    ["title", cur.title, input.title],
    ["shortDescription", cur.shortDescription, input.shortDescription],
    ["description", cur.description, input.description],
    ["tag", currentUserTags, input.tags],
    ["imageUrl", cur.imageUrl, input.thumbnailPath ? `<upload:${input.thumbnailPath}>` : input.imageUrl],
    ["videoUrl", cur.videoUrl, input.videoPath ? `<upload:${input.videoPath}>` : input.clearVideo ? null : input.videoUrl],
    ["allowRemix", cur.allowRemix, input.allowRemix],
    ["isMobileSupported", cur.isMobileSupported, input.isMobileSupported],
    ["orientation", cur.orientation, orientation],
    ["visibility", cur.visibility, input.visibility],
  ]);
  if (changes.length === 0) return opFail("invalid_input", "Nothing to change: every given value equals the current one (or no field was given).");

  const warnings: string[] = [];
  const vis = changes.find((c) => c.field === "visibility");
  if (vis) warnings.push(...visibilityWarnings(cur, String(vis.to)));
  if (changes.some((c) => c.field === "imageUrl" || c.field === "videoUrl")) {
    warnings.push("The listing's theme colors are not recomputed from the new cover / video (the web editor's Save does that); they keep their current values.");
  }
  // visibility: always sent — the new one, or the current one (see the module comment).
  const body: Record<string, unknown> = { visibility: input.visibility ?? cur.visibility, sendNotificationToFollowers: false };
  for (const c of changes) body[c.field] = c.to;

  // The current value of every field asked about, and of what is always re-sent.
  // A visibility change also reads the title: the user confirmation of a
  // widening one shows it (creatorOps RUN_RULES).
  const asked: Array<[string, unknown, unknown]> = [
    ["title", input.title ?? input.visibility, cur.title],
    ["shortDescription", input.shortDescription, cur.shortDescription],
    ["description", input.description, cur.description],
    ["tag", input.tags ?? input.visibility, cur.tag ?? []],
    ["imageUrl", input.thumbnailPath ?? input.imageUrl, cur.imageUrl],
    ["videoUrl", input.videoPath ?? input.videoUrl ?? input.clearVideo, cur.videoUrl],
    ["allowRemix", input.allowRemix, cur.allowRemix],
    ["isMobileSupported", input.isMobileSupported, cur.isMobileSupported],
    ["orientation", input.orientation, cur.orientation],
  ];
  const state: Record<string, unknown> = { visibility: cur.visibility };
  for (const [field, given, now] of asked) if (given !== undefined) state[field] = now ?? null;
  const plan: Plan = {
    op: "verse8_verse.update",
    target: { verseId },
    body,
    state,
    files: {
      ...(input.thumbnailPath ? { thumbnailPath: mediaPath(projectDir, input.thumbnailPath) } : {}),
      ...(input.videoPath ? { videoPath: mediaPath(projectDir, input.videoPath) } : {}),
    },
  };
  const gate = await planGate(plan, input.planId, {
    action: "update" as const,
    verseId,
    changes,
    ...(vis ? {} : { keptVisibility: cur.visibility }),
    warnings,
    publishBody: body,
  }, host);
  if (!isApproved(gate)) return gate;

  if (input.thumbnailPath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.thumbnailPath), token, "image", undefined, gate.files.thumbnailPath);
    if (!up.ok) return opFail(up.error, `thumbnailPath: ${up.hint}`);
    body.imageUrl = up.url;
  }
  if (input.videoPath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.videoPath), token, "video", undefined, gate.files.videoPath);
    if (!up.ok) return opFail(up.error, `videoPath: ${up.hint}`);
    body.videoUrl = up.url;
  }
  const res = await updateVerse(verseId, body, token);
  if (!res.ok) return apiFail(`POST /v1/verse/update/${verseId}`, res);
  return {
    ok: true,
    action: "update",
    dryRun: false,
    verseId,
    changes: changes.map((c) => ({ ...c, to: body[c.field] })),
    visibility: res.data.visibility ?? body.visibility,
    reviewStatus: (res.data.reviewStatus as string | undefined) ?? null,
    warnings: [
      ...warnings,
      ...(vis && ["PRIVATE_REVIEW", "REJECTED"].includes(String(res.data.reviewStatus))
        ? [`reviewStatus is now ${res.data.reviewStatus}: the game stays hidden from players until Verse8 review passes.`]
        : []),
    ],
  };
}

interface ReleaseNote {
  id: number;
  buildVersion: number;
  title: string;
  releaseTypes: string[];
  description: string;
  imageUrl: string | null;
  userUid: string;
  createdAt: string;
}

async function findReleaseNote(verseId: string, input: VerseOpsInput): Promise<{ ok: true; note: ReleaseNote } | OpFail> {
  if (input.buildVersion !== undefined) {
    const r = await v8Request<ReleaseNote>("GET", `/v1/verse/${encodeURIComponent(verseId)}/release-notes/version/${input.buildVersion}`);
    if (!r.ok || !r.data) return r.ok ? opFail("not_found", "empty answer") : apiFail(`release note v${input.buildVersion}`, r);
    return { ok: true, note: r.data };
  }
  const r = await v8Request<{ releaseNotes: ReleaseNote[] }>("GET", `/v1/verse/${encodeURIComponent(verseId)}/release-notes`, { query: { page: 1, limit: 100 } });
  if (!r.ok) return apiFail("GET release-notes", r);
  const note = (r.data?.releaseNotes ?? []).find((n) => n.id === input.releaseNoteId);
  return note ? { ok: true, note } : opFail("not_found", `No release note with id ${input.releaseNoteId} among this verse's latest 100.`);
}

async function runReleaseNoteUpdate(input: VerseOpsInput, projectDir: string, verseId: string, token: string): Promise<VerseOpsResult> {
  if (input.buildVersion === undefined && input.releaseNoteId === undefined) {
    return opFail("invalid_input", "release_note_update needs buildVersion or releaseNoteId (see action release_notes).");
  }
  if ([input.releaseNoteImagePath, input.releaseNoteImageUrl, input.clearReleaseNoteImage ? "x" : undefined].filter(Boolean).length > 1) {
    return opFail("invalid_input", "Pass only one of releaseNoteImagePath, releaseNoteImageUrl, clearReleaseNoteImage.");
  }
  if (input.releaseNoteImagePath) {
    const check = validateLocalMedia(mediaPath(projectDir, input.releaseNoteImagePath), "image");
    if (!check.ok) return opFail(check.error, `releaseNoteImagePath: ${check.hint}`);
  }
  const found = await findReleaseNote(verseId, input);
  if (!found.ok) return found;
  const note = found.note;
  const changes = diff([
    ["title", note.title, input.releaseNoteTitle],
    ["releaseTypes", note.releaseTypes, input.releaseNoteTypes],
    ["description", note.description, input.releaseNoteDescription],
    [
      "imageUrl",
      note.imageUrl,
      input.releaseNoteImagePath ? `<upload:${input.releaseNoteImagePath}>` : input.clearReleaseNoteImage ? null : input.releaseNoteImageUrl,
    ],
  ]);
  if (changes.length === 0) return opFail("invalid_input", "Nothing to change in this release note.");

  // Only the note's author may edit it (not every owner of the verse).
  const warnings: string[] = [];
  const me = await verifyToken(token);
  if (me.ok && me.profile.userUid !== undefined && String(me.profile.userUid) !== String(note.userUid)) {
    warnings.push("This note was written by another account; the server allows only its author to edit it, so this will be refused (403).");
  }
  const body: Record<string, unknown> = {};
  for (const c of changes) body[c.field] = c.to;
  const state: Record<string, unknown> = { author: note.userUid };
  if (input.releaseNoteTitle !== undefined) state.title = note.title;
  if (input.releaseNoteTypes !== undefined) state.releaseTypes = note.releaseTypes;
  if (input.releaseNoteDescription !== undefined) state.description = note.description;
  if (input.releaseNoteImagePath ?? input.releaseNoteImageUrl ?? input.clearReleaseNoteImage) state.imageUrl = note.imageUrl;
  const plan: Plan = {
    op: "verse8_verse.release_note_update",
    target: { verseId, releaseNoteId: note.id },
    body,
    state,
    files: input.releaseNoteImagePath ? { releaseNoteImagePath: mediaPath(projectDir, input.releaseNoteImagePath) } : {},
  };
  const gate = await planGate(plan, input.planId, {
    action: "release_note_update" as const,
    verseId,
    releaseNote: { id: note.id, buildVersion: note.buildVersion },
    changes,
    warnings,
  });
  if (!isApproved(gate)) return gate;
  if (input.releaseNoteImagePath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.releaseNoteImagePath), token, "image", undefined, gate.files.releaseNoteImagePath);
    if (!up.ok) return opFail(up.error, `releaseNoteImagePath: ${up.hint}`);
    body.imageUrl = up.url;
  }
  const r = await v8Request<ReleaseNote>("PUT", `/v1/release-notes/${note.id}`, { token, body });
  if (!r.ok) return apiFail(`PUT /v1/release-notes/${note.id}`, r);
  return { ok: true, action: "release_note_update", dryRun: false, verseId, releaseNote: r.data ?? { id: note.id }, changes, warnings };
}

/** Parse an ISO date input to epoch ms, or null when invalid. */
function isoMs(v: string | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Analytics are keyed by the lowercased verseShortId (the GA page path), not
 * the verse id (g2-sync analytics.service.ts); the routes are public, but the
 * short id is resolved through the owner read so only the owner's games are
 * asked for.
 */
async function runAnalytics(input: VerseOpsInput, verseId: string, token: string): Promise<VerseOpsResult> {
  const owned = await loadOwnedVerse(verseId, token);
  if (!owned.ok) return owned;
  const shortId = typeof owned.verse.verseShortId === "string" ? owned.verse.verseShortId.toLowerCase() : null;
  if (!shortId) return opFail("upstream_error", "The verse record has no verseShortId to look analytics up by.");
  const base = `/v1/analytics/${encodeURIComponent(shortId)}`;
  const summary = await v8Request<Record<string, number>>("GET", `${base}/summary`);
  if (!summary.ok) return apiFail("GET analytics summary", summary);
  const out: Record<string, unknown> = { ok: true, action: "analytics", verseId, verseShortId: owned.verse.verseShortId, summary: summary.data };
  if (input.reportType) {
    const d = CHART_DEFAULTS[input.reportType];
    const end = isoMs(input.endDate) ?? (input.endDate === undefined ? Date.now() : null);
    const start = isoMs(input.startDate) ?? (input.startDate === undefined && end !== null ? end - d.rangeMs : null);
    if (start === null || end === null || start > end) {
      return opFail("invalid_input", "startDate / endDate must be ISO 8601 dates with start ≤ end.");
    }
    const interval = input.interval ?? d.interval;
    const chart = await v8Request<Array<{ date: number; metricValue: number }>>("GET", `${base}/chart`, {
      query: { reportType: input.reportType, startDate: start, endDate: end, interval },
    });
    if (!chart.ok) return apiFail("GET analytics chart", chart);
    out.chart = {
      reportType: input.reportType,
      interval,
      startDate: new Date(start).toISOString(),
      endDate: new Date(end).toISOString(),
      // newest first, as the API returns it
      points: (chart.data ?? []).map((p) => ({ at: new Date(p.date).toISOString(), value: p.metricValue })),
    };
    if (input.reportType === "realtimeUsers") {
      out.note = "realtimeUsers is stored as a current value, not as chart ticks; its chart is usually empty — summary/get show the live number.";
    }
  }
  return out as VerseOpsResult;
}

/** What a visibility change does, from g2-sync verse.service.ts / review.service.ts. */
export function visibilityWarnings(cur: VerseInfo, to: string): string[] {
  const out: string[] = [];
  const from = String(cur.visibility);
  if (to === "Private") out.push("Private: only you can open the game; players lose access and it leaves listings.");
  if (to === "Unlisted") out.push("Unlisted: anyone with the link can play; it is not listed.");
  if (to === "Public") out.push("Public: listed on Verse8 for everyone.");
  if (from === "Private" && to !== "Private" && (cur.tag ?? []).includes("__review_required")) {
    out.push(
      "This game carries __review_required: making it visible starts a Verse8 review, and without an earlier approval it goes to PRIVATE_REVIEW — still hidden until the review passes.",
    );
  }
  return out;
}

interface VerseComment {
  id: number;
  userUid: string;
  userDisplayName?: string;
  userHandle?: string | null;
  content: string;
  parentCommentId: number | null;
  likes: number;
  isDeleted: boolean;
  createdAt: string;
  replies?: VerseComment[];
}
interface CommentPage {
  pinnedComment?: VerseComment;
  comments: VerseComment[];
  page: number;
  limit: number;
  total: number;
}

export function presentComment(c: VerseComment): Record<string, unknown> {
  return {
    id: c.id,
    author: { uid: c.userUid, handle: c.userHandle ?? null, displayName: c.userDisplayName ?? null },
    content: c.content,
    likes: c.likes,
    isDeleted: c.isDeleted,
    parentCommentId: c.parentCommentId,
    createdAt: c.createdAt,
    ...(c.replies && c.replies.length > 0 ? { replies: c.replies.map(presentComment) } : {}),
  };
}

/** Page through the newest comments (and their replies) for one id; also returns the pinned one. */
async function findComment(
  verseId: string,
  token: string,
  commentId: number,
): Promise<{ ok: true; comment: VerseComment | null; pinnedId: number | null } | OpFail> {
  let pinnedId: number | null = null;
  for (let page = 1; page <= 10; page++) {
    const r = await v8Request<CommentPage>("GET", `/v1/verse/${encodeURIComponent(verseId)}/comments`, {
      token,
      query: { page, limit: 100, sortBy: "latest" },
    });
    if (!r.ok) return apiFail("GET comments", r);
    const d = r.data;
    if (!d) break;
    if (page === 1) pinnedId = d.pinnedComment?.id ?? null;
    const pool = [...(d.pinnedComment ? [d.pinnedComment] : []), ...(d.comments ?? [])];
    for (const c of pool) {
      if (c.id === commentId) return { ok: true, comment: c, pinnedId };
      const reply = (c.replies ?? []).find((x) => x.id === commentId);
      if (reply) return { ok: true, comment: reply, pinnedId };
    }
    if ((d.comments ?? []).length < 100) break;
  }
  return { ok: true, comment: null, pinnedId };
}

async function runCommentChange(input: VerseOpsInput, verseId: string, token: string, host: ConfirmHost | undefined): Promise<VerseOpsResult> {
  if (input.commentId === undefined) return opFail("invalid_input", `${input.action} needs commentId (see action comments).`);
  const owned = await loadOwnedVerse(verseId, token);
  if (!owned.ok) return owned;
  const found = await findComment(verseId, token, input.commentId);
  if (!found.ok) return found;
  const c = found.comment;
  if (!c) return opFail("not_found", `No comment ${input.commentId} among this verse's newest 1,000.`);
  if (c.isDeleted) return opFail("invalid_input", `Comment ${c.id} is already deleted.`);
  const shown = presentComment({ ...c, replies: undefined });
  const isPinned = found.pinnedId === c.id;

  if (input.action === "comment_delete") {
    const warnings = [
      "Deleting is irreversible (no undo for creators).",
      "It counts against the commenter's moderation record (deletedCommentCount).",
      ...(isPinned ? ["It is the pinned comment; it gets unpinned."] : []),
    ];
    const plan: Plan = {
      op: "verse8_verse.comment_delete",
      target: { verseId, commentId: c.id },
      body: null,
      // author and content are what the user confirmation shows (creatorOps RUN_RULES).
      state: { content: c.content, pinned: isPinned, author: c.userHandle ?? c.userDisplayName ?? `uid ${c.userUid}` },
    };
    const gate = await planGate(plan, input.planId, { action: "comment_delete" as const, verseId, comment: shown, warnings }, host);
    if (!isApproved(gate)) return gate;
    const r = await v8Request("DELETE", `/v1/verse/${encodeURIComponent(verseId)}/comments/${c.id}`, { token });
    if (!r.ok) return apiFail(`DELETE comment ${c.id}`, r);
    return { ok: true, action: "comment_delete", dryRun: false, verseId, deleted: c.id };
  }

  // comment_pin — the route toggles, so call it only when the state would
  // change; the pin state read now is part of the plan.
  const want = input.pinned ?? true;
  const plan: Plan = {
    op: "verse8_verse.comment_pin",
    target: { verseId, commentId: c.id },
    body: { pinned: want },
    state: { pinned: isPinned, pinnedCommentId: found.pinnedId, content: c.content },
  };
  if (want === isPinned) {
    // A preview never hands out a planId for this state, so a given one is stale.
    const stale = input.planId === undefined ? null : checkPlan(plan, input.planId);
    if (stale && !isApproved(stale)) return stale;
    return { ok: true, action: "comment_pin", dryRun: input.planId === undefined, verseId, comment: shown, pinned: isPinned, unchanged: true };
  }
  if (want && c.parentCommentId !== null) return opFail("invalid_input", "Only top-level comments can be pinned.");
  const warnings = want
    ? [
        ...(found.pinnedId !== null ? [`Replaces the current pin (comment ${found.pinnedId}).`] : []),
        "The commenter is notified that you pinned it.",
      ]
    : [];
  const gate = await planGate(plan, input.planId, {
    action: "comment_pin" as const,
    verseId,
    comment: shown,
    changes: [{ field: "pinned", from: isPinned, to: want }],
    warnings,
  });
  if (!isApproved(gate)) return gate;
  const r = await v8Request<{ isPinned: boolean }>("POST", `/v1/verse/${encodeURIComponent(verseId)}/comments/${c.id}/pin`, { token });
  if (!r.ok) return apiFail(`pin comment ${c.id}`, r);
  return { ok: true, action: "comment_pin", dryRun: false, verseId, commentId: c.id, pinned: r.data?.isPinned ?? want, warnings };
}
