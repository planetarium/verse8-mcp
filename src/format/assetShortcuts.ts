/**
 * Category shortcuts and CDN path validation for verse8_upload_asset.
 *
 * The four categories mirror the upstream upload-asset.js shortcuts:
 *   --bgm, --sfx, --image, --effect.
 *
 * Validation rules:
 *   - Exactly one of `category` or `cdnPath` must be set.
 *   - `cdnPath` must be a relative path (no leading `/`), must not contain
 *     `..` segments or NUL bytes, and has a trailing slash stripped.
 */

export type AssetCategory = "bgm" | "sfx" | "image" | "effect";

export const ASSET_CATEGORY_TO_CDN_PATH: Readonly<Record<AssetCategory, string>> =
  Object.freeze({
    bgm: "assets/audio/bgm",
    sfx: "assets/audio/sfx",
    image: "assets/images",
    effect: "assets/effects",
  });

export type ResolveCdnPathInput = {
  category?: AssetCategory;
  cdnPath?: string;
};

export type ResolveCdnPathResult =
  | { ok: true; cdnPath: string }
  | {
      ok: false;
      error: "cdn_path_required" | "cdn_path_conflict" | "cdn_path_invalid";
      hint: string;
    };

function sanitizeCdnPath(raw: string): ResolveCdnPathResult {
  if (raw.length === 0) {
    return {
      ok: false,
      error: "cdn_path_invalid",
      hint: "cdnPath is empty",
    };
  }
  if (raw.startsWith("/")) {
    return {
      ok: false,
      error: "cdn_path_invalid",
      hint: "cdnPath must be relative (no leading '/')",
    };
  }
  if (raw.indexOf("\u0000") >= 0) {
    return {
      ok: false,
      error: "cdn_path_invalid",
      hint: "cdnPath must not contain NUL bytes",
    };
  }
  const stripped = raw.replace(/\/+$/, "");
  const segments = stripped.split("/");
  if (segments.some((s) => s === ".." || s === "")) {
    return {
      ok: false,
      error: "cdn_path_invalid",
      hint: "cdnPath must not contain '..' segments or empty segments",
    };
  }
  return { ok: true, cdnPath: stripped };
}

export function resolveCdnPath(input: ResolveCdnPathInput): ResolveCdnPathResult {
  const hasCategory = typeof input.category === "string" && input.category.length > 0;
  const hasCdn = typeof input.cdnPath === "string" && input.cdnPath.length > 0;
  if (hasCategory && hasCdn) {
    return {
      ok: false,
      error: "cdn_path_conflict",
      hint: "Pass exactly one of { category, cdnPath } — not both.",
    };
  }
  if (!hasCategory && !hasCdn) {
    return {
      ok: false,
      error: "cdn_path_required",
      hint: "Pass either `category` (bgm|sfx|image|effect) or `cdnPath`.",
    };
  }
  if (hasCategory) {
    const mapped = ASSET_CATEGORY_TO_CDN_PATH[input.category as AssetCategory];
    return { ok: true, cdnPath: mapped };
  }
  return sanitizeCdnPath(input.cdnPath as string);
}
