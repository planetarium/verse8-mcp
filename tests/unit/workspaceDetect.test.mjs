import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { detectWorkspace } from "../../dist/context/workspace.js";

const PRE_COMMIT = '#!/bin/sh\nexec verse8-mcp hook pre-commit "$@"\n';
const COMMIT_MSG = '#!/bin/sh\nexec verse8-mcp hook commit-msg "$@"\n';
const AGENTS_BODY = "# verse8-mcp guidance\nUse verse8_checkpoint.\n";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-ws-"));
}
function cleanup(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
function writeHook(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
}
function writeMarker(root, projectId = "abc123") {
  fs.mkdirSync(path.join(root, ".verse8"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".verse8", "project.json"),
    JSON.stringify({ version: 1, projectId, attachedAt: "2026-04-21T00:00:00Z" }) + "\n",
  );
}
function installVerseAttachArtifacts(root) {
  const hooks = path.join(root, ".git", "hooks");
  writeHook(hooks, "pre-commit", PRE_COMMIT);
  writeHook(hooks, "commit-msg", COMMIT_MSG);
  fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_BODY);
  writeMarker(root);
}

test("detectWorkspace: empty dir (no .git) → empty", () => {
  const root = tmpdir();
  try {
    const w = detectWorkspace(root);
    assert.equal(w.hasGit, false);
    assert.equal(w.originHost, null);
    assert.equal(w.hasProjectMarker, false);
    assert.equal(w.attached, false);
    assert.equal(w.workspaceMode, "empty");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: git repo without origin → non_verse_dir", () => {
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const w = detectWorkspace(root);
    assert.equal(w.hasGit, true);
    assert.equal(w.originHost, null);
    assert.equal(w.workspaceMode, "non_verse_dir");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: git repo with github.com origin → non_verse_dir", () => {
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/foo/bar.git"], {
      cwd: root,
    });
    const w = detectWorkspace(root);
    assert.equal(w.hasGit, true);
    assert.equal(w.originHost, "github.com");
    assert.equal(w.workspaceMode, "non_verse_dir");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: gitlab.verse8.io origin, no marker, no hooks → unattached_clone", () => {
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
      { cwd: root },
    );
    const w = detectWorkspace(root);
    assert.equal(w.hasGit, true);
    assert.equal(w.originHost, "gitlab.verse8.io");
    assert.equal(w.hasProjectMarker, false);
    assert.equal(w.attached, false);
    assert.equal(w.workspaceMode, "unattached_clone");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: gitlab.verse8.io origin + marker but no hooks → unattached_clone", () => {
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
      { cwd: root },
    );
    writeMarker(root);
    const w = detectWorkspace(root);
    assert.equal(w.hasProjectMarker, true);
    assert.equal(w.attached, false);
    assert.equal(w.workspaceMode, "unattached_clone");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: fully attached verse8 project → attached", () => {
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
      { cwd: root },
    );
    installVerseAttachArtifacts(root);
    const w = detectWorkspace(root);
    assert.equal(w.hasProjectMarker, true);
    assert.equal(w.attached, true);
    assert.equal(w.workspaceMode, "attached");
    assert.equal(w.projectId, "abc123");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: marker present but origin missing → unattached_clone (marker-only project)", () => {
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeMarker(root);
    const w = detectWorkspace(root);
    assert.equal(w.hasProjectMarker, true);
    assert.equal(w.originHost, null);
    assert.equal(w.workspaceMode, "unattached_clone");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: SSH origin form git@gitlab.verse8.io:u/p.git parsed correctly", () => {
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@gitlab.verse8.io:u/p.git"],
      { cwd: root },
    );
    const w = detectWorkspace(root);
    assert.equal(w.originHost, "gitlab.verse8.io");
    assert.equal(w.workspaceMode, "unattached_clone");
  } finally {
    cleanup(root);
  }
});

test("detectWorkspace: hooks + AGENTS.md present but marker missing → not attached", () => {
  // Attachment detection checks hooks + AGENTS.md signature; without the
  // marker the detector still says "unattached_clone" because classification
  // prefers origin host as the verse-ness signal and marker is absent.
  const root = tmpdir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://gitlab.verse8.io/u/p.git"],
      { cwd: root },
    );
    const hooks = path.join(root, ".git", "hooks");
    writeHook(hooks, "pre-commit", PRE_COMMIT);
    writeHook(hooks, "commit-msg", COMMIT_MSG);
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_BODY);
    // No marker.
    const w = detectWorkspace(root);
    assert.equal(w.hasProjectMarker, false);
    assert.equal(w.attached, true); // hooks + AGENTS.md satisfy detectAttachment
    // classify() requires marker for "attached" mode; falls through to
    // unattached_clone because origin host is gitlab.verse8.io.
    assert.equal(w.workspaceMode, "unattached_clone");
  } finally {
    cleanup(root);
  }
});
