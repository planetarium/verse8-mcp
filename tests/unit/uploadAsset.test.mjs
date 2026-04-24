import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  runUploadAsset,
  uploadAssetInputSchema,
} from "../../dist/tools/uploadAsset.js";

// Build a minimal attached verse8 project in a temp dir:
//   - git init + verse8-flavored origin
//   - .verse8/project.json marker
//   - .env with VITE_AGENT8_VERSE
//   - commit-msg + pre-commit hook stubs with the verse8-mcp signatures
//   - AGENTS.md with the verse8-mcp marker
// This lets detectVerseProject / detectAttachment succeed without full attach.
function makeAttachedProject(envVerse) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-upload-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git"],
    { cwd: dir },
  );
  fs.mkdirSync(path.join(dir, ".verse8"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".verse8", "project.json"),
    JSON.stringify({
      version: 1,
      projectId: "demo",
      attachedAt: new Date().toISOString(),
    }),
  );
  if (envVerse !== null) {
    fs.writeFileSync(
      path.join(dir, ".env"),
      `VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=${envVerse}\n`,
    );
  }
  const hooksDir = path.join(dir, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    "#!/bin/sh\n# verse8-mcp hook pre-commit\nexit 0\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(hooksDir, "commit-msg"),
    "#!/bin/sh\n# verse8-mcp hook commit-msg\nexit 0\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    "<!-- verse8-mcp attached -->\n# Agents\n",
  );
  return dir;
}

function withToken(value, fn) {
  const home = process.env.HOME;
  const tokenDir = path.join(home, ".config", "verse8");
  const tokenPath = path.join(tokenDir, "token");
  const existed = fs.existsSync(tokenPath);
  const backup = existed ? fs.readFileSync(tokenPath) : null;
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(tokenPath, value);
  return Promise.resolve(fn()).finally(() => {
    if (backup !== null) fs.writeFileSync(tokenPath, backup);
    else fs.unlinkSync(tokenPath);
  });
}

function withoutToken(fn) {
  const home = process.env.HOME;
  const tokenPath = path.join(home, ".config", "verse8", "token");
  const existed = fs.existsSync(tokenPath);
  const backup = existed ? fs.readFileSync(tokenPath) : null;
  if (existed) fs.unlinkSync(tokenPath);
  return Promise.resolve(fn()).finally(() => {
    if (backup !== null) fs.writeFileSync(tokenPath, backup);
  });
}

function withFetch(handler, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = saved;
  });
}

test("schema: category alone is valid", () => {
  const parsed = uploadAssetInputSchema.parse({
    filePath: "/tmp/a.png",
    category: "image",
  });
  assert.equal(parsed.category, "image");
});

test("schema: neither category nor cdnPath is invalid", () => {
  assert.throws(() => {
    uploadAssetInputSchema.parse({ filePath: "/tmp/a.png" });
  });
});

test("schema: both category and cdnPath is invalid", () => {
  assert.throws(() => {
    uploadAssetInputSchema.parse({
      filePath: "/tmp/a.png",
      category: "image",
      cdnPath: "assets/custom",
    });
  });
});

test("runUploadAsset: not_a_verse_project", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-plain-"));
  try {
    const r = await runUploadAsset(
      { filePath: "a.png", category: "image", projectDir: dir },
      dir,
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_a_verse_project");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: not_logged_in when no token", async () => {
  const dir = makeAttachedProject("v1");
  try {
    await withoutToken(async () => {
      const r = await runUploadAsset(
        { filePath: "a.png", category: "image", projectDir: dir },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "not_logged_in");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: missing_verse_env", async () => {
  const dir = makeAttachedProject(null);
  try {
    await withToken("test-token", async () => {
      const r = await runUploadAsset(
        { filePath: "a.png", category: "image", projectDir: dir },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "missing_verse_env");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: invalid_extension", async () => {
  const dir = makeAttachedProject("v1");
  try {
    fs.writeFileSync(path.join(dir, "bad.exe"), "x");
    await withToken("test-token", async () => {
      const r = await runUploadAsset(
        {
          filePath: path.join(dir, "bad.exe"),
          category: "image",
          projectDir: dir,
        },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "invalid_extension");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: file_not_found", async () => {
  const dir = makeAttachedProject("v1");
  try {
    await withToken("test-token", async () => {
      const r = await runUploadAsset(
        {
          filePath: path.join(dir, "ghost.png"),
          category: "image",
          projectDir: dir,
        },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "file_not_found");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: happy path returns url and resolved cdnPath", async () => {
  const dir = makeAttachedProject("v1");
  try {
    const src = path.join(dir, "a.png");
    fs.writeFileSync(src, new Uint8Array([137, 80, 78, 71]));
    await withToken("test-token", async () => {
      let sawFormBody = false;
      await withFetch(
        async (url, init) => {
          assert.ok(String(url).endsWith("/api/upload-attachment"));
          sawFormBody = init.body instanceof FormData;
          return new Response(
            JSON.stringify({
              success: true,
              url: "https://agent8-games.verse8.io/v1/assets/images/x.png",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
        async () => {
          const r = await runUploadAsset(
            { filePath: src, category: "image", projectDir: dir },
            dir,
          );
          assert.equal(r.ok, true);
          assert.equal(r.cdnPath, "assets/images");
          assert.equal(r.verse, "v1");
          assert.equal(
            r.url,
            "https://agent8-games.verse8.io/v1/assets/images/x.png",
          );
          assert.equal(r.filename, "a.png");
          assert.equal(r.sizeBytes, 4);
          assert.equal(r.contentType, "image/png");
        },
      );
      assert.equal(sawFormBody, true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: cdn_path_invalid when leading slash", async () => {
  const dir = makeAttachedProject("v1");
  try {
    const src = path.join(dir, "a.png");
    fs.writeFileSync(src, new Uint8Array([0]));
    await withToken("test-token", async () => {
      const r = await runUploadAsset(
        { filePath: src, cdnPath: "/assets/x", projectDir: dir },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "cdn_path_invalid");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: upload backend 401 -> unauthorized", async () => {
  const dir = makeAttachedProject("v1");
  try {
    const src = path.join(dir, "a.png");
    fs.writeFileSync(src, new Uint8Array([0]));
    await withToken("test-token", async () => {
      await withFetch(
        async () => new Response("Unauthorized", { status: 401 }),
        async () => {
          const r = await runUploadAsset(
            { filePath: src, category: "image", projectDir: dir },
            dir,
          );
          assert.equal(r.ok, false);
          assert.equal(r.error, "unauthorized");
        },
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
