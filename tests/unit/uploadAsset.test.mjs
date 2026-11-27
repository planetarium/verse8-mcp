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

// Token fixtures live in a private XDG_CONFIG_HOME, never in the real
// ~/.config/verse8/token: other test files run in parallel and read that
// path, and a developer's own login lives there.
// VERSE8_ACCESS_TOKEN wins over every token file, so a developer's own
// value would replace the fixture (or turn "no token" into a token, and show
// up in a failed assertion): it is taken out and put back after.
function withConfigHome(value, fn) {
  const saved = process.env.XDG_CONFIG_HOME;
  const savedEnvToken = process.env.VERSE8_ACCESS_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-upload-xdg-"));
  if (value !== null) {
    fs.mkdirSync(path.join(dir, "verse8"), { recursive: true });
    fs.writeFileSync(path.join(dir, "verse8", "token"), value, { mode: 0o600 });
  }
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.VERSE8_ACCESS_TOKEN;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      if (savedEnvToken === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
      else process.env.VERSE8_ACCESS_TOKEN = savedEnvToken;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function withToken(value, fn) {
  return withConfigHome(value, fn);
}

function withoutToken(fn) {
  return withConfigHome(null, fn);
}

function withFetch(handler, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = saved;
  });
}

test("schema: filePath + cdnPath is valid", () => {
  const parsed = uploadAssetInputSchema.parse({
    filePath: "/tmp/a.png",
    cdnPath: "assets/images",
  });
  assert.equal(parsed.cdnPath, "assets/images");
});

test("schema: missing cdnPath is invalid", () => {
  assert.throws(() => {
    uploadAssetInputSchema.parse({ filePath: "/tmp/a.png" });
  });
});

test("schema: category field is rejected (removed, strict schema)", () => {
  assert.throws(() => {
    uploadAssetInputSchema.parse({
      filePath: "/tmp/a.png",
      cdnPath: "assets/images",
      category: "image",
    });
  });
});

test("runUploadAsset: not_a_verse_project", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-plain-"));
  try {
    const r = await runUploadAsset(
      { filePath: "a.png", cdnPath: "assets/images", projectDir: dir },
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
        { filePath: "a.png", cdnPath: "assets/images", projectDir: dir },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "not_logged_in");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: a developer's VERSE8_ACCESS_TOKEN does not leak into the no-token test", async () => {
  const dir = makeAttachedProject("v1");
  const saved = process.env.VERSE8_ACCESS_TOKEN;
  process.env.VERSE8_ACCESS_TOKEN = "dev-env-token";
  try {
    await withoutToken(async () => {
      const r = await runUploadAsset({ filePath: "a.png", cdnPath: "assets/images", projectDir: dir }, dir);
      assert.equal(r.error, "not_logged_in");
    });
    assert.equal(process.env.VERSE8_ACCESS_TOKEN, "dev-env-token", "restored after the helper");
  } finally {
    if (saved === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runUploadAsset: missing_verse_env", async () => {
  const dir = makeAttachedProject(null);
  try {
    await withToken("test-token", async () => {
      const r = await runUploadAsset(
        { filePath: "a.png", cdnPath: "assets/images", projectDir: dir },
        dir,
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "missing_verse_env");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MCP-UP-3: `ATTACHMENT_EXTS` is the pre-network extension gate
test("runUploadAsset: invalid_extension", async () => {
  const dir = makeAttachedProject("v1");
  try {
    fs.writeFileSync(path.join(dir, "bad.exe"), "x");
    await withToken("test-token", async () => {
      const r = await runUploadAsset(
        {
          filePath: path.join(dir, "bad.exe"),
          cdnPath: "assets/images",
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
          cdnPath: "assets/images",
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

// MCP-UP-1: `verse8_upload_asset` hits only the allow-listed backend
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
            { filePath: src, cdnPath: "assets/images", projectDir: dir },
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
            { filePath: src, cdnPath: "assets/images", projectDir: dir },
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
