import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { detectAttachment, type AttachmentState } from "../context/attachment.js";
import { detectVerseProject } from "../context/verseProject.js";
import {
  ensureVerse8EnvFile,
  readEnvAccount,
  type EnsureVerse8EnvResult,
} from "../context/envFile.js";
import {
  ensureVerse8GitIgnore,
  type EnsureGitIgnoreResult,
} from "../context/gitIgnore.js";
import { loadToken } from "../context/token.js";
import { verifyToken } from "../api/v8MemeApi.js";
import {
  listSkillResources,
  type SkillResource,
} from "../resources/skills.js";
import {
  writeSkillFiles,
  type SkillWriteResult,
} from "./skillWriter.js";
import { isSafeAbsPath } from "../util/safePath.js";
import {
  AGENTS_MD_TEMPLATE,
  AGENTS_MD_TEMPLATE_HAS_CATALOG_MARKER,
} from "../prompts/agentsMdTemplate.js";
import { resolveHooksDir, writeHook } from "../context/hooks.js";
import { renderSkillsCatalog } from "../resources/skillCatalog.js";
import { RollbackJournal } from "../util/rollback.js";

/**
 * `verse8_attach` — bring an already-cloned gitlab.verse8.io project under
 * verse8-mcp governance without going through verse8_new_project.
 *
 * Installs both git hooks (pre-commit origin check, commit-msg V8 format
 * validator), drops AGENTS.md so the host LLM is explicitly guided to use
 * verse8_checkpoint for commits, and ensures `.verse8/project.json` exists.
 *
 * Idempotent: running on an already-attached project re-verifies files
 * without clobbering existing content (unless `overwriteAgentsDoc` is true).
 */

export const attachInputSchema = z
  .object({
    projectDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "projectDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
      })
      .optional()
      .describe(
        "Absolute path to the project root. Defaults to process.cwd(). Use when the MCP server's cwd is a parent of the project.",
      ),
    overwriteAgentsDoc: z
      .boolean()
      .default(false)
      .describe(
        "When true, overwrite an existing AGENTS.md with the current verse8-mcp template. Default false preserves user edits.",
      ),
    overwriteAllSkills: z
      .boolean()
      .default(false)
      .describe(
        "When true, force-overwrite every bundled skill file under .claude/skills/, ignoring any hash-drift signals that would normally protect a user-edited copy. Default false preserves user edits.",
      ),
    pruneOrphanedSkills: z
      .boolean()
      .default(false)
      .describe(
        "When true, remove .claude/skills/<name>/ directories whose skill is no longer bundled by verse8-mcp (and that still carry the verse8-mcp hash marker, proving we wrote them). Default false leaves orphans on disk to preserve user work.",
      ),
    overwriteEnv: z
      .boolean()
      .default(false)
      .describe(
        "When true, force-write the `.env` file's VITE_AGENT8_ACCOUNT / VITE_AGENT8_VERSE keys from the currently logged-in wallet, minting a fresh VITE_AGENT8_VERSE timestamp. Default false preserves any pre-existing account binding per the 'once set, never auto-overwritten' contract.",
      ),
  })
  .strict();

export type AttachInput = z.infer<typeof attachInputSchema>;

export type AttachResult =
  | {
      ok: true;
      projectDir: string;
      installed: {
        preCommitHook: "created" | "already-present";
        commitMsgHook: "created" | "already-present";
        agentsDoc: "created" | "skipped-existing" | "overwritten";
        projectMarker: "created" | "already-present";
        skills: SkillWriteResult;
        env: EnsureVerse8EnvResult;
        gitIgnore: EnsureGitIgnoreResult;
      };
      state: AttachmentState;
    }
  | { ok: false; error: "not_a_verse_project"; hint: string }
  | { ok: false; error: "missing_git"; hint: string }
  | { ok: false; error: "attach_failed"; hint: string };

const PRE_COMMIT_SCRIPT = '#!/bin/sh\nexec verse8-mcp hook pre-commit "$@"\n';
const COMMIT_MSG_SCRIPT = '#!/bin/sh\nexec verse8-mcp hook commit-msg "$@"\n';

export async function runAttach(
  input: AttachInput,
  serverCwd: string = process.cwd(),
): Promise<AttachResult> {
  const projectDir = path.resolve(input.projectDir ?? serverCwd);

  const detection = detectVerseProject(projectDir);
  const hasMarker = (() => {
    try {
      return fs.statSync(path.join(projectDir, ".verse8", "project.json")).isFile();
    } catch {
      return false;
    }
  })();

  if (!detection.isVerse && !hasMarker) {
    return {
      ok: false,
      error: "not_a_verse_project",
      hint: `${projectDir} is not a verse8 project. Expected gitlab.verse8.io as origin or a .verse8/project.json marker. If this is a fresh clone, ensure 'git remote get-url origin' points to gitlab.verse8.io.`,
    };
  }

  const gitDir = path.join(projectDir, ".git");
  try {
    if (!fs.statSync(gitDir).isDirectory()) {
      return {
        ok: false,
        error: "missing_git",
        hint: `${projectDir}/.git is not a directory — is this a git working copy?`,
      };
    }
  } catch {
    return {
      ok: false,
      error: "missing_git",
      hint: `${projectDir} has no .git directory`,
    };
  }

  const walletAddress = await resolveWalletAddress(projectDir);

  try {
    const installed = applyAttachmentArtifacts(projectDir, {
      overwrite: input.overwriteAgentsDoc === true,
      projectId: detection.projectId,
      overwriteAllSkills: input.overwriteAllSkills === true,
      pruneOrphanedSkills: input.pruneOrphanedSkills === true,
      walletAddress,
      overwriteEnv: input.overwriteEnv === true,
    });

    const state = detectAttachment(projectDir);
    return { ok: true, projectDir, installed, state };
  } catch (e) {
    return {
      ok: false,
      error: "attach_failed",
      hint: (e as Error).message,
    };
  }
}

/** Writes hooks + agents doc + marker + skills + env. Shared by runAttach and runNewProject. */
export type AttachFailStep =
  | "hooks"
  | "agentsDoc"
  | "marker"
  | "skills"
  | "env"
  | "gitIgnore";

export interface ApplyAttachmentArtifactsOptions {
  overwrite: boolean;
  projectId?: string;
  overwriteAllSkills?: boolean;
  pruneOrphanedSkills?: boolean;
  /** Wallet for .env VITE_AGENT8_ACCOUNT; null degrades to skipped-not-logged-in. */
  walletAddress?: string | null;
  overwriteEnv?: boolean;
  /** Test-only: throw after the named step to verify AC-ATOMICITY rollback. */
  __failAfter?: AttachFailStep;
}

export interface ApplyAttachmentArtifactsResult {
  preCommitHook: "created" | "already-present";
  commitMsgHook: "created" | "already-present";
  agentsDoc: "created" | "skipped-existing" | "overwritten";
  projectMarker: "created" | "already-present";
  skills: SkillWriteResult;
  env: EnsureVerse8EnvResult;
  gitIgnore: EnsureGitIgnoreResult;
}

export function applyAttachmentArtifacts(
  projectDir: string,
  opts: ApplyAttachmentArtifactsOptions,
): ApplyAttachmentArtifactsResult {
  const hooksDir = resolveHooksDir(projectDir);
  const defaultHooksDir = path.join(projectDir, ".git", "hooks");
  if (hooksDir !== defaultHooksDir) {
    console.error(
      `[verse8-attach] writing hooks to custom core.hooksPath: ${hooksDir}`,
    );
  }
  const skills = listSkillResources();
  const journal = new RollbackJournal();

  try {
    // Step 1 — hooks.
    const preCommitHook = writeHook(hooksDir, "pre-commit", PRE_COMMIT_SCRIPT);
    if (preCommitHook === "created") {
      const p = path.join(hooksDir, "pre-commit");
      journal.record(() => fs.rmSync(p, { force: true }));
    }
    const commitMsgHook = writeHook(hooksDir, "commit-msg", COMMIT_MSG_SCRIPT);
    if (commitMsgHook === "created") {
      const p = path.join(hooksDir, "commit-msg");
      journal.record(() => fs.rmSync(p, { force: true }));
    }
    maybeFail(opts.__failAfter, "hooks");

    // Step 2 — AGENTS.md / CLAUDE.md.
    const agentsSnapshot = snapshotAgentsDocs(projectDir);
    const agentsDoc = writeAgentsDoc(projectDir, opts.overwrite, skills);
    if (agentsDoc !== "skipped-existing") {
      journal.record(() => restoreAgentsDocs(projectDir, agentsSnapshot));
    }
    maybeFail(opts.__failAfter, "agentsDoc");

    // Step 3 — project marker.
    const markerSnapshot = snapshotMarker(projectDir);
    const projectMarker = ensureProjectMarker(projectDir, opts.projectId);
    if (projectMarker === "created") {
      journal.record(() => restoreMarker(projectDir, markerSnapshot));
    }
    maybeFail(opts.__failAfter, "marker");

    // Step 4 — skills.
    const skillsRoot = path.join(projectDir, ".claude", "skills");
    const skillsRootExistedBefore = safeIsDir(skillsRoot);
    const result = writeSkillFiles(projectDir, skills, {
      overwriteAll: opts.overwriteAllSkills === true,
      pruneOrphaned: opts.pruneOrphanedSkills === true,
    });
    if (result.created.length > 0 || result.updated.length > 0) {
      journal.record(() =>
        reverseSkillWrites(skillsRoot, result, skillsRootExistedBefore),
      );
    }
    maybeFail(opts.__failAfter, "skills");

    // Step 5 — .env.
    const envPath = path.join(projectDir, ".env");
    const envSnapshot = snapshotFile(envPath);
    const env = ensureVerse8EnvFile(projectDir, opts.walletAddress ?? null, {
      overwrite: opts.overwriteEnv === true,
    });
    if (
      env.status === "created" ||
      env.status === "added-missing" ||
      env.status === "overwrote"
    ) {
      journal.record(() => restoreFile(envPath, envSnapshot));
    }
    maybeFail(opts.__failAfter, "env");

    // Step 6 — .verse8/.gitignore.
    const gitIgnorePath = path.join(projectDir, ".verse8", ".gitignore");
    const gitIgnoreSnapshot = snapshotFile(gitIgnorePath);
    const gitIgnore = ensureVerse8GitIgnore(projectDir);
    if (gitIgnore.status !== "already-present") {
      journal.record(() => restoreFile(gitIgnorePath, gitIgnoreSnapshot));
    }
    maybeFail(opts.__failAfter, "gitIgnore");

    return {
      preCommitHook,
      commitMsgHook,
      agentsDoc,
      projectMarker,
      skills: result,
      env,
      gitIgnore,
    };
  } catch (e) {
    journal.rollback();
    throw e;
  }
}

function maybeFail(
  failAfter: AttachFailStep | undefined,
  step: AttachFailStep,
): void {
  if (failAfter === step) {
    throw new Error(`__failAfter:${step}`);
  }
}

interface FileSnapshot {
  existed: boolean;
  content?: string;
  mode?: number;
}

function snapshotFile(p: string): FileSnapshot {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return { existed: false };
    return {
      existed: true,
      content: fs.readFileSync(p, "utf8"),
      mode: stat.mode & 0o777,
    };
  } catch {
    return { existed: false };
  }
}

function restoreFile(p: string, snap: FileSnapshot): void {
  if (snap.existed && typeof snap.content === "string") {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, snap.content, snap.mode ? { mode: snap.mode } : undefined);
  } else {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* already gone */
    }
  }
}

interface AgentsSnapshot {
  agents: FileSnapshot;
  claude: FileSnapshot;
}

function snapshotAgentsDocs(projectDir: string): AgentsSnapshot {
  return {
    agents: snapshotFile(path.join(projectDir, "AGENTS.md")),
    claude: snapshotFile(path.join(projectDir, "CLAUDE.md")),
  };
}

function restoreAgentsDocs(projectDir: string, snap: AgentsSnapshot): void {
  restoreFile(path.join(projectDir, "AGENTS.md"), snap.agents);
  restoreFile(path.join(projectDir, "CLAUDE.md"), snap.claude);
}

interface MarkerSnapshot {
  file: FileSnapshot;
  dirExistedBefore: boolean;
}

function snapshotMarker(projectDir: string): MarkerSnapshot {
  const verse8Dir = path.join(projectDir, ".verse8");
  const file = snapshotFile(path.join(verse8Dir, "project.json"));
  return { file, dirExistedBefore: safeIsDir(verse8Dir) };
}

function restoreMarker(projectDir: string, snap: MarkerSnapshot): void {
  const verse8Dir = path.join(projectDir, ".verse8");
  restoreFile(path.join(verse8Dir, "project.json"), snap.file);
  // If we created .verse8/ AND it's now empty, remove it.
  if (!snap.dirExistedBefore) {
    try {
      const entries = fs.readdirSync(verse8Dir);
      if (entries.length === 0) fs.rmdirSync(verse8Dir);
    } catch {
      /* best-effort */
    }
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function reverseSkillWrites(
  skillsRoot: string,
  result: SkillWriteResult,
  skillsRootExistedBefore: boolean,
): void {
  for (const name of result.created) {
    try {
      fs.rmSync(path.join(skillsRoot, name), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  // Updated skills were already verse8-mcp-authored; no content restore needed.
  if (!skillsRootExistedBefore) {
    try {
      // Clean up the whole tree if we brought it into existence.
      fs.rmSync(skillsRoot, { recursive: true, force: true });
      const parent = path.dirname(skillsRoot); // .claude/
      // Only remove .claude if it's now empty AND we created it.
      try {
        const entries = fs.readdirSync(parent);
        if (entries.length === 0) fs.rmdirSync(parent);
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort */
    }
  }
}

function writeAgentsDoc(
  projectDir: string,
  overwrite: boolean,
  skills: SkillResource[],
): "created" | "skipped-existing" | "overwritten" {
  // Dual-write: AGENTS.md (OMC/OpenAI) + CLAUDE.md (Claude Code native).
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const claudePath = path.join(projectDir, "CLAUDE.md");
  const existsAny = (() => {
    for (const p of [agentsPath, claudePath]) {
      try {
        if (fs.statSync(p).isFile()) return true;
      } catch {
        /* missing */
      }
    }
    return false;
  })();
  if (existsAny && !overwrite) return "skipped-existing";
  const rendered = AGENTS_MD_TEMPLATE.replace(
    "{{SKILLS_CATALOG}}",
    renderSkillsCatalog(skills),
  );
  fs.writeFileSync(agentsPath, rendered);
  fs.writeFileSync(claudePath, rendered);
  return existsAny ? "overwritten" : "created";
}

// Back-compat re-exports — skillWriter.test.mjs imports these names from
// attach.ts. Source of truth lives in src/prompts/agentsMdTemplate.ts (M1b-1).
export const AGENTS_MD_TEMPLATE_SOURCE = AGENTS_MD_TEMPLATE;
export { AGENTS_MD_TEMPLATE_HAS_CATALOG_MARKER };

/** Resolve wallet: .env (immutable once set) > verifyToken > null. */
async function resolveWalletAddress(projectDir: string): Promise<string | null> {
  const fromEnv = readEnvAccount(projectDir);
  if (fromEnv) return fromEnv;
  const token = loadToken(projectDir);
  if (!token) return null;
  try {
    const resp = await verifyToken(token);
    if (resp.ok) {
      return typeof resp.profile.walletAddress === "string" &&
        resp.profile.walletAddress.length > 0
        ? resp.profile.walletAddress
        : null;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

function ensureProjectMarker(
  projectDir: string,
  projectId: string | undefined,
): "created" | "already-present" {
  const verse8Dir = path.join(projectDir, ".verse8");
  const markerPath = path.join(verse8Dir, "project.json");
  try {
    if (fs.statSync(markerPath).isFile()) return "already-present";
  } catch {
    // missing — create
  }
  fs.mkdirSync(verse8Dir, { recursive: true });
  const payload = {
    version: 1,
    projectId: projectId ?? "attached",
    attachedAt: new Date().toISOString(),
  };
  fs.writeFileSync(markerPath, JSON.stringify(payload, null, 2) + "\n");
  return "created";
}
