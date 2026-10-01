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
import { parseV8CommitMessage } from "../format/v8CommitMessage.js";
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
import { uploadLocalMedia, validateLocalMedia } from "./uploadThumbnail.js";

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
export type ReleaseNoteType = (typeof RELEASE_NOTE_TYPES)[number];
/**
 * Field limits of the web publish dialog (verse8-vibe
 * `GAME_INFO_FORM_LENGTH`). The server accepts less (title + description
 * only), but the web is the product contract — release note types feed the
 * web's release-note components and follower notifications — so the MCP
 * enforces the same shape. Strict → lenient is backward compatible; the
 * reverse is not.
 */
export const WEB_PUBLISH_FORM = {
  TITLE_MIN: 4,
  TITLE_MAX: 50,
  SHORT_DESCRIPTION_MAX: 100,
  DESCRIPTION_MAX: 1000,
  TAGS_MAX: 5,
  RELEASE_NOTE_TITLE_MAX: 50,
  RELEASE_NOTE_DESCRIPTION_MAX: 1000,
  RELEASE_NOTE_TYPES_MAX: 3,
} as const;
/** Values interpolated into argv under a Windows shell — keep them inert. */
const SAFE_ARG = /^[A-Za-z0-9_.-]+$/;
/**
 * `installCommand` is split on whitespace and run with `shell: true` on
 * Windows (npx / bun are .cmd shims), so a token carrying shell syntax
 * (`&&`, `|`, `;`, `$(…)`, backticks, redirects, quotes, globs) would be
 * interpreted by cmd.exe. Only plain package-manager argv is accepted.
 */
const INSTALL_TOKEN_RE = /^[A-Za-z0-9_.@/:=+-]+$/;

/** Tokens of `installCommand` that could be interpreted by a shell. */
export function unsafeInstallCommandTokens(installCommand: string): string[] {
  return installCommand
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !INSTALL_TOKEN_RE.test(t));
}

export const deployInputSchema = checkpointInputSchema
  .extend({
    title: z
      .string()
      .min(WEB_PUBLISH_FORM.TITLE_MIN)
      .max(WEB_PUBLISH_FORM.TITLE_MAX)
      .optional()
      .describe("Verse title (4–50 chars, same as the web dialog). Required on first deploy; defaults to the current title on update."),
    shortDescription: z
      .string()
      .max(WEB_PUBLISH_FORM.SHORT_DESCRIPTION_MAX)
      .optional()
      .describe("One-line game preview text (≤100 chars)."),
    description: z
      .string()
      .max(WEB_PUBLISH_FORM.DESCRIPTION_MAX)
      .optional()
      .describe("Full verse description (≤1000 chars)."),
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
      .max(WEB_PUBLISH_FORM.TAGS_MAX)
      .optional()
      .describe("User tags (1–5, no `__` prefix). First deploy needs at least one; update keeps the current user tags when omitted."),
    allowRemix: z.boolean().optional(),
    isMobileSupported: z.boolean().optional(),
    releaseNoteTitle: z
      .string()
      .min(1)
      .max(WEB_PUBLISH_FORM.RELEASE_NOTE_TITLE_MAX)
      .optional()
      .describe("Release note title (≤50 chars). Required on every deploy, like the web dialog's Notes step."),
    releaseNoteTypes: z
      .array(z.enum(RELEASE_NOTE_TYPES))
      .min(1)
      .max(WEB_PUBLISH_FORM.RELEASE_NOTE_TYPES_MAX)
      .optional()
      .describe("1–3 of New / Improvements / Balance / Events / Compatibility / BugFixes. Required on every deploy."),
    releaseNoteDescription: z
      .string()
      .min(1)
      .max(WEB_PUBLISH_FORM.RELEASE_NOTE_DESCRIPTION_MAX)
      .optional()
      .describe("Release note body (≤1000 chars). Required on every deploy."),
    sendNotificationToFollowers: z
      .boolean()
      .default(false)
      .describe("Notify followers about this release. Default false (same as the web dialog)."),
    installCommand: z
      .string()
      .min(1)
      .default("bun update")
      .describe("Dependency sync before the build. Default `bun update` (same as the web editor). Plain argv only — no shell operators."),
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

/**
 * The sha pinned in the live verse's playUrl (`…/index.html?sha=<sha>`), i.e.
 * the commit the last deploy was built from. null on first deploy or when
 * the URL carries no sha.
 */
export function readDeployedSha(existing: VerseInfo | null): string | null {
  const playUrl = existing?.playUrl;
  if (typeof playUrl !== "string" || playUrl.length === 0) return null;
  try {
    const sha = new URL(playUrl).searchParams.get("sha");
    return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Publish fields the web dialog requires and the caller has not supplied.
 * First deploy: Info (title, ≥1 visible tag) + Visuals (cover) + Notes
 * (release note title / types / description). Update: Notes every time;
 * the rest falls back to the live verse.
 */
export function missingPublishFields(
  mode: DeployMode,
  input: Pick<
    DeployInput,
    "title" | "thumbnailPath" | "imageUrl" | "tags" | "releaseNoteTitle" | "releaseNoteTypes" | "releaseNoteDescription"
  >,
  existing: VerseInfo | null,
): string[] {
  const missing: string[] = [];
  const visibleTags = (input.tags ?? existing?.tag ?? []).filter((t) => !t.startsWith("__"));
  if (!input.title && !(mode === "update" && existing?.title)) missing.push("title");
  if (visibleTags.length === 0) missing.push("tags");
  if (!input.thumbnailPath && !input.imageUrl && !(mode === "update" && existing?.imageUrl)) {
    missing.push("thumbnailPath or imageUrl");
  }
  if (!input.releaseNoteTitle) missing.push("releaseNoteTitle");
  if (!input.releaseNoteTypes || input.releaseNoteTypes.length === 0) missing.push("releaseNoteTypes");
  if (!input.releaseNoteDescription) missing.push("releaseNoteDescription");
  return missing;
}

const RELEASE_TYPE_KEYWORDS: Record<ReleaseNoteType, RegExp> = {
  BugFixes: /\b(fix|fixed|fixes|bug|bugs|crash|crashes|error|errors|broken|glitch|regression|patch)\b|수정|버그|오류|크래시/i,
  Balance: /\b(balance|balanced|rebalance|nerf|buff|difficulty|tuning|tuned|damage|cooldown|spawn rate)\b|밸런스|난이도|너프|버프/i,
  Events: /\b(event|events|seasonal|holiday|limited[- ]time|campaign)\b|이벤트|시즌/i,
  Compatibility: /\b(mobile|touch|browser|resolution|aspect ratio|safari|android|ios|compat|compatibility|performance|fps|lag)\b|모바일|호환|해상도|성능/i,
  New: /\b(add|added|adds|new|introduce|introduced|feature|features|level|levels|stage|stages|mode|modes|boss|character|weapon|item)\b|추가|신규|새로운/i,
  Improvements: /\b(improve|improved|improves|improvement|polish|polished|tweak|tweaked|refine|refined|refactor|ui|ux|visual|visuals|animation|sound|music|sfx|art)\b|개선|다듬|리팩터|리팩토링/i,
};

/**
 * Keyword classification of release-note text into the web dialog's types
 * (≤3, most-mentioned first). Falls back to New (first deploy) or
 * Improvements (update) when nothing matches.
 */
export function classifyReleaseTypes(text: string, mode: DeployMode): ReleaseNoteType[] {
  const scored = (Object.keys(RELEASE_TYPE_KEYWORDS) as ReleaseNoteType[])
    .map((type) => ({ type, hits: (text.match(new RegExp(RELEASE_TYPE_KEYWORDS[type].source, "gi")) ?? []).length }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || RELEASE_NOTE_TYPES.indexOf(a.type) - RELEASE_NOTE_TYPES.indexOf(b.type))
    .slice(0, WEB_PUBLISH_FORM.RELEASE_NOTE_TYPES_MAX)
    .map((s) => s.type);
  if (scored.length > 0) return scored;
  return [mode === "first" ? "New" : "Improvements"];
}

export interface SuggestedReleaseNote {
  title: string;
  types: ReleaseNoteType[];
  description: string;
  basedOn: {
    /** Commit the last deploy was built from; null on first deploy. */
    sinceSha: string | null;
    /** V8 checkpoints summarized. */
    commits: number;
    /** Commits in range without a V8 workSummary (template / manual / bypass commits), left out. */
    skipped: number;
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Draft a release note from the V8 checkpoints made since the last deploy
 * (`sinceSha`..HEAD) or, on first deploy, since the repo started. Each
 * checkpoint's workSummary becomes one bullet; commits without a V8
 * workSummary (template "Initial commit", GitLab "Add README.md",
 * VERSE8_ALLOW_NONCOMPLIANT bypasses) carry nothing to summarize and are
 * skipped. The agent is expected to edit this before the user sees it.
 */
export function suggestReleaseNote(projectDir: string, mode: DeployMode, sinceSha: string | null): SuggestedReleaseNote {
  const range = sinceSha ? `${sinceSha}..HEAD` : "HEAD";
  let raw = "";
  for (const r of [range, "HEAD"]) {
    try {
      raw = execFileSync("git", ["log", "--max-count=200", "--format=%B%x1e", r], {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      break;
    } catch {
      // `sinceSha` may not exist locally (deployed from another clone); fall back to the whole history.
      raw = "";
    }
  }
  const bodies = raw.split("\u001e").map((b) => b.trim()).filter((b) => b.length > 0);
  const bullets: string[] = [];
  let skipped = 0;
  for (const body of bodies) {
    const parsed = parseV8CommitMessage(body);
    const summary = parsed.valid ? parsed.workSummary?.replace(/\s+/g, " ").trim() : undefined;
    if (!summary) {
      skipped += 1;
      continue;
    }
    if (!bullets.includes(summary)) bullets.push(summary);
  }

  const today = new Date().toISOString().slice(0, 10);
  const title = mode === "first" ? "Initial release" : `Update ${today}`;
  let description: string;
  if (bullets.length === 0) {
    description = mode === "first" ? "First release." : "Maintenance update.";
  } else {
    // Oldest first reads like a changelog.
    const lines = [...bullets].reverse().map((b) => `- ${b}`);
    description = lines.join("\n");
    if (description.length > WEB_PUBLISH_FORM.RELEASE_NOTE_DESCRIPTION_MAX) {
      const kept: string[] = [];
      for (const line of lines) {
        if ([...kept, line].join("\n").length > WEB_PUBLISH_FORM.RELEASE_NOTE_DESCRIPTION_MAX - 2) break;
        kept.push(line);
      }
      description = truncate(kept.length > 0 ? `${kept.join("\n")}\n…` : lines[0], WEB_PUBLISH_FORM.RELEASE_NOTE_DESCRIPTION_MAX);
    }
  }
  return {
    title,
    types: classifyReleaseTypes(bullets.join(" "), mode),
    description,
    basedOn: { sinceSha, commits: bullets.length, skipped },
  };
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
    return { command: step.command, durationMs: Date.now() - start, exitCode: 0, stdoutTail: safeHint(tail(String(out))) };
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
      stdoutTail: safeHint(tail(String(err.stdout ?? ""))),
      stderrTail: safeHint(tail(String(err.stderr ?? err.message ?? ""))),
    };
  }
}

/** Whole-word match so `MyDebugPanelThing` does not count as `DebugPanel` (container publish.ts). */
export function referencesGlobal(source: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(source);
}

/**
 * Publish-only plugin shim check. The web container (plugins/publish.ts
 * injectPublishAssets) copies `debug-panel-shim.js` into
 * `dist/__agent8/plugins/` and references it from `dist/index.html` when the
 * built JS references `DebugPanel`, and fails the publish when that
 * injection fails. The MCP has no plugin injection yet, so a build that
 * references `DebugPanel` without the shim would throw ReferenceError in
 * production — the deploy stops before upload instead.
 */
export function detectDebugPanelWithoutShim(distDir: string): boolean {
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
      if (entry.isDirectory()) {
        if (entry.name !== "__agent8") stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        try {
          if (referencesGlobal(fs.readFileSync(full, "utf8"), "DebugPanel")) return true;
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  }
  return false;
}

/**
 * Safety net only: v8-meme-api dropped the captcha guard on
 * POST /v1/verse/create for authenticated callers (g2-sync #844/#845), so a
 * first deploy no longer stops here. Kept in case the guard returns.
 */
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
  for (const [field, kind] of [["thumbnailPath", "image"], ["videoPath", "video"]] as const) {
    const given = input[field];
    if (!given) continue;
    const abs = path.isAbsolute(given) ? given : path.resolve(cwd, given);
    const check = validateLocalMedia(abs, kind);
    if (!check.ok) return fail("validate", check.error, `${field}: ${check.hint}`, { field });
  }
  const unsafeTokens = unsafeInstallCommandTokens(input.installCommand);
  if (unsafeTokens.length > 0) {
    return fail(
      "validate",
      "invalid_input",
      `installCommand contains shell syntax (${unsafeTokens.join(" ")}); pass a plain package-manager command such as "bun update" or "npm ci".`,
    );
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

  // ── 4. Metadata (web publish dialog rules) ────────────────────────────
  const missing = missingPublishFields(mode, input, existing);
  if (missing.length > 0) {
    const suggestedReleaseNote = suggestReleaseNote(cwd, mode, readDeployedSha(existing));
    return fail(
      "validate",
      "invalid_input",
      `${mode === "first" ? "First deploy" : "Update"} of ${verseId} requires: ${missing.join(", ")} (same fields as the web publish dialog). Do not ask the user field by field — draft them from the project (title/tags/description from the game itself, cover via image_asset_generate → thumbnailPath, release note from suggestedReleaseNote), re-run dryRun, show the user that one result, then deploy after they approve. Values the user already gave are used as-is.`,
      { mode, missing, suggestedReleaseNote },
    );
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
      warnings.push("Local commit succeeded but push to gitlab.verse8.io failed; the deployed sha is not on the remote yet. Run `git push origin HEAD` in the project before relying on the web editor history (verse8_checkpoint would report nothing_to_commit).");
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
    if (step === uploadStep) {
      if (!fs.existsSync(path.join(distDir, "index.html"))) {
        return fail("build", "build_failed", "Build finished but dist/index.html is missing — check the project's build script.", {
          stepsCompleted: completed,
        });
      }
      if (detectDebugPanelWithoutShim(distDir)) {
        return fail(
          "build",
          "plugin_shim_missing",
          "The build references `DebugPanel` but no publish plugin shim is in dist/ (the web editor injects dist/__agent8/plugins/debug-panel-shim.js at publish time; verse8-mcp cannot yet). Publishing would crash the game with ReferenceError: DebugPanel. Nothing was uploaded. Guard the reference (`if (typeof DebugPanel !== \"undefined\")`) or remove the DebugPanel usage, checkpoint, and deploy again — or publish this project from the web editor.",
          { stepsCompleted: completed },
        );
      }
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

  // ── 8. Publish verse record ───────────────────────────────────────────
  const playUrl = buildPlayUrl(verseId, readHeadSha(cwd), projectPath, Date.now());
  const publishBody = buildPublishBody({ mode, verseId, playUrl, fields, tags, existing, parentVerseId });
  let published;
  try {
    published = mode === "first" ? await createVerse(publishBody, token) : await updateVerse(verseId, publishBody, token);
  } catch (e) {
    return fail("publish", "upstream_unreachable", `${safeErrorHint(e)} The game files are already uploaded at ${playUrl}; only the verse record was not updated. Run verse8_deploy again once the API is reachable.`, { steps: completed, playUrl, filesLive: true });
  }
  if (!published.ok) {
    const { status, body } = published;
    const webEditor = projectPath ? buildWebEditorLink(projectPath).url : "https://create.verse8.io/";
    if (mode === "first" && status === 403 && looksLikeBotCheck(body)) {
      return fail(
        "publish",
        "captcha_required",
        `Game files are uploaded (${playUrl}) but the first publish needs the web captcha — POST /v1/verse/create rejects headless calls. Finish the first publish in the web editor: ${webEditor}. Later updates work from verse8_deploy.`,
        { status, playUrl, filesLive: true, steps: completed, publishBody },
      );
    }
    const code =
      status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 409 ? "verse_owned_by_other" : status >= 400 && status < 500 ? "bad_request" : "verse_publish_failed";
    return fail(
      "publish",
      code,
      `${mode === "first" ? "create" : "update"} verse failed: HTTP ${status} ${body.slice(0, 300)}. The game files are already uploaded and live at ${playUrl} (same order as the web editor); only the verse record was not updated. Fix the publish fields and run verse8_deploy again — the rebuild re-uploads the same sha.`,
      { status, playUrl, filesLive: true, steps: completed, publishBody },
    );
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
