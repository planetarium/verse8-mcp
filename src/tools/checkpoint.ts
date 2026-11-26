import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { detectAttachment } from "../context/attachment.js";
import { loadToken, PROJECT_TOKEN_REL_PATH } from "../context/token.js";
import { detectVerseProject } from "../context/verseProject.js";
import {
  ensureVerse8EnvFile,
  readEnvAccount,
} from "../context/envFile.js";
import { verifyToken } from "../api/v8MemeApi.js";
import {
  buildV8CommitMessage,
  type V8ToolCallEntry,
} from "../format/v8CommitMessage.js";
import { drainSinceLastCheckpoint } from "../util/v8CallLog.js";
import { isSafeAbsPath } from "../util/safePath.js";
import { LOGIN_HINT } from "../util/hints.js";
import { synthesizeFileChangesFromDiff } from "../format/fileChangeSynthesis.js";

/**
 * `verse8_checkpoint` — commit + push, in V8 message format.
 *
 * Default staging is `git add -A` (verse8 projects commit `.env` by
 * convention — VITE_AGENT8_ACCOUNT / VITE_AGENT8_VERSE live there).
 * `stageAll: false` (or VERSE8_CHECKPOINT_REQUIRE_FILES=1) turns that off:
 * without `files` the call stops with `files_required` and lists the
 * changed paths, so work of another session in the same folder is not
 * committed by accident.
 *
 * Message format selection:
 *  - If `userPrompt` is provided → build the V8 format deterministically
 *    via buildV8CommitMessage (recommended path).
 *  - Else if `message` is provided → use it verbatim (escape hatch for
 *    bootstrap / maintenance commits).
 *  - Else → fall back to "[verse8] checkpoint" subject-only message.
 *
 * On commit-hook failure we surface stderr verbatim so the LLM sees why.
 * A staging or commit failure restores the index to its state before the
 * call, so a retry does not pick up files this call staged.
 */

const toolCallEntrySchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(["completed", "error"]).optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .strict();

export const checkpointInputSchema = z
  .object({
    // Staging
    files: z.array(z.string().min(1)).optional(),
    stageAll: z
      .boolean()
      .optional()
      .describe(
        "Only matters when `files` is omitted. true: stage every change under projectDir (`git add -A`). false: stage nothing and stop with `files_required` + `changedFiles`, so another session's work in the same folder is never committed — then call again with `files`. Default: false when the MCP server has VERSE8_CHECKPOINT_REQUIRE_FILES=1, else true.",
      ),
    projectDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "projectDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
      })
      .optional()
      .describe(
        "Absolute path to the verse8 project directory. Required when the MCP server's cwd is a parent of the project (e.g., after verse8_new_project cloned a subdirectory). If omitted, process.cwd() is used.",
      ),

    // V8 format fields (preferred path)
    userPrompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The user's message this turn, verbatim. First line becomes the subject; full text goes into <V8UserMessage>. Required for V8-format commits.",
      ),
    model: z.string().optional().describe('e.g. "claude-opus-4-7"'),
    provider: z.string().optional().describe('e.g. "anthropic", "google-vertex"'),
    mcpServers: z
      .array(z.string())
      .optional()
      .describe('MCP server names whose tools you used this turn, e.g. ["image"]'),
    reasoning: z
      .string()
      .optional()
      .describe("Short prose summary of reasoning. Omit if none."),
    problemStatement: z
      .string()
      .min(1)
      .optional()
      .describe(
        "REQUIRED for history continuity. 1–3 sentences describing how you interpreted the user's request this turn (what the user wants + key constraints). Future agents reading `git log` depend on this to reconstruct the narrative without re-reading every tool payload.",
      ),
    workSummary: z
      .string()
      .min(1)
      .optional()
      .describe(
        "REQUIRED for history continuity. 1–5 sentences describing what you actually did this turn at a higher level than `reasoning` (which is about thought) or `toolCalls` (which is raw payloads). Good example: 'Replaced the stubbed verse8_new_project with a 2-tool split, added agent8-backend client + mock, documented the flow in AGENTS.md.'",
      ),
    toolCalls: z
      .array(toolCallEntrySchema)
      .optional()
      .describe(
        "Tool calls this turn. name+status minimum; input/output optional (truncated at 4 KB). Omit to auto-fill from MCP-observed calls only.",
      ),
    useAutoToolLog: z
      .boolean()
      .default(true)
      .describe(
        "When true and `toolCalls` is omitted, verse8-mcp auto-fills from its own call log. When false, the message has no toolCall entries.",
      ),

    // Raw escape hatch
    message: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Raw commit message override. Use only for non-V8 bootstrap commits. Ignored when userPrompt is provided.",
      ),

    // Attachment override
    skipAttachCheck: z
      .boolean()
      .default(false)
      .describe(
        "When true, bypass the verse8-mcp attachment gate. Use only when you have confirmed the project is already verse8-governed (hooks + AGENTS.md) or when you intentionally want to commit through an unattached repo.",
      ),
  })
  .strict();

export type CheckpointInput = z.infer<typeof checkpointInputSchema>;

export type CheckpointResult =
  | {
      ok: true;
      committed: boolean;
      pushed: boolean;
      commitSha?: string;
      subject: string;
      messageLength: number;
      v8Format: boolean;
      fileCount: number;
    }
  | { ok: false; error: "not_logged_in"; hint: string }
  | { ok: false; error: "not_a_verse_project"; hint: string }
  | {
      ok: false;
      error: "project_needs_attach";
      hint: string;
      missing: string[];
    }
  | {
      ok: false;
      error: "stage_failed";
      hint: string;
      /** The index is back to its state before this call. */
      indexRestored?: boolean;
    }
  | { ok: false; error: "nothing_to_commit"; hint: string }
  | {
      ok: false;
      error: "files_required";
      hint: string;
      /** Changed paths under projectDir (relative), at most CHANGED_FILES_LIMIT. */
      changedFiles: string[];
      changedFilesTruncated?: boolean;
    }
  | {
      ok: false;
      error: "commit_failed";
      hint: string;
      hookStderr?: string;
      /** The index is back to its state before this call. */
      indexRestored?: boolean;
    }
  | { ok: false; error: "push_failed"; hint: string };

interface RunError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number | null;
}

/**
 * Files a checkpoint never commits, mirroring the agent8 container's
 * `NEVER_COMMIT_FILES` (agent-process.ts). `.deployed` is written by
 * `@agent8/deploy` after every upload and `.secret` holds project secrets;
 * both are local state, and a committed `.deployed` can make the container's
 * `--preview` upload skip files whose hash matches (emptying the preview).
 *
 * `.verse8/token` is this server's own addition (the container has no such
 * file): a project token placed by hand is a login, and a committed one is
 * both leaked and, from then on, refused by the token lookup (INV-16).
 */
export const NEVER_COMMIT_FILES: readonly string[] = [".secret", ".deployed", PROJECT_TOKEN_REL_PATH];

/** Is `p` (relative to the project dir) a file a checkpoint never commits? */
export function isNeverCommitFile(p: string): boolean {
  // The token name is matched without regard to case: on a case-insensitive
  // filesystem `.verse8/Token` is the token file.
  return NEVER_COMMIT_FILES.includes(p) || p.toLowerCase() === PROJECT_TOKEN_REL_PATH;
}

/** Paths currently staged for commit, relative to `cwd` (the project dir). */
export function listStagedFiles(cwd: string): string[] {
  return listStagedChanges(cwd).map((c) => c.path);
}

export interface StagedChange {
  /** Path relative to `cwd`, not to the repo root (`--relative`). */
  path: string;
  /** git diff-filter letter: A M D R C T U X B */
  status: string;
}

function listStagedChanges(cwd: string): StagedChange[] {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-status", "--relative", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parts = out.split("\0");
    const changes: StagedChange[] = [];
    for (let i = 0; i < parts.length; ) {
      const status = parts[i];
      if (!status) break;
      // Renames/copies carry two paths (old, new); the new one is what lands in the commit.
      const twoPaths = status.startsWith("R") || status.startsWith("C");
      const p = twoPaths ? parts[i + 2] : parts[i + 1];
      if (p) changes.push({ path: p, status: status[0] });
      i += twoPaths ? 3 : 2;
    }
    return changes;
  } catch {
    return [];
  }
}

/**
 * Drop NEVER_COMMIT_FILES from the index after staging. Returns the paths
 * that were unstaged. Matches the names at the project dir level (the
 * container's workspace root), so a project nested inside a larger repo is
 * handled too. A staged *deletion* is left alone: that is how a previously
 * committed `.deployed` gets removed from the remote. The working-tree
 * files are never touched.
 */
export function unstageNeverCommitFiles(cwd: string): string[] {
  const hits = listStagedChanges(cwd)
    .filter((c) => isNeverCommitFile(c.path) && c.status !== "D")
    .map((c) => c.path);
  if (hits.length === 0) return [];
  execFileSync("git", ["reset", "-q", "--", ...hits], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return hits;
}

/** Env switch: `1` / `true` / `yes` makes `stageAll` default to false. */
export const REQUIRE_FILES_ENV = "VERSE8_CHECKPOINT_REQUIRE_FILES";

/** Effective `stageAll`: the input wins, else the env switch, else true. */
export function resolveStageAll(
  stageAll: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (stageAll !== undefined) return stageAll;
  const v = (env[REQUIRE_FILES_ENV] ?? "").trim().toLowerCase();
  return !(v === "1" || v === "true" || v === "yes");
}

export const CHANGED_FILES_LIMIT = 200;

/**
 * Paths a `git add -A -- .` would pick up (staged, modified, deleted,
 * untracked-not-ignored), relative to `cwd`, without NEVER_COMMIT_FILES.
 */
export function listChangedFiles(cwd: string): string[] {
  const paths = new Set<string>(listStagedFiles(cwd));
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const p of out.split("\0")) if (p) paths.add(p);
  } catch {
    // not a git repo / git missing: report what the index gave us
  }
  return [...paths].filter((p) => !isNeverCommitFile(p)).sort();
}

/**
 * Record the index as a tree object so a failed checkpoint can put it back.
 * null when the index cannot be written as a tree (e.g. unmerged entries);
 * the caller then leaves the index as it is.
 */
export function snapshotIndex(cwd: string): string | null {
  try {
    const tree = execFileSync("git", ["write-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return tree || null;
  } catch {
    return null;
  }
}

/**
 * Put the index back to `tree` (from snapshotIndex). Only the index changes;
 * the working tree is never touched. Returns false when it could not.
 */
export function restoreIndex(cwd: string, tree: string | null): boolean {
  if (!tree) return false;
  try {
    execFileSync("git", ["read-tree", tree], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return false;
  }
  // read-tree drops the cached stat data; refresh it so the next
  // `git status` does not re-hash every file. Best effort.
  try {
    execFileSync("git", ["update-index", "-q", "--refresh"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // exit 1 only means some files differ from the index — expected.
  }
  return true;
}

const RESTORED_NOTE = " The index was restored to its state before this call.";

/**
 * `git commit` with the message read from a temp file (`-F`), not argv.
 * The V8 message carries file diffs and can exceed the Windows command-line
 * limit (32,767 chars) as `-m`, which fails with spawnSync ENAMETOOLONG.
 * Cleanup mode is the same as `-m` (whitespace), so the stored message is
 * unchanged.
 */
export function commitWithMessageFile(cwd: string, messageText: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-commit-msg-"));
  try {
    const file = path.join(dir, "MESSAGE");
    fs.writeFileSync(file, messageText, "utf8");
    execFileSync("git", ["commit", "-F", file], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function getFilePath(entry: V8ToolCallEntry): string | undefined {
  const input = entry.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.filePath === "string") return input.filePath;
  if (typeof input.to === "string") return input.to;
  return undefined;
}

function mergeToolCalls(
  llmProvided: V8ToolCallEntry[] | undefined,
  autoLogged: V8ToolCallEntry[] | undefined,
  fileChanges: V8ToolCallEntry[],
): V8ToolCallEntry[] {
  const result: V8ToolCallEntry[] = [];
  const coveredPaths = new Set<string>();

  // LLM-provided entries come first and establish which filePaths are already
  // narrated. We trust the LLM's version over the synthesized fallback when
  // both describe the same file.
  for (const e of llmProvided ?? []) {
    result.push(e);
    const p = getFilePath(e);
    if (p) coveredPaths.add(p);
  }

  // Auto-log: MCP-observed calls (image_*, etc.). Don't collide with file paths
  // since these are remote tools.
  for (const e of autoLogged ?? []) {
    result.push(e);
  }

  // File-change backstop: anything staged that the LLM didn't already narrate.
  for (const e of fileChanges) {
    const p = getFilePath(e);
    if (p && coveredPaths.has(p)) continue;
    result.push(e);
  }
  return result;
}

function resolveMessage(
  input: CheckpointInput,
  cwd: string,
): {
  text: string;
  v8Format: boolean;
  subject: string;
  fileCount: number;
} {
  if (input.userPrompt) {
    const autoLog =
      input.useAutoToolLog !== false ? drainSinceLastCheckpoint(cwd) : [];
    const autoEntries: V8ToolCallEntry[] | undefined =
      autoLog.length > 0
        ? autoLog.map((e) => ({
            name: e.name,
            status: e.status,
            input: e.input,
            output: e.output,
          }))
        : undefined;
    const fileChanges = synthesizeFileChangesFromDiff(cwd);
    const merged = mergeToolCalls(input.toolCalls, autoEntries, fileChanges);

    const text = buildV8CommitMessage({
      userPrompt: input.userPrompt,
      model: input.model,
      provider: input.provider,
      mcpServers: input.mcpServers,
      reasoning: input.reasoning,
      problemStatement: input.problemStatement,
      workSummary: input.workSummary,
      toolCalls: merged.length > 0 ? merged : undefined,
    });
    const subject = text.split(/\r?\n/)[0] ?? "";
    return {
      text,
      v8Format: true,
      subject,
      fileCount: fileChanges.length,
    };
  }
  if (input.message) {
    const subject = input.message.split(/\r?\n/)[0] ?? "";
    return { text: input.message, v8Format: false, subject, fileCount: 0 };
  }
  const fallback = "[verse8] checkpoint";
  return { text: fallback, v8Format: false, subject: fallback, fileCount: 0 };
}

export async function runCheckpoint(
  input: CheckpointInput,
  serverCwd: string = process.cwd(),
): Promise<CheckpointResult> {
  const cwd = input.projectDir ?? serverCwd;
  const detection = detectVerseProject(cwd);
  if (!detection.isVerse) {
    return {
      ok: false,
      error: "not_a_verse_project",
      hint: `${cwd} is not a verse8 project (missing .verse8/project.json or wrong origin). Pass 'projectDir' if the project lives in a subdirectory of the MCP server's cwd.`,
    };
  }

  if (!loadToken(cwd)) {
    return {
      ok: false,
      error: "not_logged_in",
      hint: LOGIN_HINT,
    };
  }

  if (!input.skipAttachCheck) {
    const attachment = detectAttachment(cwd);
    if (!attachment.attached) {
      return {
        ok: false,
        error: "project_needs_attach",
        hint: `This project is not fully attached to verse8-mcp (${attachment.missing.join(", ")} missing). Call verse8_attach first so commits go through the V8 format + origin hooks. To override and commit anyway, pass { skipAttachCheck: true }.`,
        missing: attachment.missing,
      };
    }
  }

  // Without `files`, staging everything must be allowed (stageAll).
  const hasFiles = !!input.files && input.files.length > 0;
  if (!hasFiles && !resolveStageAll(input.stageAll)) {
    const changed = listChangedFiles(cwd);
    if (changed.length === 0) {
      return {
        ok: false,
        error: "nothing_to_commit",
        hint: "nothing staged; no changes to checkpoint",
      };
    }
    const truncated = changed.length > CHANGED_FILES_LIMIT;
    return {
      ok: false,
      error: "files_required",
      hint: `stageAll is off (input or ${REQUIRE_FILES_ENV}), so nothing was staged. Call again with \`files\` set to the paths this change touched — ${changed.length} changed path(s) are listed in changedFiles; leave out work that is not yours. Pass stageAll: true to commit all of them.`,
      changedFiles: truncated ? changed.slice(0, CHANGED_FILES_LIMIT) : changed,
      ...(truncated ? { changedFilesTruncated: true } : {}),
    };
  }

  // 0. Self-heal .env. The verse8 runtime requires VITE_AGENT8_ACCOUNT /
  // VITE_AGENT8_VERSE; a commit that lands without them will boot a broken
  // preview. If the file is already intact this is a zero-network noop
  // (readEnvAccount short-circuits); if not, we fall back to verifyToken.
  // Failures are non-fatal — log to stderr and continue so a transient
  // outage never blocks a commit.
  try {
    let walletAddress: string | null = readEnvAccount(cwd);
    if (!walletAddress) {
      const tk = loadToken(cwd);
      if (tk) {
        const v = await verifyToken(tk);
        if (v.ok && typeof v.profile.walletAddress === "string") {
          walletAddress = v.profile.walletAddress;
        }
      }
    }
    const envResult = ensureVerse8EnvFile(cwd, walletAddress);
    if (envResult.status === "mismatch-preserved") {
      // hint has already been echoed to stderr from inside ensureVerse8EnvFile
    }
  } catch (e) {
    process.stderr.write(
      `[verse8-checkpoint] .env self-heal failed (non-fatal): ${(e as Error).message}\n`,
    );
  }

  // 1. Stage — remember the index first so a failure below can undo it.
  const indexBefore = snapshotIndex(cwd);
  try {
    if (hasFiles) {
      execFileSync("git", ["add", "--", ...input.files!], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      // Scope to the project dir so staging and the `--relative` index listing
      // below agree when the project is nested inside a larger repo.
      execFileSync("git", ["add", "-A", "--", "."], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    }
  } catch (e) {
    const err = e as RunError;
    const indexRestored = restoreIndex(cwd, indexBefore);
    return {
      ok: false,
      error: "stage_failed",
      hint: (err.stderr?.toString().trim() || err.message) + (indexRestored ? RESTORED_NOTE : ""),
      indexRestored,
    };
  }

  // Never commit local deploy / secret state (container parity).
  try {
    unstageNeverCommitFiles(cwd);
  } catch (e) {
    const err = e as RunError;
    const indexRestored = restoreIndex(cwd, indexBefore);
    return {
      ok: false,
      error: "stage_failed",
      hint: `could not unstage ${NEVER_COMMIT_FILES.join(", ")}: ${err.stderr?.toString().trim() || err.message}` + (indexRestored ? RESTORED_NOTE : ""),
      indexRestored,
    };
  }

  // Nothing to commit? Judge by the index, not the working tree — an
  // unstaged .deployed must not count as a pending change.
  if (listStagedFiles(cwd).length === 0) {
    return {
      ok: false,
      error: "nothing_to_commit",
      hint: "nothing staged; no changes to checkpoint",
    };
  }

  const { text: messageText, v8Format, subject, fileCount } = resolveMessage(
    input,
    cwd,
  );

  // 2. Commit — message via a file (-F): it can be longer than argv allows.
  let commitSha: string | undefined;
  let committed = false;
  try {
    commitWithMessageFile(cwd, messageText);
    committed = true;
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    commitSha = sha;
  } catch (e) {
    const err = e as RunError;
    // Undo staging only when no commit was made; after a commit the index
    // already matches the new HEAD.
    const indexRestored = committed ? false : restoreIndex(cwd, indexBefore);
    return {
      ok: false,
      error: "commit_failed",
      hint: (err.stderr?.toString().trim() || err.message) + (indexRestored ? RESTORED_NOTE : ""),
      hookStderr: err.stderr?.toString(),
      indexRestored,
    };
  }

  // 3. Push
  try {
    execFileSync("git", ["push", "origin", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as RunError;
    return {
      ok: false,
      error: "push_failed",
      hint: err.stderr?.toString().trim() || err.message,
    };
  }

  return {
    ok: true,
    committed: true,
    pushed: true,
    commitSha,
    subject,
    messageLength: messageText.length,
    v8Format,
    fileCount,
  };
}
