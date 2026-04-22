import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { runAttach } from "../../dist/tools/attach.js";

// Regression: a freshly-cloned gitlab.verse8.io project has origin set
// but no .verse8/project.json marker yet. Pre-0.5.6 the attach gate
// AND-ed detectVerseProject (which required the marker) with a redundant
// hasMarker check, so fresh clones were rejected with
// "not_a_verse_project" — while verse8_bootstrap classified the same
// workspace as "unattached_clone" and routed to attach. The two gates
// have to agree.

function setupFreshClone(origin) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-fresh-clone-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
  return root;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test("runAttach: fresh gitlab.verse8.io clone with NO marker attaches successfully (HTTPS origin)", async () => {
  const root = setupFreshClone("https://gitlab.verse8.io/u/p.git");
  try {
    assert.equal(
      fs.existsSync(path.join(root, ".verse8", "project.json")),
      false,
      "precondition: marker must not exist",
    );

    const result = await runAttach({}, root);
    assert.equal(result.ok, true, `attach should succeed, got: ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.equal(result.installed.projectMarker, "created");
      assert.equal(result.installed.preCommitHook, "created");
    }
  } finally {
    cleanup(root);
  }
});

test("runAttach: fresh gitlab.verse8.io clone with NO marker attaches successfully (SSH origin)", async () => {
  const root = setupFreshClone("git@gitlab.verse8.io:u/p.git");
  try {
    const result = await runAttach({}, root);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.installed.projectMarker, "created");
    }
  } finally {
    cleanup(root);
  }
});

test("runAttach: non-verse origin (github.com) without marker is rejected with not_a_verse_project", async () => {
  const root = setupFreshClone("https://github.com/u/p.git");
  try {
    const result = await runAttach({}, root);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "not_a_verse_project");
      assert.match(result.hint, /originHost=github\.com/);
      assert.match(result.hint, /hasMarker=false/);
    }
  } finally {
    cleanup(root);
  }
});

test("runAttach: marker-only (no git origin set) still attaches — legacy marker path preserved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-marker-only-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    // No origin; marker present.
    fs.mkdirSync(path.join(root, ".verse8"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".verse8", "project.json"),
      JSON.stringify({ version: 1, projectId: "legacy-42" }) + "\n",
    );
    const result = await runAttach({}, root);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.installed.projectMarker, "already-present");
    }
  } finally {
    cleanup(root);
  }
});
