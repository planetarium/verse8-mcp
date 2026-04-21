// Unit tests for the Web Editor URL derivation used by verse8_preview.
//
// The helpers live in src/tools/preview.ts. We test them against dist/ so
// the compiled output is what's exercised.
//
// Covers:
//   - deriveProjectPathFromOrigin: https / https+oauth / ssh / non-gitlab / no-origin
//   - buildWebEditorLink: URL encoding of path segments with timestamps
//   - VERSE8_CREATE_URL override + host allow-list

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  deriveProjectPathFromOrigin,
  buildWebEditorLink,
} from "../../dist/tools/preview.js";

function makeGitRepoWithOrigin(originUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-preview-test-"));
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", originUrl], { stdio: "ignore" });
  return dir;
}

test("deriveProjectPathFromOrigin: https gitlab.verse8.io URL", () => {
  const dir = makeGitRepoWithOrigin(
    "https://gitlab.verse8.io/yixxiy/simple-gomoku-game-1776684071022.git",
  );
  try {
    assert.equal(
      deriveProjectPathFromOrigin(dir),
      "yixxiy/simple-gomoku-game-1776684071022",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveProjectPathFromOrigin: oauth-embedded URL strips token and .git", () => {
  const dir = makeGitRepoWithOrigin(
    "https://oauth2:glpat-XXXXXXXX@gitlab.verse8.io/user/proj-ts.git",
  );
  try {
    assert.equal(deriveProjectPathFromOrigin(dir), "user/proj-ts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveProjectPathFromOrigin: ssh style git@host:path", () => {
  const dir = makeGitRepoWithOrigin(
    "git@gitlab.verse8.io:user/proj-ts.git",
  );
  try {
    assert.equal(deriveProjectPathFromOrigin(dir), "user/proj-ts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveProjectPathFromOrigin: non-gitlab host returns null", () => {
  const dir = makeGitRepoWithOrigin("https://github.com/user/repo.git");
  try {
    assert.equal(deriveProjectPathFromOrigin(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveProjectPathFromOrigin: file:// fixture returns null", () => {
  const dir = makeGitRepoWithOrigin("file:///tmp/verse8-smoke-bundle.git");
  try {
    assert.equal(deriveProjectPathFromOrigin(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveProjectPathFromOrigin: directory with no git returns null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-preview-nogit-"));
  try {
    assert.equal(deriveProjectPathFromOrigin(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveProjectPathFromOrigin: deeply nested path (group/subgroup/repo)", () => {
  const dir = makeGitRepoWithOrigin(
    "https://gitlab.verse8.io/org/team/repo.git",
  );
  try {
    assert.equal(deriveProjectPathFromOrigin(dir), "org/team/repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildWebEditorLink: encodes slash as %2F", () => {
  const link = buildWebEditorLink("yixxiy/simple-gomoku-game-1776684071022");
  assert.equal(link.projectPath, "yixxiy/simple-gomoku-game-1776684071022");
  assert.equal(
    link.url,
    "https://create.verse8.io/creator/editor?chat=yixxiy%2Fsimple-gomoku-game-1776684071022",
  );
});

test("buildWebEditorLink: VERSE8_CREATE_URL override (.verse8.io) is honored", () => {
  const saved = process.env.VERSE8_CREATE_URL;
  process.env.VERSE8_CREATE_URL = "https://staging-create.verse8.io";
  try {
    const link = buildWebEditorLink("user/proj");
    assert.equal(
      link.url,
      "https://staging-create.verse8.io/creator/editor?chat=user%2Fproj",
    );
  } finally {
    if (saved === undefined) delete process.env.VERSE8_CREATE_URL;
    else process.env.VERSE8_CREATE_URL = saved;
  }
});

test("buildWebEditorLink: hostile VERSE8_CREATE_URL falls back to default", () => {
  const savedUrl = process.env.VERSE8_CREATE_URL;
  const originalError = console.error;
  console.error = () => {};
  process.env.VERSE8_CREATE_URL = "https://evil.example.com";
  try {
    const link = buildWebEditorLink("user/proj");
    assert.equal(
      link.url,
      "https://create.verse8.io/creator/editor?chat=user%2Fproj",
    );
  } finally {
    console.error = originalError;
    if (savedUrl === undefined) delete process.env.VERSE8_CREATE_URL;
    else process.env.VERSE8_CREATE_URL = savedUrl;
  }
});

test("buildWebEditorLink: trailing slash in VERSE8_CREATE_URL is normalized", () => {
  const saved = process.env.VERSE8_CREATE_URL;
  process.env.VERSE8_CREATE_URL = "https://create.verse8.io/";
  try {
    const link = buildWebEditorLink("u/p");
    assert.equal(link.url, "https://create.verse8.io/creator/editor?chat=u%2Fp");
  } finally {
    if (saved === undefined) delete process.env.VERSE8_CREATE_URL;
    else process.env.VERSE8_CREATE_URL = saved;
  }
});
