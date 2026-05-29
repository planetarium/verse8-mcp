import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_EXTS,
  isAllowedAttachmentExt,
  detectContentType,
} from "../../dist/format/attachmentExts.js";

test("ATTACHMENT_EXTS includes core image/audio/3d/font/text", () => {
  for (const ext of [
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    ".glb", ".gltf", ".vrm",
    ".mp3", ".wav", ".ogg", ".m4a",
    ".mp4", ".webm", ".mov",
    ".ttf", ".otf", ".woff", ".woff2",
    ".txt", ".md", ".json", ".csv", ".xml",
  ]) {
    assert.ok(
      ATTACHMENT_EXTS.includes(ext),
      "expected " + ext + " in ATTACHMENT_EXTS",
    );
  }
});

test("isAllowedAttachmentExt: case-insensitive accept", () => {
  assert.equal(isAllowedAttachmentExt("cover.PNG"), true);
  assert.equal(isAllowedAttachmentExt("song.MP3"), true);
});

test("isAllowedAttachmentExt: reject unknown", () => {
  assert.equal(isAllowedAttachmentExt("hack.exe"), false);
  assert.equal(isAllowedAttachmentExt("noext"), false);
});

test("detectContentType: known and fallback", () => {
  assert.equal(detectContentType("a.png"), "image/png");
  assert.equal(detectContentType("a.mp3"), "audio/mpeg");
  assert.equal(detectContentType("a.glb"), "model/gltf-binary");
  assert.equal(detectContentType("a.unknown"), "application/octet-stream");
});
