#!/usr/bin/env node
// Builds the seed projects every run starts from.
//
// For each seed in config.SEEDS:
//   1. copy the template directory out of agent8-templates at the pinned ref
//   1b. apply the seed's patch, if any (config.SEEDS[id].patch)
//   2. register the shared asset set (same keys and URLs in every arm)
//   3. `bun install` once and keep the lockfile, so runs install frozen
//   4. git init with a gitlab.verse8.io origin (the pre-commit hook demands
//      it) whose push URL is local — nothing ever reaches GitLab
//   5. verse8_attach (runAttach from this repo's dist/) with overwriteAgentsDoc
//   6. check the attached plugins against the arm's expectation
//   7. commit everything (lockfile included) and tag it `seed`
//
// Writes eval/seeds/seeds.json with what was built. Re-running rebuilds from
// scratch. Usage: node eval/seeds/build-seeds.mjs [seedId...]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ARMS,
  CACHE_DIR,
  FAKE_ORIGIN,
  OFFLINE_ACCOUNT,
  REPO_DIR,
  SEEDS,
  SEEDS_DIR,
  TEMPLATES_DIR,
  TEMPLATES_REPO,
} from "../config.mjs";
import { makeAssets } from "../assets/make-assets.mjs";
import { SHARED_ASSETS, SHARED_ASSET_DIR } from "../assets/shared-assets.mjs";

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

function ensureTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    sh("gh", ["repo", "clone", TEMPLATES_REPO, TEMPLATES_DIR, "--", "--filter=blob:none", "-q"]);
  }
  for (const s of Object.values(SEEDS)) {
    try {
      sh("git", ["-C", TEMPLATES_DIR, "cat-file", "-e", `${s.ref}^{commit}`]);
    } catch {
      sh("git", ["-C", TEMPLATES_DIR, "fetch", "-q", "origin"]);
    }
  }
}

function extractTemplate(ref, template, dest) {
  const tmp = fs.mkdtempSync(path.join(CACHE_DIR, "extract-"));
  const tar = path.join(tmp, "t.tar");
  sh("git", ["-C", TEMPLATES_DIR, "archive", "-o", tar, ref, template]);
  sh("tar", ["-xf", tar, "-C", tmp]);
  fs.renameSync(path.join(tmp, template), dest);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Adds the shared entries without touching the template's own ones, so the
// template still boots. Returns the template's original category keys for
// the record (the per-arm difference the report has to mention).
function registerSharedAssets(dir) {
  const file = path.join(dir, "src", "assets.json");
  const assets = JSON.parse(fs.readFileSync(file, "utf8"));
  const original = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, Object.keys(v)]));
  for (const [category, entries] of Object.entries(SHARED_ASSETS)) {
    assets[category] = { ...(assets[category] ?? {}), ...entries };
  }
  fs.writeFileSync(file, JSON.stringify(assets, null, 2) + "\n");
  makeAssets(path.join(dir, "public", SHARED_ASSET_DIR));
  return original;
}

// Removes `shadowMapSize` from the DirectionalLight3D in the template's scenes
// so the engine's default (2048) applies. Text edit, so the seed diff is that
// one line; the parsed result is checked. Returns the files changed.
function patchSunShadowMapSize(dir) {
  const changed = [];
  const lights = (n, out = []) => {
    if (n.type === "DirectionalLight3D") out.push(n);
    for (const c of n.children ?? []) lights(c, out);
    return out;
  };
  for (const f of fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".scene.json"))) {
    const file = path.join(dir, "src", f);
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(/,\s*"shadowMapSize":\s*\d+/g, "");
    if (after === before) continue;
    const scene = JSON.parse(after);
    const removed = (before.match(/"shadowMapSize"/g) ?? []).length;
    const suns = lights(JSON.parse(before).root).filter((n) => n.props && "shadowMapSize" in n.props).length;
    if (removed !== suns || lights(scene.root).some((n) => n.props && "shadowMapSize" in n.props))
      throw new Error(`${file}: shadowMapSize found outside DirectionalLight3D props`);
    fs.writeFileSync(file, after);
    changed.push(`src/${f}`);
  }
  if (!changed.length) throw new Error(`${dir}: patch sun-shadow-map-size matched nothing`);
  return changed;
}

const PATCHES = { "sun-shadow-map-size": patchSunShadowMapSize };

async function attach(dir) {
  // Import the built server code — the same function verse8_attach runs.
  const { runAttach } = await import(path.join(REPO_DIR, "dist", "tools", "attach.js"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await runAttach({
      projectDir: dir,
      overwriteAgentsDoc: true,
      overwriteAllSkills: false,
      pruneOrphanedSkills: false,
      overwriteEnv: false,
    });
  } finally {
    process.chdir(cwd);
  }
}

function listSkills(dir) {
  const root = path.join(dir, ".claude", "skills");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function installedVersions(dir, names) {
  const out = {};
  for (const n of names) {
    try {
      out[n] = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", n, "package.json"), "utf8")).version;
    } catch {
      /* not installed */
    }
  }
  return out;
}

async function buildSeed(id) {
  const spec = SEEDS[id];
  const arm = ARMS[spec.arm];
  const dir = path.join(SEEDS_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  extractTemplate(spec.ref, spec.template, dir);
  const patched = spec.patch ? { name: spec.patch, files: PATCHES[spec.patch](dir) } : null;

  const originalAssetCategories = registerSharedAssets(dir);

  // Checkpoint reads the account from .env before it would ask the network.
  fs.writeFileSync(path.join(dir, ".env"), `VITE_AGENT8_ACCOUNT=${OFFLINE_ACCOUNT}\nVITE_AGENT8_VERSE=eval-${id}\n`);
  fs.mkdirSync(path.join(dir, ".verse8"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".verse8", "project.json"), JSON.stringify({ projectId: `eval-${id}` }, null, 2) + "\n");

  sh("bun", ["install"], { cwd: dir });

  sh("git", ["init", "-q", "-b", "develop"], { cwd: dir });
  sh("git", ["config", "user.name", "verse8-eval"], { cwd: dir });
  sh("git", ["config", "user.email", "eval@localhost"], { cwd: dir });
  sh("git", ["remote", "add", "origin", FAKE_ORIGIN(id)], { cwd: dir });
  // Replaced per run by the runner; a seed must never push anywhere.
  sh("git", ["config", "remote.origin.pushurl", "/dev/null/no-push"], { cwd: dir });

  const result = await attach(dir);
  if (!result.ok) throw new Error(`${id}: attach failed: ${JSON.stringify(result)}`);
  const plugins = result.installed.skillPlugins;
  const gated = plugins.active.filter((p) => p.reason === "dependency").map((p) => p.name).sort();
  const ungated = plugins.active.filter((p) => p.reason === "ungated").map((p) => p.name).sort();
  const expected = [...arm.expectedGatedPlugins].sort();
  const pluginCheck = JSON.stringify(gated) === JSON.stringify(expected) ? "pass" : "FAIL";

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const forbidden = deps.filter((d) => arm.forbiddenDeps.includes(d));

  // .env is gitignored by attach; keep it out of git like a real project.
  // The Incanto templates gitignore bun.lock — force it in, the frozen
  // install depends on it.
  const lockfileIgnored = (() => {
    try {
      sh("git", ["check-ignore", "-q", "bun.lock"], { cwd: dir });
      return true;
    } catch {
      return false;
    }
  })();
  sh("git", ["add", "-A"], { cwd: dir });
  sh("git", ["add", "-f", "bun.lock"], { cwd: dir });
  sh("git", ["commit", "-q", "--no-verify", "-m", `seed: ${spec.template}@${spec.ref.slice(0, 9)}${patched ? ` + patch ${patched.name}` : ""} + shared assets + verse8_attach`], {
    cwd: dir,
  });
  sh("git", ["tag", "seed"], { cwd: dir });

  return {
    id,
    arm: spec.arm,
    template: spec.template,
    templateRef: spec.ref,
    patch: patched,
    dir: path.relative(REPO_DIR, dir),
    commit: sh("git", ["rev-parse", "HEAD"], { cwd: dir }),
    lockfile: fs.existsSync(path.join(dir, "bun.lock")) ? "bun.lock" : fs.existsSync(path.join(dir, "bun.lockb")) ? "bun.lockb" : null,
    lockfileIgnoredByTemplate: lockfileIgnored,
    lockfileTracked: sh("git", ["ls-files", "bun.lock", "bun.lockb"], { cwd: dir }) !== "",
    pluginCheck,
    gatedPlugins: gated,
    expectedGatedPlugins: expected,
    ungatedPlugins: ungated,
    inactivePlugins: plugins.inactive.map((p) => p.name).sort(),
    skills: listSkills(dir),
    forbiddenDeps: forbidden,
    versions: installedVersions(dir, [
      "incanto",
      "three",
      "react",
      "@react-three/fiber",
      "@react-three/drei",
      "@react-three/rapier",
      "vibe-starter-3d",
      "vite",
    ]),
    originalAssetCategories,
    agentsDoc: result.installed.agentsDoc,
  };
}

async function main() {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SEEDS);
  ensureTemplates();
  const manifestPath = path.join(SEEDS_DIR, "seeds.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
  manifest.builtAt = new Date().toISOString();
  manifest.verse8Mcp = sh("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR });
  manifest.bun = sh("bun", ["--version"]);
  manifest.node = process.version;
  manifest.seeds ??= {};
  let failed = false;
  for (const id of ids) {
    process.stderr.write(`building ${id}…\n`);
    const s = await buildSeed(id);
    manifest.seeds[id] = s;
    if (s.pluginCheck !== "pass" || s.forbiddenDeps.length || !s.lockfileTracked) failed = true;
    process.stderr.write(
      `  ${s.pluginCheck} plugins=${s.gatedPlugins.join(",")} (+${s.ungatedPlugins.join(",")}) skills=${s.skills.length} lock=${s.lockfile}${s.lockfileTracked ? "" : " UNTRACKED"}\n`,
    );
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (failed) {
    console.error("seed check failed — see eval/seeds/seeds.json");
    process.exit(1);
  }
}

await main();
