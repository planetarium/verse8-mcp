import * as path from "node:path";
import { z } from "zod";
import { loadToken } from "../context/token.js";
import { getVerse, updateVerse, v8Request, verifyToken, type VerseInfo } from "../api/v8MemeApi.js";
import { safeErrorHint } from "../util/redact.js";
import { CONFIRM_NEXT, apiFail, diff, mediaPath, opFail, type OpFail } from "./creatorOps.js";
import { RELEASE_NOTE_TYPES, WEB_PUBLISH_FORM } from "./deploy.js";
import { uploadLocalMedia, validateLocalMedia } from "./uploadThumbnail.js";
import { projectDirField, resolveVerseContext, verseIdField } from "./verseContext.js";

/**
 * `verse8_verse` — the creator page's game operations without a rebuild:
 * read the verse and the creator's games, edit the listing (title, texts,
 * tags, cover, preview video, flags), read and edit release notes.
 *
 * Changing actions preview by default and only call the API with
 * `confirm: true`. Every listing update re-sends the current `visibility`:
 * the backend's update DTO defaults `isPublic` to true, so a body without
 * `visibility` would make a Private / Unlisted game Public
 * (g2-sync verseUpdate.dto.ts isPublic default + verse.service.ts
 * visibility resolution).
 */

const ACTIONS = ["get", "mine", "update", "release_notes", "release_note_update", "analytics"] as const;
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
        "get: this verse's listing, visibility, review status, latest release note. mine: your games (paged). update: edit the listing without a rebuild (preview unless confirm). release_notes: release-note history (paged). release_note_update: edit one release note (preview unless confirm). analytics: DAU / MAU / sessions / avg session summary, plus a chart when reportType is given.",
      ),
    projectDir: projectDirField,
    verseId: verseIdField,
    confirm: z
      .boolean()
      .default(false)
      .describe("Changing actions only run with true. Without it they return the planned `changes` and change nothing — show them to the user first."),
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
    thumbnailPath: z.string().min(1).optional().describe("update: local cover image (png/jpg/gif/webp ≤4 MB), uploaded on confirm."),
    imageUrl: z.string().url().optional().describe("update: already-hosted cover image URL."),
    videoPath: z.string().min(1).optional().describe("update: local preview video (mp4 ≤10 MiB), uploaded on confirm."),
    videoUrl: z.string().url().optional().describe("update: already-hosted preview video URL."),
    clearVideo: z.boolean().optional().describe("update: remove the preview video."),
    allowRemix: z.boolean().optional().describe("update: allow remixes (Spin)."),
    isMobileSupported: z.boolean().optional().describe("update: mark as playable on mobile."),
    orientation: z.enum(["landscape", "portrait", "auto"]).optional().describe("update: screen orientation; auto lets the device decide."),
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
    releaseNoteImagePath: z.string().min(1).optional().describe("release_note_update: local image, uploaded on confirm."),
    releaseNoteImageUrl: z.string().url().max(500).optional().describe("release_note_update: already-hosted image URL."),
    clearReleaseNoteImage: z.boolean().optional().describe("release_note_update: remove the note's image."),
    // analytics
    reportType: z.enum(REPORT_TYPES).optional().describe("analytics: also return this metric's time series."),
    startDate: z.string().min(1).max(40).optional().describe("analytics chart: ISO 8601 start (default: the web's range for the metric)."),
    endDate: z.string().min(1).max(40).optional().describe("analytics chart: ISO 8601 end (default now)."),
    interval: z.enum(INTERVALS).optional().describe("analytics chart: bucket size (default: the web's for the metric)."),
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

export async function runVerseOps(input: VerseOpsInput, serverCwd: string = process.cwd()): Promise<VerseOpsResult> {
  const ctx = resolveVerseContext(input, serverCwd);
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
        const token = ctx.ok ? ctx.token : loadToken(path.resolve(input.projectDir ?? serverCwd));
        if (!token) return opFail("not_logged_in", "call verse8_login_start (then verse8_login_complete)");
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
        return await runUpdate(input, ctx.projectDir, ctx.verseId, ctx.token);
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
    }
  } catch (e) {
    return opFail("upstream_unreachable", safeErrorHint(e));
  }
}

async function runUpdate(input: VerseOpsInput, projectDir: string, verseId: string, token: string): Promise<VerseOpsResult> {
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
  ]);
  if (changes.length === 0) return opFail("invalid_input", "Nothing to change: every given value equals the current one (or no field was given).");

  const warnings: string[] = [];
  if (changes.some((c) => c.field === "imageUrl" || c.field === "videoUrl")) {
    warnings.push("The listing's theme colors are not recomputed from the new cover / video (the web editor's Save does that); they keep their current values.");
  }
  // visibility: the current value, always — see the module comment.
  const body: Record<string, unknown> = { visibility: cur.visibility, sendNotificationToFollowers: false };
  for (const c of changes) body[c.field] = c.to;

  if (!input.confirm) {
    return { ok: true, action: "update", dryRun: true, verseId, changes, keptVisibility: cur.visibility, warnings, publishBody: body, next: CONFIRM_NEXT };
  }

  if (input.thumbnailPath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.thumbnailPath), token, "image");
    if (!up.ok) return opFail(up.error, `thumbnailPath: ${up.hint}`);
    body.imageUrl = up.url;
  }
  if (input.videoPath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.videoPath), token, "video");
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
    visibility: res.data.visibility ?? cur.visibility,
    reviewStatus: (res.data.reviewStatus as string | undefined) ?? null,
    warnings,
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
  if (!input.confirm) {
    return {
      ok: true,
      action: "release_note_update",
      dryRun: true,
      verseId,
      releaseNote: { id: note.id, buildVersion: note.buildVersion },
      changes,
      warnings,
      next: CONFIRM_NEXT,
    };
  }
  if (input.releaseNoteImagePath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.releaseNoteImagePath), token, "image");
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
