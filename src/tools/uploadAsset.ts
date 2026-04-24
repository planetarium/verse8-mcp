import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { uploadAttachment } from "../api/agent8Backend.js";
import { detectAttachment } from "../context/attachment.js";
import { readEnvVerse } from "../context/envFile.js";
import { loadToken } from "../context/token.js";
import { detectVerseProject } from "../context/verseProject.js";
import {
  detectContentType,
  isAllowedAttachmentExt,
} from "../format/attachmentExts.js";
import {
  resolveCdnPath,
  type AssetCategory,
} from "../format/assetShortcuts.js";
import { safeHint } from "../util/redact.js";
import { isSafeAbsPath } from "../util/safePath.js";

/**
 * verse8_upload_asset — upload a single local file to the Verse8 CDN via
 * agent8-backend's /api/upload-attachment route.
 *
 * Preflight order (cheapest → most expensive):
 *   verse-project → token → attachment → env → file stat → extension →
 *   cdnPath resolution → multipart POST.
 *
 * Meme-api's `/v1/activity/upload-asset` counter endpoint is NOT called
 * — that bookkeeping is out of scope for the MCP tool.
 */

export const uploadAssetInputSchema = z
  .object({
    filePath: z
      .string()
      .min(1)
      .describe(
        "Absolute path, or path relative to projectDir, of the local file to upload.",
      ),
    category: z
      .enum(["bgm", "sfx", "image", "effect"])
      .optional()
      .describe(
        "Shortcut for a pre-defined CDN subpath. Exactly one of {category, cdnPath} is required.",
      ),
    cdnPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "CDN subpath under the verse (e.g. 'assets/custom'). Must be relative, no '..' segments, no NUL.",
      ),
    projectDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "projectDir must not contain `..`, NUL byte, or redundant separators",
      })
      .optional()
      .describe(
        "Absolute path to the verse8 project. Defaults to process.cwd().",
      ),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Override the filename sent to the backend. Defaults to basename(filePath). Must not contain path separators or NUL.",
      ),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasCategory = typeof val.category === "string";
    const hasCdn = typeof val.cdnPath === "string";
    if (hasCategory && hasCdn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass exactly one of { category, cdnPath }; got both.",
        path: ["category"],
      });
    }
    if (!hasCategory && !hasCdn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass either `category` or `cdnPath`.",
        path: ["category"],
      });
    }
  });

export type UploadAssetInput = z.infer<typeof uploadAssetInputSchema>;

export type UploadAssetResult =
  | {
      ok: true;
      url: string;
      filename: string;
      cdnPath: string;
      verse: string;
      sizeBytes: number;
      contentType: string;
    }
  | { ok: false; error: string; hint: string; [k: string]: unknown };

function fail(
  error: string,
  hint: string,
  extras: Record<string, unknown> = {},
): UploadAssetResult {
  return { ok: false, error, hint: safeHint(hint), ...extras };
}

function resolveInputPath(filePath: string, projectDir: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectDir, filePath);
}

function isSafeFilename(name: string): boolean {
  if (name.length === 0) return false;
  if (name.indexOf(String.fromCharCode(0)) >= 0) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

export async function runUploadAsset(
  input: UploadAssetInput,
  serverCwd: string = process.cwd(),
): Promise<UploadAssetResult> {
  const cwd = input.projectDir ?? serverCwd;

  // 1. Verse project gate
  const project = detectVerseProject(cwd);
  if (!project.isVerse) {
    return fail(
      "not_a_verse_project",
      `${cwd} is not a verse8 project (missing .verse8/project.json or wrong origin).`,
    );
  }

  // 2. Token gate
  const token = loadToken(cwd);
  if (!token) {
    return fail(
      "not_logged_in",
      "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
    );
  }

  // 3. Attachment gate
  const attachment = detectAttachment(cwd);
  if (!attachment.attached) {
    return fail(
      "project_needs_attach",
      `project is not fully attached (${attachment.missing.join(", ")} missing). Call verse8_attach first.`,
      { missing: attachment.missing },
    );
  }

  // 4. Verse env
  const verse = readEnvVerse(cwd);
  if (!verse) {
    return fail(
      "missing_verse_env",
      "VITE_AGENT8_VERSE is absent from <projectDir>/.env. Call verse8_attach to materialize it.",
    );
  }

  // 5. Resolve + stat input file
  const absPath = resolveInputPath(input.filePath, cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return fail("file_not_found", `cannot stat ${absPath}`);
  }
  if (!stat.isFile()) {
    return fail("file_not_regular", `${absPath} is not a regular file`);
  }

  // 6. Filename + extension
  const defaultName = path.basename(absPath);
  const filename = input.filename ?? defaultName;
  if (!isSafeFilename(filename)) {
    return fail(
      "cdn_path_invalid",
      "filename must not contain path separators or NUL",
    );
  }
  if (!isAllowedAttachmentExt(filename)) {
    return fail(
      "invalid_extension",
      `extension not in ATTACHMENT_EXTS allowlist (filename=${filename})`,
    );
  }
  const contentType = detectContentType(filename);

  // 7. Resolve cdnPath
  const resolvedCdn = resolveCdnPath({
    category: input.category as AssetCategory | undefined,
    cdnPath: input.cdnPath,
  });
  if (!resolvedCdn.ok) {
    return fail(resolvedCdn.error, resolvedCdn.hint);
  }

  // 8. Upload
  const buf = fs.readFileSync(absPath);
  const blob = new Blob([buf], { type: contentType });
  const resp = await uploadAttachment({
    file: blob,
    filename,
    cdnPath: resolvedCdn.cdnPath,
    verse,
    token,
  });
  if (!resp.ok) {
    return fail(resp.error, resp.hint, { status: resp.status });
  }

  return {
    ok: true,
    url: resp.url,
    filename,
    cdnPath: resolvedCdn.cdnPath,
    verse,
    sizeBytes: stat.size,
    contentType,
  };
}
