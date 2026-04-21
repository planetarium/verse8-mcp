import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve the path to the Verse8 token file, honoring XDG_CONFIG_HOME.
 */
export function getConfigTokenPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "verse8", "token");
}

/**
 * Per-process set of token paths we have already warned about. Prevents
 * stderr spam: every loadToken() call must not re-emit the mode warning
 * for the same file. Cleared on process exit (no IPC).
 */
const warnedPaths = new Set<string>();

/**
 * On POSIX, the token file should be mode 0600 (owner read/write only).
 * On Windows, POSIX mode bits are not meaningful, so the check is skipped.
 * Warning is best-effort and never refuses the read — it only nudges the
 * user to tighten permissions. (US-M0-7.)
 */
function warnOnLooseTokenMode(p: string): void {
  if (process.platform === "win32") return;
  if (warnedPaths.has(p)) return;
  let mode: number;
  try {
    mode = fs.statSync(p).mode & 0o777;
  } catch {
    return;
  }
  if (mode !== 0o600) {
    warnedPaths.add(p);
    process.stderr.write(
      `[verse8-token] WARNING: ${p} mode is 0${mode.toString(8)}; expected 0600. ` +
        `Tighten with: chmod 600 "${p}"\n`,
    );
  }
}

/**
 * Load the Verse8 access token using the documented priority:
 *   1. VERSE8_ACCESS_TOKEN env
 *   2. <cwd>/.verse8/token
 *   3. ${XDG_CONFIG_HOME or ~/.config}/verse8/token
 *
 * Returns null if no token is available. Trims trailing whitespace/newlines.
 */
export function loadToken(cwd: string = process.cwd()): string | null {
  const envToken = process.env.VERSE8_ACCESS_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  const projectTokenPath = path.join(cwd, ".verse8", "token");
  const configTokenPath = getConfigTokenPath();

  for (const p of [projectTokenPath, configTokenPath]) {
    try {
      if (fs.existsSync(p)) {
        warnOnLooseTokenMode(p);
        const value = fs.readFileSync(p, "utf8").trim();
        if (value.length > 0) return value;
      }
    } catch {
      // Ignore unreadable file and continue to the next source.
    }
  }

  return null;
}

/**
 * Test-only helper to reset the per-process warned-paths set. Lets unit
 * tests assert the warn-once behavior without process restart.
 */
export function _resetTokenWarnedPathsForTests(): void {
  warnedPaths.clear();
}
