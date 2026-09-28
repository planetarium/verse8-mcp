import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  checkVerseIdAvailable,
  createVerse,
  getVerse,
  updateVerse,
  type VerseInfo,
} from "../api/v8MemeApi.js";
import { detectAttachment } from "../context/attachment.js";
import { readEnvAccount, readEnvVerse } from "../context/envFile.js";
import { isMsuProject } from "../context/msuProject.js";
import { loadToken } from "../context/token.js";
import { detectVerseProject } from "../context/verseProject.js";
import { sanitizeChildEnv } from "../util/childEnv.js";
import { resolveAgent8Pin } from "../util/gameserverPin.js";
import { safeErrorHint, safeHint } from "../util/redact.js";
import {
  checkpointInputSchema,
  runCheckpoint,
  type CheckpointResult,
} from "./checkpoint.js";
import {
  buildWebEditorLink,
  deriveProjectPathFromOrigin,
  detectGameserver,
} from "./preview.js";
import { uploadLocalMedia } from "./uploadThumbnail.js";

/**
 * verse8_deploy — publish the project to Verse8 (first deploy or update),
 * replicating the web editor's Launch flow without a browser:
 *
 *   1. resolve mode   GET /v1/verse/verseId (404 → first, 200 → update)
 *   2. checkpoint     V8 commit of pending changes (playUrl pins the sha)
 *   3. media          thumbnailPath / videoPath → contents.verse8.io
 *   4. build          rm -rf dist → install → `bun run build --base ./`
 *                     → `@agent8/gameserver-node build` (gameserver projects)
 *   5. upload         `@agent8/deploy --prod --verse <id> --account <acct>`
 *   6. publish        POST /v1/verse/create | /v1/verse/update/:verseId
 *
 * Mirrors agent8 container-agent deploy (message-handler.ts
 * handleDeployOperation + deploy-command.ts) and verse8-vibe's publish
 * handler (creator/editor/page.tsx).
 *
 * The verse id is NEVER re-minted here: VX Shop products, the deployed
 * server.js ($onItemPurchased) and crossramp setup are all keyed by the
 * verse id, so silently switching ids would orphan them. Conflicts stop
 * with an error instead.
 */

const GAMES_BASE_URL = "https://agent8-games.verse8.io";
const PUBLISH_ALLOWED_SYSTEM_TAGS = new Set(["__MSU", "__review_required"]);
const MSU_TAGS = ["__MSU", "__review_required"];
const RELEASE_NOTE_TYPES = [
  "New",
  "Improvements",
  "Balance",
  "Events",
  "Compatibility",
  "BugFixes",
] as const;
/** Values interpolated into argv under a Windows shell — keep them inert. */
const SAFE_ARG = /^[A-Za-z0-9_.-]+$/;

export const deployInputSchema = checkpointInputSchema
  .extend({
    title: z
      .string()
      .min(1)
      .optional()
      .describe("Verse title. Required on first deploy; defaults to the current title on update."),
    shortDescription: z
      .string()
      .max(500)
      .optional()
      .describe("One-line game preview text (≤500 chars)."),
    description: z.string().optional().describe("Full verse description."),
    thumbnailPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Local cover image (png/jpg/jpeg/gif/webp, ≤4 MB), absolute or relative to projectDir. Uploaded to contents.verse8.io and sent as imageUrl. First deploy needs this or imageUrl.",
      ),
    imageUrl: z
      .string()
      .url()
      .optional()
      .describe("Already-hosted cover image URL (e.g. from verse8_upload_thumbnail). Mutually exclusive with thumbnailPath."),
    videoPath: z
      .string()
      .min(1)
      .optional()
      .describe("Local preview video (mp4, ≤10 MiB). Uploaded and sent as videoUrl."),
    videoUrl: z
      .string()
      .url()
      .optional()
      .describe("Already-hosted preview video URL. Mutually exclusive with videoPath."),
    visibility: z
      .enum(["Public", "Unlisted", "Private"])
      .optional()
      .describe("Public (listed), Unlisted (link only), Private (owner only). First deploy default Public; update keeps the current value."),
    tags: z
      .array(z.string().min(1))
      .max(5)
      .optional()
      .describe("User tags (≤5, no `__` prefix). Update keeps the current user tags when omitted."),
    allowRemix: z.boolean().optional(),
    isMobileSupported: z.boolean().optional(),
    releaseNoteTitle: z.string().max(50).optional(),
    releaseNoteTypes: z.array(z.enum(RELEASE_NOTE_TYPES)).min(1).max(3).optional(),
    releaseNoteDescription: z.string().optional(),
    sendNotificationToFollowers: z
      .boolean()
      .default(false)
      .describe("Notify followers about this release. Default false (same as the web dialog)."),
    installCommand: z
      .string()
      .min(1)
      .default("bun update")
      .describe("Dependency sync before the build. Default `bun update` (same as the web editor)."),
    stepTimeoutMs: z
      .number()
      .int()
      .min(5_000)
      .max(1_800_000)
      .default(600_000)
      .describe("Per-step timeout for install / build / upload. Default 600000 (10 min)."),
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "When true, only resolve first-vs-update, validate metadata and return the planned steps + publish body. No commit, upload, build or publish.",
      ),
  })
  .strict();

export type DeployInput = z.infer<typeof deployInputSchema>;

export type DeployMode = "first" | "update";

export interface DeployStepResult {
  command: string;
  durationMs: number;
  exitCode: number;
  stdoutTail?: string;
  stderrTail?: string;
}

export type DeployResult =
  | {
      ok: true;
      dryRun: boolean;
      mode: DeployMode;
      verseId: string;
      playUrl: string;
      publishBody: Record<string, unknown>;
      plannedSteps?: string[];
      commit?: CheckpointResult;
      steps?: DeployStepResult[];
      verse?: VerseInfo;
      msu: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      stage: string;
      error: string;
      hint: string;
      [k: string]: unknown;
    };

function fail(
  stage: string,
  error: string,
  hint: string,
  extras: Record<string, unknown> = {},
): DeployResult {
  return { ok: false, stage, error, hint: safeHint(hint), ...extras };
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Final `tag` array for the publish body. Server rules (g2-sync
 * verseTag.service): ≤5 user tags, and the only `__` tags a user may send
 * are `__MSU` / `__review_required` — any other system tag on the existing
 * verse (admin-owned) must be left out or the update is rejected; the
 * server keeps those itself.
 */
export function buildPublishTags(
  inputTags: string[] | undefined,
  existingTags: string[] | undefined,
  msu: boolean,
): string[] {
  const existing = existingTags ?? [];
  const userTags = inputTags ?? existing.filter((t) => !t.startsWith("__"));
  const systemTags = existing.filter((t) => PUBLISH_ALLOWED_SYSTEM_TAGS.has(t));
  if (msu) systemTags.push(...MSU_TAGS);
  return [...new Set([...userTags, ...systemTags])];
}

export function buildPlayUrl(
  verseId: string,
  sha: string | null,
  projectPath: string | null,
  buildAt: number,
): string {
  const qs = new URLSearchParams();
  if (projectPath) qs.set("chatId", projectPath);
  if (sha) qs.set("sha", sha);
  qs.set("buildAt", String(buildAt));
  return `${GAMES_BASE_URL}/${encodeURIComponent(verseId)}/index.html?${qs.toString()}`;
}

export interface PublishFields {
  title?: string;
  shortDescription?: string;
  description?: string;
  imageUrl?: string;
  videoUrl?: string;
  visibility?: "Public" | "Unlisted" | "Private";
  allowRemix?: boolean;
  isMobileSupported?: boolean;
  releaseNoteTitle?: string;
  releaseNoteTypes?: string[];
  releaseNoteDescription?: string;
  sendNotificationToFollowers: boolean;
}

/** Request body for /v1/verse/create (first) or /v1/verse/update/:id. */
export function buildPublishBody(args: {
  mode: DeployMode;
  verseId: string;
  playUrl: string;
  fields: PublishFields;
  tags: string[];
  existing: VerseInfo | null;
  parentVerseId: string | null;
}): Record<string, unknown> {
  const { mode, fields, existing } = args;
  const common = {
    shortDescription: fields.shortDescription ?? existing?.shortDescription,
    playUrl: args.playUrl,
    tag: args.tags,
    releaseNoteTitle: fields.releaseNoteTitle,
    releaseNoteTypes: fields.releaseNoteTypes,
    releaseNoteDescription: fields.releaseNoteDescription,
    sendNotificationToFollowers: fields.sendNotificationToFollowers,
  };
  if (mode === "first") {
    return dropUndefined({
      verseId: args.verseId,
      title: fields.title,
      description: fields.description ?? "",
      imageUrl: fields.imageUrl,
      videoUrl: fields.videoUrl,
      category: "ALL",
      parentVerseId: args.parentVerseId ?? undefined,
      isPublic: true,
      visibility: fields.visibility ?? "Public",
      allowRemix: fields.allowRemix ?? false,
      isMobileSupported: fields.isMobileSupported ?? false,
      ...common,
    });
  }
  return dropUndefined({
    title: fields.title ?? existing?.title,
    description: fields.description ?? existing?.description,
    imageUrl: fields.imageUrl ?? existing?.imageUrl,
    videoUrl: fields.videoUrl ?? existing?.videoUrl,
    category: existing?.category ?? "ALL",
    isPublic: existing?.isPublic ?? true,
    visibility: fields.visibility ?? existing?.visibility ?? "Public",
    allowRemix: fields.allowRemix ?? existing?.allowRemix,
    isMobileSupported: fields.isMobileSupported ?? existing?.isMobileSupported,
    ...common,
  });
}

/** `verse-from-<parentVerseId>` git tag marks a remix (web editor convention). */
export function readParentVerseId(projectDir: string): string | null {
  try {
    const out = execFileSync("git", ["tag", "-l", "verse-from-*"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first ? first.slice("verse-from-".length) || null : null;
  } catch {
    return null;
  }
}

function readHeadSha(projectDir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function isGameserverProject(projectDir: string): boolean {
  // Container rule: `[ -e server ] || [ -f src/server.ts ]`; preview's
  // detectGameserver additionally covers root server.ts / server.js.
  return detectGameserver(projectDir) || fs.existsSync(path.join(projectDir, "src", "server.ts"));
}

interface StepSpec {
  command: string;
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildDeploySteps(args: {
  installCommand: string;
  gameserver: boolean;
  verseId: string;
  account: string;
  baseEnv: NodeJS.ProcessEnv;
  token: string;
}): StepSpec[] {
  const [installBin, ...installArgs] = args.installCommand.trim().split(/\s+/);
  const steps: StepSpec[] = [];
  if (installBin) {
    steps.push({ command: args.installCommand.trim(), cmd: installBin, args: installArgs, env: args.baseEnv });
  }
  steps.push({
    command: "bun run build --base ./",
    cmd: "bun",
    args: ["run", "build", "--base", "./"],
    env: args.baseEnv,
  });
  if (args.gameserver) {
    const gsPin = resolveAgent8Pin("gameserver-node");
    steps.push({
      command: `npx -y ${gsPin.nameArg} build`,
      cmd: "npx",
      args: ["-y", gsPin.nameArg, "build"],
      env: args.baseEnv,
    });
  }
  const deployPin = resolveAgent8Pin("deploy");
  steps.push({
    command: `npx -y ${deployPin.nameArg} --prod --verse ${args.verseId} --account ${args.account}`,
    cmd: "npx",
    args: ["-y", deployPin.nameArg, "--prod", "--verse", args.verseId, "--account", args.account],
    // The deploy CLI authenticates uploads with V8_ACCESS_TOKEN; only this
    // step sees it (install/build run third-party code).
    env: { ...args.baseEnv, V8_ACCESS_TOKEN: args.token },
  });
  return steps;
}

function tail(s: string, lines = 20): string {
  if (!s) return "";
  return s.split(/\r?\n/).slice(-lines).join("\n").trim();
}

function runStep(cwd: string, step: StepSpec, timeoutMs: number): DeployStepResult {
  const start = Date.now();
  try {
    const out = execFileSync(step.cmd, step.args, {
      cwd,
      env: step.env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      // npx / bun are .cmd shims on Windows; argv is SAFE_ARG-validated.
      shell: process.platform === "win32",
    });
    return { command: step.command, durationMs: Date.now() - start, exitCode: 0, stdoutTail: tail(String(out)) };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: string | null;
    };
    return {
      command: step.command,
      durationMs: Date.now() - start,
      exitCode: typeof err.status === "number" ? err.status : err.signal ? 128 : -1,
      stdoutTail: tail(String(err.stdout ?? "")),
      stderrTail: tail(String(err.stderr ?? err.message ?? "")),
    };
  }
}

/**
 * Publish-only plugin shim check. The web container injects
 * `dist/__agent8/plugins/debug-panel-shim.js` at publish time when the
 * build references `DebugPanel`; the MCP has no plugin injection yet, so
 * such a build would throw ReferenceError in production. Warn only.
 */
function detectDebugPanelWithoutShim(distDir: string): boolean {
  if (fs.existsSync(path.join(distDir, "__agent8", "plugins"))) return false;
  const stack = [distDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.(js|html)$/.test(entry.name)) {
        try {
          if (fs.readFileSync(full, "utf8").includes("DebugPanel")) return true;
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  }
  return false;
}

function looksLikeBotCheck(body: string): boolean {
  return /captcha|turnstile|bot|app.?check/i.test(body);
}

export async function runDeploy(
  input: DeployInput,
  serverCwd: string = process.cwd(),
): Promise<DeployResult> {
  const cwd = path.resolve(input.projectDir ?? serverCwd);
  const warnings: string[] = [];

  // ── 1. Preflight gates ────────────────────────────────────────────────
  const project = detectVerseProject(cwd);
  if (!project.isVerse) {
    return fail("preflight", "not_a_verse_project", `${cwd} is not a verse8 project (missing .verse8/project.json or wrong origin).`);
  }
  const token = loadToken(cwd);
  if (!token) {
    return fail("preflight", "not_logged_in", "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh");
  }
  const attachment = detectAttachment(cwd);
  if (!attachment.attached && !input.skipAttachCheck) {
    return fail("preflight", "project_needs_attach", `project is not fully attached (${attachment.missing.join(", ")} missing). Call verse8_attach first.`, {
      missing: attachment.missing,
    });
  }
  const verseId = readEnvVerse(cwd);
  if (!verseId) {
    return fail("preflight", "missing_verse_env", "VITE_AGENT8_VERSE is absent from <projectDir>/.env. Call verse8_attach to materialize it.");
  }
  const account = readEnvAccount(cwd);
  if (!account) {
    return fail("preflight", "missing_account_env", "VITE_AGENT8_ACCOUNT is absent from <projectDir>/.env. Call verse8_attach to materialize it.");
  }
  if (!SAFE_ARG.test(verseId) || !SAFE_ARG.test(account)) {
    return fail("preflight", "invalid_input", "VITE_AGENT8_VERSE / VITE_AGENT8_ACCOUNT in .env contain unexpected characters.");
  }

  // ── 2. Input validation (cheap, before any network) ───────────────────
  if (input.thumbnailPath && input.imageUrl) {
    return fail("validate", "invalid_input", "Pass either thumbnailPath or imageUrl, not both.");
  }
  if (input.videoPath && input.videoUrl) {
    return fail("validate", "invalid_input", "Pass either videoPath or videoUrl, not both.");
  }
  const reservedTags = (input.tags ?? []).filter((t) => t.startsWith("__"));
  if (reservedTags.length > 0) {
    return fail("validate", "invalid_input", `Tags starting with '__' are reserved: ${reservedTags.join(", ")}`);
  }

  // ── 3. First vs update ────────────────────────────────────────────────
  let mode: DeployMode;
  let existing: VerseInfo | null = null;
  try {
    const got = await getVerse(verseId, token);
    if (got.ok) {
      if (got.data.isOwner === false) {
        return fail(
          "resolve_mode",
          "verse_owned_by_other",
          `Verse ${verseId} is already published by another account. This project's .env points at someone else's verse; run verse8_attach with overwriteEnv:true to mint a new verse id for your account (a new id starts with no VX Shop products).`,
        );
      }
      mode = "update";
      existing = got.data;
    } else if (got.status === 404) {
      mode = "first";
      const avail = await checkVerseIdAvailable(verseId, token);
      if (avail.ok && avail.data.available === false) {
        return fail(
          "resolve_mode",
          "verse_id_unavailable",
          `Verse id ${verseId} cannot be published (${avail.data.reason ?? "unavailable"}). Run verse8_attach with overwriteEnv:true to mint a new verse id — note VX Shop products and gameserver data are keyed by verse id and do not carry over.`,
          { reason: avail.data.reason },
        );
      }
    } else if (got.status === 401) {
      return fail("resolve_mode", "unauthorized", "Verse8 token rejected. Re-run verse8_login_start.", { status: got.status });
    } else {
      return fail("resolve_mode", "upstream_error", `GET /v1/verse/verseId failed: HTTP ${got.status} ${got.body.slice(0, 200)}`, {
        status: got.status,
      });
    }
  } catch (e) {
    return fail("resolve_mode", "upstream_unreachable", safeErrorHint(e));
  }

  // ── 4. Metadata ───────────────────────────────────────────────────────
  if (mode === "first") {
    const missing: string[] = [];
    if (!input.title) missing.push("title");
    if (!input.thumbnailPath && !input.imageUrl) missing.push("thumbnailPath or imageUrl");
    if (missing.length > 0) {
      return fail("validate", "invalid_input", `First deploy of ${verseId} requires: ${missing.join(", ")}. Ask the user for them (thumbnail can be generated with image_asset_generate and passed as thumbnailPath).`, {
        mode,
        missing,
      });
    }
  }
  const msu = isMsuProject(cwd);
  const tags = buildPublishTags(input.tags, existing?.tag, msu);
  const parentVerseId = mode === "first" ? readParentVerseId(cwd) : null;
  const projectPath = deriveProjectPathFromOrigin(cwd);
  const gameserver = isGameserverProject(cwd);
  const fields: PublishFields = {
    title: input.title,
    shortDescription: input.shortDescription,
    description: input.description,
    imageUrl: input.imageUrl,
    videoUrl: input.videoUrl,
    visibility: input.visibility,
    allowRemix: input.allowRemix,
    isMobileSupported: input.isMobileSupported,
    releaseNoteTitle: input.releaseNoteTitle,
    releaseNoteTypes: input.releaseNoteTypes,
    releaseNoteDescription: input.releaseNoteDescription,
    sendNotificationToFollowers: input.sendNotificationToFollowers,
  };
  const baseEnv: NodeJS.ProcessEnv = {
    ...sanitizeChildEnv(),
    // Vite bakes VITE_* into the bundle; @verse8/platform (VX Shop
    // buyItem) reads VITE_AGENT8_VERSE from it. Set explicitly like the
    // container does instead of trusting whatever the shell exported.
    VITE_AGENT8_ACCOUNT: account,
    VITE_AGENT8_VERSE: verseId,
  };
  const steps = buildDeploySteps({ installCommand: input.installCommand, gameserver, verseId, account, baseEnv, token });

  if (input.dryRun) {
    const placeholderFields: PublishFields = {
      ...fields,
      imageUrl: input.thumbnailPath ? `<upload:${input.thumbnailPath}>` : fields.imageUrl,
      videoUrl: input.videoPath ? `<upload:${input.videoPath}>` : fields.videoUrl,
    };
    const playUrl = buildPlayUrl(verseId, "<HEAD after checkpoint>", projectPath, Date.now());
    return {
      ok: true,
      dryRun: true,
      mode,
      verseId,
      playUrl,
      publishBody: buildPublishBody({ mode, verseId, playUrl, fields: placeholderFields, tags, existing, parentVerseId }),
      plannedSteps: [
        "verse8_checkpoint (pending changes)",
        ...(input.thumbnailPath ? [`upload thumbnail ${input.thumbnailPath}`] : []),
        ...(input.videoPath ? [`upload video ${input.videoPath}`] : []),
        "rm -rf dist",
        ...steps.map((s) => s.command),
        mode === "first" ? "POST /v1/verse/create" : `POST /v1/verse/update/${verseId}`,
      ],
      msu,
      warnings,
    };
  }

  // ── 5. Checkpoint ─────────────────────────────────────────────────────
  const ckKeys = Object.keys(checkpointInputSchema.shape) as (keyof typeof checkpointInputSchema.shape)[];
  const ckInput = checkpointInputSchema.parse(
    Object.fromEntries(ckKeys.map((k) => [k, input[k]]).filter(([, v]) => v !== undefined)),
  );
  const commit = await runCheckpoint(ckInput, serverCwd);
  if (!commit.ok) {
    const code = (commit as { error: string }).error;
    if (code === "push_failed") {
      warnings.push("Local commit succeeded but push to gitlab.verse8.io failed; the deployed sha is not on the remote yet. Retry with verse8_checkpoint.");
    } else if (code !== "nothing_to_commit") {
      return fail("checkpoint", "checkpoint_failed", `Deploy aborted: checkpoint failed (${code}). Fix the commit error first.`, { checkpoint: commit });
    }
  }

  // ── 6. Media uploads ──────────────────────────────────────────────────
  if (input.thumbnailPath) {
    const abs = path.isAbsolute(input.thumbnailPath) ? input.thumbnailPath : path.resolve(cwd, input.thumbnailPath);
    const up = await uploadLocalMedia(abs, token, "image");
    if (!up.ok) return { ...up, ok: false, stage: "media", error: up.error, hint: up.hint };
    fields.imageUrl = up.url;
  }
  if (input.videoPath) {
    const abs = path.isAbsolute(input.videoPath) ? input.videoPath : path.resolve(cwd, input.videoPath);
    const up = await uploadLocalMedia(abs, token, "video");
    if (!up.ok) return { ...up, ok: false, stage: "media", error: up.error, hint: up.hint };
    fields.videoUrl = up.url;
  }

  // ── 7. Build + upload ─────────────────────────────────────────────────
  const distDir = path.join(cwd, "dist");
  try {
    fs.rmSync(distDir, { recursive: true, force: true });
  } catch (e) {
    return fail("build", "build_failed", `could not clear dist/: ${safeErrorHint(e)}`);
  }
  const completed: DeployStepResult[] = [];
  const uploadStep = steps[steps.length - 1];
  for (const step of steps) {
    if (step === uploadStep && !fs.existsSync(path.join(distDir, "index.html"))) {
      return fail("build", "build_failed", "Build finished but dist/index.html is missing — check the project's build script.", {
        stepsCompleted: completed,
      });
    }
    const res = runStep(cwd, step, input.stepTimeoutMs);
    if (res.exitCode !== 0) {
      const isUpload = step === uploadStep;
      return fail(
        isUpload ? "upload" : "build",
        isUpload ? "deploy_upload_failed" : "build_failed",
        `Deploy aborted at: ${step.command} (exit ${res.exitCode}).` + (res.stderrTail ? `\n--- stderr (last lines) ---\n${res.stderrTail}` : ""),
        { failedStep: res, stepsCompleted: completed },
      );
    }
    completed.push(res);
  }
  if (detectDebugPanelWithoutShim(distDir)) {
    warnings.push("The build references DebugPanel but no publish plugin shim was injected (the web editor adds dist/__agent8/plugins/debug-panel-shim.js). The published game may throw ReferenceError: DebugPanel — verify the play URL.");
  }

  // ── 8. Publish verse record ───────────────────────────────────────────
  const playUrl = buildPlayUrl(verseId, readHeadSha(cwd), projectPath, Date.now());
  const publishBody = buildPublishBody({ mode, verseId, playUrl, fields, tags, existing, parentVerseId });
  let published;
  try {
    published = mode === "first" ? await createVerse(publishBody, token) : await updateVerse(verseId, publishBody, token);
  } catch (e) {
    return fail("publish", "upstream_unreachable", safeErrorHint(e), { steps: completed, playUrl });
  }
  if (!published.ok) {
    const { status, body } = published;
    const webEditor = projectPath ? buildWebEditorLink(projectPath).url : "https://create.verse8.io/";
    if (mode === "first" && status === 403 && looksLikeBotCheck(body)) {
      return fail(
        "publish",
        "captcha_required",
        `Game files are uploaded (${playUrl}) but the first publish needs the web captcha — POST /v1/verse/create rejects headless calls. Finish the first publish in the web editor: ${webEditor}. Later updates work from verse8_deploy.`,
        { status, playUrl, steps: completed, publishBody },
      );
    }
    const code =
      status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 409 ? "verse_owned_by_other" : status >= 400 && status < 500 ? "bad_request" : "verse_publish_failed";
    return fail("publish", code, `${mode === "first" ? "create" : "update"} verse failed: HTTP ${status} ${body.slice(0, 300)}`, {
      status,
      playUrl,
      steps: completed,
      publishBody,
    });
  }

  return {
    ok: true,
    dryRun: false,
    mode,
    verseId,
    playUrl,
    publishBody,
    commit,
    steps: completed,
    verse: published.data,
    msu,
    warnings,
  };
}
