#!/usr/bin/env node
// sync-agent8-skills.mjs
//
// Rebuild `skills-vendor/agent8-skills/` from a checkout of
// planetarium/agent8-skills, copying only what that checkout's `public.json`
// allows, then re-pin `package.json :: verse8.skillsVendor`.
//
// Driven by `.github/workflows/sync-agent8-skills.yml` on the
// `agent8-skills-updated` repository_dispatch that agent8-skills sends for
// every push to its main (see its README, "Syncing to verse8-mcp"). Runs by
// hand too:
//
//   node scripts/sync-agent8-skills.mjs --upstream ../agent8-skills \
//     --commit "$(git -C ../agent8-skills rev-parse HEAD)"
//
// What ends up in the vendor tree (and nothing else):
//
//   skills-vendor/agent8-skills/
//     README.md                      generated — where this tree comes from
//     public.json                    the manifest, verbatim
//     skills/<name>.md               one per `public.json :: skills[]`
//     plugins/<plugin>/skills/*.md   one per `public.json :: plugins[]`,
//                                    skill files only
//
// The layout mirrors upstream so a diff against it is a plain path diff, and
// the MCP's skill discovery (`src/resources/skills.ts`, layout B: a `.md`
// whose parent directory is literally `skills`, walked four levels deep)
// picks both locations up. Plugin manifests, `instructions/AGENTS.md`,
// assets, `prompts/` and the upstream README are container-side mechanisms
// the MCP never reads, so they are not vendored.
//
// `public.json` is assumed to be `{ "skills": [...], "plugins": [...] }` —
// two allowlists of names. A commit without the file is an explicit failure
// (exit 2, `public_json_missing`), never a silent "vendor nothing".

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const UPSTREAM_REPO = "planetarium/agent8-skills";
/** Repo-relative, POSIX separators (messages and summaries print it as-is). */
export const VENDOR_REL = "skills-vendor/agent8-skills";
export const PUBLIC_JSON = "public.json";
/** Same rule as upstream's validator for skill and plugin names. */
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;

export class SyncError extends Error {
  /**
   * @param {string} code  stable, machine-readable (`public_json_missing`, …)
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// public.json
// ---------------------------------------------------------------------------

/**
 * Read and validate `<upstreamDir>/public.json`.
 *
 * @param {string} upstreamDir
 * @returns {{ skills: string[], plugins: string[], raw: string, warnings: string[] }}
 */
export function readPublicManifest(upstreamDir) {
  const abs = path.join(upstreamDir, PUBLIC_JSON);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new SyncError(
      "public_json_missing",
      `${PUBLIC_JSON} is missing from the upstream checkout (${upstreamDir}). ` +
        `This commit predates the public manifest, or it was removed; nothing is vendored without it.`,
    );
  }
  const raw = fs.readFileSync(abs, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new SyncError("public_json_invalid", `${PUBLIC_JSON} is not valid JSON: ${e.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SyncError(
      "public_json_invalid",
      `${PUBLIC_JSON} must be a JSON object with \`skills\` and \`plugins\` arrays`,
    );
  }
  const warnings = [];
  for (const key of Object.keys(data)) {
    if (key !== "skills" && key !== "plugins") {
      warnings.push(`${PUBLIC_JSON}: ignoring unknown key '${key}'`);
    }
  }
  const names = (key) => {
    const list = data[key];
    if (!Array.isArray(list)) {
      throw new SyncError("public_json_invalid", `${PUBLIC_JSON} :: '${key}' must be an array of names (may be empty)`);
    }
    const seen = new Set();
    const out = [];
    list.forEach((entry, i) => {
      if (typeof entry !== "string" || !NAME_RE.test(entry) || entry.length > MAX_NAME) {
        throw new SyncError(
          "public_json_invalid",
          `${PUBLIC_JSON} :: ${key}[${i}] must be a name matching ${NAME_RE} (max ${MAX_NAME} chars), got ${JSON.stringify(entry)}`,
        );
      }
      if (seen.has(entry)) {
        throw new SyncError("public_json_invalid", `${PUBLIC_JSON} :: ${key}[${i}] duplicates '${entry}'`);
      }
      seen.add(entry);
      out.push(entry);
    });
    return out;
  };
  return { skills: names("skills"), plugins: names("plugins"), raw, warnings };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

/** @typedef {{ rel: string, src?: string, content?: Buffer }} PlannedFile */

/**
 * Resolve the manifest against the upstream checkout into the exact list of
 * files the vendor tree will contain. Every problem is an error, not a skip:
 * a listed name that does not resolve means upstream and this repo disagree
 * about what is public, and that is for a human to settle.
 *
 * @param {string} upstreamDir
 * @param {{ skills: string[], plugins: string[], raw: string }} manifest
 * @returns {{ files: PlannedFile[], skillNames: string[], warnings: string[] }}
 */
export function planVendor(upstreamDir, manifest) {
  /** @type {PlannedFile[]} */
  const files = [];
  const warnings = [];
  /** skill name → rel path that claims it */
  const claimed = new Map();

  const claim = (skillName, rel) => {
    const prev = claimed.get(skillName);
    if (prev) {
      throw new SyncError(
        "skill_name_collision",
        `skill '${skillName}' is provided by both ${prev} and ${rel}; the MCP registers skills by name, so one would shadow the other`,
      );
    }
    claimed.set(skillName, rel);
  };

  for (const name of manifest.skills) {
    const rel = `skills/${name}.md`;
    const src = path.join(upstreamDir, rel);
    if (!isRegularFile(src)) {
      throw new SyncError("skill_missing", `${PUBLIC_JSON} lists skill '${name}' but ${rel} does not exist upstream`);
    }
    claim(name, rel);
    files.push({ rel, src });
  }

  for (const plugin of manifest.plugins) {
    const dirRel = `plugins/${plugin}`;
    const dir = path.join(upstreamDir, dirRel);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new SyncError("plugin_missing", `${PUBLIC_JSON} lists plugin '${plugin}' but ${dirRel}/ does not exist upstream`);
    }
    assertPluginEligible(dir, plugin);

    const skillsDir = path.join(dir, "skills");
    const entries = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.name.endsWith(".md"))
      : [];
    let count = 0;
    for (const entry of entries.sort((a, b) => byCodePoint(a.name, b.name))) {
      const rel = `${dirRel}/skills/${entry.name}`;
      const src = path.join(skillsDir, entry.name);
      if (!isRegularFile(src)) {
        throw new SyncError("plugin_skill_invalid", `${rel} is not a regular file (symlinks are not vendored)`);
      }
      const skillName = entry.name.slice(0, -3);
      if (!NAME_RE.test(skillName) || skillName.length > MAX_NAME) {
        throw new SyncError("plugin_skill_invalid", `${rel}: skill file name must match ${NAME_RE}`);
      }
      // Upstream rule: a plugin's skill files are `<plugin>.md` or
      // `<plugin>-*.md`. The file name is the skill name everywhere, so a
      // bare `tuning.md` would reach projects as `tuning` and collide.
      if (skillName !== plugin && !skillName.startsWith(`${plugin}-`)) {
        throw new SyncError(
          "plugin_skill_invalid",
          `${rel}: a plugin's skill files must be named '${plugin}.md' or '${plugin}-*.md'`,
        );
      }
      claim(skillName, rel);
      files.push({ rel, src });
      count += 1;
    }
    if (count === 0) {
      warnings.push(`plugin '${plugin}' is listed but ships no skills/*.md — nothing vendored for it`);
    }
  }

  files.push({ rel: PUBLIC_JSON, content: Buffer.from(manifest.raw, "utf8") });
  files.push({ rel: "README.md", content: Buffer.from(renderVendorReadme(), "utf8") });
  files.sort((a, b) => byCodePoint(a.rel, b.rel));

  return { files, skillNames: [...claimed.keys()].sort(byCodePoint), warnings };
}

/** Locale-independent ordering, so plans and summaries read the same on every machine. */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The MCP has no tag gate and no asset injection, so a plugin that relies on
 * either would misbehave for every project it reaches. Upstream's validator
 * refuses to list such a plugin in public.json; this is the receiving side's
 * own check so a validator gap upstream cannot ship through here.
 */
function assertPluginEligible(dir, plugin) {
  const manifestPath = path.join(dir, "plugin.json");
  if (!isRegularFile(manifestPath)) {
    throw new SyncError("plugin_invalid", `plugins/${plugin}/plugin.json is missing; a plugin without a manifest is not a plugin`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new SyncError("plugin_invalid", `plugins/${plugin}/plugin.json is not valid JSON: ${e.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new SyncError("plugin_invalid", `plugins/${plugin}/plugin.json must be a JSON object`);
  }
  if (Array.isArray(manifest.tags) && manifest.tags.length > 0) {
    throw new SyncError(
      "plugin_ineligible",
      `plugin '${plugin}' is tag-scoped (${manifest.tags.join(", ")}); the MCP has no tag gate, so it would reach every project`,
    );
  }
  const injected = (Array.isArray(manifest.assets) ? manifest.assets : [])
    .filter((a) => a && typeof a === "object")
    .filter((a) => a.target === "preview" || a.target === "publish");
  if (injected.length > 0) {
    throw new SyncError(
      "plugin_ineligible",
      `plugin '${plugin}' ships preview/publish assets (${injected.map((a) => String(a.file)).join(", ")}); the MCP cannot inject them`,
    );
  }
}

function isRegularFile(p) {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

export function renderVendorReadme() {
  return [
    "# agent8-skills (vendored)",
    "",
    `Generated by \`scripts/sync-agent8-skills.mjs\` from ${UPSTREAM_REPO}. Do not edit by hand —`,
    "the next sync rewrites this directory from scratch.",
    "",
    "Only what upstream's `public.json` lists is here (the file is copied alongside):",
    "",
    "- `skills/<name>.md` — top-level skills",
    "- `plugins/<plugin>/skills/*.md` — a public plugin's skill files, and nothing else of the plugin",
    "",
    "`package.json :: verse8.skillsVendor` pins the upstream commit (`upstream.commit`) and the",
    "content hash of this tree (`sha`, see `scripts/compute-subtree-sha.sh`).",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Snapshot every regular file under `dir` as rel path → bytes. Used to tell
 * "nothing changed" apart from "changed", independent of mtimes.
 *
 * @param {string} dir
 * @returns {Map<string, Buffer>}
 */
export function snapshotDir(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.set(path.relative(dir, abs).split(path.sep).join("/"), fs.readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

/**
 * Replace `<repoRoot>/skills-vendor/agent8-skills/` with the planned files.
 *
 * @param {string} repoRoot
 * @param {{ files: PlannedFile[] }} plan
 * @returns {{ changed: boolean, added: string[], removed: string[], modified: string[] }}
 */
export function vendorDirOf(repoRoot) {
  return path.join(repoRoot, ...VENDOR_REL.split("/"));
}

export function applyVendor(repoRoot, plan) {
  const vendorDir = vendorDirOf(repoRoot);
  const before = snapshotDir(vendorDir);
  const after = new Map();
  for (const f of plan.files) {
    after.set(f.rel, f.content ?? fs.readFileSync(f.src));
  }

  fs.rmSync(vendorDir, { recursive: true, force: true });
  for (const [rel, bytes] of after) {
    const abs = path.join(vendorDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }

  const added = [];
  const removed = [];
  const modified = [];
  for (const rel of after.keys()) {
    if (!before.has(rel)) added.push(rel);
    else if (!before.get(rel).equals(after.get(rel))) modified.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) removed.push(rel);
  }
  added.sort();
  removed.sort();
  modified.sort();
  return { changed: added.length + removed.length + modified.length > 0, added, removed, modified };
}

// ---------------------------------------------------------------------------
// pin
// ---------------------------------------------------------------------------

/**
 * `scripts/compute-subtree-sha.sh` is the one definition of the content
 * hash; it is invoked rather than re-implemented so the pin written here is
 * exactly what `check-subtree-sha.sh` will verify.
 */
export function computeVendorSha(repoRoot) {
  const script = path.join(repoRoot, "scripts", "compute-subtree-sha.sh");
  const res = spawnSync("bash", [script], { cwd: repoRoot, encoding: "utf8" });
  if (res.status !== 0) {
    throw new SyncError("sha_failed", `compute-subtree-sha.sh failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  const sha = res.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new SyncError("sha_failed", `compute-subtree-sha.sh printed something that is not a sha256: ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * @param {string} repoRoot
 * @returns {{ sha?: string, upstream?: { repo?: string, commit?: string } }}
 */
export function readPin(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const sv = pkg?.verse8?.skillsVendor;
  return sv && typeof sv === "object" ? sv : {};
}

/**
 * Rewrite `verse8.skillsVendor` in package.json, keeping the file's two-space
 * formatting and trailing newline.
 *
 * @param {string} repoRoot
 * @param {{ sha: string, commit?: string }} pin
 */
export function writePin(repoRoot, pin) {
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.verse8 ??= {};
  const prev = pkg.verse8.skillsVendor ?? {};
  const next = { ...prev, sha: pin.sha };
  if (pin.commit) next.upstream = { repo: UPSTREAM_REPO, commit: pin.commit };
  pkg.verse8.skillsVendor = next;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SyncResult
 * @property {boolean} changed
 * @property {string[]} added
 * @property {string[]} removed
 * @property {string[]} modified
 * @property {string[]} warnings
 * @property {string[]} skillNames
 * @property {{ skills: number, plugins: number }} manifest
 * @property {string | undefined} commit        upstream commit recorded (as given)
 * @property {string | undefined} previousCommit
 * @property {string | undefined} sha           new content hash (only when changed)
 * @property {string | undefined} previousSha
 */

/**
 * @param {{ repoRoot: string, upstreamDir: string, commit?: string, dryRun?: boolean }} opts
 * @returns {SyncResult}
 */
export function sync({ repoRoot, upstreamDir, commit, dryRun = false }) {
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) {
    throw new SyncError("bad_commit", `--commit must be a full 40-hex sha, got ${JSON.stringify(commit)}`);
  }
  const manifest = readPublicManifest(upstreamDir);
  const plan = planVendor(upstreamDir, manifest);
  const warnings = [...manifest.warnings, ...plan.warnings];
  const previous = readPin(repoRoot);
  const base = {
    warnings,
    skillNames: plan.skillNames,
    manifest: { skills: manifest.skills.length, plugins: manifest.plugins.length },
    commit,
    previousCommit: previous.upstream?.commit,
    previousSha: previous.sha,
  };

  if (dryRun) {
    const before = snapshotDir(vendorDirOf(repoRoot));
    const added = [];
    const modified = [];
    for (const f of plan.files) {
      const bytes = f.content ?? fs.readFileSync(f.src);
      if (!before.has(f.rel)) added.push(f.rel);
      else if (!before.get(f.rel).equals(bytes)) modified.push(f.rel);
    }
    const planned = new Set(plan.files.map((f) => f.rel));
    const removed = [...before.keys()].filter((rel) => !planned.has(rel)).sort();
    return { ...base, changed: added.length + removed.length + modified.length > 0, added, removed, modified, sha: undefined };
  }

  const diff = applyVendor(repoRoot, plan);
  if (!diff.changed) {
    return { ...base, ...diff, sha: undefined };
  }
  const sha = computeVendorSha(repoRoot);
  writePin(repoRoot, { sha, commit });
  return { ...base, ...diff, sha };
}

/** Markdown summary for the PR body / commit message. */
export function renderSummary(result) {
  const lines = [];
  lines.push(
    `public.json: ${result.manifest.skills} skill(s), ${result.manifest.plugins} plugin(s) → ${result.skillNames.length} skill file(s) vendored`,
  );
  const section = (title, items) => {
    if (items.length === 0) return;
    lines.push("", `${title} (${items.length}):`);
    for (const rel of items) lines.push(`- \`${rel}\``);
  };
  section("Added", result.added);
  section("Modified", result.modified);
  section("Removed", result.removed);
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { upstream: undefined, commit: undefined, repoRoot: undefined, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new SyncError("usage", `${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "--upstream") opts.upstream = next();
    else if (a === "--commit") opts.commit = next();
    else if (a === "--repo-root") opts.repoRoot = next();
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "usage: node scripts/sync-agent8-skills.mjs --upstream <agent8-skills checkout> [--commit <40-hex sha>] [--repo-root <dir>] [--dry-run] [--json]",
      );
      process.exit(0);
    } else throw new SyncError("usage", `unknown argument ${a}`);
  }
  if (!opts.upstream) throw new SyncError("usage", "--upstream <dir> is required");
  return opts;
}

function appendGithubOutput(result) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const delimiter = `__SYNC_${Date.now()}__`;
  fs.appendFileSync(
    out,
    [
      `changed=${result.changed ? "true" : "false"}`,
      `sha=${result.sha ?? ""}`,
      `previous_sha=${result.previousSha ?? ""}`,
      `previous_commit=${result.previousCommit ?? ""}`,
      `summary<<${delimiter}`,
      renderSummary(result),
      delimiter,
      "",
    ].join("\n"),
  );
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`sync-agent8-skills: ${e.message}`);
    process.exit(2);
  }
  const repoRoot = path.resolve(opts.repoRoot ?? path.join(here, ".."));
  const upstreamDir = path.resolve(opts.upstream);
  try {
    const result = sync({ repoRoot, upstreamDir, commit: opts.commit, dryRun: opts.dryRun });
    for (const w of result.warnings) console.error(`sync-agent8-skills: warning: ${w}`);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.changed ? `sync-agent8-skills: ${VENDOR_REL} changed` : `sync-agent8-skills: ${VENDOR_REL} unchanged — nothing to do`);
      console.log(renderSummary(result));
      if (result.changed && !opts.dryRun) console.log(`verse8.skillsVendor.sha: ${result.previousSha ?? "(none)"} → ${result.sha}`);
    }
    appendGithubOutput(result);
    process.exit(0);
  } catch (e) {
    if (e instanceof SyncError) {
      const msg = `sync-agent8-skills: ${e.code}: ${e.message}`;
      console.error(process.env.GITHUB_ACTIONS ? `::error::${msg}` : msg);
      process.exit(2);
    }
    throw e;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
