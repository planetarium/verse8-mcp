import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHooksDir } from "./hooks.js";

/**
 * Attachment state for a verse8 project.
 *
 * A project is "attached" when:
 *   - `<hooksDir>/pre-commit`  is the verse8-mcp dispatcher
 *   - `<hooksDir>/commit-msg`  is the verse8-mcp dispatcher
 *   - `AGENTS.md` (or `CLAUDE.md`) exists at the project root with a
 *     verse8-mcp signature
 *
 * `<hooksDir>` is `.git/hooks` by default, OR the value of
 * `git config --get core.hooksPath` when configured (husky / lefthook /
 * manually overridden projects). Without this, `detectAttachment` would
 * return false for repos where `verse8_attach` correctly wrote hooks to the
 * custom path but the gate still checked `.git/hooks`.
 */

export interface AttachmentState {
  attached: boolean;
  missing: string[];
  checks: {
    preCommitHook: boolean;
    commitMsgHook: boolean;
    agentsDoc: boolean;
  };
}

const PRE_COMMIT_SIGNATURE = "verse8-mcp hook pre-commit";
const COMMIT_MSG_SIGNATURE = "verse8-mcp hook commit-msg";

function hasVerse8HookSignature(hookPath: string, signature: string): boolean {
  try {
    const stat = fs.statSync(hookPath);
    if (!stat.isFile()) return false;
    const content = fs.readFileSync(hookPath, "utf8");
    return content.includes(signature);
  } catch {
    return false;
  }
}

/**
 * True only when the file exists AND carries a verse8-mcp signature. Without
 * the signature check, an unrelated AGENTS.md / CLAUDE.md shipped with a
 * non-verse8 project would incorrectly satisfy the attachment gate; the
 * subsequent commit-msg hook would still reject V8-missing commits but the
 * user would have been told the project is "attached" when it isn't.
 */
function hasVerse8AgentsDoc(filePath: string): boolean {
  let content: string;
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  return content.includes("verse8-mcp") || content.includes("verse8_checkpoint");
}

function hasAgentsDoc(projectDir: string): boolean {
  // Either AGENTS.md (OpenAI / OMC convention) or CLAUDE.md (Claude Code native)
  // satisfies the guidance requirement — but ONLY if it carries a verse8-mcp
  // signature, so an unrelated agents doc doesn't mask the need to attach.
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    if (hasVerse8AgentsDoc(path.join(projectDir, name))) return true;
  }
  return false;
}

// resolveHooksDir moved to src/context/hooks.ts (M1b-2 dedup with attach.ts).

export function detectAttachment(projectDir: string): AttachmentState {
  const hooksDir = resolveHooksDir(projectDir);
  const preCommitHook = hasVerse8HookSignature(
    path.join(hooksDir, "pre-commit"),
    PRE_COMMIT_SIGNATURE,
  );
  const commitMsgHook = hasVerse8HookSignature(
    path.join(hooksDir, "commit-msg"),
    COMMIT_MSG_SIGNATURE,
  );
  const agentsDoc = hasAgentsDoc(projectDir);

  // Surface the effective hooks dir in `missing` so users using a custom
  // core.hooksPath see which path we actually checked.
  const hooksDirRel = path.relative(projectDir, hooksDir) || hooksDir;
  const missing: string[] = [];
  if (!preCommitHook) missing.push(`${hooksDirRel}/pre-commit`);
  if (!commitMsgHook) missing.push(`${hooksDirRel}/commit-msg`);
  if (!agentsDoc) missing.push("AGENTS.md");

  return {
    attached: missing.length === 0,
    missing,
    checks: { preCommitHook, commitMsgHook, agentsDoc },
  };
}
