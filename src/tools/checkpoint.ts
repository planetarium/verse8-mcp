import { execFileSync } from "node:child_process";
import { z } from "zod";
import { detectAttachment } from "../context/attachment.js";
import { loadToken } from "../context/token.js";
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
import { synthesizeFileChangesFromDiff } from "../format/fileChangeSynthesis.js";

/**
 * `verse8_checkpoint` — commit + push, in V8 message format.
 *
 * Default staging is `git add -A` (verse8 projects commit `.env` by
 * convention — VITE_AGENT8_ACCOUNT / VITE_AGENT8_VERSE live there).
 *
 * Message format selection:
 *  - If `userPrompt` is provided → build the V8 format deterministically
 *    via buildV8CommitMessage (recommended path).
 *  - Else if `message` is provided → use it verbatim (escape hatch for
 *    bootstrap / maintenance commits).
 *  - Else → fall back to "[verse8] checkpoint" subject-only message.
 *
 * On commit-hook failure we surface stderr verbatim so the LLM sees why.
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
  | { ok: false; error: "stage_failed"; hint: string }
  | { ok: false; error: "nothing_to_commit"; hint: string }
  | {
      ok: false;
      error: "commit_failed";
      hint: string;
      hookStderr?: string;
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
 */
export const NEVER_COMMIT_FILES: readonly string[] = [".secret", ".deployed"];

/** Paths currently staged for commit (relative to the repo root). */
export function listStagedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Drop NEVER_COMMIT_FILES from the index after staging. Returns the paths
 * that were unstaged. Only the exact root-level names are matched, like the
 * container does; the working-tree files are left untouched.
 */
export function unstageNeverCommitFiles(cwd: string): string[] {
  const staged = listStagedFiles(cwd);
  const hits = staged.filter((f) => NEVER_COMMIT_FILES.includes(f));
  if (hits.length === 0) return [];
  execFileSync("git", ["reset", "-q", "--", ...hits], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return hits;
}

// synthesizeFileChangesFromDiff moved to src/format/fileChangeSynthesis.ts (M1b-5)

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
      hint: "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
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

  // 1. Stage
  try {
    if (input.files && input.files.length > 0) {
      execFileSync("git", ["add", "--", ...input.files], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      execFileSync("git", ["add", "-A"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    }
  } catch (e) {
    const err = e as RunError;
    return {
      ok: false,
      error: "stage_failed",
      hint: err.stderr?.toString().trim() || err.message,
    };
  }

  // Never commit local deploy / secret state (container parity).
  try {
    unstageNeverCommitFiles(cwd);
  } catch (e) {
    const err = e as RunError;
    return {
      ok: false,
      error: "stage_failed",
      hint: `could not unstage ${NEVER_COMMIT_FILES.join(", ")}: ${err.stderr?.toString().trim() || err.message}`,
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

  // 2. Commit — pass message via -F to preserve multi-line + special characters.
  let commitSha: string | undefined;
  try {
    execFileSync("git", ["commit", "-m", messageText], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    commitSha = sha;
  } catch (e) {
    const err = e as RunError;
    return {
      ok: false,
      error: "commit_failed",
      hint: err.stderr?.toString().trim() || err.message,
      hookStderr: err.stderr?.toString(),
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
