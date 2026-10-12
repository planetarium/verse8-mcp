// Plugin activation for vendored agent8-skills plugins.
//
// Pins the MCP to the Agent8 container's "Package scoping" rules
// (agent8-skills plugins/README.md): no requiresPackage → always active,
// requiresPackage → active iff package.json dependencies/devDependencies list
// one of them (OR), malformed → inactive (never "applies to everyone").
// Top-level skills are always active. Then checks verse8_attach end to end:
// only active skills are installed and listed, active plugins' instructions
// are composed into AGENTS.md, and our unedited copies of inactive plugins'
// skills are removed while user-owned ones stay.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  evaluatePlugin,
  readProjectDependencies,
  selectProjectSkills,
} from "../../dist/resources/pluginGate.js";
import { renderPluginInstructions } from "../../dist/resources/skillCatalog.js";
import { applyAttachmentArtifacts } from "../../dist/tools/attach.js";
import { addHashMarker } from "../../dist/tools/skillWriter.js";

function scratch(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(root, rel, body) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function pkg(deps = {}, devDeps = {}) {
  return JSON.stringify({ name: "game", dependencies: deps, devDependencies: devDeps });
}

// ---------------------------------------------------------------------------
// evaluatePlugin — the decision table
// ---------------------------------------------------------------------------

const DEPS = new Set(["react", "@react-three/fiber", "vibe-starter-3d"]);

const CASES = [
  // [label, manifest, active, reason]
  ["no requiresPackage", { version: 1, assets: [] }, true, "ungated"],
  ["empty requiresPackage", { version: 1, requiresPackage: [], assets: [] }, true, "ungated"],
  ["empty tags", { version: 1, tags: [], assets: [] }, true, "ungated"],
  ["dependency present", { version: 1, requiresPackage: ["@react-three/fiber"] }, true, "dependency"],
  ["any one of several (OR)", { version: 1, requiresPackage: ["incanto", "vibe-starter-3d"] }, true, "dependency"],
  ["dependency absent", { version: 1, requiresPackage: ["incanto"] }, false, "no_dependency"],
  ["string instead of array", { version: 1, requiresPackage: "@react-three/fiber" }, false, "requires_package_invalid"],
  ["object instead of array", { version: 1, requiresPackage: { name: "react" } }, false, "requires_package_invalid"],
  ["null", { version: 1, requiresPackage: null }, false, "requires_package_invalid"],
  ["non-string entry", { version: 1, requiresPackage: ["react", 1] }, false, "requires_package_invalid"],
  ["not a package name", { version: 1, requiresPackage: ["React Three"] }, false, "requires_package_invalid"],
  ["uppercase name", { version: 1, requiresPackage: ["React"] }, false, "requires_package_invalid"],
  [
    "more than 16 entries",
    { version: 1, requiresPackage: [...Array.from({ length: 16 }, (_, i) => `p${i}`), "react"] },
    false,
    "requires_package_invalid",
  ],
  ["tag-scoped", { version: 1, tags: ["MSU"] }, false, "tag_scoped"],
  ["malformed tags", { version: 1, tags: "MSU" }, false, "tag_scoped"],
  ["manifest not an object", ["react"], false, "manifest_invalid"],
  ["manifest unparseable (null)", null, false, "manifest_invalid"],
  ["manifest missing", undefined, false, "manifest_missing"],
];

// INV-12: The plugin package gate fails closed
for (const [label, manifest, active, reason] of CASES) {
  test(`evaluatePlugin: ${label} → ${active ? "active" : "inactive"} (${reason})`, () => {
    const status = evaluatePlugin("p", manifest, DEPS);
    assert.equal(status.active, active);
    assert.equal(status.reason, reason);
  });
}

test("evaluatePlugin: reports which dependencies matched", () => {
  const status = evaluatePlugin("p", { requiresPackage: ["incanto", "react", "vibe-starter-3d"] }, DEPS);
  assert.deepEqual(status.matched, ["react", "vibe-starter-3d"]);
  assert.deepEqual(status.requiresPackage, ["incanto", "react", "vibe-starter-3d"]);
});

// ---------------------------------------------------------------------------
// readProjectDependencies
// ---------------------------------------------------------------------------

test("readProjectDependencies: dependencies ∪ devDependencies; peer/optional ignored", () => {
  const dir = scratch("verse8-gate-deps-");
  try {
    write(
      dir,
      "package.json",
      JSON.stringify({
        dependencies: { react: "^19" },
        devDependencies: { vite: "^6" },
        peerDependencies: { incanto: "*" },
        optionalDependencies: { "vibe-starter-3d": "*" },
      }),
    );
    const deps = readProjectDependencies(dir);
    assert.equal(deps.source, "package.json");
    assert.deepEqual([...deps.names].sort(), ["react", "vite"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// INV-12: The plugin package gate fails closed
test("readProjectDependencies: missing, unparseable, or non-object package.json → empty set", () => {
  const dir = scratch("verse8-gate-deps-");
  try {
    assert.deepEqual(readProjectDependencies(dir), { source: "missing", names: new Set() });
    write(dir, "package.json", "{ nope");
    assert.deepEqual(readProjectDependencies(dir), { source: "invalid", names: new Set() });
    write(dir, "package.json", "[]");
    assert.deepEqual(readProjectDependencies(dir), { source: "invalid", names: new Set() });
    write(dir, "package.json", JSON.stringify({ dependencies: ["react"] }));
    assert.deepEqual(readProjectDependencies(dir), { source: "package.json", names: new Set() });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// selectProjectSkills — fixture vendor tree
// ---------------------------------------------------------------------------

/** A vendor tree shaped like skills-vendor/agent8-skills with one plugin per rule. */
function seedVendor(root) {
  const skill = (rel, name, plugin) => ({
    uri: `verse8://skill/${name}/SKILL.md`,
    name,
    mimeType: "text/markdown",
    fsPath: write(root, rel, `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`),
    ...(plugin ? { plugin, pluginDir: path.join(root, "plugins", plugin) } : {}),
  });
  write(root, "plugins/gameserver/plugin.json", '{ "version": 1, "assets": [] }\n');
  write(root, "plugins/gameserver/instructions/AGENTS.md", "## GameServer rules\n");
  write(root, "plugins/r3f/plugin.json", '{ "version": 1, "requiresPackage": ["@react-three/fiber"], "assets": [] }\n');
  write(root, "plugins/r3f/instructions/AGENTS.md", "## R3F rules\n");
  write(root, "plugins/incanto/plugin.json", '{ "version": 1, "requiresPackage": ["incanto"], "assets": [] }\n');
  write(root, "plugins/incanto/instructions/AGENTS.md", "## Incanto rules\n");
  write(root, "plugins/broken/plugin.json", '{ "version": 1, "requiresPackage": "incanto", "assets": [] }\n');
  write(root, "plugins/no-manifest/skills/no-manifest.md", "# orphan\n");
  write(root, "plugins/notes/plugin.json", '{ "version": 1, "assets": [] }\n');
  write(root, "plugins/notes/instructions/AGENTS.md", "## Notes rules\n");
  return [
    skill("skills/leaderboard-impl.md", "leaderboard-impl"),
    skill("plugins/gameserver/skills/gameserver-sdk.md", "gameserver-sdk", "gameserver"),
    skill("plugins/r3f/skills/r3f-tree.md", "r3f-tree", "r3f"),
    skill("plugins/incanto/skills/incanto-hud.md", "incanto-hud", "incanto"),
    skill("plugins/broken/skills/broken.md", "broken", "broken"),
    skill("plugins/no-manifest/skills/no-manifest.md", "no-manifest", "no-manifest"),
  ];
}

function withVendorAndProject(fn) {
  const vendor = scratch("verse8-gate-vendor-");
  const project = scratch("verse8-gate-project-");
  try {
    return fn(seedVendor(vendor), path.join(vendor, "plugins"), project);
  } finally {
    fs.rmSync(vendor, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

const names = (skills) => skills.map((s) => s.name).sort();

test("selectProjectSkills: an R3F project gets top-level + ungated + r3f, not incanto", () => {
  withVendorAndProject((skills, pluginsRoot, project) => {
    write(project, "package.json", pkg({ "@react-three/fiber": "^9" }));
    const sel = selectProjectSkills(skills, project, pluginsRoot);
    assert.deepEqual(names(sel.active), ["gameserver-sdk", "leaderboard-impl", "r3f-tree"]);
    assert.deepEqual(names(sel.inactive), ["broken", "incanto-hud", "no-manifest"]);
    assert.deepEqual(
      sel.plugins.map((p) => [p.name, p.active, p.reason]),
      [
        ["broken", false, "requires_package_invalid"],
        ["gameserver", true, "ungated"],
        ["incanto", false, "no_dependency"],
        ["no-manifest", false, "manifest_missing"],
        ["notes", true, "ungated"],
        ["r3f", true, "dependency"],
      ],
    );
  });
});

test("selectProjectSkills: devDependencies count too", () => {
  withVendorAndProject((skills, pluginsRoot, project) => {
    write(project, "package.json", pkg({}, { incanto: "^1" }));
    const sel = selectProjectSkills(skills, project, pluginsRoot);
    assert.deepEqual(names(sel.active), ["gameserver-sdk", "incanto-hud", "leaderboard-impl"]);
  });
});

test("selectProjectSkills: no package.json → only ungated plugins and top-level skills", () => {
  withVendorAndProject((skills, pluginsRoot, project) => {
    const sel = selectProjectSkills(skills, project, pluginsRoot);
    assert.equal(sel.dependencies.source, "missing");
    assert.deepEqual(names(sel.active), ["gameserver-sdk", "leaderboard-impl"]);
  });
});

test("selectProjectSkills: a plugin that only shows up through a skill's pluginDir is still judged", () => {
  withVendorAndProject((skills, _pluginsRoot, project) => {
    write(project, "package.json", pkg({ incanto: "^1" }));
    const sel = selectProjectSkills(skills, project);
    assert.deepEqual(names(sel.active), ["gameserver-sdk", "incanto-hud", "leaderboard-impl"]);
    assert.ok(!sel.plugins.some((p) => p.name === "notes"), "no pluginsRoot → instructions-only plugin unseen");
  });
});

test("renderPluginInstructions: active plugins only, in name order, instructions-only plugins included", () => {
  withVendorAndProject((skills, pluginsRoot, project) => {
    write(project, "package.json", pkg({ "@react-three/fiber": "^9" }));
    const sel = selectProjectSkills(skills, project, pluginsRoot);
    assert.equal(
      renderPluginInstructions(sel.plugins),
      "## GameServer rules\n\n## Notes rules\n\n## R3F rules\n",
    );
    assert.equal(renderPluginInstructions([]), "");
  });
});

// ---------------------------------------------------------------------------
// verse8_attach end to end, against the real vendored tree
// ---------------------------------------------------------------------------

function attachFixture(packageJson) {
  const root = scratch("verse8-gate-attach-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (packageJson !== undefined) write(root, "package.json", packageJson);
  return root;
}

function installed(root) {
  const dir = path.join(root, ".claude", "skills");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

test("attach: an R3F project gets r3f skills and instructions, no incanto / vibe-starter-3d", () => {
  const root = attachFixture(pkg({ "@react-three/fiber": "^9", "@agent8/gameserver": "^1" }));
  try {
    const r = applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    const skills = installed(root);
    assert.ok(skills.includes("r3f-tree"), "r3f skill installed");
    assert.ok(skills.includes("gameserver-sdk"), "ungated plugin skill installed");
    assert.ok(skills.includes("leaderboard-impl"), "top-level skill installed");
    assert.ok(skills.includes("verse8-login"), "core skill installed");
    for (const s of skills) {
      assert.ok(!s.startsWith("incanto") && !s.startsWith("vibe-starter-3d"), `${s} must not be installed`);
    }
    assert.deepEqual(
      r.skillPlugins.active.map((p) => p.name),
      ["gameserver", "localization", "r3f"],
    );
    assert.deepEqual(r.skillPlugins.active.find((p) => p.name === "r3f").matched, ["@react-three/fiber"]);
    assert.deepEqual(
      r.skillPlugins.inactive.map((p) => [p.name, p.reason]),
      [
        ["incanto", "no_dependency"],
        ["vibe-starter-3d", "no_dependency"],
        ["vibe-starter-3d-environment", "no_dependency"],
      ],
    );

    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), agents);
    assert.match(agents, /\| `r3f-tree` \|/);
    assert.doesNotMatch(agents, /`incanto-/);
    assert.match(agents, /## React Three Fiber Projects/);
    assert.match(agents, /## Server Logic & GameServer SDK Skills/);
    assert.doesNotMatch(agents, /## Incanto Projects/);
    assert.doesNotMatch(agents, /\{\{SKILLS_CATALOG\}\}/);
    // Instructions come after the catalog table.
    assert.ok(agents.indexOf("## React Three Fiber Projects") > agents.indexOf("| `r3f-tree` |"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// INV-6: Skills outside the bundle are never touched
test("attach: removing a dependency retires our copies of that plugin's skills, keeps user-owned ones", () => {
  const root = attachFixture(pkg({ incanto: "^1" }));
  try {
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    assert.ok(installed(root).includes("incanto-hud"));
    assert.ok(installed(root).includes("incanto-editor"));

    // User edits one copy and adds a note next to another.
    const edited = path.join(root, ".claude", "skills", "incanto-hud", "SKILL.md");
    fs.appendFileSync(edited, "\nmy notes\n");
    write(root, ".claude/skills/incanto-audio/NOTES.md", "mine\n");
    // A user-written skill that happens to share a plugin skill's name.
    fs.rmSync(path.join(root, ".claude", "skills", "incanto-editor"), { recursive: true });
    write(root, ".claude/skills/incanto-editor/SKILL.md", "# my own, no marker\n");

    write(root, "package.json", pkg({ "@react-three/fiber": "^9" }));
    const r = applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });

    const skills = installed(root);
    assert.ok(skills.includes("incanto-hud"), "user-edited copy stays");
    assert.ok(skills.includes("incanto-editor"), "user-written skill stays");
    assert.ok(skills.includes("incanto-audio"), "dir with a user file stays");
    assert.ok(!fs.existsSync(path.join(root, ".claude", "skills", "incanto-audio", "SKILL.md")), "our file in it goes");
    assert.ok(!skills.includes("incanto-assets"), "unedited copy is removed");
    assert.ok(skills.includes("r3f-tree"));
    assert.ok(r.skills.deactivated.includes("incanto-assets"));
    assert.ok(r.skills.deactivated.includes("incanto-audio"));
    assert.ok(!r.skills.deactivated.includes("incanto-hud"));
    assert.ok(!r.skills.deactivated.includes("incanto-editor"));
    assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /## Incanto Projects/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attach: a failure after the skills step restores retired skills", () => {
  const root = attachFixture(pkg({ incanto: "^1" }));
  try {
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    const file = path.join(root, ".claude", "skills", "incanto-assets", "SKILL.md");
    const before = fs.readFileSync(file, "utf8");
    assert.equal(addHashMarker(before), before, "fixture copy carries our marker");

    write(root, "package.json", pkg({}));
    assert.throws(
      () => applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null, __failAfter: "env" }),
      /__failAfter:env/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// INV-6: Skills outside the bundle are never touched
test("attach: dependency removed → restored → attach fails: the user's file in the skill folder survives", () => {
  const root = attachFixture(pkg({ incanto: "^1" }));
  const skillDir = path.join(root, ".claude", "skills", "incanto-audio");
  const notes = path.join(skillDir, "NOTES.md");
  const skillFile = path.join(skillDir, "SKILL.md");
  try {
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    fs.writeFileSync(notes, "mine\n");

    // Dependency removed: our SKILL.md is retired, the folder stays for NOTES.md.
    write(root, "package.json", pkg({}));
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    assert.ok(!fs.existsSync(skillFile));
    assert.equal(fs.readFileSync(notes, "utf8"), "mine\n");

    // Dependency restored, but a later step fails: SKILL.md is "created" in a
    // folder this run did not create, so the rollback removes only SKILL.md.
    write(root, "package.json", pkg({ incanto: "^1" }));
    assert.throws(
      () => applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null, __failAfter: "env" }),
      /__failAfter:env/,
    );
    assert.equal(fs.readFileSync(notes, "utf8"), "mine\n", "user file kept through the rollback");
    assert.ok(!fs.existsSync(skillFile), "this run's SKILL.md rolled back");

    // And the next successful attach reinstalls next to it.
    const r = applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    assert.ok(r.skills.created.includes("incanto-audio"));
    assert.ok(fs.existsSync(skillFile));
    assert.equal(fs.readFileSync(notes, "utf8"), "mine\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attach: a failed first attach leaves no .claude/ behind; a failed overwriteAll restores the user's edit", () => {
  const root = attachFixture(pkg({ incanto: "^1" }));
  try {
    assert.throws(
      () => applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null, __failAfter: "env" }),
      /__failAfter:env/,
    );
    assert.ok(!fs.existsSync(path.join(root, ".claude")), "everything this run created is gone");

    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    const file = path.join(root, ".claude", "skills", "incanto-hud", "SKILL.md");
    fs.appendFileSync(file, "\nmy edit\n");
    const edited = fs.readFileSync(file, "utf8");
    assert.throws(
      () =>
        applyAttachmentArtifacts(root, {
          overwrite: true,
          walletAddress: null,
          overwriteAllSkills: true,
          __failAfter: "env",
        }),
      /__failAfter:env/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), edited);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Every `.SKILL.md.verse8-tmp-*` left anywhere under .claude/skills. */
function leftoverTempFiles(root) {
  const skillsDir = path.join(root, ".claude", "skills");
  const out = [];
  for (const name of fs.readdirSync(skillsDir)) {
    const dir = path.join(skillsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.includes(".verse8-tmp-")) out.push(`${name}/${f}`);
  }
  return out;
}

// INV-6: Skills outside the bundle are never touched
test("attach: a write that throws halfway through the skills still rolls back the ones already overwritten", () => {
  const root = attachFixture(pkg({ incanto: "^1" }));
  try {
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    const skills = path.join(root, ".claude", "skills");
    const edited = path.join(skills, "incanto-hud", "SKILL.md");
    fs.appendFileSync(edited, "\nmy edit\n");
    const editedBytes = fs.readFileSync(edited);
    // A later skill (by URI order) cannot be written: its SKILL.md is a
    // non-empty directory, so the rename onto it throws mid-loop.
    const blocked = path.join(skills, "incanto-your-first-game", "SKILL.md");
    fs.rmSync(blocked);
    write(root, ".claude/skills/incanto-your-first-game/SKILL.md/keep", "x\n");

    assert.throws(() =>
      applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null, overwriteAllSkills: true }),
    );

    assert.deepEqual(fs.readFileSync(edited), editedBytes, "the earlier overwrite is rolled back");
    assert.ok(fs.statSync(blocked).isDirectory(), "the blocker is untouched");
    assert.deepEqual(leftoverTempFiles(root), [], "no temp file is left behind");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attach: rollback restores the exact bytes and mode of overwritten and retired SKILL.md files", () => {
  const root = attachFixture(pkg({ incanto: "^1", "@react-three/fiber": "^9" }));
  try {
    applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    const skills = path.join(root, ".claude", "skills");
    // Overwritten: not valid UTF-8, mode changed by the user.
    const overwritten = path.join(skills, "r3f-tree", "SKILL.md");
    const notUtf8 = Buffer.concat([Buffer.from("# mine\n"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]), Buffer.from("\n")]);
    fs.writeFileSync(overwritten, notUtf8);
    fs.chmodSync(overwritten, 0o640);
    // Retired: our unedited copy, mode changed by the user.
    const retired = path.join(skills, "incanto-hud", "SKILL.md");
    const retiredBytes = fs.readFileSync(retired);
    fs.chmodSync(retired, 0o600);
    const modes = { overwritten: fs.statSync(overwritten).mode & 0o777, retired: fs.statSync(retired).mode & 0o777 };

    write(root, "package.json", pkg({ "@react-three/fiber": "^9" }));
    assert.throws(
      () =>
        applyAttachmentArtifacts(root, {
          overwrite: true,
          walletAddress: null,
          overwriteAllSkills: true,
          __failAfter: "env",
        }),
      /__failAfter:env/,
    );

    assert.deepEqual(fs.readFileSync(overwritten), notUtf8);
    assert.deepEqual(fs.readFileSync(retired), retiredBytes);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(overwritten).mode & 0o777, modes.overwritten);
      assert.equal(fs.statSync(retired).mode & 0o777, modes.retired);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// INV-12: The plugin package gate fails closed
test("attach: a project with no package.json gets no package-scoped plugin", () => {
  const root = attachFixture(undefined);
  try {
    const r = applyAttachmentArtifacts(root, { overwrite: true, walletAddress: null });
    assert.equal(r.skillPlugins.dependencies, "missing");
    assert.deepEqual(r.skillPlugins.active.map((p) => p.name), ["gameserver", "localization"]);
    assert.ok(!installed(root).some((s) => s.startsWith("r3f-") || s.startsWith("incanto-")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
