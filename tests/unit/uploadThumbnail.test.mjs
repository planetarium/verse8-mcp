// Unit tests for verse8_upload_thumbnail + the verse8.io media client.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getVerse8WebBaseUrl } from "../../dist/api/verse8Web.js";
import { uploadLocalMedia } from "../../dist/tools/uploadThumbnail.js";

function withEnv(key, value, fn) {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

function withFetch(handler, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = saved;
  });
}

function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-thumb-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

test("getVerse8WebBaseUrl: default verse8.io, *.verse8.io override ok, foreign host rejected", () => {
  withEnv("VERSE8_WEB_URL", undefined, () => assert.equal(getVerse8WebBaseUrl(), "https://verse8.io"));
  withEnv("VERSE8_WEB_URL", "https://staging.vibe.verse8.io/", () =>
    assert.equal(getVerse8WebBaseUrl(), "https://staging.vibe.verse8.io"),
  );
  const err = console.error;
  console.error = () => {};
  try {
    withEnv("VERSE8_WEB_URL", "https://evil.example.com", () =>
      assert.equal(getVerse8WebBaseUrl(), "https://verse8.io"),
    );
  } finally {
    console.error = err;
  }
});

test("uploadLocalMedia: image → multipart POST /api/upload category=verses with Bearer", async () => {
  const p = tmpFile("cover.png", 64);
  let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ publicUrl: "https://contents.verse8.io/verses/x/y.png" }), { status: 200 });
    },
    () => uploadLocalMedia(p, "tok"),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.kind, "image");
  assert.equal(res.url, "https://contents.verse8.io/verses/x/y.png");
  assert.equal(seen.url, "https://verse8.io/api/upload");
  assert.equal(seen.init.headers.Authorization, "Bearer tok");
  assert.equal(seen.init.body.get("category"), "verses");
  assert.equal(seen.init.body.get("file").type, "image/png");
});

test("uploadLocalMedia: video → presigned request, then PUT without the token", async () => {
  const p = tmpFile("clip.mp4", 128);
  const calls = [];
  const res = await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/api/upload/video-presigned")) {
        return new Response(
          JSON.stringify({
            uploadUrl: "https://r2.example/put?sig=1",
            publicUrl: "https://contents.verse8.io/verses/x/v.mp4",
            contentType: "video/mp4",
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    },
    () => uploadLocalMedia(p, "tok"),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.kind, "video");
  assert.equal(JSON.parse(calls[0].init.body).fileSize, 128);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers["Content-Type"], "video/mp4");
});

test("uploadLocalMedia: rejects wrong extension, wrong expected kind, and oversize images locally", async () => {
  const svg = tmpFile("a.svg", 10);
  assert.equal((await uploadLocalMedia(svg, "tok")).error, "invalid_extension");
  const mp4 = tmpFile("a.mp4", 10);
  assert.equal((await uploadLocalMedia(mp4, "tok", "image")).error, "invalid_extension");
  const big = tmpFile("big.png", 4_000_001);
  const res = await uploadLocalMedia(big, "tok");
  assert.equal(res.error, "media_too_large");
  assert.equal(res.limitBytes, 4_000_000);
  assert.equal((await uploadLocalMedia(path.join(os.tmpdir(), "nope-404.png"), "tok")).error, "file_not_found");
});

test("uploadLocalMedia: 401 from verse8.io → unauthorized with server message", async () => {
  const p = tmpFile("cover.webp", 8);
  const res = await withFetch(
    async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    () => uploadLocalMedia(p, "tok"),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "unauthorized");
  assert.match(res.hint, /Unauthorized/);
});
