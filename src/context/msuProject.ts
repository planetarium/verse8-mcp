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
 *
 * Nine Chronicles (9C) projects use the same keyword scan with their own
 * needles and get `__9C` + `__review_required`. Two signals are 9C-only: the
 * marker file PROJECT/NineChronicles.md, and those needles in *.json under src/
 * (raw source), where a game's asset manifest lives. *.json elsewhere is not
 * scanned for 9C. MSU wins when both match; see resolveJamProject.
 *
 * Nothing is shared with the agent8 container, so a change to the needles or
 * the scan rules here has to be made in its apps/container-agent/src/utils too:
 * jam-project.ts (9C needles, MSU-first resolution), workspace-reference-scan.ts
 * (the scanner) and maple-system-helpers.ts (MSU needles and hosts).
 */

const MAPLE_HELPERS_SUBPATH = path.join("src", "__system__", "maple");

interface ReferenceSignals {
  /** Lower-case; matched in *.ts / *.tsx / *.html with comments removed. */
  keywords: readonly string[];
  /** Lower-case; matched in raw source, so a host in a comment still counts. */
  hosts: readonly string[];
}

const MSU_SIGNALS: ReferenceSignals = {
  keywords: ["메이플스토리", "메이플 스토리", "maple story", "maplestory"],
  hosts: ["d1zf9cjayl5rrg.cloudfront.net", "resource-static.msu.io"],
};
// "9c" is left out on purpose: it matches too much unrelated code (hex colors, hashes).
const NINE_CHRONICLES_SIGNALS: ReferenceSignals = {
  keywords: [
    "나인크로니클",
    "나인 크로니클",
    "nine chronicles",
    "ninechronicles",
    "nine-chronicles",
    "nine-chronicles-assets",
    "jujeongmin.github.io",
    "jujeongmin/nine-chronicles",
  ],
  hosts: [],
};
const NINE_CHRONICLES_MARKER_SUBPATH = path.join("PROJECT", "NineChronicles.md");
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
 * stays code — misreads keep the keyword signal, never drop it.
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

function hasKeyword(lowerContent: string, keywords: readonly string[]): boolean {
  return keywords.some((needle) => lowerContent.includes(needle));
}

/** True as soon as `matches` accepts a file under `dir`. */
function someFile(dir: string, matches: (file: string) => boolean): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (someFile(full, matches)) return true;
    } else if (entry.isFile() && matches(full)) {
      return true;
    }
  }
  return false;
}

function scanForReference(dir: string, signals: ReferenceSignals): boolean {
  return someFile(dir, (full) => {
    const ext = path.extname(full);
    const scanKeywords = KEYWORD_SCAN_EXTENSIONS.has(ext);
    const scanHosts = signals.hosts.length > 0 && HOST_SCAN_EXTENSIONS.has(ext);
    if (!scanKeywords && !scanHosts) return false;
    const content = fs.readFileSync(full, "utf8").toLowerCase();
    if (scanKeywords && hasKeyword(content, signals.keywords) && hasKeyword(stripComments(content), signals.keywords)) {
      return true;
    }
    return scanHosts && signals.hosts.some((host) => content.includes(host));
  });
}

function jsonUnderSrcMentions(projectDir: string, keywords: readonly string[]): boolean {
  const srcDir = path.join(projectDir, "src");
  if (!fs.existsSync(srcDir)) return false;
  return someFile(
    srcDir,
    (full) => path.extname(full) === ".json" && hasKeyword(fs.readFileSync(full, "utf8").toLowerCase(), keywords),
  );
}

export function hasMapleSystemHelpers(projectDir: string): boolean {
  try {
    return fs.statSync(path.join(projectDir, MAPLE_HELPERS_SUBPATH)).isDirectory();
  } catch {
    return false;
  }
}

/** Throws on fs errors, so a failed scan can be told apart from "not MSU". */
function detectMsu(projectDir: string): boolean {
  return hasMapleSystemHelpers(projectDir) || scanForReference(projectDir, MSU_SIGNALS);
}

/** Best-effort: fs errors are treated as "no reference". */
export function isMsuProject(projectDir: string): boolean {
  try {
    return detectMsu(projectDir);
  } catch {
    return false;
  }
}

/**
 * Later signals (hosts, a helper bundle) belong in here so callers keep going
 * through this function. Best-effort like isMsuProject.
 */
export function isNineChroniclesProject(projectDir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(projectDir, NINE_CHRONICLES_MARKER_SUBPATH)) ||
      scanForReference(projectDir, NINE_CHRONICLES_SIGNALS) ||
      jsonUnderSrcMentions(projectDir, NINE_CHRONICLES_SIGNALS.keywords)
    );
  } catch {
    return false;
  }
}

export type JamProject = "MSU" | "9C" | null;

/**
 * MSU first: 9C is not even looked at for an MSU project, so a stray 9C mention
 * cannot change how an MSU project is tagged. An MSU scan that failed leaves the
 * question open, so it yields null rather than falling through to 9C.
 */
export function resolveJamProject(projectDir: string): JamProject {
  try {
    if (detectMsu(projectDir)) return "MSU";
  } catch {
    return null;
  }
  return isNineChroniclesProject(projectDir) ? "9C" : null;
}
