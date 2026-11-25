import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  _resetLibraryCacheForTests,
  assetsInputSchema,
  runAssets,
} from "../../dist/tools/assets.js";
import {
  generateAssetKey,
  fileNameFromUrl,
  imageSize,
} from "../../dist/format/assetsManifest.js";

// A minimal attached verse8 project (same fixture as uploadAsset.test.mjs).
function makeAttachedProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-assets-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git"], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".verse8"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".verse8", "project.json"),
    JSON.stringify({ version: 1, projectId: "demo", attachedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(path.join(dir, ".env"), "VITE_AGENT8_ACCOUNT=0xabc\nVITE_AGENT8_VERSE=v1\n");
  const hooksDir = path.join(dir, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\n# verse8-mcp hook pre-commit\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, "commit-msg"), "#!/bin/sh\n# verse8-mcp hook commit-msg\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "<!-- verse8-mcp attached -->\n# Agents\n");
  return dir;
}

// Token in a private XDG_CONFIG_HOME, never the real home config.
async function withToken(fn) {
  const saved = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-assets-xdg-"));
  fs.mkdirSync(path.join(dir, "verse8"), { recursive: true });
  fs.writeFileSync(path.join(dir, "verse8", "token"), "test-token", { mode: 0o600 });
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withFetch(handler, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const LIB_ITEMS = [
  { id: "r1", url: "https://cdn.example/lib/Knight%20Hero.glb", description: "knight", metadata: { tags: ["3d", "characters"] } },
  { id: "r2", url: "https://cdn.example/lib/orc.glb?v=2", description: "orc", metadata: {} },
  // The live backend sends numeric ids.
  { id: 44456, url: "https://cdn.example/lib/girl.glb", description: "girl", metadata: {} },
];

function libraryFetch(seen) {
  return async (url, init) => {
    seen.push({ url: String(url), init });
    return json({ success: true, data: LIB_ITEMS, pagination: { page: 1, limit: 20, total: 2, totalPages: 1, hasNext: false, hasPrev: false } });
  };
}

function manifestPath(dir) {
  return path.join(dir, "src", "assets.json");
}

// A 1×1 PNG header is enough for the size reader.
function pngBytes(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

test("schema: search / add / upload shapes parse; unknown category is rejected", () => {
  assert.ok(assetsInputSchema.parse({ action: "search", category: "3d/characters", keyword: "knight" }));
  assert.ok(assetsInputSchema.parse({ action: "add", ids: ["r1"], categoryPath: ["3d", "characters"] }));
  assert.ok(assetsInputSchema.parse({ action: "upload", files: [{ path: "a.png" }], categoryPath: ["images"] }));
  assert.throws(() => assetsInputSchema.parse({ action: "search", category: "music" }));
});

test("key and file name follow the web panel's helpers", () => {
  assert.equal(generateAssetKey("My Hero (1).glb", 1700000000000), "my_hero_1_1700000000000_1");
  assert.equal(generateAssetKey("___.png", 5, 2), "resource_5_2");
  assert.equal(fileNameFromUrl("https://x/a/Knight%20Hero.glb?v=1"), "Knight Hero.glb");
});

test("imageSize reads png, gif and jpeg headers", () => {
  assert.deepEqual(imageSize(pngBytes(64, 32)), { width: 64, height: 32 });
  const gif = Buffer.alloc(13);
  gif.write("GIF89a", 0, "latin1");
  gif.writeUInt16LE(10, 6);
  gif.writeUInt16LE(20, 8);
  assert.deepEqual(imageSize(gif), { width: 10, height: 20 });
  // SOI, APP0 (len 4), SOF0 (h=7, w=9)
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x07, 0x00, 0x09, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 9, height: 7 });
  assert.equal(imageSize(Buffer.from("<svg/>")), undefined);
});

test("search sends the web panel's query: category tags, page, limit 20, trimmed keyword", async () => {
  _resetLibraryCacheForTests();
  const dir = makeAttachedProject();
  try {
    await withToken(async () => {
      const seen = [];
      await withFetch(libraryFetch(seen), async () => {
        const r = await runAssets({ action: "search", category: "3d/characters", keyword: "  knight ", page: 2 }, dir);
        assert.equal(r.ok, true);
        assert.equal(r.items.length, LIB_ITEMS.length);
        assert.equal(r.pagination.total, 2);
        const blank = await runAssets({ action: "search", category: "2d", keyword: "  " }, dir);
        assert.equal(blank.ok, true);
      });
      const u = new URL(seen[0].url);
      assert.equal(u.pathname, "/api/resources");
      assert.equal(u.searchParams.get("tags"), "3d,characters");
      assert.equal(u.searchParams.get("page"), "2");
      assert.equal(u.searchParams.get("limit"), "20");
      assert.equal(u.searchParams.get("keyword"), "knight");
      assert.equal(new Headers(seen[0].init.headers).get("authorization"), "Bearer test-token");
      const u2 = new URL(seen[1].url);
      assert.equal(u2.searchParams.get("tags"), "2d");
      assert.equal(u2.searchParams.has("keyword"), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("search: success:false from the backend is a failure", async () => {
  const dir = makeAttachedProject();
  try {
    await withToken(() =>
      withFetch(async () => json({ success: false, error: "boom", data: [] }), async () => {
        const r = await runAssets({ action: "search", category: "3d" }, dir);
        assert.equal(r.ok, false);
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("add writes library items in the web shape and keeps existing entries", async () => {
  _resetLibraryCacheForTests();
  const dir = makeAttachedProject();
  try {
    fs.mkdirSync(path.join(dir, "src"));
    const existing = {
      images: { logo: { url: "https://x/logo.png", description: "logo", metadata: {} } },
      "3d": { characters: { old: { url: "https://x/old.glb", description: "old", metadata: { a: 1 } } } },
    };
    fs.writeFileSync(manifestPath(dir), JSON.stringify(existing, null, 2));
    await withToken(() =>
      withFetch(libraryFetch([]), async () => {
        assert.equal((await runAssets({ action: "search", category: "3d/characters" }, dir)).ok, true);
        const r = await runAssets({ action: "add", ids: ["r1", "r2"], categoryPath: ["3d", "characters"] }, dir);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.added.length, 2);
        assert.match(r.added[0].key, /^knight_hero_\d+_1$/);
        assert.match(r.added[1].key, /^orc_\d+_1$/);
        const n = await runAssets({ action: "add", ids: ["44456"], categoryPath: ["girls"] }, dir);
        assert.equal(n.ok, true, JSON.stringify(n));
        assert.equal(n.added[0].id, 44456);
      }),
    );
    const text = fs.readFileSync(manifestPath(dir), "utf8");
    const m = JSON.parse(text);
    assert.equal(text, JSON.stringify(m, null, 2), "saved the web's way: 2-space JSON, no trailing newline");
    assert.deepEqual(m.images, existing.images);
    assert.deepEqual(m["3d"].characters.old, existing["3d"].characters.old);
    const keys = Object.keys(m["3d"].characters).filter((k) => k !== "old");
    assert.equal(keys.length, 2);
    const knight = m["3d"].characters[keys.find((k) => k.startsWith("knight_hero_"))];
    assert.equal(knight.url, LIB_ITEMS[0].url);
    assert.equal(knight.description, "knight");
    assert.deepEqual(knight.metadata.tags, ["3d", "characters"]);
    assert.equal(knight.metadata.source, "resource_pool");
    assert.equal(knight.metadata.original_id, "r1");
    assert.equal(knight.metadata.original_filename, "Knight Hero.glb");
    assert.ok(!Number.isNaN(Date.parse(knight.metadata.imported_at)));
    const girl = Object.values(m.girls)[0];
    assert.equal(girl.metadata.original_id, 44456, "original_id keeps the backend's numeric id, as the web does");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("add: ids not returned by a search are refused and nothing is written", async () => {
  _resetLibraryCacheForTests();
  const dir = makeAttachedProject();
  try {
    const r = await runAssets({ action: "add", ids: ["nope"], categoryPath: ["images"] }, dir);
    assert.equal(r.ok, false);
    assert.equal(r.error, "resource_not_found");
    assert.deepEqual(r.missing, ["nope"]);
    assert.equal(fs.existsSync(manifestPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("add: a categoryPath through an existing asset, or a broken manifest, changes nothing", async () => {
  _resetLibraryCacheForTests();
  const dir = makeAttachedProject();
  try {
    fs.mkdirSync(path.join(dir, "src"));
    const body = JSON.stringify({ hero: { url: "https://x/h.glb", description: "", metadata: {} } }, null, 2);
    fs.writeFileSync(manifestPath(dir), body);
    await withToken(() =>
      withFetch(libraryFetch([]), async () => {
        await runAssets({ action: "search", category: "3d" }, dir);
        const r = await runAssets({ action: "add", ids: ["r1"], categoryPath: ["hero", "x"] }, dir);
        assert.equal(r.error, "asset_category_conflict");
        assert.equal(fs.readFileSync(manifestPath(dir), "utf8"), body);

        fs.writeFileSync(manifestPath(dir), "{ not json");
        const r2 = await runAssets({ action: "add", ids: ["r1"], categoryPath: ["a"] }, dir);
        assert.equal(r2.error, "assets_manifest_invalid");
        assert.equal(fs.readFileSync(manifestPath(dir), "utf8"), "{ not json");

        const r3 = await runAssets({ action: "add", ids: ["r1"], categoryPath: ["__proto__"] }, dir);
        assert.equal(r3.error, "invalid_input");
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MCP-UP-4: asset manifest writes never leave the project folder
test("add: src linked outside the project is refused and the outside file is untouched", async () => {
  _resetLibraryCacheForTests();
  const dir = makeAttachedProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-assets-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "assets.json"), "{}");
    fs.symlinkSync(outside, path.join(dir, "src"), "junction");
    await withToken(() =>
      withFetch(libraryFetch([]), async () => {
        await runAssets({ action: "search", category: "3d" }, dir);
        const r = await runAssets({ action: "add", ids: ["r1"], categoryPath: ["images"] }, dir);
        assert.equal(r.ok, false);
        assert.equal(r.error, "assets_manifest_write_failed");
      }),
    );
    assert.equal(fs.readFileSync(path.join(outside, "assets.json"), "utf8"), "{}");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

function uploadFetch(calls, { failName } = {}) {
  return async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/api/upload-attachment")) {
      const file = init.body.get("file");
      if (file.name === failName) return new Response("nope", { status: 500 });
      return json({ success: true, url: `https://agent8-games.verse8.io/v1/${init.body.get("path")}/uuid-${file.name}` });
    }
    if (u.endsWith("/v1/activity/upload-asset")) return json({ ok: true });
    throw new Error(`unexpected fetch ${u}`);
  };
}

test("upload: several files go to assets/<categoryPath>, are registered the web's way, and the activity is recorded", async () => {
  const dir = makeAttachedProject();
  try {
    fs.writeFileSync(path.join(dir, "hero.png"), pngBytes(64, 32));
    fs.writeFileSync(path.join(dir, "jump.mp3"), Buffer.from([1, 2, 3]));
    const calls = [];
    await withToken(() =>
      withFetch(uploadFetch(calls), async () => {
        const r = await runAssets(
          {
            action: "upload",
            categoryPath: ["images"],
            files: [{ path: "hero.png", description: "the hero" }, { path: path.join(dir, "jump.mp3") }],
          },
          dir,
        );
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.added.length, 2);
        assert.equal(r.failed.length, 0);
        assert.equal(r.activityRecorded, true);
        assert.equal(r.cdnPath, "assets/images");
      }),
    );
    const uploads = calls.filter((c) => c.url.endsWith("/api/upload-attachment"));
    assert.equal(uploads.length, 2);
    for (const c of uploads) {
      assert.equal(c.init.body.get("path"), "assets/images");
      assert.equal(c.init.body.get("verse"), "v1");
    }
    const activity = calls.filter((c) => c.url.endsWith("/v1/activity/upload-asset"));
    assert.equal(activity.length, 1);
    assert.equal(activity[0].init.method, "POST");
    assert.deepEqual(JSON.parse(activity[0].init.body), { count: 2 });

    const m = JSON.parse(fs.readFileSync(manifestPath(dir), "utf8"));
    const entries = Object.entries(m.images);
    assert.equal(entries.length, 2);
    const [heroKey, hero] = entries.find(([k]) => k.startsWith("hero_"));
    assert.match(heroKey, /^hero_\d+_1$/);
    assert.equal(hero.url, "https://agent8-games.verse8.io/v1/assets/images/uuid-hero.png");
    assert.equal(hero.description, "the hero");
    assert.equal(hero.metadata.type, "image/png");
    assert.equal(hero.metadata.originalName, "hero.png");
    assert.equal(hero.metadata.width, 64);
    assert.equal(hero.metadata.height, 32);
    assert.equal(hero.metadata.fileExt, ".png");
    assert.equal(hero.metadata.uploadComplete, true);
    assert.match(hero.metadata.uploadId, /^upload_\d+_[0-9a-f]{7}$/);
    const [, jump] = entries.find(([k]) => k.startsWith("jump_"));
    assert.equal(jump.description, "jump.mp3");
    assert.equal(jump.metadata.width, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: a failed file is reported, the rest are registered, activity counts only uploads", async () => {
  const dir = makeAttachedProject();
  try {
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(1, 1));
    fs.writeFileSync(path.join(dir, "b.png"), pngBytes(1, 1));
    const calls = [];
    await withToken(() =>
      withFetch(uploadFetch(calls, { failName: "b.png" }), async () => {
        const r = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }, { path: "b.png" }] }, dir);
        assert.equal(r.ok, true);
        assert.equal(r.added.length, 1);
        assert.equal(r.failed.length, 1);
        assert.equal(r.failed[0].error, "upload_failed");
      }),
    );
    const activity = calls.find((c) => c.url.endsWith("/v1/activity/upload-asset"));
    assert.deepEqual(JSON.parse(activity.init.body), { count: 1 });
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(manifestPath(dir), "utf8")).images).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MCP-UP-4: asset manifest writes never leave the project folder
test("upload: src linked outside the project is refused before any upload or activity request", async () => {
  const dir = makeAttachedProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-assets-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "assets.json"), "{}");
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(1, 1));
    fs.symlinkSync(outside, path.join(dir, "src"), "junction");
    const calls = [];
    await withToken(() =>
      withFetch(uploadFetch(calls), async () => {
        const r = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }] }, dir);
        assert.equal(r.ok, false);
        assert.equal(r.error, "assets_manifest_write_failed");
      }),
    );
    assert.deepEqual(calls.map((c) => c.url), [], "no upload-attachment and no activity request");
    assert.equal(fs.readFileSync(path.join(outside, "assets.json"), "utf8"), "{}");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("upload: a broken manifest or a conflicting categoryPath is refused before any network call", async () => {
  const dir = makeAttachedProject();
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(1, 1));
    const calls = [];
    await withToken(() =>
      withFetch(uploadFetch(calls), async () => {
        fs.writeFileSync(manifestPath(dir), "{ not json");
        const r = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }] }, dir);
        assert.equal(r.error, "assets_manifest_invalid");
        assert.equal(fs.readFileSync(manifestPath(dir), "utf8"), "{ not json");

        const body = JSON.stringify({ hero: { url: "https://x/h.png", description: "", metadata: {} } }, null, 2);
        fs.writeFileSync(manifestPath(dir), body);
        const r2 = await runAssets({ action: "upload", categoryPath: ["hero", "x"], files: [{ path: "a.png" }] }, dir);
        assert.equal(r2.error, "asset_category_conflict");
        assert.equal(fs.readFileSync(manifestPath(dir), "utf8"), body);
      }),
    );
    assert.deepEqual(calls.map((c) => c.url), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: a manifest broken while uploading is not overwritten; the uploaded files are reported", async () => {
  const dir = makeAttachedProject();
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(manifestPath(dir), "{}");
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(1, 1));
    const calls = [];
    const inner = uploadFetch(calls);
    await withToken(() =>
      withFetch(
        async (url, init) => {
          if (String(url).endsWith("/api/upload-attachment")) fs.writeFileSync(manifestPath(dir), "{ broken");
          return inner(url, init);
        },
        async () => {
          const r = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }] }, dir);
          assert.equal(r.ok, false);
          assert.equal(r.error, "assets_manifest_invalid");
          assert.equal(r.uploaded.length, 1);
          assert.match(r.hint, /NOT in src\/assets\.json/);
          assert.equal(r.activityRecorded, true, "the upload happened, so the activity is still recorded");
        },
      ),
    );
    assert.equal(fs.readFileSync(manifestPath(dir), "utf8"), "{ broken");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: a file unreadable after its check fails alone; earlier uploads are registered and counted", async () => {
  const dir = makeAttachedProject();
  try {
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(2, 2));
    fs.writeFileSync(path.join(dir, "b.png"), pngBytes(3, 3));
    const calls = [];
    const inner = uploadFetch(calls);
    await withToken(() =>
      withFetch(
        async (url, init) => {
          // b.png passed its stat; it disappears while a.png uploads.
          if (String(url).endsWith("/api/upload-attachment")) fs.rmSync(path.join(dir, "b.png"), { force: true });
          return inner(url, init);
        },
        async () => {
          const r = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }, { path: "b.png" }] }, dir);
          assert.equal(r.ok, true, JSON.stringify(r));
          assert.equal(r.added.length, 1);
          assert.equal(r.failed.length, 1);
          assert.equal(r.failed[0].path, path.join(dir, "b.png"));
          assert.equal(r.failed[0].error, "read_failed");
          assert.equal(r.activityRecorded, true);
        },
      ),
    );
    const activity = calls.filter((c) => c.url.endsWith("/v1/activity/upload-asset"));
    assert.equal(activity.length, 1);
    assert.deepEqual(JSON.parse(activity[0].init.body), { count: 1 });
    const images = JSON.parse(fs.readFileSync(manifestPath(dir), "utf8")).images;
    assert.deepEqual(Object.values(images).map((a) => a.metadata.originalName), ["a.png"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: an upload that throws mid-batch fails alone; earlier uploads are registered and counted", async () => {
  const dir = makeAttachedProject();
  try {
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(1, 1));
    fs.writeFileSync(path.join(dir, "b.png"), pngBytes(1, 1));
    const calls = [];
    const inner = uploadFetch(calls);
    await withToken(() =>
      withFetch(
        async (url, init) => {
          if (String(url).endsWith("/api/upload-attachment") && init.body.get("file").name === "b.png") {
            calls.push({ url: String(url), init });
            // The connection drops while the answer is read.
            return new Response(new ReadableStream({ start(c) { c.error(new Error("socket reset")); } }), { status: 200 });
          }
          return inner(url, init);
        },
        async () => {
          const r = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }, { path: "b.png" }] }, dir);
          assert.equal(r.ok, true, JSON.stringify(r));
          assert.equal(r.added.length, 1);
          assert.equal(r.failed.length, 1);
          assert.equal(r.failed[0].path, path.join(dir, "b.png"));
          assert.equal(r.failed[0].error, "upload_failed");
        },
      ),
    );
    const activity = calls.find((c) => c.url.endsWith("/v1/activity/upload-asset"));
    assert.deepEqual(JSON.parse(activity.init.body), { count: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("add and upload outside a verse8 project write nothing and send nothing", async () => {
  _resetLibraryCacheForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-assets-plain-"));
  try {
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(1, 1));
    const calls = [];
    await withToken(() =>
      withFetch(uploadFetch(calls), async () => {
        const a = await runAssets({ action: "add", ids: ["r1"], categoryPath: ["images"] }, dir);
        assert.equal(a.error, "not_a_verse_project");
        const u = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }] }, dir);
        assert.equal(u.error, "not_a_verse_project");
      }),
    );
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(manifestPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: one file failing the upload checks stops the batch before any network call", async () => {
  const dir = makeAttachedProject();
  try {
    fs.writeFileSync(path.join(dir, "a.png"), pngBytes(1, 1));
    fs.writeFileSync(path.join(dir, "evil.exe"), "x");
    const calls = [];
    await withToken(() =>
      withFetch(uploadFetch(calls), async () => {
        const r = await runAssets({ action: "upload", categoryPath: ["images"], files: [{ path: "a.png" }, { path: "evil.exe" }] }, dir);
        assert.equal(r.ok, false);
        assert.equal(r.error, "invalid_extension");
        const r2 = await runAssets({ action: "upload", categoryPath: [".."], files: [{ path: "a.png" }] }, dir);
        assert.equal(r2.error, "invalid_input");
      }),
    );
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(manifestPath(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
