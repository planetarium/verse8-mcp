import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectAttachment } from "./attachment.js";
import { extractHost } from "./verseProject.js";

/**
 * Rich workspace state — single source of truth for `verse8_bootstrap`
 * and `verse8_status` routing. Replaces the fragile
 * `detectVerseProject` predicate which required BOTH a marker AND a
 * matching origin, mis-classifying fresh `gitlab.verse8.io` clones that
 * have not yet attached.
 */

export type WorkspaceMode =
  | "empty"
  | "unattached_clone"
  | "attached"
  | "non_verse_dir";

export interface WorkspaceState {
  hasGit: boolean;
  originHost: string | null;
  hasProjectMarker: boolean;
  projectId: string | null;
  attached: boolean;
  workspaceMode: WorkspaceMode;
}

const VERSE8_HOST = "gitlab.verse8.io";

function readGitOriginHost(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const host = extractHost(out.trim());
    return host && host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

function readProjectMarker(cwd: string): {
  exists: boolean;
  projectId: string | null;
} {
  const markerPath = path.join(cwd, ".verse8", "project.json");
  try {
    if (!fs.statSync(markerPath).isFile()) return { exists: false, projectId: null };
    const raw = fs.readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    return {
      exists: true,
      projectId:
        typeof parsed.projectId === "string" && parsed.projectId.length > 0
          ? parsed.projectId
          : null,
    };
  } catch {
    return { exists: false, projectId: null };
  }
}

function hasGitDir(cwd: string): boolean {
  try {
    return fs.statSync(path.join(cwd, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function classify(
  hasGit: boolean,
  originHost: string | null,
  hasProjectMarker: boolean,
  attached: boolean,
): WorkspaceMode {
  if (attached && hasProjectMarker && originHost === VERSE8_HOST) return "attached";
  if (originHost === VERSE8_HOST) return "unattached_clone";
  if (hasProjectMarker) return "unattached_clone";
  if (!hasGit) return "empty";
  return "non_verse_dir";
}

export function detectWorkspace(cwd: string): WorkspaceState {
  const hasGit = hasGitDir(cwd);
  const originHost = hasGit ? readGitOriginHost(cwd) : null;
  const marker = readProjectMarker(cwd);
  const attachment = detectAttachment(cwd);
  const attached = attachment.attached;
  const workspaceMode = classify(hasGit, originHost, marker.exists, attached);
  return {
    hasGit,
    originHost,
    hasProjectMarker: marker.exists,
    projectId: marker.projectId,
    attached,
    workspaceMode,
  };
}
