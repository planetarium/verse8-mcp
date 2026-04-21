import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { detectAttachment } from "../../dist/context/attachment.js";
import { resolveHooksDir } from "../../dist/context/hooks.js";

const PRE_COMMIT_DISPATCH = '#!/bin/sh\nexec verse8-mcp hook pre-commit "$@"\n';
const COMMIT_MSG_DISPATCH = '#!/bin/sh\nexec verse8-mcp hook commit-msg "$@"\n';
const AGENTS_DOC_BODY =
  "# Project guidance\n\nCommit via `verse8_checkpoint` — powered by verse8-mcp.\n";

function mkGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-attachment-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function writeHookFile(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, body, { mode: 0o755 });
  return full;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test("attachment: no .git directory → attached:false, graceful", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-attachment-nogit-"));
  try {
    const state = detectAttachment(root);
    assert.equal(state.attached, false);
    assert.ok(state.missing.length > 0);
  } finally {
    cleanup(root);
  }
});

test("attachment: both hooks + AGENTS.md → attached:true", () => {
  const root = mkGitRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    writeHookFile(hooksDir, "pre-commit", PRE_COMMIT_DISPATCH);
    writeHookFile(hooksDir, "commit-msg", COMMIT_MSG_DISPATCH);
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_DOC_BODY);
    const state = detectAttachment(root);
    assert.equal(state.attached, true);
    assert.equal(state.missing.length, 0);
    assert.equal(state.checks.preCommitHook, true);
    assert.equal(state.checks.commitMsgHook, true);
    assert.equal(state.checks.agentsDoc, true);
  } finally {
    cleanup(root);
  }
});

test("attachment: CLAUDE.md satisfies the agents-doc check", () => {
  const root = mkGitRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    writeHookFile(hooksDir, "pre-commit", PRE_COMMIT_DISPATCH);
    writeHookFile(hooksDir, "commit-msg", COMMIT_MSG_DISPATCH);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), AGENTS_DOC_BODY);
    const state = detectAttachment(root);
    assert.equal(state.attached, true);
    assert.equal(state.checks.agentsDoc, true);
  } finally {
    cleanup(root);
  }
});

test("attachment: AGENTS.md without verse8-mcp signature → attached:false (false-positive reject)", () => {
  const root = mkGitRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    writeHookFile(hooksDir, "pre-commit", PRE_COMMIT_DISPATCH);
    writeHookFile(hooksDir, "commit-msg", COMMIT_MSG_DISPATCH);
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      "# Some unrelated docs\nThis project is not a verse8 project.\n",
    );
    const state = detectAttachment(root);
    assert.equal(state.attached, false);
    assert.equal(state.checks.agentsDoc, false);
    assert.ok(state.missing.includes("AGENTS.md"));
  } finally {
    cleanup(root);
  }
});

test("attachment: missing hooks dir entirely → attached:false, no throw", () => {
  const root = mkGitRepo();
  try {
    // Replace .git/hooks with a non-directory file so the hook read paths
    // fail but detectAttachment does not throw.
    const hooksDir = path.join(root, ".git", "hooks");
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_DOC_BODY);
    assert.doesNotThrow(() => detectAttachment(root));
    const state = detectAttachment(root);
    assert.equal(state.attached, false);
    assert.equal(state.checks.preCommitHook, false);
    assert.equal(state.checks.commitMsgHook, false);
  } finally {
    cleanup(root);
  }
});

test("attachment: pre-commit only (no commit-msg) → attached:false", () => {
  const root = mkGitRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    writeHookFile(hooksDir, "pre-commit", PRE_COMMIT_DISPATCH);
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_DOC_BODY);
    const state = detectAttachment(root);
    assert.equal(state.attached, false);
    assert.equal(state.checks.preCommitHook, true);
    assert.equal(state.checks.commitMsgHook, false);
  } finally {
    cleanup(root);
  }
});

test("attachment: hooks present + AGENTS.md missing → partial, attached:false", () => {
  const root = mkGitRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    writeHookFile(hooksDir, "pre-commit", PRE_COMMIT_DISPATCH);
    writeHookFile(hooksDir, "commit-msg", COMMIT_MSG_DISPATCH);
    const state = detectAttachment(root);
    assert.equal(state.attached, false);
    assert.equal(state.checks.agentsDoc, false);
    assert.ok(state.missing.includes("AGENTS.md"));
  } finally {
    cleanup(root);
  }
});

test("attachment: alternate pre-commit body still signature-detected when it invokes verse8-mcp", () => {
  const root = mkGitRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    writeHookFile(
      hooksDir,
      "pre-commit",
      '#!/bin/sh\n# user comment\nverse8-mcp hook pre-commit "$@" || exit 1\n',
    );
    writeHookFile(hooksDir, "commit-msg", COMMIT_MSG_DISPATCH);
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_DOC_BODY);
    const state = detectAttachment(root);
    assert.equal(state.checks.preCommitHook, true);
    assert.equal(state.attached, true);
  } finally {
    cleanup(root);
  }
});

test("attachment: resolveHooksDir honors absolute core.hooksPath", () => {
  const root = mkGitRepo();
  const hooksCustom = fs.mkdtempSync(
    path.join(os.tmpdir(), "verse8-attachment-customhooks-"),
  );
  try {
    execFileSync("git", ["config", "core.hooksPath", hooksCustom], {
      cwd: root,
    });
    writeHookFile(hooksCustom, "pre-commit", PRE_COMMIT_DISPATCH);
    writeHookFile(hooksCustom, "commit-msg", COMMIT_MSG_DISPATCH);
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_DOC_BODY);
    assert.equal(resolveHooksDir(root), hooksCustom);
    const state = detectAttachment(root);
    assert.equal(state.attached, true);
    assert.equal(state.checks.preCommitHook, true);
    assert.equal(state.checks.commitMsgHook, true);
  } finally {
    cleanup(root);
    cleanup(hooksCustom);
  }
});

test("attachment: resolveHooksDir resolves a relative core.hooksPath against repo root", () => {
  const root = mkGitRepo();
  try {
    const rel = ".husky";
    const absolute = path.join(root, rel);
    execFileSync("git", ["config", "core.hooksPath", rel], { cwd: root });
    writeHookFile(absolute, "pre-commit", PRE_COMMIT_DISPATCH);
    writeHookFile(absolute, "commit-msg", COMMIT_MSG_DISPATCH);
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_DOC_BODY);
    const resolved = resolveHooksDir(root);
    // Either the absolute path joined with repo root, or the repo-root
    // prefixed resolution — both are acceptable. We only require that the
    // hooks were located.
    assert.ok(fs.existsSync(path.join(resolved, "pre-commit")));
    const state = detectAttachment(root);
    assert.equal(state.attached, true);
  } finally {
    cleanup(root);
  }
});

test("attachment: hook file with verse8-mcp substring but wrong signature still detected as verse8 dispatcher", () => {
  // Defence-in-depth: signature check greps 'verse8-mcp hook pre-commit'
  // substring. A hook that dispatches via verse8-mcp with extra args is
  // still detected, but an arbitrary verse8-mcp reference in a non-hook
  // position is not detected as pre-commit.
  const root = mkGitRepo();
  try {
    const hooksDir = path.join(root, ".git", "hooks");
    writeHookFile(
      hooksDir,
      "pre-commit",
      "#!/bin/sh\n# mention of verse8-mcp in docs\necho hi\n",
    );
    writeHookFile(hooksDir, "commit-msg", COMMIT_MSG_DISPATCH);
    fs.writeFileSync(path.join(root, "AGENTS.md"), AGENTS_DOC_BODY);
    const state = detectAttachment(root);
    // pre-commit lacks the "verse8-mcp hook pre-commit" signature → not
    // detected.
    assert.equal(state.checks.preCommitHook, false);
    assert.equal(state.attached, false);
  } finally {
    cleanup(root);
  }
});
