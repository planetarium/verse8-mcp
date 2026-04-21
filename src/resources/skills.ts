import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Expose skill markdown files as MCP resources.
 *
 * Three sources are merged, with **core > vendor > cache** precedence.
 * Later entries in the insertion chain overwrite earlier ones because the
 * merge is a `Map<uri, SkillResource>` — so `core` is inserted LAST and
 * wins on name collisions.
 *
 *   1. `<repo root>/skills/<name>/SKILL.md`           — verse8-mcp core
 *   2. `<repo root>/skills-vendor/agent8-skills/skills/<name>.md`  — vendored (flat upstream layout)
 *   3. `~/.cache/verse8/skills/**\/SKILL.md`          — optional user cache
 *
 * **BREAKING CHANGE in 0.3.0**: prior versions inserted `cache` AFTER
 * `repoSkills`, making cache win on collision. The spec-mandated precedence
 * is `core > vendor > cache`; users who had relied on `~/.cache/verse8/skills/`
 * to override a bundled skill must relocate those overrides.
 *
 * URI scheme: `verse8://skill/<name>/SKILL.md`.
 *
 * **Two on-disk layouts are supported** so we don't force the upstream
 * agent8-skills repo to restructure:
 *   A) `<scanRoot>/<skillName>/SKILL.md`    — directory-per-skill (verse8 core,
 *      Claude Code convention).
 *   B) `<scanRoot>/skills/<skillName>.md`   — flat layout used by the agent8-skills
 *      upstream repo. Only kicks in when a markdown file's immediate parent
 *      directory is literally named "skills" so a random `README.md` won't be
 *      misclassified as a skill.
 */

export interface SkillResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  fsPath: string;
}

function resolveRepoRoot(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, ".."),
      path.resolve(here, "..", ".."),
      path.resolve(here, "..", "..", ".."),
    ];
    for (const c of candidates) {
      // Any of the three source directories being present identifies the root —
      // package tarballs may omit one (e.g. `skills-vendor/` if a consumer
      // installed before 0.3.0) but the repo-root resolver must still succeed.
      if (
        fs.existsSync(path.join(c, "skills")) ||
        fs.existsSync(path.join(c, "skills-vendor"))
      ) {
        return c;
      }
    }
    return candidates[1]!;
  } catch {
    return process.cwd();
  }
}

/** One reported skill discovered under a scan root. */
interface DiscoveredSkill {
  skillName: string;
  fsPath: string;
}

/**
 * Walk `root` up to 4 levels deep and emit every skill found, honoring the
 * two supported layouts (see module doc). First-seen wins on same-name
 * collision WITHIN a single source; a stderr warn is emitted when a collision
 * is skipped so maintainers can notice shadowed duplicates.
 */
function listSkillsUnder(root: string, sourceLabel: string): SkillResource[] {
  if (!fs.existsSync(root)) return [];
  const seen = new Map<string, DiscoveredSkill>();

  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      // Layout A: <parent>/<skillName>/SKILL.md
      if (entry.name === "SKILL.md") {
        const skillName = path.basename(path.dirname(full));
        if (!isSafeSkillName(skillName)) continue;
        recordSkill(seen, skillName, full, sourceLabel);
        continue;
      }

      // Layout B: <scanRoot>/skills/<skillName>.md (flat — used by upstream
      // agent8-skills). The "skills" parent-dir check isolates this layout
      // so unrelated .md files (README.md, instructions/*.md, prompts/*.md)
      // aren't misclassified.
      const parentName = path.basename(path.dirname(full));
      if (parentName === "skills" && entry.name !== "README.md") {
        const skillName = entry.name.slice(0, -3); // strip ".md"
        if (!isSafeSkillName(skillName)) continue;
        recordSkill(seen, skillName, full, sourceLabel);
      }
    }
  };

  walk(root, 0);

  return [...seen.values()].map((d) => ({
    uri: `verse8://skill/${d.skillName}/SKILL.md`,
    name: d.skillName,
    title: d.skillName,
    description: `Verse8 skill: ${d.skillName}`,
    mimeType: "text/markdown",
    fsPath: d.fsPath,
  }));
}

/**
 * Guard against pathological skill names at the discovery boundary:
 * empty string (e.g. a file literally named `.md`), dot, parent-dot, or
 * anything containing a path separator. These would resolve outside
 * `.claude/skills/<name>/` when `writeSkillFiles` calls `path.join`, so
 * reject them up-front and keep downstream code simple. Mirror check lives
 * at the write boundary in `skillWriter.ts` (defence-in-depth).
 */
export function isSafeSkillName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

function recordSkill(
  seen: Map<string, DiscoveredSkill>,
  skillName: string,
  fsPath: string,
  sourceLabel: string,
): void {
  if (seen.has(skillName)) {
    // Intra-source duplicate: two different files claim the same skill name.
    // First-seen wins (keeps the scan stable); warn so the maintainer can
    // dedupe upstream.
    const first = seen.get(skillName)!;
    console.error(
      `[verse8-skills] duplicate skill name "${skillName}" in ${sourceLabel}: kept ${first.fsPath}, skipped ${fsPath}`,
    );
    return;
  }
  seen.set(skillName, { skillName, fsPath });
}

export function listSkillResources(): SkillResource[] {
  const repoRoot = resolveRepoRoot();
  const coreSkills = path.join(repoRoot, "skills");
  const vendorSkills = path.join(repoRoot, "skills-vendor");
  const userCache = path.join(os.homedir(), ".cache", "verse8", "skills");

  // Insertion order drives priority — LAST insert wins in Map.set().
  // So we insert in REVERSE priority: cache (lowest) → vendor (mid) → core (highest).
  // Callers observe `core > vendor > cache` collision behavior.
  const byUri = new Map<string, SkillResource>();
  for (const s of listSkillsUnder(userCache, "userCache")) byUri.set(s.uri, s);
  for (const s of listSkillsUnder(vendorSkills, "skills-vendor")) byUri.set(s.uri, s);
  for (const s of listSkillsUnder(coreSkills, "skills")) byUri.set(s.uri, s);
  return Array.from(byUri.values()).sort((a, b) => a.uri.localeCompare(b.uri));
}

export interface ReadSkillSuccess {
  ok: true;
  uri: string;
  mimeType: string;
  text: string;
}
export interface ReadSkillError {
  ok: false;
  error: "unknown_uri" | "read_failed";
  hint: string;
}

export function readSkillResource(uri: string): ReadSkillSuccess | ReadSkillError {
  const match = uri.match(/^verse8:\/\/skill\/([^/]+)\/SKILL\.md$/);
  if (!match) {
    return { ok: false, error: "unknown_uri", hint: `unrecognized URI: ${uri}` };
  }
  const all = listSkillResources();
  const hit = all.find((r) => r.uri === uri);
  if (!hit) {
    return { ok: false, error: "unknown_uri", hint: `no skill resource for ${uri}` };
  }
  try {
    const text = fs.readFileSync(hit.fsPath, "utf8");
    return { ok: true, uri, mimeType: hit.mimeType, text };
  } catch (e) {
    return { ok: false, error: "read_failed", hint: (e as Error).message };
  }
}
