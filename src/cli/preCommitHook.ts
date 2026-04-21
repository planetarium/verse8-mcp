import { execFileSync } from "node:child_process";
import { extractHost } from "../context/verseProject.js";

/**
 * `verse8-mcp hook pre-commit` — validates the current repo's origin host is
 * `gitlab.verse8.io`. Exit 0 on match, exit 1 with a diagnostic message on
 * mismatch. Designed to be invoked from `.git/hooks/pre-commit`.
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
    return 0;
  }

  process.stderr.write(
    `[verse8 pre-commit] origin host must be gitlab.verse8.io (got: ${host ?? "<unparsable>"} from ${origin})\n` +
      `[verse8 pre-commit] commit rejected — verse8 projects must push to gitlab.verse8.io.\n`,
  );
  return 1;
}
