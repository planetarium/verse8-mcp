/**
 * Media upload client for the verse8.io web app (verse8-vibe Next.js routes).
 *
 * Verse thumbnails and preview videos live on contents.verse8.io (R2). The
 * web publish dialog uploads them through verse8.io's own API routes, which
 * authenticate the same V8 Bearer token via /v1/auth/verify:
 *   - POST /api/upload                  multipart {file, category} → {publicUrl}
 *   - POST /api/upload/video-presigned  {category, fileSize} → {uploadUrl, publicUrl, contentType}
 *     followed by a PUT of the bytes to the presigned R2 `uploadUrl`.
 *
 * Base URL resolves from env `VERSE8_WEB_URL` (default https://verse8.io),
 * restricted to *.verse8.io / loopback because the Bearer token is sent there.
 */

import { parseOverrideHost } from "../util/hostAllowlist.js";
import { safeHint } from "../util/redact.js";
import { tolerantJsonParse } from "./agent8Backend.js";

const DEFAULT_WEB_BASE = "https://verse8.io";

/** verse8-vibe upload categories (src/constants/upload.ts). */
export const VERSE_MEDIA_CATEGORY = "verses";

/** Mirrors verse8-vibe's server-side limits (src/constants/upload.ts). */
export const MAX_IMAGE_BYTES = 4_000_000;
export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export const VIDEO_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
};

function isAllowedWebBase(url: string): boolean {
  const p = parseOverrideHost(url);
  if (!p) return false;
  if (!p.isHttp) return false;
  if (p.isLoopback) return true;
  return p.host === "verse8.io" || p.host.endsWith(".verse8.io");
}

export function getVerse8WebBaseUrl(): string {
  const override = process.env.VERSE8_WEB_URL;
  if (!override || override.length === 0) return DEFAULT_WEB_BASE;
  if (!isAllowedWebBase(override)) {
    console.error(
      `[verse8-web] rejecting VERSE8_WEB_URL=${override} — host not on .verse8.io allow-list. Using default ${DEFAULT_WEB_BASE}.`,
    );
    return DEFAULT_WEB_BASE;
  }
  return override.replace(/\/+$/, "");
}

export type MediaUploadResult =
  | { ok: true; url: string }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "bad_request"
        | "upload_failed"
        | "upload_response_malformed";
      status: number;
      hint: string;
    };

function classify(status: number): "unauthorized" | "forbidden" | "bad_request" | "upload_failed" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status >= 400 && status < 500) return "bad_request";
  return "upload_failed";
}

function failFromResponse(status: number, raw: string): MediaUploadResult {
  const data = tolerantJsonParse<{ error?: string }>(raw);
  const msg = data && typeof data.error === "string" ? data.error : raw.slice(0, 200);
  return {
    ok: false,
    error: classify(status),
    status,
    hint: safeHint(msg || `HTTP ${status}`),
  };
}

/** POST /api/upload — images (and small mp4) up to the route's size limits. */
export async function uploadVerseImage(input: {
  file: Blob;
  filename: string;
  token: string;
}): Promise<MediaUploadResult> {
  const form = new FormData();
  form.append("file", input.file, input.filename);
  form.append("category", VERSE_MEDIA_CATEGORY);
  let res: Response;
  try {
    res = await fetch(`${getVerse8WebBaseUrl()}/api/upload`, {
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
  if (res.status < 200 || res.status >= 300) return failFromResponse(res.status, raw);
  const data = tolerantJsonParse<{ publicUrl?: string }>(raw);
  if (!data || typeof data.publicUrl !== "string" || data.publicUrl.length === 0) {
    return {
      ok: false,
      error: "upload_response_malformed",
      status: res.status,
      hint: safeHint(`expected {publicUrl} JSON; got: ${raw.slice(0, 200)}`),
    };
  }
  return { ok: true, url: data.publicUrl };
}

/** Presigned two-step upload for mp4 videos (what the web dialog uses). */
export async function uploadVerseVideo(input: {
  file: Blob;
  token: string;
}): Promise<MediaUploadResult> {
  let res: Response;
  try {
    res = await fetch(`${getVerse8WebBaseUrl()}/api/upload/video-presigned`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ category: VERSE_MEDIA_CATEGORY, fileSize: input.file.size }),
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
  if (res.status < 200 || res.status >= 300) return failFromResponse(res.status, raw);
  const data = tolerantJsonParse<{ uploadUrl?: string; publicUrl?: string; contentType?: string }>(raw);
  if (
    !data ||
    typeof data.uploadUrl !== "string" ||
    typeof data.publicUrl !== "string" ||
    data.uploadUrl.length === 0 ||
    data.publicUrl.length === 0
  ) {
    return {
      ok: false,
      error: "upload_response_malformed",
      status: res.status,
      hint: safeHint(`expected {uploadUrl, publicUrl} JSON; got: ${raw.slice(0, 200)}`),
    };
  }
  // The presigned URL is signed for Content-Type + Content-Length; no token is sent.
  let put: Response;
  try {
    put = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": data.contentType ?? "video/mp4" },
      body: input.file,
    });
  } catch (e) {
    return {
      ok: false,
      error: "upload_failed",
      status: 0,
      hint: safeHint(`presigned PUT failed: ${(e as Error).message}`),
    };
  }
  if (put.status < 200 || put.status >= 300) {
    const putRaw = await put.text();
    return {
      ok: false,
      error: "upload_failed",
      status: put.status,
      hint: safeHint(`presigned PUT HTTP ${put.status}: ${putRaw.slice(0, 200)}`),
    };
  }
  return { ok: true, url: data.publicUrl };
}
