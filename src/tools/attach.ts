import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { detectAttachment, type AttachmentState } from "../context/attachment.js";
import { detectWorkspace } from "../context/workspace.js";
import {
  ensureVerse8EnvFile,
  readEnvAccount,
  type EnsureVerse8EnvResult,
} from "../context/envFile.js";
import {
  ensureClaudeGitIgnore,
  ensureVerse8GitIgnore,
  type EnsureGitIgnoreResult,
} from "../context/gitIgnore.js";
import { loadToken } from "../context/token.js";
import { verifyToken } from "../api/v8MemeApi.js";
import {
  listSkillResources,
  vendorPluginsRoot,
} from "../resources/skills.js";
import {
  selectProjectSkills,
  type PluginGateReason,
  type ProjectSkillSelection,
} from "../resources/pluginGate.js";
import {
  writeSkillFiles,
  removeDirIfEmpty,
  writeFileAtomic,
  type SkillFileChange,
  type SkillWriteResult,
} from "./skillWriter.js";
import { isSafeAbsPath } from "../util/safePath.js";
import {
  AGENTS_MD_TEMPLATE,
  AGENTS_MD_TEMPLATE_HAS_CATALOG_MARKER,
} from "../prompts/agentsMdTemplate.js";
import { resolveHooksDir, writeHook } from "../context/hooks.js";
import {
  renderPluginInstructions,
  renderSkillsCatalog,
} from "../resources/skillCatalog.js";
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
        "When true, delete .claude/skills/<name>/SKILL.md for skills no longer bundled by verse8-mcp, but only where the file still carries an unedited verse8-mcp hash marker (proving we wrote it and the user has not changed it). Other files in the folder are kept; the folder goes only if that leaves it empty. Default false leaves orphans on disk to preserve user work.",
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
        skillPlugins: SkillPluginsReport;
        env: EnsureVerse8EnvResult;
        gitIgnore: EnsureGitIgnoreResult;
        claudeGitIgnore: EnsureGitIgnoreResult;
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

  // Attachable iff workspaceMode is "attached" (already done, idempotent
  // re-run) or "unattached_clone" (verse8 origin OR legacy marker — either
  // is sufficient). Keeping the two conditions in parallel so fresh clones
  // (origin=gitlab.verse8.io, no marker) pass the gate; the pre-0.5.5 code
  // AND-ed both checks via detectVerseProject, which silently rejected
  // every un-attached clone.
  const workspace = detectWorkspace(projectDir);
  const attachable =
    workspace.workspaceMode === "attached" ||
    workspace.workspaceMode === "unattached_clone";
  if (!attachable) {
    return {
      ok: false,
      error: "not_a_verse_project",
      hint: `${projectDir} is not a verse8 project (originHost=${workspace.originHost ?? "<none>"}, hasMarker=${workspace.hasProjectMarker}, mode=${workspace.workspaceMode}). Expected gitlab.verse8.io origin OR a .verse8/project.json marker.`,
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
      projectId: workspace.projectId ?? undefined,
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
  | "gitIgnore"
  | "claudeGitIgnore";

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
  skillPlugins: SkillPluginsReport;
  env: EnsureVerse8EnvResult;
  gitIgnore: EnsureGitIgnoreResult;
  claudeGitIgnore: EnsureGitIgnoreResult;
}

/**
 * Which vendored plugins this project gets, and why — read from the
 * project's `package.json` at attach time (see `pluginGate.ts`).
 */
export interface SkillPluginsReport {
  dependencies: "package.json" | "missing" | "invalid";
  active: Array<{ name: string; reason: PluginGateReason; matched?: string[] }>;
  inactive: Array<{ name: string; reason: PluginGateReason; requiresPackage: string[] }>;
}

function reportSkillPlugins(selection: ProjectSkillSelection): SkillPluginsReport {
  return {
    dependencies: selection.dependencies.source,
    active: selection.plugins
      .filter((p) => p.active)
      .map((p) => ({ name: p.name, reason: p.reason, ...(p.matched ? { matched: p.matched } : {}) })),
    inactive: selection.plugins
      .filter((p) => !p.active)
      .map((p) => ({ name: p.name, reason: p.reason, requiresPackage: p.requiresPackage })),
  };
}

// INV-7: `overwriteAllSkills: true` does not cascade to .env (and vice-versa)
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
  // Only skills that apply to this project: top-level ones plus those of
  // plugins whose `requiresPackage` the project's package.json satisfies.
  const selection = selectProjectSkills(listSkillResources(), projectDir, vendorPluginsRoot());
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
    const agentsDoc = writeAgentsDoc(projectDir, opts.overwrite, selection);
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
    const createdDirs = {
      claude: !safeIsDir(path.dirname(skillsRoot)),
      skillsRoot: !safeIsDir(skillsRoot),
    };
    // Registered before writing: `changes` fills in as files change, so a
    // throw halfway through (EACCES, ENOSPC, …) still rolls back the skills
    // already written, overwritten or removed.
    const changes: SkillFileChange[] = [];
    journal.record(() => reverseSkillWrites(skillsRoot, changes, createdDirs));
    const result = writeSkillFiles(projectDir, selection.active, {
      overwriteAll: opts.overwriteAllSkills === true,
      pruneOrphaned: opts.pruneOrphanedSkills === true,
      retire: selection.inactive.map((s) => s.name),
      onChange: (change) => changes.push(change),
    });
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

    // Step 7 — .claude/.gitignore (keeps vendored skill bundle out of git).
    const claudeGitIgnorePath = path.join(projectDir, ".claude", ".gitignore");
    const claudeGitIgnoreSnapshot = snapshotFile(claudeGitIgnorePath);
    const claudeGitIgnore = ensureClaudeGitIgnore(projectDir);
    if (claudeGitIgnore.status !== "already-present") {
      journal.record(() =>
        restoreFile(claudeGitIgnorePath, claudeGitIgnoreSnapshot),
      );
    }
    maybeFail(opts.__failAfter, "claudeGitIgnore");

    return {
      preCommitHook,
      commitMsgHook,
      agentsDoc,
      projectMarker,
      skills: result,
      skillPlugins: reportSkillPlugins(selection),
      env,
      gitIgnore,
      claudeGitIgnore,
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

/**
 * Undo exactly the file changes `writeSkillFiles` reported, newest first.
 * A skill directory is removed only when this run created it; one that
 * already existed (a retired skill's folder can keep the user's notes)
 * loses at most the SKILL.md this run wrote. `.claude/skills/` and
 * `.claude/` go only if this run created them and they end up empty.
 */
// INV-6: Skills outside the bundle are never touched
function reverseSkillWrites(
  skillsRoot: string,
  changes: SkillFileChange[],
  createdDirs: { claude: boolean; skillsRoot: boolean },
): void {
  for (const change of [...changes].reverse()) {
    const dir = path.join(skillsRoot, change.name);
    const file = path.join(dir, "SKILL.md");
    try {
      if (change.kind === "created") {
        fs.rmSync(file, { force: true });
        if (change.dirCreated) removeDirIfEmpty(dir);
      } else {
        // overwritten / removed: put the previous bytes and mode back.
        fs.mkdirSync(dir, { recursive: true });
        writeFileAtomic(file, change.previous.bytes, change.previous.mode);
      }
    } catch {
      /* best-effort */
    }
  }
  if (createdDirs.skillsRoot) removeDirIfEmpty(skillsRoot);
  if (createdDirs.claude) removeDirIfEmpty(path.dirname(skillsRoot));
}

function writeAgentsDoc(
  projectDir: string,
  overwrite: boolean,
  selection: ProjectSkillSelection,
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
  // Active plugins' instructions follow the catalog, as the container
  // appends them after its base instructions.
  const catalog = renderSkillsCatalog(selection.active);
  const instructions = renderPluginInstructions(selection.plugins);
  const rendered = AGENTS_MD_TEMPLATE.replace("{{SKILLS_CATALOG}}", () =>
    instructions ? `${catalog}\n${instructions}` : catalog,
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

// INV-2: `.verse8/project.json` carries no secrets
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
