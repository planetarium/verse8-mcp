import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureVerse8GitIgnore } from "../../dist/context/gitIgnore.js";

const REQUIRED = [
  "preview.log",
  "mcp.log",
  "mcp.log.*",
  "mcp.log.link",
  "*.env.tmp-*",
  ".env.tmp-*",
];

function withTmpProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-gitignore-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("gitIgnore: created on fresh project", () => {
  withTmpProject((dir) => {
    const r = ensureVerse8GitIgnore(dir);
    assert.equal(r.status, "created");
    const body = fs.readFileSync(r.path, "utf8");
    for (const e of REQUIRED) assert.match(body, new RegExp(`^${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });
});

test("gitIgnore: idempotent re-run returns already-present", () => {
  withTmpProject((dir) => {
    ensureVerse8GitIgnore(dir);
    const r2 = ensureVerse8GitIgnore(dir);
    assert.equal(r2.status, "already-present");
  });
});

test("gitIgnore: existing user entries preserved on update", () => {
  withTmpProject((dir) => {
    const verse8 = path.join(dir, ".verse8");
    fs.mkdirSync(verse8, { recursive: true });
    const target = path.join(verse8, ".gitignore");
    fs.writeFileSync(target, "# user wrote this\nmy-personal-cache/\n");
    const r = ensureVerse8GitIgnore(dir);
    assert.equal(r.status, "updated");
    const body = fs.readFileSync(target, "utf8");
    assert.match(body, /my-personal-cache\//);
    for (const e of REQUIRED) assert.match(body, new RegExp(`^${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });
});

test("gitIgnore: no duplicate entries when partial coverage already exists", () => {
  withTmpProject((dir) => {
    const verse8 = path.join(dir, ".verse8");
    fs.mkdirSync(verse8, { recursive: true });
    const target = path.join(verse8, ".gitignore");
    fs.writeFileSync(target, "preview.log\nmcp.log\n");
    const r = ensureVerse8GitIgnore(dir);
    assert.equal(r.status, "updated");
    const body = fs.readFileSync(target, "utf8");
    for (const e of REQUIRED) {
      const matches = body.match(new RegExp(`^${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm")) ?? [];
      assert.equal(matches.length, 1, `${e} appeared ${matches.length} times`);
    }
  });
});

test("gitIgnore: re-run after update is already-present", () => {
  withTmpProject((dir) => {
    const verse8 = path.join(dir, ".verse8");
    fs.mkdirSync(verse8, { recursive: true });
    fs.writeFileSync(path.join(verse8, ".gitignore"), "preview.log\n");
    ensureVerse8GitIgnore(dir);
    const r2 = ensureVerse8GitIgnore(dir);
    assert.equal(r2.status, "already-present");
  });
});

test("gitIgnore: file mode is 0644", () => {
  if (process.platform === "win32") return;
  withTmpProject((dir) => {
    const r = ensureVerse8GitIgnore(dir);
    const mode = fs.statSync(r.path).mode & 0o777;
    assert.equal(mode, 0o644);
  });
});
