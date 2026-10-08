/**
 * CDN path validation for verse8_upload_asset.
 *
 * Note on design history: an earlier revision exposed `category` shortcuts
 * (bgm/sfx/image/effect) that mapped to fixed subpaths. Those shortcuts
 * were a convention from the RB prototype repo, NOT the V8 template
 * standard — V8 templates use an `src/assets.json` manifest as the single
 * source of truth for asset URLs, and CDN subpaths vary per-template
 * (`assets/3d/animations/mixamorig/`, `assets/images/`, etc.). Locking
 * users to a 4-way category split would have nudged LLMs away from the
 * project-specific convention recorded in that manifest. We dropped it.
 *
 * Contract:
 *   - `cdnPath` is the only subpath input, and is required.
 *   - Must be a relative path (no leading `/`), must not contain `..`
 *     segments or NUL bytes, and has any trailing slash stripped.
 */

export type ResolveCdnPathInput = {
  cdnPath?: string;
};

export type ResolveCdnPathResult =
  | { ok: true; cdnPath: string }
  | {
      ok: false;
      error: "cdn_path_required" | "cdn_path_invalid";
      hint: string;
    };

// MCP-UP-2: `cdnPath` traversal rejected before the network
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
  const hasCdn = typeof input.cdnPath === "string" && input.cdnPath.length > 0;
  if (!hasCdn) {
    return {
      ok: false,
      error: "cdn_path_required",
      hint: "Pass `cdnPath` (relative subpath, e.g. 'assets/images'). Inspect the project's src/assets.json first to match existing URL patterns.",
    };
  }
  return sanitizeCdnPath(input.cdnPath as string);
}
