import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Maintain `<projectDir>/.verse8/.gitignore` so verse8 runtime artifacts
 * (preview log, audit log + pointer, atomic-write tmp leftovers) never
 * land in `git add -A` commits. verse8 projects commit `.env` by
 * convention, so we cannot rely on a global `.verse8/` exclusion — only
 * specific files are blocked.
 *
 * Idempotent: existing user entries are preserved; missing entries are
 * appended; duplicates are never written.
 *
 * (US-M2-2.)
 */

const REQUIRED_ENTRIES = [
  "preview.log",
  "mcp.log",
  "mcp.log.*",
  "mcp.log.link",
  "*.env.tmp-*",
  ".env.tmp-*",
];

const HEADER =
  "# Managed by verse8-mcp (verse8_attach). Edit user entries below the marker freely.\n";
const USER_MARKER = "# --- user entries below ---\n";

export interface EnsureGitIgnoreResult {
  status: "created" | "updated" | "already-present";
  path: string;
}

export function ensureVerse8GitIgnore(projectDir: string): EnsureGitIgnoreResult {
  return ensureManagedGitIgnore({
    targetDir: path.join(projectDir, ".verse8"),
    entries: REQUIRED_ENTRIES,
  });
}

const CLAUDE_REQUIRED_ENTRIES = ["skills/"];

/**
 * Maintain `<projectDir>/.claude/.gitignore` so the ~288KB vendored skill
 * bundle that `verse8_attach` materializes under `.claude/skills/` never
 * lands in git. Nested .gitignore is the least-intrusive scope — we don't
 * have to touch the project-root `.gitignore` (which users typically hand-curate).
 *
 * Idempotent: preserves user entries in the same file; only appends the
 * verse8-mcp block when `skills/` is absent.
 */
export function ensureClaudeGitIgnore(projectDir: string): EnsureGitIgnoreResult {
  return ensureManagedGitIgnore({
    targetDir: path.join(projectDir, ".claude"),
    entries: CLAUDE_REQUIRED_ENTRIES,
  });
}

function ensureManagedGitIgnore(args: {
  targetDir: string;
  entries: readonly string[];
}): EnsureGitIgnoreResult {
  const target = path.join(args.targetDir, ".gitignore");

  let existing = "";
  let exists = false;
  try {
    existing = fs.readFileSync(target, "utf8");
    exists = true;
  } catch {
    /* missing — will create */
  }

  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
  );
  const missing = args.entries.filter((e) => !existingLines.has(e));

  if (exists && missing.length === 0) {
    return { status: "already-present", path: target };
  }

  fs.mkdirSync(args.targetDir, { recursive: true });

  let body: string;
  if (!exists) {
    body = HEADER + args.entries.join("\n") + "\n\n" + USER_MARKER;
  } else {
    const trailingNewline = existing.endsWith("\n") ? "" : "\n";
    body =
      existing +
      trailingNewline +
      "\n# verse8-mcp entries (added by verse8_attach):\n" +
      missing.join("\n") +
      "\n";
  }

  fs.writeFileSync(target, body, { mode: 0o644 });
  return { status: exists ? "updated" : "created", path: target };
}
