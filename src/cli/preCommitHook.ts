import { execFileSync } from "node:child_process";
import { PROJECT_TOKEN_REL_PATH } from "../context/token.js";
import { extractHost } from "../context/verseProject.js";
// INV-15: the hook's stderr reaches the agent through `git commit` output.
import { stripUrlCredentials } from "../util/redact.js";

/**
 * A commit that adds or changes a `.verse8/token` file would publish a
 * login, and the token lookup refuses a tracked token file from then on.
 * verse8_checkpoint drops the file from its own commits; this covers a
 * plain `git commit`. Removing an already tracked one (a staged deletion)
 * passes. Returns the hook's exit code.
 *
 * INV-16: The project token file is never read through a link or from git
 */
function rejectStagedProjectToken(cwd: string): number {
  let staged: string[];
  try {
    staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=d", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\0")
      .filter((p) => p.length > 0);
  } catch (e) {
    process.stderr.write(`[verse8 pre-commit] unable to list staged files: ${(e as Error).message}\n`);
    return 1;
  }
  // Any depth (a project nested in a larger repo) and any letter case.
  const tokens = staged.filter((p) => {
    const lower = p.toLowerCase();
    return lower === PROJECT_TOKEN_REL_PATH || lower.endsWith(`/${PROJECT_TOKEN_REL_PATH}`);
  });
  if (tokens.length === 0) return 0;
  process.stderr.write(
    `[verse8 pre-commit] commit rejected — ${tokens.join(", ")} is a Verse8 login token and must not be committed.\n` +
      `[verse8 pre-commit] unstage it with: git rm --cached ${tokens.map((t) => `"${t}"`).join(" ")}\n`,
  );
  return 1;
}

/**
 * `verse8-mcp hook pre-commit` — validates the current repo's origin host is
 * `gitlab.verse8.io` and that no project token file is being committed.
 * Exit 0 when both hold, exit 1 with a diagnostic message otherwise.
 * Designed to be invoked from `.git/hooks/pre-commit`.
 */
export function runPreCommitHook(cwd: string = process.cwd()): number {
  let origin: string;
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    process.stderr.write(
      `[verse8 pre-commit] unable to read origin: ${(e as Error).message}\n`,
    );
    return 1;
  }

  const host = extractHost(origin);
  if (host === "gitlab.verse8.io") {
    return rejectStagedProjectToken(cwd);
  }

  process.stderr.write(
    `[verse8 pre-commit] origin host must be gitlab.verse8.io (got: ${host ?? "<unparsable>"} from ${stripUrlCredentials(origin) ?? "<unparsable>"})\n` +
      `[verse8 pre-commit] commit rejected — verse8 projects must push to gitlab.verse8.io.\n`,
  );
  return 1;
}
