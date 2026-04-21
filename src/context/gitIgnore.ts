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
  const verse8Dir = path.join(projectDir, ".verse8");
  const target = path.join(verse8Dir, ".gitignore");

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
  const missing = REQUIRED_ENTRIES.filter((e) => !existingLines.has(e));

  if (exists && missing.length === 0) {
    return { status: "already-present", path: target };
  }

  fs.mkdirSync(verse8Dir, { recursive: true });

  let body: string;
  if (!exists) {
    body =
      HEADER +
      REQUIRED_ENTRIES.join("\n") +
      "\n\n" +
      USER_MARKER;
  } else {
    // Append missing entries on their own block at the end so user-added
    // lines (above or below) keep their position.
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
