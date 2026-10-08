import * as fs from "node:fs";
import * as path from "node:path";
import { type SkillResource } from "./skills.js";

/**
 * Per-project plugin activation for vendored agent8-skills plugins.
 *
 * Same rules as the Agent8 container (agent8-skills `plugins/README.md`,
 * "Package scoping"), so a project sees the same skills and instructions
 * through the MCP as it does on the platform:
 *
 *   - A plugin without `plugin.json`, or with one that is not a JSON object,
 *     is not a plugin — inactive.
 *   - `requiresPackage` absent or `[]` → no gate, always active.
 *   - Otherwise active iff the project's `package.json` lists one of the
 *     packages under `dependencies` or `devDependencies` (OR).
 *   - A malformed `requiresPackage` (not an array, too many entries, an entry
 *     that is not an npm package name) → inactive. A scope nobody can read
 *     must never degrade into "applies to everyone".
 *   - Non-empty `tags` → inactive. The MCP has no tag source; the sync
 *     already refuses to vendor such a plugin, this is the fail-closed backstop.
 *
 * A missing or unreadable `package.json` is an empty dependency set, which
 * leaves every package-scoped plugin inactive — as in the container before
 * the first mount. Top-level skills (no `plugin`) are always active.
 */

/** Upstream validator's rules for `requiresPackage` entries. */
const PACKAGE_RE = /^(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/;
const MAX_PACKAGES = 16;
const MAX_PACKAGE_LEN = 214;

export type PluginGateReason =
  | "ungated"
  | "dependency"
  | "no_dependency"
  | "manifest_missing"
  | "manifest_invalid"
  | "requires_package_invalid"
  | "tag_scoped";

export interface PluginStatus {
  name: string;
  active: boolean;
  reason: PluginGateReason;
  /** The gate as declared; empty when the plugin is ungated or unreadable. */
  requiresPackage: string[];
  /** Dependencies that satisfied the gate (only for reason `dependency`). */
  matched?: string[];
  /** `instructions/AGENTS.md`, when the plugin ships one. */
  instructions?: string;
}

export interface ProjectDependencies {
  /** Where the set came from — `missing`/`invalid` yield an empty set. */
  source: "package.json" | "missing" | "invalid";
  names: Set<string>;
}

export interface ProjectSkillSelection {
  dependencies: ProjectDependencies;
  plugins: PluginStatus[];
  /** Skills to install and list: top-level ones plus active plugins' ones. */
  active: SkillResource[];
  /** Skills of inactive plugins — never installed, cleaned up when ours. */
  inactive: SkillResource[];
}

/** `dependencies` ∪ `devDependencies` keys of `<projectDir>/package.json`. */
// INV-12: The plugin package gate fails closed
export function readProjectDependencies(projectDir: string): ProjectDependencies {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectDir, "package.json"), "utf8");
  } catch {
    return { source: "missing", names: new Set() };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { source: "invalid", names: new Set() };
  }
  if (!isPlainObject(pkg)) return { source: "invalid", names: new Set() };
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[key];
    if (isPlainObject(deps)) for (const name of Object.keys(deps)) names.add(name);
  }
  return { source: "package.json", names };
}

/**
 * Decide one plugin from its parsed `plugin.json` (`undefined` = file
 * missing, `null` = not valid JSON) and the project's dependency set.
 */
// INV-12: The plugin package gate fails closed
export function evaluatePlugin(
  name: string,
  manifest: unknown,
  dependencies: Set<string>,
): Omit<PluginStatus, "instructions"> {
  const inactive = (reason: PluginGateReason, requiresPackage: string[] = []) => ({
    name,
    active: false,
    reason,
    requiresPackage,
  });
  if (manifest === undefined) return inactive("manifest_missing");
  if (!isPlainObject(manifest)) return inactive("manifest_invalid");
  if (manifest.tags !== undefined && !(Array.isArray(manifest.tags) && manifest.tags.length === 0)) {
    return inactive("tag_scoped");
  }
  const declared = manifest.requiresPackage;
  if (declared === undefined) return { name, active: true, reason: "ungated", requiresPackage: [] };
  if (
    !Array.isArray(declared) ||
    declared.length > MAX_PACKAGES ||
    !declared.every((p) => typeof p === "string" && p.length <= MAX_PACKAGE_LEN && PACKAGE_RE.test(p))
  ) {
    return inactive("requires_package_invalid");
  }
  const packages = declared as string[];
  if (packages.length === 0) return { name, active: true, reason: "ungated", requiresPackage: [] };
  const matched = packages.filter((p) => dependencies.has(p));
  if (matched.length === 0) return inactive("no_dependency", packages);
  return { name, active: true, reason: "dependency", requiresPackage: packages, matched };
}

/** Read `plugins/<name>/` from disk and evaluate it. */
export function loadPluginStatus(
  name: string,
  pluginDir: string,
  dependencies: Set<string>,
): PluginStatus {
  let manifest: unknown;
  try {
    const raw = fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8");
    try {
      manifest = JSON.parse(raw);
    } catch {
      manifest = null;
    }
  } catch {
    manifest = undefined;
  }
  const status: PluginStatus = evaluatePlugin(name, manifest, dependencies);
  try {
    const instructions = fs.readFileSync(path.join(pluginDir, "instructions", "AGENTS.md"), "utf8");
    if (instructions.trim().length > 0) status.instructions = instructions;
  } catch {
    /* optional */
  }
  return status;
}

/**
 * Split discovered skills into what a project gets and what it does not.
 *
 * `pluginsRoot` is scanned for every vendored plugin so an instructions-only
 * plugin (no skills) is still reported and composed; plugins that only show
 * up through a skill's `pluginDir` are added on top.
 */
export function selectProjectSkills(
  skills: SkillResource[],
  projectDir: string,
  pluginsRoot?: string,
): ProjectSkillSelection {
  const dependencies = readProjectDependencies(projectDir);
  const dirs = new Map<string, string>();
  if (pluginsRoot) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
      /* no plugins vendored */
    }
    for (const e of entries) {
      if (e.isDirectory()) dirs.set(e.name, path.join(pluginsRoot, e.name));
    }
  }
  for (const s of skills) {
    if (s.plugin && s.pluginDir && !dirs.has(s.plugin)) dirs.set(s.plugin, s.pluginDir);
  }

  const plugins = [...dirs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, dir]) => loadPluginStatus(name, dir, dependencies.names));
  const activeNames = new Set(plugins.filter((p) => p.active).map((p) => p.name));

  const active: SkillResource[] = [];
  const inactive: SkillResource[] = [];
  for (const s of skills) {
    if (!s.plugin || activeNames.has(s.plugin)) active.push(s);
    else inactive.push(s);
  }
  return { dependencies, plugins, active, inactive };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
