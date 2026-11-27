/**
 * `src/assets.json` — the project's asset list, in the shape the web
 * editor's Resource panel reads and writes (planetarium/agent8
 * apps/frontend/src/components/workbench/ResourcePanel.tsx). There is no
 * API for it on the web either: the panel edits the file in the project's
 * container. These helpers do the same edits on a parsed manifest; the
 * file I/O is in tools/assets.ts.
 *
 * Shape: nested category objects whose leaves are assets
 * `{ url, description, metadata }` (a node is an asset when it has a string
 * `url`). Keys are `<name>_<timestamp>_<counter>`. The panel saves with
 * `JSON.stringify(categories, null, 2)` (no trailing newline).
 */

export interface ManifestAsset {
  url: string;
  description: string;
  metadata: Record<string, unknown>;
}

export type Manifest = Record<string, unknown>;

/** The web's `isAsset`: an object with a string `url`. */
export function isManifestAsset(node: unknown): node is ManifestAsset {
  return (
    node !== null &&
    typeof node === "object" &&
    typeof (node as { url?: unknown }).url === "string"
  );
}

/** The web's save format. */
export function serializeManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2);
}

/**
 * The web's `generateAssetKeyFromFileName`: extension dropped, anything but
 * `[a-zA-Z0-9_-]` turned into `_`, runs of `_` collapsed, leading/trailing
 * `_` trimmed, lower-cased; empty becomes `resource`.
 */
export function generateAssetKey(
  fileName: string,
  timestamp: number,
  counter = 1,
): string {
  let base = fileName
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!base) base = "resource";
  return `${base}_${timestamp}_${counter}`;
}

/** The web's `getFileNameFromUrl`: last path segment, query dropped, URL-decoded; "" on failure. */
export function fileNameFromUrl(url: string): string {
  if (!url) return "";
  try {
    const parts = url.split("/");
    let name = parts[parts.length - 1];
    if (name.includes("?")) name = name.split("?")[0];
    return decodeURIComponent(name);
  } catch {
    return "";
  }
}

const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A category path is the list of nested category keys an asset goes under,
 * e.g. `["images"]` or `["3d", "characters"]`. Each segment also becomes a
 * CDN folder on upload (`assets/<a>/<b>`), so separators, `.`/`..` and NUL
 * are refused; object-prototype names are refused so a key can never reach
 * `Object.prototype`.
 */
export function categoryPathProblem(segments: readonly string[]): string | null {
  if (segments.length === 0) return "categoryPath needs at least one category";
  for (const s of segments) {
    if (s.length === 0) return "categoryPath has an empty segment";
    if (s.length > 100) return "categoryPath segment longer than 100 characters";
    if (s === "." || s === "..") return `categoryPath segment "${s}" is not allowed`;
    if (/[/\\\u0000]/.test(s)) return "categoryPath segments must not contain '/', '\\' or NUL";
    if (RESERVED_SEGMENTS.has(s)) return `categoryPath segment "${s}" is reserved`;
  }
  return null;
}

export type ManifestEditResult =
  | { ok: true; keys: string[] }
  | { ok: false; error: "asset_category_conflict"; hint: string };

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * Find the category object at `segments`, creating missing ones as the
 * web's "add from library" does. Unlike the web (which replaces a blocking
 * asset with an empty category), an existing asset or non-object value on
 * the way is a conflict: nothing already in the file is overwritten.
 */
export function findOrCreateCategory(
  manifest: Manifest,
  segments: readonly string[],
): { ok: true; node: Manifest } | { ok: false; error: "asset_category_conflict"; hint: string } {
  let node: Manifest = manifest;
  const walked: string[] = [];
  for (const seg of segments) {
    walked.push(seg);
    if (!hasOwn(node, seg)) {
      node[seg] = {};
    }
    const child = node[seg];
    if (
      child === null ||
      typeof child !== "object" ||
      Array.isArray(child) ||
      isManifestAsset(child)
    ) {
      return {
        ok: false,
        error: "asset_category_conflict",
        hint: `src/assets.json already has a non-category value at ${walked.join(".")}; pick another categoryPath.`,
      };
    }
    node = child as Manifest;
  }
  return { ok: true, node };
}

/**
 * Add assets under `segments`, each keyed from its file name the web's way.
 * A key already taken bumps the counter (`_2`, `_3`, …) as the web's
 * library add does, so an existing entry is never replaced. Mutates
 * `manifest`.
 */
export function addAssetsToManifest(
  manifest: Manifest,
  segments: readonly string[],
  entries: ReadonlyArray<{ fileName: string; asset: ManifestAsset }>,
  timestamp: number,
): ManifestEditResult {
  const found = findOrCreateCategory(manifest, segments);
  if (!found.ok) return found;
  const keys: string[] = [];
  for (const e of entries) {
    let counter = 1;
    let key = generateAssetKey(e.fileName, timestamp, counter);
    while (hasOwn(found.node, key)) key = generateAssetKey(e.fileName, timestamp, ++counter);
    found.node[key] = e.asset;
    keys.push(key);
  }
  return { ok: true, keys };
}

/**
 * Pixel size of a png / gif / jpeg / webp from its header — what the web
 * reads with an `<img>` before saving `width` / `height` into the upload's
 * metadata. `undefined` when the header is not recognised (and for svg,
 * which has no fixed pixel size).
 */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  // PNG: signature, then IHDR width/height (big-endian) at 16/20.
  if (
    buf.length >= 24 &&
    buf.readUInt32BE(0) === 0x89504e47 &&
    buf.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: "GIF8", logical screen width/height (little-endian) at 6/8.
  if (buf.length >= 10 && buf.toString("latin1", 0, 4) === "GIF8") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP then a VP8 / VP8L / VP8X chunk.
  if (
    buf.length >= 30 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return {
        width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
      };
    }
    return undefined;
  }
  // JPEG: walk the markers to the first SOFn frame header.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return undefined;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) return undefined;
      i += 2 + len;
    }
    return undefined;
  }
  return undefined;
}
