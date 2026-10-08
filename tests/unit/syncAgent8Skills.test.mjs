import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as url from "node:url";

import {
  SyncError,
  VENDOR_REL,
  readPublicManifest,
  planVendor,
  applyVendor,
  computeVendorSha,
  readPin,
  sync,
  renderSummary,
} from "../../scripts/sync-agent8-skills.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "sync-agent8-skills.mjs");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A public.json in the assumed shape: two allowlists of names. */
const MANIFEST = {
  skills: ["ads-impl", "leaderboard-impl"],
  plugins: ["gameserver", "r3f"],
};

/**
 * An upstream checkout with more than the manifest allows: a private skill,
 * a tag-scoped plugin, an asset plugin, instructions, prompts — everything
 * the sync must leave behind.
 */
function seedUpstream(dir, { manifest = MANIFEST, files = {} } = {}) {
  const defaults = {
    "README.md": "# agent8-skills\n",
    "instructions/AGENTS.md": "container prompt\n",
    "prompts/add/model/gpt-.md": "prompt\n",
    "skills/ads-impl.md": "---\nname: ads-impl\n---\n# ads\n",
    "skills/leaderboard-impl.md": "---\nname: leaderboard-impl\n---\n# leaderboard\n",
    "skills/secret-impl.md": "# not public\n",
    "plugins/README.md": "# plugins\n",
    "plugins/gameserver/plugin.json": '{\n  "version": 1,\n  "assets": []\n}\n',
    "plugins/gameserver/instructions/AGENTS.md": "gameserver prompt\n",
    "plugins/gameserver/skills/gameserver.md": "# gameserver\n",
    "plugins/gameserver/skills/gameserver-sdk.md": "# sdk\n",
    "plugins/r3f/plugin.json": '{ "version": 1, "requiresPackage": ["@react-three/fiber"], "assets": [] }\n',
    "plugins/r3f/skills/r3f-tree.md": "# tree\n",
    "plugins/msu-vibecamp/plugin.json": '{ "version": 1, "tags": ["MSU"], "assets": [] }\n',
    "plugins/msu-vibecamp/skills/msu-vibecamp.md": "# seasonal\n",
    "plugins/debug-visualization/plugin.json":
      '{ "version": 1, "assets": [{ "file": "assets/debug-panel.js", "target": "preview" }] }\n',
    "plugins/debug-visualization/assets/debug-panel.js": "window.DebugPanel = {};\n",
    "plugins/debug-visualization/skills/debug-visualization.md": "# dbg\n",
  };
  const all = { ...defaults, ...files };
  if (manifest !== null) all["public.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const [rel, body] of Object.entries(all)) {
    if (body === null) continue;
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

/**
 * A verse8-mcp-shaped repo root: package.json with the pin block, the real
 * compute-subtree-sha.sh (it resolves the repo root from its own location),
 * and a stale vendor tree in the old flat layout.
 */
function seedRepo(dir, { vendor = {} } = {}) {
  const pkg = {
    name: "@verse8/mcp",
    version: "0.0.0",
    scripts: { build: "tsc" },
    verse8: {
      skillsVendor: { sha: "0".repeat(64) },
      gameserverPin: { "gameserver-node": "latest" },
    },
  };
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "compute-subtree-sha.sh"),
    path.join(dir, "scripts", "compute-subtree-sha.sh"),
  );
  const defaults = {
    "README.md": "# old upstream readme\n",
    "instructions/AGENTS.md": "old\n",
    "skills/ads-impl.md": "---\nname: ads-impl\n---\n# ads (old)\n",
    "skills/gameserver-sdk.md": "# flat, pre-plugin layout\n",
  };
  for (const [rel, body] of Object.entries({ ...defaults, ...vendor })) {
    const abs = path.join(dir, VENDOR_REL, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

/**
 * realpath'd: on macOS `os.tmpdir()` is `/var/…` while the module loader
 * reports `/private/var/…`, so a prefix comparison against the raw path
 * matches nothing.
 */
function scratch(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function withScratch(fn) {
  const up = scratch("verse8-sync-up-");
  const repo = scratch("verse8-sync-repo-");
  try {
    return fn(up, repo);
  } finally {
    fs.rmSync(up, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function expectSyncError(fn, code, re) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof SyncError, `expected SyncError, got ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.code, code, `code: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}

// ---------------------------------------------------------------------------
// public.json
// ---------------------------------------------------------------------------

test("readPublicManifest: missing file is an explicit failure, not an empty vendor", () => {
  withScratch((up) => {
    seedUpstream(up, { manifest: null });
    expectSyncError(() => readPublicManifest(up), "public_json_missing", /public\.json is missing/);
  });
});

test("readPublicManifest: shape errors", () => {
  withScratch((up) => {
    const bad = (body, re) => {
      fs.writeFileSync(path.join(up, "public.json"), body);
      expectSyncError(() => readPublicManifest(up), "public_json_invalid", re);
    };
    bad("{ not json", /not valid JSON/);
    bad("[]", /must be a JSON object/);
    bad('{ "skills": [] }', /'plugins' must be an array/);
    bad('{ "skills": "ads-impl", "plugins": [] }', /'skills' must be an array/);
    bad('{ "skills": ["Ads_Impl"], "plugins": [] }', /skills\[0\] must be a name/);
    bad('{ "skills": ["../etc"], "plugins": [] }', /skills\[0\] must be a name/);
    bad('{ "skills": ["a", "a"], "plugins": [] }', /duplicates 'a'/);
  });
});

test("readPublicManifest: unknown keys are ignored with a warning, raw text is kept verbatim", () => {
  withScratch((up) => {
    const raw = '{"skills":["ads-impl"],"plugins":[],"future":1}\n';
    fs.writeFileSync(path.join(up, "public.json"), raw);
    const m = readPublicManifest(up);
    assert.deepEqual(m.skills, ["ads-impl"]);
    assert.deepEqual(m.plugins, []);
    assert.equal(m.raw, raw);
    assert.equal(m.warnings.length, 1);
    assert.match(m.warnings[0], /unknown key 'future'/);
  });
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

test("planVendor: only listed skills and listed plugins' skill files, mirrored paths", () => {
  withScratch((up) => {
    seedUpstream(up);
    const plan = planVendor(up, readPublicManifest(up));
    assert.deepEqual(
      plan.files.map((f) => f.rel),
      [
        "README.md",
        "plugins/gameserver/skills/gameserver-sdk.md",
        "plugins/gameserver/skills/gameserver.md",
        "plugins/r3f/skills/r3f-tree.md",
        "public.json",
        "skills/ads-impl.md",
        "skills/leaderboard-impl.md",
      ],
    );
    assert.deepEqual(plan.skillNames, ["ads-impl", "gameserver", "gameserver-sdk", "leaderboard-impl", "r3f-tree"]);
    assert.deepEqual(plan.warnings, []);
    // Generated / verbatim entries carry content; copied ones carry a source.
    const readme = plan.files.find((f) => f.rel === "README.md");
    assert.match(readme.content.toString("utf8"), /Do not edit by hand/);
    const pub = plan.files.find((f) => f.rel === "public.json");
    assert.equal(pub.content.toString("utf8"), fs.readFileSync(path.join(up, "public.json"), "utf8"));
    for (const f of plan.files.filter((x) => x.src)) assert.ok(fs.existsSync(f.src), f.src);
  });
});

test("planVendor: a listed skill or plugin that does not exist upstream fails", () => {
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: ["nope"], plugins: [] } });
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "skill_missing", /skills\/nope\.md does not exist/);
  });
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: [], plugins: ["nope"] } });
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "plugin_missing", /plugins\/nope\/ does not exist/);
  });
});

test("planVendor: tag-scoped and preview/publish-asset plugins are ineligible even if listed", () => {
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: [], plugins: ["msu-vibecamp"] } });
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "plugin_ineligible", /tag-scoped \(MSU\)/);
  });
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: [], plugins: ["debug-visualization"] } });
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "plugin_ineligible", /preview\/publish assets/);
  });
});

test("planVendor: plugin without a manifest, with a bad manifest, or with a mis-named skill file fails", () => {
  withScratch((up) => {
    seedUpstream(up, {
      manifest: { skills: [], plugins: ["gameserver"] },
      files: { "plugins/gameserver/plugin.json": null },
    });
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "plugin_invalid", /plugin\.json is missing/);
  });
  withScratch((up) => {
    seedUpstream(up, {
      manifest: { skills: [], plugins: ["gameserver"] },
      files: { "plugins/gameserver/plugin.json": "{ nope" },
    });
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "plugin_invalid", /not valid JSON/);
  });
  withScratch((up) => {
    seedUpstream(up, {
      manifest: { skills: [], plugins: ["gameserver"] },
      files: { "plugins/gameserver/skills/tuning.md": "# would register as `tuning`\n" },
    });
    expectSyncError(
      () => planVendor(up, readPublicManifest(up)),
      "plugin_skill_invalid",
      /must be named 'gameserver\.md' or 'gameserver-\*\.md'/,
    );
  });
});

/** A directory symlink; `junction` needs no privilege on Windows. */
function symlinkDir(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("planVendor: symlinked skills/, plugins/<p>/ or plugins/<p>/skills/ is rejected, not followed", () => {
  // Everything under `elsewhere/` is outside the allowlist's reach by path;
  // a symlink must not become a way in.
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: [], plugins: ["r3f"] } });
    const elsewhere = path.join(up, "elsewhere");
    fs.mkdirSync(path.join(elsewhere, "skills"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "plugin.json"), '{ "version": 1, "assets": [] }\n');
    fs.writeFileSync(path.join(elsewhere, "skills", "r3f-smuggled.md"), "# not public\n");
    fs.rmSync(path.join(up, "plugins", "r3f"), { recursive: true, force: true });
    symlinkDir(elsewhere, path.join(up, "plugins", "r3f"));
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "symlink_rejected", /^plugins\/r3f is a symlink/);
  });
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: [], plugins: ["gameserver"] } });
    const elsewhere = path.join(up, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "gameserver-smuggled.md"), "# not public\n");
    fs.rmSync(path.join(up, "plugins", "gameserver", "skills"), { recursive: true, force: true });
    symlinkDir(elsewhere, path.join(up, "plugins", "gameserver", "skills"));
    expectSyncError(
      () => planVendor(up, readPublicManifest(up)),
      "symlink_rejected",
      /^plugins\/gameserver\/skills is a symlink/,
    );
  });
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: ["ads-impl"], plugins: [] } });
    const elsewhere = path.join(up, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "ads-impl.md"), "# a different ads-impl\n");
    fs.rmSync(path.join(up, "skills"), { recursive: true, force: true });
    symlinkDir(elsewhere, path.join(up, "skills"));
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "symlink_rejected", /^skills is a symlink/);
  });
  // A symlinked skill *file* was already refused; keep that pinned too.
  // (File symlinks need a privilege on Windows that a plain user lacks.)
  withScratch((up) => {
    seedUpstream(up, { manifest: { skills: ["ads-impl"], plugins: [] } });
    fs.rmSync(path.join(up, "skills", "ads-impl.md"));
    try {
      fs.symlinkSync(path.join(up, "skills", "secret-impl.md"), path.join(up, "skills", "ads-impl.md"), "file");
    } catch (e) {
      if (process.platform === "win32" && e.code === "EPERM") return;
      throw e;
    }
    expectSyncError(() => planVendor(up, readPublicManifest(up)), "skill_missing");
  });
});

test("planVendor: the same skill name from two places is a collision", () => {
  withScratch((up) => {
    seedUpstream(up, {
      manifest: { skills: ["gameserver-sdk"], plugins: ["gameserver"] },
      files: { "skills/gameserver-sdk.md": "# top-level twin\n" },
    });
    expectSyncError(
      () => planVendor(up, readPublicManifest(up)),
      "skill_name_collision",
      /'gameserver-sdk' is provided by both skills\/gameserver-sdk\.md and plugins\/gameserver\/skills\/gameserver-sdk\.md/,
    );
  });
});

test("planVendor: a listed plugin with no skill files vendors nothing and warns", () => {
  withScratch((up) => {
    seedUpstream(up, {
      manifest: { skills: [], plugins: ["project-history"] },
      files: { "plugins/project-history/plugin.json": '{ "version": 1, "assets": [] }\n' },
    });
    const plan = planVendor(up, readPublicManifest(up));
    assert.deepEqual(plan.files.map((f) => f.rel), ["README.md", "public.json"]);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /'project-history' is listed but ships no skills/);
  });
});

// ---------------------------------------------------------------------------
// apply + pin
// ---------------------------------------------------------------------------

test("sync: rebuilds the vendor tree from scratch and re-pins package.json", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    const commit = "f".repeat(40);
    const pkgBefore = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

    const result = sync({ repoRoot: repo, upstreamDir: up, commit });

    assert.equal(result.changed, true);
    assert.deepEqual(listFiles(path.join(repo, VENDOR_REL)), [
      "README.md",
      "plugins/gameserver/skills/gameserver-sdk.md",
      "plugins/gameserver/skills/gameserver.md",
      "plugins/r3f/skills/r3f-tree.md",
      "public.json",
      "skills/ads-impl.md",
      "skills/leaderboard-impl.md",
    ]);
    // Stale files from the old layout are gone, listed content is byte-identical.
    assert.deepEqual(result.removed, ["instructions/AGENTS.md", "skills/gameserver-sdk.md"]);
    assert.deepEqual(result.modified, ["README.md", "skills/ads-impl.md"]);
    assert.deepEqual(result.added, [
      "plugins/gameserver/skills/gameserver-sdk.md",
      "plugins/gameserver/skills/gameserver.md",
      "plugins/r3f/skills/r3f-tree.md",
      "public.json",
      "skills/leaderboard-impl.md",
    ]);
    assert.equal(
      fs.readFileSync(path.join(repo, VENDOR_REL, "skills", "ads-impl.md"), "utf8"),
      fs.readFileSync(path.join(up, "skills", "ads-impl.md"), "utf8"),
    );

    // Pin: content hash is exactly what compute-subtree-sha.sh prints, the
    // upstream commit is recorded, everything else in package.json survives.
    const pin = readPin(repo);
    assert.equal(pin.sha, computeVendorSha(repo));
    assert.equal(pin.sha, result.sha);
    assert.notEqual(pin.sha, "0".repeat(64));
    assert.deepEqual(pin.upstream, { repo: "planetarium/agent8-skills", commit });
    assert.equal(result.previousSha, "0".repeat(64));
    assert.equal(result.previousCommit, undefined);
    const pkgAfter = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    assert.deepEqual(pkgAfter.verse8.gameserverPin, pkgBefore.verse8.gameserverPin);
    assert.deepEqual(pkgAfter.scripts, pkgBefore.scripts);
    const text = fs.readFileSync(path.join(repo, "package.json"), "utf8");
    assert.ok(text.endsWith("}\n"), "trailing newline kept");
    assert.match(text, /\n  "verse8": \{\n    "skillsVendor": \{\n      "sha": /, "two-space formatting kept");
  });
});

test("sync: a second run against the same upstream is a no-op and leaves package.json untouched", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    const commit = "a".repeat(40);
    sync({ repoRoot: repo, upstreamDir: up, commit });
    const pkgText = fs.readFileSync(path.join(repo, "package.json"), "utf8");
    const tree = listFiles(path.join(repo, VENDOR_REL));

    const again = sync({ repoRoot: repo, upstreamDir: up, commit: "b".repeat(40) });

    assert.equal(again.changed, false);
    assert.deepEqual([again.added, again.removed, again.modified], [[], [], []]);
    assert.equal(again.sha, undefined);
    assert.equal(again.previousCommit, commit);
    assert.equal(fs.readFileSync(path.join(repo, "package.json"), "utf8"), pkgText);
    assert.deepEqual(listFiles(path.join(repo, VENDOR_REL)), tree);
  });
});

test("sync: an upstream edit to a vendored file changes the tree and the pin; a non-public edit does not", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    const first = sync({ repoRoot: repo, upstreamDir: up, commit: "a".repeat(40) });

    fs.writeFileSync(path.join(up, "skills", "secret-impl.md"), "# still not public, edited\n");
    fs.writeFileSync(path.join(up, "plugins", "gameserver", "instructions", "AGENTS.md"), "edited\n");
    const nonPublic = sync({ repoRoot: repo, upstreamDir: up, commit: "b".repeat(40) });
    assert.equal(nonPublic.changed, false);

    fs.writeFileSync(path.join(up, "plugins", "r3f", "skills", "r3f-tree.md"), "# tree v2\n");
    const edited = sync({ repoRoot: repo, upstreamDir: up, commit: "c".repeat(40) });
    assert.equal(edited.changed, true);
    assert.deepEqual(edited.modified, ["plugins/r3f/skills/r3f-tree.md"]);
    assert.notEqual(edited.sha, first.sha);
    assert.equal(readPin(repo).upstream.commit, "c".repeat(40));
  });
});

test("sync: --dry-run reports the diff without touching the tree or the pin", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    const pkgText = fs.readFileSync(path.join(repo, "package.json"), "utf8");
    const tree = listFiles(path.join(repo, VENDOR_REL));

    const result = sync({ repoRoot: repo, upstreamDir: up, commit: "a".repeat(40), dryRun: true });

    assert.equal(result.changed, true);
    assert.deepEqual(result.removed, ["instructions/AGENTS.md", "skills/gameserver-sdk.md"]);
    assert.deepEqual(result.modified, ["README.md", "skills/ads-impl.md"]);
    assert.equal(result.sha, undefined);
    assert.equal(fs.readFileSync(path.join(repo, "package.json"), "utf8"), pkgText);
    assert.deepEqual(listFiles(path.join(repo, VENDOR_REL)), tree);
  });
});

test("sync: --commit must be a full sha", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    expectSyncError(() => sync({ repoRoot: repo, upstreamDir: up, commit: "f4eca9b" }), "bad_commit");
  });
});

test("applyVendor: works on a repo that has no vendor tree yet", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    fs.rmSync(path.join(repo, VENDOR_REL), { recursive: true, force: true });
    const diff = applyVendor(repo, planVendor(up, readPublicManifest(up)));
    assert.equal(diff.changed, true);
    assert.equal(diff.added.length, 7);
    assert.deepEqual([diff.removed, diff.modified], [[], []]);
  });
});

test("renderSummary: counts, file lists and warnings", () => {
  const out = renderSummary({
    manifest: { skills: 2, plugins: 1 },
    skillNames: ["a", "b", "c"],
    added: ["skills/a.md"],
    modified: [],
    removed: ["skills/z.md"],
    warnings: ["plugin 'p' is listed but ships no skills/*.md — nothing vendored for it"],
  });
  assert.match(out, /^public\.json: 2 skill\(s\), 1 plugin\(s\) → 3 skill file\(s\) vendored/);
  assert.match(out, /Added \(1\):\n- `skills\/a\.md`/);
  assert.match(out, /Removed \(1\):\n- `skills\/z\.md`/);
  assert.doesNotMatch(out, /Modified/);
  assert.match(out, /Warnings:\n- plugin 'p'/);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_ACTIONS: "", ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("cli: writes changed/sha/summary to GITHUB_OUTPUT and exits 0", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    const out = path.join(repo, "gh-output.txt");
    fs.writeFileSync(out, "");
    const commit = "d".repeat(40);
    const res = runCli(["--upstream", up, "--repo-root", repo, "--commit", commit], { GITHUB_OUTPUT: out });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /changed/);
    const ghOut = fs.readFileSync(out, "utf8");
    assert.match(ghOut, /^changed=true$/m);
    assert.match(ghOut, new RegExp(`^sha=${readPin(repo).sha}$`, "m"));
    assert.match(ghOut, /^previous_sha=0{64}$/m);
    assert.match(ghOut, /^summary<<(\S+)\n[\s\S]*?\n\1\n/m);
    assert.match(ghOut, /- `skills\/leaderboard-impl\.md`/);
  });
});

test("cli: no change → changed=false, exit 0", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    sync({ repoRoot: repo, upstreamDir: up, commit: "a".repeat(40) });
    const out = path.join(repo, "gh-output.txt");
    fs.writeFileSync(out, "");
    const res = runCli(["--upstream", up, "--repo-root", repo, "--commit", "b".repeat(40)], { GITHUB_OUTPUT: out });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /unchanged — nothing to do/);
    assert.match(fs.readFileSync(out, "utf8"), /^changed=false$/m);
  });
});

test("cli: missing public.json exits 2 with the error code, as a ::error:: under Actions", () => {
  withScratch((up, repo) => {
    seedUpstream(up, { manifest: null });
    seedRepo(repo);
    const res = runCli(["--upstream", up, "--repo-root", repo], { GITHUB_ACTIONS: "true" });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^::error::sync-agent8-skills: public_json_missing: /m);
    // Nothing was touched.
    assert.ok(fs.existsSync(path.join(repo, VENDOR_REL, "skills", "gameserver-sdk.md")));
  });
});

test("cli: --json prints the result object; usage errors exit 2", () => {
  withScratch((up, repo) => {
    seedUpstream(up);
    seedRepo(repo);
    const res = runCli(["--upstream", up, "--repo-root", repo, "--dry-run", "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.changed, true);
    assert.deepEqual(parsed.manifest, { skills: 2, plugins: 2 });
    const usage = runCli(["--repo-root", repo]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /--upstream <dir> is required/);
  });
});

// ---------------------------------------------------------------------------
// repo assumptions
// ---------------------------------------------------------------------------

test("repo: package.json round-trips through the formatter writePin uses", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  assert.equal(`${JSON.stringify(JSON.parse(text), null, 2)}\n`, text);
  const pin = readPin(REPO_ROOT);
  assert.match(pin.sha, /^[0-9a-f]{64}$/);
  assert.equal(pin.upstream.repo, "planetarium/agent8-skills");
  assert.match(pin.upstream.commit, /^[0-9a-f]{40}$/);
});

test("repo: the MCP discovers skills in the mirrored layout (skills/ and plugins/<p>/skills/)", async () => {
  // Stand up <tmp>/dist/resources/skills.js next to a vendor tree so the
  // module's repo-root resolver (dist/.. → <tmp>) lands on our fixture.
  const built = path.join(REPO_ROOT, "dist", "resources", "skills.js");
  assert.ok(fs.existsSync(built), "run `npm run build` first");
  const tmp = scratch("verse8-sync-discover-");
  try {
    fs.mkdirSync(path.join(tmp, "dist", "resources"), { recursive: true });
    fs.copyFileSync(built, path.join(tmp, "dist", "resources", "skills.js"));
    const vendor = path.join(tmp, VENDOR_REL);
    const write = (rel, body) => {
      const abs = path.join(vendor, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };
    write("README.md", "# vendored\n");
    write("public.json", "{}\n");
    write("skills/ads-impl.md", "# ads\n");
    write("plugins/gameserver/skills/gameserver-sdk.md", "# sdk\n");
    write("plugins/gameserver/plugin.json", "{}\n");
    const mod = await import(url.pathToFileURL(path.join(tmp, "dist", "resources", "skills.js")).href);
    const names = mod
      .listSkillResources()
      .filter((s) => s.fsPath.startsWith(vendor))
      .map((s) => s.name)
      .sort();
    assert.deepEqual(names, ["ads-impl", "gameserver-sdk"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
