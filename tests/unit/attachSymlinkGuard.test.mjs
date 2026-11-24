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
import { addHashMarker } from "../../dist/tools/skillWriter.js";

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

/** File link; false when the OS refuses (Windows without symlink privilege). */
function tryLinkFile(target, link) {
  try {
    fs.symlinkSync(target, link, "file");
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
test("attach: AGENTS.md as a dangling link is refused and nothing appears where it points", (t) => {
  const { base, project, outside } = setup();
  try {
    const target = path.join(outside, "planted.md");
    if (!tryLinkFile(target, path.join(project, "AGENTS.md"))) {
      t.skip("file symlinks need privilege on this Windows host");
      return;
    }
    assert.throws(() => attach(project), /AGENTS\.md is a link to .*which does not exist/);
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
