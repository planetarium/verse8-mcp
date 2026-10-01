import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  IMAGE_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  VIDEO_CONTENT_TYPES,
  uploadVerseImage,
  uploadVerseVideo,
} from "../api/verse8Web.js";
import { loadToken } from "../context/token.js";
import { safeHint } from "../util/redact.js";
import { isSafeAbsPath } from "../util/safePath.js";

/**
 * verse8_upload_thumbnail — upload a verse cover image (png/jpg/gif/webp,
 * ≤4 MB) or preview video (mp4, ≤10 MiB) to contents.verse8.io through the
 * verse8.io web app's upload routes, the same path the web publish dialog
 * uses. The returned URL is what `verse8_deploy` sends as `imageUrl` /
 * `videoUrl`. Unlike verse8_upload_asset this is NOT a game asset: it is
 * never served from the verse's own CDN path or referenced by the game.
 */

export const uploadThumbnailInputSchema = z
  .object({
    filePath: z
      .string()
      .min(1)
      .describe(
        "Absolute path, or path relative to projectDir, of the image (png/jpg/jpeg/gif/webp, ≤4 MB) or video (mp4, ≤10 MiB) to upload.",
      ),
    projectDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "projectDir must not contain `..`, NUL byte, or redundant separators",
      })
      .optional()
      .describe("Base for a relative filePath. Defaults to process.cwd()."),
  })
  .strict();

export type UploadThumbnailInput = z.infer<typeof uploadThumbnailInputSchema>;

export type MediaKind = "image" | "video";

export type UploadThumbnailResult =
  | { ok: true; url: string; kind: MediaKind; sizeBytes: number; contentType: string }
  | { ok: false; error: string; hint: string; [k: string]: unknown };

function fail(error: string, hint: string, extras: Record<string, unknown> = {}): UploadThumbnailResult {
  return { ok: false, error, hint: safeHint(hint), ...extras };
}

export type MediaValidation =
  | { ok: true; kind: MediaKind; sizeBytes: number; contentType: string }
  | { ok: false; error: string; hint: string; [k: string]: unknown };

/**
 * stat / extension / size checks for a local cover image or preview video,
 * without network. verse8_deploy runs this before the checkpoint (and in
 * dryRun) so a bad path never costs a commit + build.
 */
export function validateLocalMedia(absPath: string, expect?: MediaKind): MediaValidation {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return fail("file_not_found", `cannot stat ${absPath}`);
  }
  if (!stat.isFile()) return fail("file_not_regular", `${absPath} is not a regular file`);

  const ext = path.extname(absPath).toLowerCase();
  const kind: MediaKind | null = IMAGE_CONTENT_TYPES[ext]
    ? "image"
    : VIDEO_CONTENT_TYPES[ext]
      ? "video"
      : null;
  if (!kind || (expect && kind !== expect)) {
    const allowed =
      expect === "video"
        ? ".mp4"
        : expect === "image"
          ? ".png/.jpg/.jpeg/.gif/.webp"
          : ".png/.jpg/.jpeg/.gif/.webp/.mp4";
    return fail("invalid_extension", `${path.basename(absPath)}: expected ${allowed}`);
  }
  const contentType = kind === "image" ? IMAGE_CONTENT_TYPES[ext] : VIDEO_CONTENT_TYPES[ext];
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (stat.size > limit) {
    return fail("media_too_large", `${path.basename(absPath)} is ${stat.size} bytes; ${kind} limit is ${limit} bytes`, {
      sizeBytes: stat.size,
      limitBytes: limit,
    });
  }
  return { ok: true, kind, sizeBytes: stat.size, contentType };
}

/**
 * Validate + upload one local media file. Shared by verse8_upload_thumbnail
 * and verse8_deploy (thumbnailPath / videoPath). `expect` pins the kind when
 * the caller slot only accepts one (imageUrl vs videoUrl).
 */
export async function uploadLocalMedia(
  absPath: string,
  token: string,
  expect?: MediaKind,
): Promise<UploadThumbnailResult> {
  const checked = validateLocalMedia(absPath, expect);
  if (!checked.ok) return checked;
  const { kind, sizeBytes, contentType } = checked;

  const blob = new Blob([fs.readFileSync(absPath)], { type: contentType });
  const resp =
    kind === "image"
      ? await uploadVerseImage({ file: blob, filename: path.basename(absPath), token })
      : await uploadVerseVideo({ file: blob, token });
  if (!resp.ok) return fail(resp.error, resp.hint, { status: resp.status });
  return { ok: true, url: resp.url, kind, sizeBytes, contentType };
}

export async function runUploadThumbnail(
  input: UploadThumbnailInput,
  serverCwd: string = process.cwd(),
): Promise<UploadThumbnailResult> {
  const cwd = input.projectDir ?? serverCwd;
  const token = loadToken(cwd);
  if (!token) {
    return fail(
      "not_logged_in",
      "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
    );
  }
  const absPath = path.isAbsolute(input.filePath) ? input.filePath : path.resolve(cwd, input.filePath);
  return uploadLocalMedia(absPath, token);
}
