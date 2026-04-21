import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface VerseProjectDetection {
  isVerse: boolean;
  projectId?: string;
  gitlabRemote?: string;
}

interface ProjectJsonShape {
  version?: number;
  projectId?: string;
  gitlabRemote?: string;
  preset?: string;
  [k: string]: unknown;
}

/**
 * Detect whether `cwd` is a verse8 project.
 *
 * A directory qualifies when BOTH:
 *   - `.verse8/project.json` exists
 *   - `git remote get-url origin` resolves to a URL whose host is `gitlab.verse8.io`
 */
export function detectVerseProject(cwd: string): VerseProjectDetection {
  const projectJsonPath = path.join(cwd, ".verse8", "project.json");

  let projectJson: ProjectJsonShape | null = null;
  try {
    if (fs.existsSync(projectJsonPath)) {
      const raw = fs.readFileSync(projectJsonPath, "utf8");
      projectJson = JSON.parse(raw) as ProjectJsonShape;
    }
  } catch {
    projectJson = null;
  }

  if (!projectJson) {
    return { isVerse: false };
  }

  let originUrl: string | null = null;
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    originUrl = out.trim();
  } catch {
    originUrl = null;
  }

  if (!originUrl) {
    return { isVerse: false };
  }

  const host = extractHost(originUrl);
  if (host !== "gitlab.verse8.io") {
    return { isVerse: false };
  }

  return {
    isVerse: true,
    projectId: typeof projectJson.projectId === "string" ? projectJson.projectId : undefined,
    gitlabRemote:
      typeof projectJson.gitlabRemote === "string" ? projectJson.gitlabRemote : originUrl,
  };
}

/**
 * Extract the host portion from a git remote URL. Supports both:
 *   - https://host/path
 *   - git@host:path
 */
export function extractHost(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  // SSH form: git@host:path
  const sshMatch = trimmed.match(/^[^@\s]+@([^:\s]+):/);
  if (sshMatch) {
    return sshMatch[1]!.toLowerCase();
  }

  try {
    const u = new URL(trimmed);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}
