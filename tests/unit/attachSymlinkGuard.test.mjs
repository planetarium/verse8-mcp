import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { execFileSync } from "node:child_process";

import ts from "typescript";
import { applyAttachmentArtifacts } from "../../dist/tools/attach.js";
import { cloneAndAttach } from "../../dist/tools/projectClone.js";
import { addHashMarker, writeSkillFiles } from "../../dist/tools/skillWriter.js";
import * as projectWrite from "../../dist/util/projectWrite.js";

const { projectWriter } = projectWrite;

// Attach writes into a project the user (or a cloned repo) controls. A link
// in it must not turn an attach write into a write outside the project.

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");
const isWin = process.platform === "win32";

function mkRoot() {
  // realpath: on macOS os.tmpdir() is itself behind /var → /private/var.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verse8-linkguard-")));
}

function setup() {
  const base = mkRoot();
  const project = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  execFileSync("git", ["init", "-q"], { cwd: project });
  return { base, project, outside };
}

function cleanup(base) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Directory link — a junction on Windows, which needs no privilege. */
function linkDir(target, link) {
  fs.symlinkSync(target, link, isWin ? "junction" : "dir");
}

/**
 * Symlink (a file link, or a relative directory link that a junction can't
 * express); false when the OS refuses (Windows without symlink privilege).
 */
function tryLinkFile(target, link, type = "file") {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (e) {
    if (isWin && (e.code === "EPERM" || e.code === "EACCES")) return false;
    throw e;
  }
}

function attach(project, extra = {}) {
  return applyAttachmentArtifacts(project, { overwrite: false, walletAddress: null, ...extra });
}

function listTree(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort();
}

// INV-14: Attach writes never leave the project folder
test("attach: .claude/skills linked outside the project is refused and the outside folder stays empty", (t) => {
  const { base, project, outside } = setup();
  try {
    fs.mkdirSync(path.join(project, ".claude"));
    linkDir(outside, path.join(project, ".claude", "skills"));

    assert.throws(() => attach(project), (e) => {
      assert.match(e.message, /\.claude\/skills is a link to .*outside the project folder/);
      return true;
    });
    assert.deepEqual(listTree(outside), []);
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: .claude linked outside with pruneOrphanedSkills leaves the outside skill untouched", () => {
  const { base, project, outside } = setup();
  try {
    // A SKILL.md that looks like ours (unedited marker) — prune would delete it.
    const victim = path.join(outside, "skills", "old-skill");
    fs.mkdirSync(victim, { recursive: true });
    const bytes = addHashMarker("# old\n");
    fs.writeFileSync(path.join(victim, "SKILL.md"), bytes);
    linkDir(outside, path.join(project, ".claude"));

    assert.throws(() => attach(project, { pruneOrphanedSkills: true }), /outside the project folder/);
    assert.equal(fs.readFileSync(path.join(victim, "SKILL.md"), "utf8"), bytes);
    assert.deepEqual(listTree(outside), ["skills", path.join("skills", "old-skill"), path.join("skills", "old-skill", "SKILL.md")].sort());
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: .verse8/.gitignore linked to an outside file is refused and the file's bytes are unchanged", (t) => {
  const { base, project, outside } = setup();
  try {
    const target = path.join(outside, "rc");
    fs.writeFileSync(target, "export KEEP=1\n");
    fs.mkdirSync(path.join(project, ".verse8"));
    if (!tryLinkFile(target, path.join(project, ".verse8", ".gitignore"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    assert.throws(() => attach(project), /\.verse8\/\.gitignore is a link to .*outside the project folder/);
    assert.equal(fs.readFileSync(target, "utf8"), "export KEEP=1\n");
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: .verse8 linked outside is refused before project.json is written", () => {
  const { base, project, outside } = setup();
  try {
    linkDir(outside, path.join(project, ".verse8"));
    assert.throws(() => attach(project), /\.verse8 is a link to .*outside the project folder/);
    assert.deepEqual(listTree(outside), []);
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: AGENTS.md as a dangling link out of the project is refused and nothing appears where it points", (t) => {
  const { base, project, outside } = setup();
  try {
    const target = path.join(outside, "planted.md");
    if (!tryLinkFile(target, path.join(project, "AGENTS.md"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    assert.throws(() => attach(project), /AGENTS\.md is a link to .*\(missing\), which is outside the project folder/);
    assert.equal(fs.existsSync(target), false);
    // Rolled back: the hooks written in step 1 are gone again.
    assert.equal(fs.existsSync(path.join(project, ".git", "hooks", "pre-commit")), false);
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: CLAUDE.md linked to AGENTS.md inside the project is allowed with overwriteAgentsDoc", (t) => {
  const { base, project } = setup();
  try {
    fs.writeFileSync(path.join(project, "AGENTS.md"), "old\n");
    if (!tryLinkFile("AGENTS.md", path.join(project, "CLAUDE.md"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    const r = attach(project, { overwrite: true });
    assert.equal(r.agentsDoc, "overwritten");
    assert.equal(fs.lstatSync(path.join(project, "CLAUDE.md")).isSymbolicLink(), true);
    assert.notEqual(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8"), "old\n");
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: a link into the project's .git folder is refused", () => {
  const { base, project } = setup();
  try {
    linkDir(path.join(project, ".git"), path.join(project, ".claude"));
    assert.throws(() => attach(project), /\.claude is a link to .*inside the project's \.git folder/);
    assert.equal(fs.existsSync(path.join(project, ".git", "skills")), false);
  } finally {
    cleanup(base);
  }
});

function canCheckOutSymlinks() {
  if (!isWin) return true;
  const dir = mkRoot();
  try {
    fs.symlinkSync("x", path.join(dir, "probe"), "file");
    return true;
  } catch {
    return false;
  } finally {
    cleanup(dir);
  }
}

// INV-14: Attach writes never leave the project folder
test("clone then attach: a repo with a committed .claude/skills link out of the project fails with attach_failed", async (t) => {
  if (!canCheckOutSymlinks()) {
    t.skip("git cannot check out symlinks without privilege on this Windows host");
    return;
  }
  const base = mkRoot();
  const prevApi = process.env.VERSE8_API_URL;
  // The wallet lookup is best-effort; aim it at a closed loopback port.
  process.env.VERSE8_API_URL = "http://127.0.0.1:9";
  try {
    const work = path.join(base, "work");
    const bare = path.join(base, "fixture.git");
    const parent = path.join(base, "parent");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const git = (...a) => execFileSync("git", a, { cwd: work, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    fs.mkdirSync(work);
    git("init", "-q", "-b", "main");
    // Commit the link with plumbing, so building the fixture needs no
    // symlink privilege: <clone>/.claude/skills → <parent>/outside.
    fs.writeFileSync(path.join(work, "link-target"), "../../outside");
    const blob = git("hash-object", "-w", "link-target");
    fs.rmSync(path.join(work, "link-target"));
    git("update-index", "--add", "--cacheinfo", `120000,${blob},.claude/skills`);
    git("-c", "user.email=t@verse8.io", "-c", "user.name=t", "commit", "-q", "-m", "link");
    execFileSync("git", ["clone", "-q", "--bare", work, bare]);

    const fileUrl = url.pathToFileURL(bare).href;
    const r = await cloneAndAttach({
      projectPath: "u/proj",
      projectId: "p1",
      cloneCommand: `git clone --config=core.symlinks=true -b main ${fileUrl} proj`,
      parentDir: parent,
      token: "test-token",
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, "attach_failed");
    assert.match(r.hint, /\.claude\/skills is a link to .*outside the project folder/);
    assert.deepEqual(listTree(outside), []);
  } finally {
    if (prevApi === undefined) delete process.env.VERSE8_API_URL;
    else process.env.VERSE8_API_URL = prevApi;
    cleanup(base);
  }
});

const WALLET = "0x1111111111111111111111111111111111111111";
const gitIn = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

let bundledName;
/** A skill name this attach installs (read from a scratch attach). */
function bundledSkill() {
  if (bundledName) return bundledName;
  const { base, project } = setup();
  try {
    bundledName = attach(project).skills.created[0];
    assert.ok(bundledName, "the bundle installs at least one skill");
    return bundledName;
  } finally {
    cleanup(base);
  }
}

// --- content read through a link must not be copied into the project ---

// INV-14: Attach writes never leave the project folder
test("attach: .env linked to an outside file is refused and the outside content is not copied into the project", (t) => {
  const { base, project, outside } = setup();
  try {
    const target = path.join(outside, "secrets.env");
    fs.writeFileSync(target, "OUTSIDE_SECRET=1\n");
    if (!tryLinkFile(target, path.join(project, ".env"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    assert.throws(
      () => attach(project, { walletAddress: WALLET }),
      /\.env is a link to .*outside the project folder/,
    );
    assert.equal(fs.lstatSync(path.join(project, ".env")).isSymbolicLink(), true, ".env is still the link");
    assert.equal(fs.readFileSync(target, "utf8"), "OUTSIDE_SECRET=1\n");
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: .env linked outside that already holds both keys is left alone (already-present)", (t) => {
  const { base, project, outside } = setup();
  try {
    const target = path.join(outside, "shared.env");
    const body = `VITE_AGENT8_ACCOUNT=${WALLET}\nVITE_AGENT8_VERSE=${WALLET}-1\n`;
    fs.writeFileSync(target, body);
    if (!tryLinkFile(target, path.join(project, ".env"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    const r = attach(project, { walletAddress: WALLET });
    assert.equal(r.env.status, "already-present");
    assert.equal(fs.lstatSync(path.join(project, ".env")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), body);
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: a bundled SKILL.md linked outside, with overwriteAllSkills and a later failure, never becomes a copy of the outside file", (t) => {
  const name = bundledSkill();
  const { base, project, outside } = setup();
  try {
    const target = path.join(outside, "notes.md");
    fs.writeFileSync(target, "OUTSIDE NOTES\n");
    const dir = path.join(project, ".claude", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    if (!tryLinkFile(target, path.join(dir, "SKILL.md"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    assert.throws(() => attach(project, { overwriteAllSkills: true, __failAfter: "env" }));
    const skill = path.join(dir, "SKILL.md");
    assert.equal(fs.lstatSync(skill).isSymbolicLink(), true, "SKILL.md is still the link, not a regular copy");
    assert.equal(fs.readFileSync(target, "utf8"), "OUTSIDE NOTES\n");
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("writeSkillFiles: retire and prune skip a skill folder linked outside and leave its SKILL.md there", () => {
  const { base, project, outside } = setup();
  try {
    const signed = addHashMarker("# gone\n");
    for (const n of ["retired-one", "orphan-one"]) {
      fs.mkdirSync(path.join(outside, n));
      fs.writeFileSync(path.join(outside, n, "SKILL.md"), signed);
    }
    const skills = path.join(project, ".claude", "skills");
    fs.mkdirSync(skills, { recursive: true });
    linkDir(path.join(outside, "retired-one"), path.join(skills, "retired-one"));
    linkDir(path.join(outside, "orphan-one"), path.join(skills, "orphan-one"));

    const r = writeSkillFiles(project, [], { overwriteAll: false, pruneOrphaned: true, retire: ["retired-one"] });
    assert.deepEqual(r.deactivated, []);
    assert.deepEqual(r.pruned, []);
    for (const n of ["retired-one", "orphan-one"]) {
      assert.equal(fs.readFileSync(path.join(outside, n, "SKILL.md"), "utf8"), signed);
    }
  } finally {
    cleanup(base);
  }
});

// --- rollback puts back what was there ---

// INV-14: Attach writes never leave the project folder
test("attach: a user's own hook is restored, bytes and mode, when a later step fails", () => {
  const { base, project } = setup();
  try {
    const hook = path.join(project, ".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho mine\n", { mode: 0o700 });
    fs.chmodSync(hook, 0o700);
    assert.throws(() => attach(project, { __failAfter: "agentsDoc" }), /__failAfter:agentsDoc/);
    assert.equal(fs.readFileSync(hook, "utf8"), "#!/bin/sh\necho mine\n");
    if (!isWin) assert.equal(fs.statSync(hook).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(project, ".git", "hooks", "commit-msg")), false);
  } finally {
    cleanup(base);
  }
});

// --- where a link really leads ---

// INV-14: Attach writes never leave the project folder
test("attach: CLAUDE.md linked to a not-yet-existing AGENTS.md inside the project succeeds", (t) => {
  const { base, project } = setup();
  try {
    if (!tryLinkFile("AGENTS.md", path.join(project, "CLAUDE.md"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    const r = attach(project);
    assert.equal(r.agentsDoc, "created");
    assert.equal(fs.lstatSync(path.join(project, "CLAUDE.md")).isSymbolicLink(), true);
    assert.ok(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8").length > 0);
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: a link to a dangling link that points outside is refused", (t) => {
  const { base, project, outside } = setup();
  try {
    const target = path.join(outside, "planted.md");
    if (!tryLinkFile(target, path.join(project, "mid.md")) || !tryLinkFile("mid.md", path.join(project, "AGENTS.md"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    assert.throws(() => attach(project), /AGENTS\.md is a link to .*outside the project folder/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    cleanup(base);
  }
});

/** A project nested `depth` folders below a fresh base, so `..` chains stay inside base. */
function setupNested(depth) {
  const base = mkRoot();
  const project = path.join(base, ...Array.from({ length: depth }, (_, i) => `d${i}`), "project");
  fs.mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  return { base, project };
}

// The kernel follows `sub` before applying `..`; a guard that folds
// `sub/../planted` as a string first judges the wrong place.
for (const [label, subTarget, depth] of [
  ["sub → ..", "..", 1],
  ["sub → ../..", "../..", 2],
]) {
  // INV-14: Attach writes never leave the project folder
  test(`attach: a dangling AGENTS.md → sub/../planted with ${label} is refused and nothing is created outside`, (t) => {
    const { base, project } = setupNested(depth);
    try {
      if (
        !tryLinkFile(subTarget, path.join(project, "sub"), "dir") ||
        !tryLinkFile("sub/../planted", path.join(project, "AGENTS.md"))
      ) {
        t.skip("file symlinks need privilege on this Windows host");
        return;
      }
      assert.throws(() => attach(project), /AGENTS\.md is a link to .*outside the project folder/);
      // Where the kernel would put it: `sub` leads to <base>/d0, `..` to <base>.
      assert.equal(fs.existsSync(path.join(base, "planted")), false);
    } finally {
      cleanup(base);
    }
  });
}

// Readings that disagree: sub → a/b, AGENTS.md → sub/../../x. Walking the
// links first (POSIX) lands in <project>/x; folding the target as text
// first lands in <base>/x, outside. win32 checks both and refuses; POSIX
// keeps the walk. The platform is injected so Linux CI runs the win32 rule.
// INV-14: Attach writes never leave the project folder
test("projectWriter: win32 refuses when either reading of a dangling link is outside; POSIX follows the walk", (t) => {
  for (const platform of ["win32", "posix"]) {
    const { base, project } = setupNested(0);
    try {
      fs.mkdirSync(path.join(project, "a", "b"), { recursive: true });
      if (
        !tryLinkFile("a/b", path.join(project, "sub"), "dir") ||
        !tryLinkFile("sub/../../x", path.join(project, "AGENTS.md"))
      ) {
        t.skip("file symlinks need privilege on this Windows host");
        return;
      }
      const w = projectWriter(project, { platform });
      if (platform === "win32") {
        assert.throws(() => w.writeFile(path.join(project, "AGENTS.md"), "x"), /AGENTS\.md is a link to .*outside the project folder/);
        assert.equal(fs.existsSync(path.join(base, "x")), false);
        assert.equal(fs.existsSync(path.join(project, "x")), false);
      } else if (!isWin) {
        // Only where the host kernel itself walks POSIX-style.
        w.writeFile(path.join(project, "AGENTS.md"), "x");
        assert.equal(fs.readFileSync(path.join(project, "x"), "utf8"), "x");
        assert.equal(fs.existsSync(path.join(base, "x")), false);
      }
    } finally {
      cleanup(base);
    }
  }
});

test("linkTargetStart: win32 roots — a drive-less target is on the link's drive; \\\\?\\ and UNC forms keep their root", () => {
  const lts = (tgt) => projectWrite.linkTargetStart(tgt, "D:\\work\\proj", "win32");
  assert.deepEqual(lts("\\Project\\x"), { start: "D:\\", parts: ["Project", "x"] });
  assert.deepEqual(lts("/Project/x"), { start: "D:\\", parts: ["Project", "x"] });
  assert.deepEqual(lts("C:\\a\\b"), { start: "C:\\", parts: ["a", "b"] });
  assert.deepEqual(lts("\\\\?\\C:\\a\\b"), { start: "C:\\", parts: ["a", "b"] });
  assert.deepEqual(lts("\\??\\C:\\a"), { start: "C:\\", parts: ["a"] });
  assert.deepEqual(lts("\\\\srv\\share\\a"), { start: "\\\\srv\\share\\", parts: ["a"] });
  assert.deepEqual(lts("\\\\?\\UNC\\srv\\share\\a"), { start: "\\\\srv\\share\\", parts: ["a"] });
  assert.deepEqual(lts("..\\x"), { start: "D:\\work\\proj", parts: ["..", "x"] });
  assert.throws(() => lts("C:x"), /relative to a drive's current folder/);
});

test("linkTargetStart: posix — absolute from /, relative from the link's folder, backslash is a plain character", () => {
  const lts = (tgt) => projectWrite.linkTargetStart(tgt, "/w/proj", "posix");
  assert.deepEqual(lts("/a/b"), { start: "/", parts: ["a", "b"] });
  assert.deepEqual(lts("../x"), { start: "/w/proj", parts: ["..", "x"] });
  assert.deepEqual(lts("a\\b"), { start: "/w/proj", parts: ["a\\b"] });
});

// INV-14: Attach writes never leave the project folder
test("attach: a dangling CLAUDE.md → s/../hooks/x with s → .git/info is refused (lands in .git)", (t) => {
  const { base, project } = setup();
  try {
    fs.mkdirSync(path.join(project, ".git", "info"), { recursive: true });
    if (
      !tryLinkFile(".git/info", path.join(project, "s"), "dir") ||
      !tryLinkFile("s/../hooks/x", path.join(project, "CLAUDE.md"))
    ) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    assert.throws(() => attach(project), /CLAUDE\.md is a link to .*inside the project's \.git folder/);
    assert.equal(fs.existsSync(path.join(project, ".git", "hooks", "x")), false);
    assert.equal(fs.existsSync(path.join(project, "hooks", "x")), false);
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: .git/hooks linked to an outside folder gets the hooks there (user's own setup)", () => {
  const { base, project, outside } = setup();
  try {
    const hooks = path.join(project, ".git", "hooks");
    fs.rmSync(hooks, { recursive: true, force: true });
    linkDir(outside, hooks);
    const r = attach(project);
    assert.equal(r.preCommitHook, "created");
    assert.ok(fs.readFileSync(path.join(outside, "pre-commit"), "utf8").includes("verse8-mcp hook pre-commit"));
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: .git linked to an outside git folder gets the hooks there", () => {
  const { base, project, outside } = setup();
  try {
    const gitdir = path.join(outside, "gitdir");
    fs.renameSync(path.join(project, ".git"), gitdir);
    linkDir(gitdir, path.join(project, ".git"));
    const r = attach(project);
    assert.equal(r.commitMsgHook, "created");
    assert.ok(fs.existsSync(path.join(gitdir, "hooks", "commit-msg")));
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: a relative core.hooksPath through a working-tree link out of the project is refused", () => {
  const { base, project, outside } = setup();
  try {
    linkDir(outside, path.join(project, "hooks-link"));
    gitIn(project, "config", "core.hooksPath", "hooks-link");
    assert.throws(() => attach(project), /hooks-link is a link to .*outside the project folder/);
    assert.deepEqual(listTree(outside), []);
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: core.hooksPath outside the project (absolute and relative) gets the hooks only there", () => {
  for (const relative of [false, true]) {
    const { base, project } = setup();
    try {
      const shared = path.join(base, "shared-hooks");
      gitIn(project, "config", "core.hooksPath", relative ? "../shared-hooks" : shared);
      const r = attach(project);
      assert.equal(r.preCommitHook, "created");
      assert.deepEqual(listTree(shared), ["commit-msg", "pre-commit"]);
      assert.equal(fs.existsSync(path.join(project, ".git", "hooks", "pre-commit")), false);
    } finally {
      cleanup(base);
    }
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: .git/hooks linked to another folder inside .git is allowed", () => {
  const { base, project } = setup();
  try {
    const other = path.join(project, ".git", "other-hooks");
    fs.mkdirSync(other);
    fs.rmSync(path.join(project, ".git", "hooks"), { recursive: true, force: true });
    linkDir(other, path.join(project, ".git", "hooks"));
    attach(project);
    assert.ok(fs.existsSync(path.join(other, "pre-commit")));
  } finally {
    cleanup(base);
  }
});

// INV-14: Attach writes never leave the project folder
test("attach: with .git linked to a folder inside the project, a working-tree link into that folder is refused", () => {
  const { base, project } = setup();
  try {
    const store = path.join(project, "gitstore");
    fs.renameSync(path.join(project, ".git"), store);
    linkDir(store, path.join(project, ".git"));
    linkDir(store, path.join(project, ".claude"));
    assert.throws(() => attach(project), /\.claude is a link to .*inside the project's \.git folder/);
    assert.equal(fs.existsSync(path.join(store, "skills")), false);
  } finally {
    cleanup(base);
  }
});

test("unit tests run with the developer's global and system git config switched off", () => {
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1", "run via `npm run test:unit` (preloads tests/setup/isolateGit.cjs)");
  assert.equal(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, "utf8"), "");
});

// Every write on the attach path goes through util/projectWrite.ts. A bare
// fs mutation added to one of these files would bypass the link check.
const ATTACH_PATH_FILES = [
  "tools/attach.ts",
  "tools/skillWriter.ts",
  "context/hooks.ts",
  "context/gitIgnore.ts",
  "context/envFile.ts",
];
const MUTATING_FS = new Set([
  "writeFileSync", "writeFile", "appendFileSync", "appendFile",
  "mkdirSync", "mkdir", "rmSync", "rm", "rmdirSync", "rmdir",
  "unlinkSync", "unlink", "renameSync", "rename", "chmodSync", "chmod",
  "copyFileSync", "copyFile", "cpSync", "cp", "symlinkSync", "symlink",
  "linkSync", "link", "truncateSync", "truncate", "openSync", "open",
  "createWriteStream",
]);
const BYPASS_MODULES = ["atomicWrite.js"];

function bareFsWrites(file) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const fsNames = new Set(); // `import * as fs` / `import fs`
  const direct = new Set(); // `import { writeFileSync } from "node:fs"`
  const hits = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const mod = st.moduleSpecifier.text;
    if (BYPASS_MODULES.some((m) => mod.endsWith(m))) hits.push(`imports ${mod}`);
    if (!/^(node:)?fs(\/promises)?$/.test(mod)) continue;
    const c = st.importClause;
    if (!c) continue;
    if (c.name) fsNames.add(c.name.text);
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) fsNames.add(c.namedBindings.name.text);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
      for (const el of c.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === "promises") fsNames.add(el.name.text);
        else if (MUTATING_FS.has(imported)) direct.add(el.name.text);
      }
    }
  }
  const at = (n) => `line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const rootName = (e) => {
    while (ts.isPropertyAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : null;
  };
  (function visit(n) {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isPropertyAccessExpression(e) && MUTATING_FS.has(e.name.text) && fsNames.has(rootName(e))) {
        hits.push(`${at(n)}: ${e.getText()}`);
      } else if (ts.isIdentifier(e) && direct.has(e.text)) {
        hits.push(`${at(n)}: ${e.text}`);
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
  return hits;
}

// INV-14: Attach writes never leave the project folder
test("attach path: no bare fs write, mkdir, delete or rename outside util/projectWrite.ts", () => {
  const offenders = [];
  for (const rel of ATTACH_PATH_FILES) {
    for (const hit of bareFsWrites(path.join(SRC_ROOT, rel))) offenders.push(`src/${rel} ${hit}`);
  }
  assert.deepEqual(offenders, [], `route these through projectWriter():\n${offenders.join("\n")}`);
});

test("attach path source check: catches a bare write (self-test)", () => {
  const dir = mkRoot();
  try {
    const f = path.join(dir, "x.ts");
    fs.writeFileSync(
      f,
      'import * as fs from "node:fs";\nimport { rmSync as r } from "fs";\nimport { atomicWriteFileSync } from "../util/atomicWrite.js";\nfs.writeFileSync("a", "b");\nfs.promises.rename("a", "b");\nr("a");\nfs.readFileSync("a");\n',
    );
    assert.equal(bareFsWrites(f).length, 4);
  } finally {
    cleanup(dir);
  }
});
