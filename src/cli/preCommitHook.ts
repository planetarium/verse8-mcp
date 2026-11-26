import { execFileSync } from "node:child_process";
import { PROJECT_TOKEN_REL_PATH } from "../context/token.js";
import { extractHost } from "../context/verseProject.js";
import { gitEnvInsideHook } from "../util/gitEnv.js";
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
  let tokens: string[];
  try {
    tokens = stagedProjectTokens(cwd);
  } catch (e) {
    const err = e as Error & { stderr?: string | Buffer };
    const detail = (err.stderr?.toString().trim().split(/\r?\n/)[0] || err.message).slice(0, 300);
    process.stderr.write(
      `[verse8 pre-commit] commit rejected — git could not say whether a Verse8 login token (${PROJECT_TOKEN_REL_PATH}) is staged: ${detail}\n` +
        `[verse8 pre-commit] run \`git status\` to see the git error, fix it, and commit again.\n`,
    );
    return 1;
  }
  if (tokens.length === 0) return 0;
  // The paths come from the repository (a clone can carry any folder name),
  // so they are shown as quoted data only. The command below is a fixed
  // string: a path pasted into a shell command could carry `$(…)`.
  process.stderr.write(
    `[verse8 pre-commit] commit rejected — a Verse8 login token must not be committed. Staged: ${tokens.map((t) => JSON.stringify(t)).join(", ")}\n` +
      `[verse8 pre-commit] unstage it with: ${UNSTAGE_TOKEN_COMMAND}\n`,
  );
  return 1;
}

/** Any depth (a project nested in a larger repo) and any letter case, from the top of the work tree. */
const TOKEN_PATHSPEC = `:(top,icase,glob)**/${PROJECT_TOKEN_REL_PATH}`;

/** Fixed text — no staged path is ever put into it. Double quotes work in sh, PowerShell and cmd. */
export const UNSTAGE_TOKEN_COMMAND = `git rm --cached -- "${TOKEN_PATHSPEC}"`;

function gitInHook(cwd: string, args: string[]): string {
  return execFileSync("git", ["--no-literal-pathspecs", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnvInsideHook(),
  });
}

/**
 * Staged project token files that this commit adds or changes (a staged
 * removal is not listed). git does the path matching, so the output holds
 * token paths only however many files are staged, and plumbing commands
 * are used so that `diff.*` settings (a `diff.orderFile` that points
 * nowhere, an external diff) cannot make the listing fail or differ.
 * Throws when git cannot answer.
 */
function stagedProjectTokens(cwd: string): string[] {
  let hasHead = true;
  try {
    gitInHook(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch (e) {
    // Exit 1 = no commit yet (the first commit of a repository).
    if ((e as { status?: number | null }).status !== 1) throw e;
    hasHead = false;
  }
  const out = hasHead
    ? gitInHook(cwd, ["diff-index", "--cached", "--name-only", "--diff-filter=d", "-z", "HEAD", "--", TOKEN_PATHSPEC])
    : // Nothing committed yet: every index entry is an addition.
      gitInHook(cwd, ["ls-files", "--cached", "-z", "--", TOKEN_PATHSPEC]);
  return out.split("\0").filter((p) => p.length > 0);
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
