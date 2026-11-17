// Child steps under a Windows shell — shared by verse8_preview's preflight
// and verse8_deploy, so both decide the same way and accept the same argv.

/**
 * `npx` (and `bunx`, `npm`, `pnpm`, …) is a `.cmd` shim on Windows, which
 * `execFileSync` cannot start without a shell (`spawnSync npx ENOENT`).
 * Child steps therefore go through the shell on Windows only.
 */
export function stepsUseShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Under a shell every argv token is re-read by cmd.exe, so a token carrying
 * shell syntax (`&&`, `|`, `;`, redirects, quotes, `%VAR%`, `^`, parentheses,
 * `$(…)`, backticks, globs) would be interpreted instead of passed on. Only
 * inert tokens are accepted: package-manager argv (`@scope/pkg@1.2.3`,
 * `--flag=value`, URLs) plus `\` and `~` so a Windows path
 * (`C:\Users\RUNNER~1\…`) still counts as plain argv.
 */
const SHELL_INERT_TOKEN_RE = /^[A-Za-z0-9_.@/:=+\\~-]+$/;

/** Tokens that a shell could interpret instead of passing on. */
export function unsafeShellTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => t.length > 0 && !SHELL_INERT_TOKEN_RE.test(t));
}
