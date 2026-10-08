import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeSkillName, type SkillResource } from "../resources/skills.js";

/**
 * Hash-fingerprint-based writer for project-scoped skill files.
 *
 * For each discovered skill, we materialize `<projectDir>/.claude/skills/<name>/SKILL.md`
 * (Claude Code's auto-load convention). To tell apart "verse8-mcp wrote this" from
 * "a user edited their copy", every written file carries a last-line marker:
 *
 *     <!-- verse8-skill-hash: <sha256-of-content-without-this-line> -->
 *
 * On re-attach we read the destination, strip the marker, hash the remainder, and
 * compare to the marker value. Equal = we wrote it last = safe to overwrite. Not
 * equal = user edited = preserve. `overwriteAll: true` bypasses the check.
 *
 * The marker lives on the LAST line (Fallback B from the plan's Step 0 decision
 * tree) because it's universally tolerated — every markdown parser and Claude
 * Code's skill loader ignores trailing HTML comments, whereas a leading HTML
 * comment above optional YAML frontmatter is more likely to confuse loaders.
 *
 * Hash input normalization: CRLF → LF on BOTH source and destination content
 * BEFORE hashing so Windows / macOS / Linux produce identical fingerprints for
 * the same logical content.
 */

const MARKER_PREFIX = "<!-- verse8-skill-hash: ";
const MARKER_SUFFIX = " -->";
const MARKER_REGEX = /\r?\n<!-- verse8-skill-hash: ([a-f0-9]{64}) -->\s*$/;

export interface SkillWriteResult {
  created: string[];
  updated: string[];
  skippedUserEdited: string[];
  existingUnchanged: string[];
  pruned: string[];
  /** Skills of plugins inactive for this project, removed because we wrote them. */
  deactivated: string[];
}

export interface SkillWriteOptions {
  overwriteAll: boolean;
  pruneOrphaned: boolean;
  /**
   * Skill names that must not be installed in this project (their plugin is
   * inactive). A `.claude/skills/<name>/SKILL.md` that still carries our
   * unedited hash marker is removed; a user-written or user-edited one stays.
   * Unlike `pruneOrphaned` this always runs: a skill the project's
   * dependencies rule out is not an orphan the user might still want.
   */
  retire?: string[];
  /** Called with the removed SKILL.md bytes so the caller can roll back. */
  onRetire?: (name: string, raw: string) => void;
}

/**
 * Normalize line endings — hashes must be deterministic regardless of the
 * OS that wrote the file. Trailing whitespace is also stripped to keep the
 * hash stable against editor auto-insert of a final newline.
 */
function normalizeForHash(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Compute the canonical sha256 for a skill's logical content. The caller
 * must pass content that does NOT already contain the marker; this function
 * does not strip.
 */
export function computeSkillHash(content: string): string {
  const normalized = normalizeForHash(content);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Append the hash marker to a body, returning the final file bytes to write.
 * Idempotent if called with content that already has a marker (strips first).
 */
export function addHashMarker(rawContent: string): string {
  const bareBody = stripHashMarker(rawContent);
  const hash = computeSkillHash(bareBody);
  // Normalize trailing whitespace before appending so the marker sits on
  // exactly one line after the content.
  const trimmed = bareBody.replace(/\s+$/, "");
  return `${trimmed}\n\n${MARKER_PREFIX}${hash}${MARKER_SUFFIX}\n`;
}

/**
 * Strip the last-line marker if present, returning the "bare" content that
 * the marker was calculated over. If no marker is found the input is
 * returned unchanged.
 */
export function stripHashMarker(content: string): string {
  const m = content.match(MARKER_REGEX);
  if (!m) return content;
  return content.slice(0, m.index);
}

/**
 * Extract the sha256 value from a destination file's marker, or null when
 * the file has no marker (i.e. the user wrote it from scratch, or it was
 * never touched by verse8-mcp).
 */
export function extractMarkerHash(content: string): string | null {
  const m = content.match(MARKER_REGEX);
  return m ? m[1] : null;
}

/**
 * True when the destination's current body hashes to the same value that
 * its marker records — i.e. verse8-mcp wrote it and the user has not edited
 * since. CRLF-normalized on BOTH sides (plan AC-18).
 */
function destIsUnedited(destRaw: string): boolean {
  const markerHash = extractMarkerHash(destRaw);
  if (!markerHash) return false;
  const body = stripHashMarker(destRaw);
  return computeSkillHash(body) === markerHash;
}

/**
 * Main entry — iterate `skills`, materialize each into
 * `<projectDir>/.claude/skills/<name>/SKILL.md`, respecting the hash-based
 * conflict policy. NEVER touches skill directories whose basename is not
 * in the input `skills` array (no-touch invariant, AC-15).
 */
export function writeSkillFiles(
  projectDir: string,
  skills: SkillResource[],
  opts: SkillWriteOptions,
): SkillWriteResult {
  const result: SkillWriteResult = {
    created: [],
    updated: [],
    skippedUserEdited: [],
    existingUnchanged: [],
    pruned: [],
    deactivated: [],
  };

  const skillsRoot = path.join(projectDir, ".claude", "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });

  const bundledNames = new Set(skills.map((s) => s.name));

  for (const skill of skills) {
    // Defence-in-depth: `skill.name` is already filtered by isSafeSkillName
    // at the discovery boundary (src/resources/skills.ts), but the writer
    // re-validates at the WRITE boundary so a caller that fabricates a
    // SkillResource with a hostile name can't escape the projectDir.
    if (!isSafeSkillName(skill.name)) {
      console.error(
        `[verse8-skills] rejecting unsafe skill name at write boundary: ${JSON.stringify(skill.name)}`,
      );
      continue;
    }
    const destDir = path.join(skillsRoot, skill.name);
    const destPath = path.join(destDir, "SKILL.md");

    let source: string;
    try {
      source = fs.readFileSync(skill.fsPath, "utf8");
    } catch (e) {
      // Missing source — should be rare (race with subtree pull?). Skip
      // silently rather than crash the whole attach.
      console.error(
        `[verse8-skills] failed to read source for ${skill.name}: ${(e as Error).message}`,
      );
      continue;
    }
    const sourceBody = stripHashMarker(source); // idempotent if absent
    const sourceHash = computeSkillHash(sourceBody);
    const finalBytes = `${sourceBody.replace(/\s+$/, "")}\n\n${MARKER_PREFIX}${sourceHash}${MARKER_SUFFIX}\n`;

    let destExists = false;
    let destRaw = "";
    try {
      destRaw = fs.readFileSync(destPath, "utf8");
      destExists = true;
    } catch {
      /* missing — will create */
    }

    if (!destExists) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, finalBytes);
      result.created.push(skill.name);
      continue;
    }

    // Dest exists. Four sub-cases.
    if (opts.overwriteAll) {
      fs.writeFileSync(destPath, finalBytes);
      result.updated.push(skill.name);
      continue;
    }

    const destMarkerHash = extractMarkerHash(destRaw);
    if (destMarkerHash === null) {
      // No marker → user wrote this from scratch or edited+stripped. Treat
      // as user edit, preserve.
      result.skippedUserEdited.push(skill.name);
      continue;
    }

    // Did the user edit between our last write and now?
    const destBodyHash = computeSkillHash(stripHashMarker(destRaw));
    const userEdited = destBodyHash !== destMarkerHash;
    if (userEdited) {
      result.skippedUserEdited.push(skill.name);
      continue;
    }

    // Marker matched current body — verse8-mcp wrote this last and the
    // user didn't touch. Decide: is the source content different?
    if (destMarkerHash === sourceHash) {
      // Source unchanged since last write — true no-op.
      result.existingUnchanged.push(skill.name);
      continue;
    }

    // Source changed; our previous write is still intact; safe to overwrite.
    fs.writeFileSync(destPath, finalBytes);
    result.updated.push(skill.name);
  }

  for (const name of opts.retire ?? []) {
    if (bundledNames.has(name) || !isSafeSkillName(name)) continue;
    const dir = path.join(skillsRoot, name);
    const file = path.join(dir, "SKILL.md");
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // never installed
    }
    if (!destIsUnedited(raw)) continue; // user-written or user-edited
    try {
      // Only our file goes; anything the user added next to it keeps the dir.
      fs.rmSync(file, { force: true });
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      result.deactivated.push(name);
      opts.onRetire?.(name, raw);
    } catch {
      /* best-effort */
    }
  }

  if (opts.pruneOrphaned) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (bundledNames.has(entry.name)) continue;
      // readdirSync never returns "." / ".." as entry names, but re-validate
      // for defence-in-depth before constructing paths.
      if (!isSafeSkillName(entry.name)) continue;
      // No-touch invariant: only prune dirs we *would* have written to —
      // i.e. dirs that contain a SKILL.md with our marker (proving we were
      // the ones who created it). A user-created skill dir has no marker
      // and survives even under pruneOrphaned.
      const candidatePath = path.join(skillsRoot, entry.name, "SKILL.md");
      let candidateRaw = "";
      try {
        candidateRaw = fs.readFileSync(candidatePath, "utf8");
      } catch {
        continue; // no SKILL.md in the dir, leave it alone
      }
      if (!destIsUnedited(candidateRaw)) continue; // user-edited or user-owned
      try {
        fs.rmSync(path.join(skillsRoot, entry.name), { recursive: true, force: true });
        result.pruned.push(entry.name);
      } catch {
        /* best-effort */
      }
    }
  }

  return result;
}
