import * as path from "node:path";

/**
 * Safe-path policy for MCP tool input.
 *
 * Tool handlers receive `projectDir` / `targetDir` from the host LLM;
 * accepting any string and immediately calling `path.resolve` lets a hostile
 * LLM aim file IO at arbitrary locations. The accepted shape is narrowed at
 * the dispatch boundary so by the time `runAttach` / `runCheckpoint` /
 * `runPreview` / `runNewProjectConfirm` see the value, it has already passed
 * a traversal-rejection refinement.
 *
 * The check is deliberately strict and explicit:
 *   - reject NUL byte
 *   - reject paths whose normalized form differs from the input — catches
 *     `/tmp/../etc`, `~/foo/../bar`, mid-path `..`, `//double//slash`
 *   - reject any explicit `..` segment (defense-in-depth even if normalize
 *     somehow preserved it)
 *   - permit absolute POSIX paths and `~`-prefixed paths (caller may expand
 *     `~` later via `os.homedir()`)
 *
 * (US-M0-4.)
 */

export function isSafeAbsPath(input: string): boolean {
  if (typeof input !== "string") return false;
  if (input.length === 0) return false;
  if (input.includes("\0")) return false;

  // No `..` anywhere.
  const segments = input.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === "..") return false;
  }

  // The normalized form must equal the input. `path.posix.normalize` collapses
  // `//`, resolves `.`/`..`, and trims trailing `/`. A mismatch means the
  // input contained semantic redundancy or a traversal token.
  const normalized = path.posix.normalize(input);
  if (normalized !== input) {
    // Allow one specific delta: `os.homedir()` style "~" prefix.
    if (input.startsWith("~/") || input === "~") {
      const tail = input.slice(2);
      if (tail.length === 0) return true;
      const normTail = path.posix.normalize(tail);
      return normTail === tail && !tail.includes("..");
    }
    return false;
  }
  return true;
}
