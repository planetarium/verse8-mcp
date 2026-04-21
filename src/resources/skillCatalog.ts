import * as fs from "node:fs";
import { type SkillResource } from "./skills.js";

/**
 * Render the dynamic skill catalog spliced into AGENTS.md / CLAUDE.md by
 * verse8_attach. One row per discovered skill. Description priority:
 *   1. YAML frontmatter `description:` (single-line OR block scalar)
 *   2. First non-blank line after an H1 heading
 *   3. First non-blank line of body
 *   4. Fallback: "(no description)"
 *
 * Output is a markdown subsection so the template keeps its visual rhythm.
 * (M1b-3 — extracted from src/tools/attach.ts.)
 */
export function renderSkillsCatalog(skills: SkillResource[]): string {
  if (skills.length === 0) {
    return "## Available Verse8 skills\n\n_(no skills bundled)_\n";
  }
  const rows: string[] = [];
  for (const s of skills) {
    let description = "(no description)";
    try {
      const raw = fs.readFileSync(s.fsPath, "utf8");
      description = extractSkillDescription(raw);
    } catch {
      /* fall through to default */
    }
    rows.push(
      `| \`${s.name}\` | ${escapeCell(description)} | \`${s.uri}\` |`,
    );
  }
  return [
    "## Available Verse8 skills",
    "",
    "The MCP server discovers skills from `skills/` (verse8 core) and",
    "`skills-vendor/agent8-skills/` (vendored upstream). If you're running",
    "on Claude Code, the matching `.claude/skills/<name>/SKILL.md` files",
    "are installed in this project by `verse8_attach` and auto-load.",
    "On other hosts, fetch the content via MCP `resources/read`.",
    "",
    "| Skill | Purpose | MCP URI |",
    "|-------|---------|---------|",
    ...rows,
    "",
  ].join("\n");
}

/** Markdown table cells: escape pipes and collapse newlines. */
export function escapeCell(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.replace(/\|/g, "\\|");
}

/** Description priority resolver. Exported for unit tests. */
export function extractSkillDescription(raw: string): string {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fmMatch) {
    const fm = fmMatch[1];
    // description: | <block scalar>
    //
    // Resolved manually (instead of a single complex regex) so the terminator
    // logic is unambiguous: block scalar ends at the next top-level YAML key,
    // OR at end-of-frontmatter, regardless of whether `description` is the
    // last key in the block.
    const blockStartMatch = fm.match(/(?:^|\n)description:\s*\|[^\n]*\r?\n/);
    if (blockStartMatch) {
      const bodyStart =
        (blockStartMatch.index ?? 0) + blockStartMatch[0].length;
      const rest = fm.slice(bodyStart);
      const nextKey = rest.search(/(?:^|\r?\n)[a-zA-Z][\w-]*:/m);
      const body = nextKey >= 0 ? rest.slice(0, nextKey) : rest;
      const block = body
        .split(/\r?\n/)
        .map((ln) => ln.replace(/^\s{0,4}/, ""))
        .filter((ln, i, all) => !(i === all.length - 1 && ln.trim() === ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (block.length > 0) return truncateDescription(block);
    }
    const inlineMatch = fm.match(/(?:^|\n)description:\s*([^\n]+)\s*$/m);
    if (inlineMatch) {
      const inline = inlineMatch[1].replace(/^["']|["']$/g, "").trim();
      if (inline.length > 0) return truncateDescription(inline);
    }
  }
  // Fall back to the first non-blank line after an H1 (if any),
  // else the first non-blank line.
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const lines = body.split(/\r?\n/);
  let seenH1 = false;
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!seenH1 && /^#\s/.test(trimmed)) {
      seenH1 = true;
      continue;
    }
    if (trimmed.length === 0) continue;
    if (/^#+\s/.test(trimmed)) continue;
    return truncateDescription(trimmed);
  }
  return "(no description)";
}

/** Cap descriptions to keep AGENTS.md table cells visually consistent. */
export function truncateDescription(s: string): string {
  const MAX = 160;
  return s.length > MAX ? s.slice(0, MAX - 1).trimEnd() + "…" : s;
}
