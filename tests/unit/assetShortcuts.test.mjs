import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_CATEGORY_TO_CDN_PATH,
  resolveCdnPath,
} from "../../dist/format/assetShortcuts.js";

test("ASSET_CATEGORY_TO_CDN_PATH covers bgm/sfx/image/effect", () => {
  assert.equal(ASSET_CATEGORY_TO_CDN_PATH.bgm, "assets/audio/bgm");
  assert.equal(ASSET_CATEGORY_TO_CDN_PATH.sfx, "assets/audio/sfx");
  assert.equal(ASSET_CATEGORY_TO_CDN_PATH.image, "assets/images");
  assert.equal(ASSET_CATEGORY_TO_CDN_PATH.effect, "assets/effects");
});

test("resolveCdnPath: category-only returns mapped path", () => {
  assert.deepEqual(resolveCdnPath({ category: "bgm" }), {
    ok: true,
    cdnPath: "assets/audio/bgm",
  });
});

test("resolveCdnPath: cdnPath-only returns trimmed path", () => {
  assert.deepEqual(resolveCdnPath({ cdnPath: "assets/custom/" }), {
    ok: true,
    cdnPath: "assets/custom",
  });
});

test("resolveCdnPath: neither -> cdn_path_required", () => {
  const r = resolveCdnPath({});
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_required");
});

test("resolveCdnPath: both -> cdn_path_conflict", () => {
  const r = resolveCdnPath({ category: "bgm", cdnPath: "assets/x" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_conflict");
});

test("resolveCdnPath: leading slash rejected", () => {
  const r = resolveCdnPath({ cdnPath: "/assets/x" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_invalid");
});

test("resolveCdnPath: parent traversal rejected", () => {
  const r = resolveCdnPath({ cdnPath: "assets/../secret" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_invalid");
});

test("resolveCdnPath: NUL byte rejected", () => {
  const r = resolveCdnPath({ cdnPath: "assets/x\u0000y" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_invalid");
});

test("resolveCdnPath: empty string rejected", () => {
  const r = resolveCdnPath({ cdnPath: "" });
  assert.equal(r.ok, false);
});

test("resolveCdnPath: single-segment relative path accepted", () => {
  assert.deepEqual(resolveCdnPath({ cdnPath: "assets/custom" }), {
    ok: true,
    cdnPath: "assets/custom",
  });
});
