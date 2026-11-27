import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  searchResources,
  uploadAttachment,
  type ResourceItem,
  type ResourcePagination,
} from "../api/agent8Backend.js";
import { recordUploadAssetActivity } from "../api/v8MemeApi.js";
import { loadToken } from "../context/token.js";
import { detectVerseProject } from "../context/verseProject.js";
import { resolveCdnPath } from "../format/assetShortcuts.js";
import {
  addAssetsToManifest,
  categoryPathProblem,
  fileNameFromUrl,
  findOrCreateCategory,
  imageSize,
  serializeManifest,
  type Manifest,
  type ManifestAsset,
} from "../format/assetsManifest.js";
import { extractExt } from "../format/attachmentExts.js";
import { LOGIN_HINT } from "../util/hints.js";
import { projectWriter, ProjectWriteError } from "../util/projectWrite.js";
import { safeHint } from "../util/redact.js";
import { apiFail } from "./creatorOps.js";
import { checkUploadFile, checkUploadProject, type CheckedUploadFile } from "./uploadAsset.js";
import { projectDirField } from "./verseContext.js";

/**
 * verse8_assets — the web editor's Resource panel, locally
 * (planetarium/agent8 apps/frontend/src/components/workbench/ResourcePanel.tsx):
 *
 *   search  GET agent8-backend /api/resources with the panel's query
 *           (a category's tags, page, limit 20, trimmed keyword).
 *   add     put library items found by `search` into src/assets.json the
 *           way the panel's "add to category" does.
 *   upload  upload several files to `assets/<categoryPath>` with the gates
 *           of verse8_upload_asset, register the uploaded ones in
 *           src/assets.json the way the panel's upload does, and record
 *           POST /v1/activity/upload-asset {count}.
 *
 * src/assets.json has no API on the web either (the panel edits the file
 * in the container), so it is read, edited and written here. Existing
 * entries are kept; every write goes through `projectWriter`, so a link
 * that leads outside the project folder is refused (MCP-UP-4).
 */

/** The web panel's RESOURCE_CATEGORIES, as `<label path>` → tags. */
export const LIBRARY_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "2d": ["2d"],
  "2d/sprite_characters": ["2d", "sprite_characters"],
  "3d": ["3d"],
  "3d/characters": ["3d", "characters"],
  "3d/objects": ["3d", "objects"],
  "3d/monsters": ["3d", "monsters"],
  "3d/polyhaven": ["3d", "polyhaven"],
  "3d/vehicles": ["3d", "vehicles"],
  "3d/weapons": ["3d", "weapons"],
  "3d/textures": ["3d", "textures"],
});
const CATEGORY_NAMES = Object.keys(LIBRARY_CATEGORIES) as [string, ...string[]];

/** The web panel's page size. */
export const SEARCH_PAGE_SIZE = 20;
export const MANIFEST_REL = "src/assets.json";

const categoryPathField = z
  .array(z.string().min(1).max(100))
  .min(1)
  .max(8)
  .optional()
  .describe(
    "add / upload: category keys in src/assets.json to put the assets under, e.g. [\"images\"] or [\"3d\",\"characters\"]. Missing categories are created. Upload also stores the files at CDN folder assets/<a>/<b>. Read src/assets.json first and reuse its categories.",
  );

export const assetsInputSchema = z
  .object({
    action: z.enum(["search", "add", "upload"]),
    projectDir: projectDirField,
    category: z
      .enum(CATEGORY_NAMES)
      .optional()
      .describe("search: library category (the web panel's list). Required for search."),
    keyword: z.string().max(200).optional().describe("search: words to match."),
    page: z.number().int().min(1).optional().describe("search: page (default 1, 20 per page)."),
    ids: z
      .array(z.union([z.string().min(1).max(200), z.number().int()]))
      .min(1)
      .max(50)
      .optional()
      .describe("add: ids of items returned by search in this server session."),
    categoryPath: categoryPathField,
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).describe("Absolute path, or path relative to projectDir."),
            description: z
              .string()
              .max(2000)
              .optional()
              .describe("Description saved with the asset. Defaults to the file name."),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional()
      .describe("upload: local files to upload (same extension allowlist as verse8_upload_asset)."),
  })
  .strict();

export type AssetsInput = z.infer<typeof assetsInputSchema>;

type Fail = { ok: false; error: string; hint: string; [k: string]: unknown };
type Ok = { ok: true; [k: string]: unknown };
export type AssetsResult = Ok | Fail;

function fail(error: string, hint: string, extras: Record<string, unknown> = {}): Fail {
  return { ok: false, error, hint: safeHint(hint), ...extras };
}

// ── search results kept for `add` ──
//
// `add` takes only ids `search` returned, so what lands in src/assets.json
// is the library's own url / description / metadata, never values the host
// made up. There is no get-by-id endpoint, so the items are kept in memory
// for this server process (newest LIBRARY_CACHE_MAX).

const LIBRARY_CACHE_MAX = 500;
const libraryCache = new Map<string, ResourceItem>();

function rememberItems(items: readonly ResourceItem[]): void {
  for (const it of items) {
    libraryCache.delete(String(it.id));
    libraryCache.set(String(it.id), it);
  }
  while (libraryCache.size > LIBRARY_CACHE_MAX) {
    const oldest = libraryCache.keys().next().value as string;
    libraryCache.delete(oldest);
  }
}

/** Test hook: forget every remembered search result. */
export function _resetLibraryCacheForTests(): void {
  libraryCache.clear();
}

// ── src/assets.json I/O ──

type ManifestRead =
  | { ok: true; manifest: Manifest; mode?: number }
  | Fail;

/**
 * When the manifest is touched: `before` anything else happened (add, and
 * upload's check before the network), or `afterUpload`, when files are
 * already on the CDN and running the tool again would upload them twice.
 */
type ManifestPhase = "before" | "afterUpload";

const writerFor = (cwd: string) => projectWriter(cwd, { tool: "verse8_assets" });

/**
 * A manifest write refused because of a link, worded for this tool: the
 * projectWriter's own advice is generic, and after an upload "run it again"
 * would be wrong. The upload result adds what to do with the uploaded files.
 */
function manifestLinkRefusal(e: ProjectWriteError, phase: ManifestPhase): Fail {
  const what = `${MANIFEST_REL} was not written: a link on the way to it leads outside the project folder (${e.detail}). verse8_assets writes only inside the project folder`;
  return fail(
    "assets_manifest_write_failed",
    phase === "before"
      ? `${what}; nothing was changed. Remove or replace the link, then call verse8_assets again.`
      : `${what}. Remove or replace the link`,
  );
}

// MCP-UP-4: asset manifest writes never leave the project folder
function readManifest(cwd: string, phase: ManifestPhase): ManifestRead {
  const file = path.join(cwd, ...MANIFEST_REL.split("/"));
  try {
    // Checked before reading: content read through an outside link would
    // be written back into the project.
    writerFor(cwd).assertInside(file);
  } catch (e) {
    // Any failure here is reported, never thrown: this also runs after a
    // batch uploaded, and a throw would leave those uploads unrecorded.
    if (e instanceof ProjectWriteError) return manifestLinkRefusal(e, phase);
    return fail("assets_manifest_write_failed", `cannot check ${MANIFEST_REL}: ${(e as Error).message}`);
  }
  let raw: string;
  let mode: number | undefined;
  try {
    raw = fs.readFileSync(file, "utf8");
    mode = fs.statSync(file).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, manifest: {} };
    return fail("read_failed", `cannot read ${MANIFEST_REL}: ${(e as Error).message}`);
  }
  if (raw.trim().length === 0) return { ok: true, manifest: {}, mode };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail(
      "assets_manifest_invalid",
      `${MANIFEST_REL} is not valid JSON (${(e as Error).message}); fix it before adding assets — nothing was written.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("assets_manifest_invalid", `${MANIFEST_REL} must hold a JSON object of categories; nothing was written.`);
  }
  return { ok: true, manifest: parsed as Manifest, mode };
}

// MCP-UP-4: asset manifest writes never leave the project folder
function writeManifest(cwd: string, manifest: Manifest, mode: number | undefined, phase: ManifestPhase): Ok | Fail {
  const w = writerFor(cwd);
  const file = path.join(cwd, ...MANIFEST_REL.split("/"));
  try {
    w.mkdirp(path.dirname(file));
    w.writeFileAtomic(file, serializeManifest(manifest), mode);
  } catch (e) {
    if (e instanceof ProjectWriteError) return manifestLinkRefusal(e, phase);
    return fail("assets_manifest_write_failed", (e as Error).message);
  }
  return { ok: true };
}

function verseGate(cwd: string): Fail | null {
  if (!detectVerseProject(cwd).isVerse) {
    return fail(
      "not_a_verse_project",
      `${cwd} is not a verse8 project (missing .verse8/project.json or wrong origin).`,
    );
  }
  return null;
}

function checkCategoryPath(segments: readonly string[] | undefined): Fail | null {
  if (!segments) return fail("invalid_input", "categoryPath is required for this action.");
  const problem = categoryPathProblem(segments);
  return problem ? fail("invalid_input", problem) : null;
}

// ── actions ──

async function runSearch(input: AssetsInput, cwd: string): Promise<AssetsResult> {
  if (!input.category) {
    return fail("invalid_input", `search needs \`category\`: one of ${CATEGORY_NAMES.join(", ")}.`);
  }
  const token = loadToken(cwd);
  if (!token) return fail("not_logged_in", LOGIN_HINT);
  const page = input.page ?? 1;
  const r = await searchResources({
    tags: LIBRARY_CATEGORIES[input.category],
    page,
    limit: SEARCH_PAGE_SIZE,
    keyword: input.keyword,
    token,
  });
  if (!r.ok) return r.status === 0 ? fail("upstream_unreachable", r.body) : apiFail("asset library search", r);
  rememberItems(r.items);
  return {
    ok: true,
    category: input.category,
    keyword: input.keyword?.trim() || undefined,
    items: r.items,
    pagination: r.pagination as ResourcePagination,
    next: "To use items, call action add with their ids and a categoryPath.",
  };
}

async function runAdd(input: AssetsInput, cwd: string): Promise<AssetsResult> {
  const gate = verseGate(cwd);
  if (gate) return gate;
  if (!input.ids) return fail("invalid_input", "add needs `ids` from a search result.");
  const bad = checkCategoryPath(input.categoryPath);
  if (bad) return bad;
  const segments = input.categoryPath!;

  const ids = [...new Set(input.ids.map(String))];
  const missing = ids.filter((id) => !libraryCache.has(id));
  if (missing.length > 0) {
    return fail(
      "resource_not_found",
      "these ids were not returned by a search in this server session (search again, then add): " + missing.join(", "),
      { missing },
    );
  }

  const read = readManifest(cwd, "before");
  if (!read.ok) return read;
  const importedAt = new Date().toISOString();
  const entries = ids.map((id) => {
    const item = libraryCache.get(id)!;
    const fileName = fileNameFromUrl(item.url) || item.description || String(item.id);
    const asset: ManifestAsset = {
      url: item.url,
      description: item.description,
      metadata: {
        ...item.metadata,
        source: "resource_pool",
        imported_at: importedAt,
        original_id: item.id,
        original_filename: fileName,
      },
    };
    return { fileName, asset };
  });
  const edit = addAssetsToManifest(read.manifest, segments, entries, Date.now());
  if (!edit.ok) return fail(edit.error, edit.hint);
  const written = writeManifest(cwd, read.manifest, read.mode, "before");
  if (!written.ok) return written;
  return {
    ok: true,
    manifest: MANIFEST_REL,
    categoryPath: segments,
    added: edit.keys.map((key, i) => ({ key, id: libraryCache.get(ids[i])!.id, url: entries[i].asset.url })),
    next: usageHint(segments),
  };
}

/** `Assets.images[<key>].url`, with bracket access for keys like `3d`. */
function usageHint(segments: readonly string[]): string {
  const access = segments
    .map((s) => (/^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`))
    .join("");
  return `Use them in code via ${MANIFEST_REL} (import Assets from './assets.json'; Assets${access}[<key>].url).`;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

async function runUpload(input: AssetsInput, cwd: string): Promise<AssetsResult> {
  if (!input.files) return fail("invalid_input", "upload needs `files`.");
  const bad = checkCategoryPath(input.categoryPath);
  if (bad) return bad;
  const segments = input.categoryPath!;

  const gate = checkUploadProject(cwd);
  if (!gate.ok) return gate;
  const { token, verse } = gate;

  // The web uploads to assets/<category path>; it passes the same cdnPath
  // gate as verse8_upload_asset.
  const cdn = resolveCdnPath({ cdnPath: `assets/${segments.join("/")}` });
  if (!cdn.ok) return fail(cdn.error, cdn.hint);

  // Every file is checked before anything is uploaded.
  const checked: Array<{ file: CheckedUploadFile; description?: string }> = [];
  for (const f of input.files) {
    const c = checkUploadFile(f.path, cwd);
    if (!c.ok) return { ...c, file: f.path };
    checked.push({ file: c, description: f.description });
  }

  // The manifest must be writable at the target before bytes go out, so a
  // broken file or a conflicting category does not strand uploads.
  const pre = readManifest(cwd, "before");
  if (!pre.ok) return pre;
  const preFound = findOrCreateCategory(pre.manifest, segments);
  if (!preFound.ok) return fail(preFound.error, preFound.hint);

  const uploaded: Array<{ fileName: string; asset: ManifestAsset; path: string }> = [];
  const failed: Array<{ path: string; error: string; hint: string; status?: number }> = [];
  // A failure past the checks above (a file deleted or unreadable since its
  // stat, a dropped connection) fails that file only: the loop never throws,
  // so files already on the CDN still get registered and counted. Bytes are
  // read one file at a time rather than all up front, so a batch of large
  // files (verse8_upload_asset has no size cap) is never held in memory at once.
  for (const { file, description } of checked) {
    let buf: Buffer<ArrayBuffer>;
    try {
      buf = fs.readFileSync(file.absPath);
    } catch (e) {
      failed.push({ path: file.absPath, error: "read_failed", hint: safeHint(`cannot read ${file.absPath}: ${(e as Error).message}`) });
      continue;
    }
    let resp: Awaited<ReturnType<typeof uploadAttachment>>;
    try {
      resp = await uploadAttachment({
        file: new Blob([buf], { type: file.contentType }),
        filename: file.filename,
        cdnPath: cdn.cdnPath,
        verse,
        token,
      });
    } catch (e) {
      // Whether the bytes reached the CDN is unknown; it is reported as failed.
      failed.push({ path: file.absPath, error: "upload_failed", hint: safeHint(`upload interrupted: ${(e as Error).message}`) });
      continue;
    }
    if (!resp.ok) {
      failed.push({ path: file.absPath, error: resp.error, hint: resp.hint, status: resp.status });
      continue;
    }
    const fileExt = extractExt(file.filename);
    let dims: { width: number; height: number } | undefined;
    try {
      dims = IMAGE_EXTS.has(fileExt) ? imageSize(buf) : undefined;
    } catch {
      dims = undefined; // an odd header must not drop an upload that succeeded
    }
    // The web's final upload entry: the placeholder's metadata, then the
    // image size and extension, then uploadComplete (ResourcePanel.tsx
    // processFiles + uploadFile).
    const asset: ManifestAsset = {
      url: resp.url,
      description: description ?? file.filename,
      metadata: {
        type: file.contentType,
        uploadId: `upload_${Date.now()}_${randomBytes(4).toString("hex").slice(0, 7)}`,
        isPlaceholder: true,
        originalName: file.filename,
        ...(dims ?? {}),
        fileExt,
        uploadComplete: true,
      },
    };
    uploaded.push({ fileName: file.filename, asset, path: file.absPath });
  }

  let added: Array<{ key: string; path: string; url: string }> = [];
  let manifestError: Fail | undefined;
  if (uploaded.length > 0) {
    // Re-read: the uploads took time and the file may have changed.
    const read = readManifest(cwd, "afterUpload");
    if (!read.ok) {
      manifestError = read;
    } else {
      const edit = addAssetsToManifest(read.manifest, segments, uploaded, Date.now());
      if (!edit.ok) {
        manifestError = fail(edit.error, edit.hint);
      } else {
        const written = writeManifest(cwd, read.manifest, read.mode, "afterUpload");
        if (!written.ok) manifestError = written;
        else added = edit.keys.map((key, i) => ({ key, path: uploaded[i].path, url: uploaded[i].asset.url }));
      }
    }
  }

  let activityRecorded = false;
  let activityHint: string | undefined;
  if (uploaded.length > 0) {
    const a = await recordUploadAssetActivity(uploaded.length, token);
    activityRecorded = a.ok;
    if (!a.ok) activityHint = safeHint(`upload activity not recorded: HTTP ${a.status} ${a.body}`.slice(0, 300));
  }

  if (uploaded.length === 0) {
    return fail(failed[0].error, `no file uploaded: ${failed[0].hint}`, { failed });
  }
  if (manifestError) {
    return {
      ...manifestError,
      hint: safeHint(
        `${manifestError.hint} — the files below were uploaded but are NOT in ${MANIFEST_REL}; add them by hand (do not upload them again).`,
      ),
      uploaded: uploaded.map((u) => ({ path: u.path, url: u.asset.url })),
      failed,
      activityRecorded,
    };
  }
  return {
    ok: true,
    manifest: MANIFEST_REL,
    categoryPath: segments,
    cdnPath: cdn.cdnPath,
    verse,
    added,
    failed,
    activityRecorded,
    ...(activityHint ? { activityHint } : {}),
    next: usageHint(segments),
  };
}

export async function runAssets(
  input: AssetsInput,
  serverCwd: string = process.cwd(),
): Promise<AssetsResult> {
  const cwd = input.projectDir ?? serverCwd;
  switch (input.action) {
    case "search":
      return runSearch(input, cwd);
    case "add":
      return runAdd(input, cwd);
    case "upload":
      return runUpload(input, cwd);
  }
}
