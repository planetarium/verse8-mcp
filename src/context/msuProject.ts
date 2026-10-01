import * as fs from "node:fs";
import * as path from "node:path";

/**
 * MSU (MapleStory Universe) project detection — ported from the agent8
 * container (apps/container-agent/src/utils/maple-system-helpers.ts) so a
 * deploy from the MCP tags the verse exactly like a web-editor publish:
 * the container returns `tags: ['MSU']`, which verse8-vibe turns into the
 * `__MSU` + `__review_required` verse tags.
 *
 * A project counts as MSU when the maple helper bundle
 * (`src/__system__/maple`) is installed OR the shipped code references
 * MapleStory:
 *   - keyword mentions in *.ts / *.tsx / *.html, ignoring comments;
 *   - MSU resource hosts in those files plus *.json / *.css (raw source).
 * *.md is never scanned — a mention in docs is not usage.
 */

const MAPLE_HELPERS_SUBPATH = path.join("src", "__system__", "maple");

const KEYWORD_NEEDLES = ["메이플스토리", "메이플 스토리", "maple story", "maplestory"] as const;
const RESOURCE_HOSTS = ["d1zf9cjayl5rrg.cloudfront.net", "resource-static.msu.io"] as const;
const KEYWORD_SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".html"]);
const HOST_SCAN_EXTENSIONS = new Set([".json", ".ts", ".tsx", ".html", ".css"]);
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

/** A `//` that begins a host, not a comment: `//cdn.example.com/hero.png`. */
const PROTOCOL_RELATIVE_URL = /^\/\/[a-z0-9-]+(\.[a-z0-9-]+)+([/\s]|$)/i;

function opensUrl(source: string, i: number): boolean {
  return source[i - 1] === ":" || PROTOCOL_RELATIVE_URL.test(source.slice(i, i + 128));
}

/**
 * Blank out comment bodies so keyword matching only sees what ships to the
 * player. String/template literals are preserved and an unterminated comment
 * stays code — misreads keep the MSU signal, never drop it.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "sq" | "dq" | "tpl" = "code";

  while (i < source.length) {
    const c = source[i];
    if (state === "code") {
      if (c === "<" && source.startsWith("<!--", i)) {
        const end = source.indexOf("-->", i + 4);
        if (end !== -1) {
          i = end + 3;
          out += " ";
          continue;
        }
      } else if (c === "/" && source[i + 1] === "/" && !opensUrl(source, i)) {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end;
        out += " ";
        continue;
      } else if (c === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end !== -1) {
          i = end + 2;
          out += " ";
          continue;
        }
      }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out += c;
      i += 1;
      continue;
    }

    if (c === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) {
      state = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

function hasKeywordNeedle(lowerContent: string): boolean {
  return KEYWORD_NEEDLES.some((needle) => lowerContent.includes(needle));
}

function scanForMapleStoryReference(dir: string): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (scanForMapleStoryReference(full)) return true;
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      const scanKeywords = KEYWORD_SCAN_EXTENSIONS.has(ext);
      const scanHosts = HOST_SCAN_EXTENSIONS.has(ext);
      if (!scanKeywords && !scanHosts) continue;
      const content = fs.readFileSync(full, "utf8").toLowerCase();
      if (scanKeywords && hasKeywordNeedle(content) && hasKeywordNeedle(stripComments(content))) {
        return true;
      }
      if (scanHosts && RESOURCE_HOSTS.some((host) => content.includes(host))) {
        return true;
      }
    }
  }
  return false;
}

export function hasMapleSystemHelpers(projectDir: string): boolean {
  try {
    return fs.statSync(path.join(projectDir, MAPLE_HELPERS_SUBPATH)).isDirectory();
  } catch {
    return false;
  }
}

/** Best-effort: fs errors are treated as "no reference". */
export function isMsuProject(projectDir: string): boolean {
  if (hasMapleSystemHelpers(projectDir)) return true;
  try {
    return scanForMapleStoryReference(projectDir);
  } catch {
    return false;
  }
}
