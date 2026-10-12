import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCdnPath } from "../../dist/format/assetShortcuts.js";

test("resolveCdnPath: single-segment relative path accepted", () => {
  assert.deepEqual(resolveCdnPath({ cdnPath: "assets/images" }), {
    ok: true,
    cdnPath: "assets/images",
  });
});

test("resolveCdnPath: nested path accepted (V8 template convention)", () => {
  assert.deepEqual(
    resolveCdnPath({ cdnPath: "assets/3d/animations/mixamorig" }),
    { ok: true, cdnPath: "assets/3d/animations/mixamorig" },
  );
});

test("resolveCdnPath: trailing slash stripped", () => {
  assert.deepEqual(resolveCdnPath({ cdnPath: "assets/custom/" }), {
    ok: true,
    cdnPath: "assets/custom",
  });
});

test("resolveCdnPath: missing cdnPath -> cdn_path_required", () => {
  const r = resolveCdnPath({});
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_required");
});

test("resolveCdnPath: empty string -> cdn_path_required", () => {
  const r = resolveCdnPath({ cdnPath: "" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_required");
});

// MCP-UP-2: `cdnPath` traversal rejected before the network
test("resolveCdnPath: leading slash rejected", () => {
  const r = resolveCdnPath({ cdnPath: "/assets/x" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_invalid");
});

// MCP-UP-2: `cdnPath` traversal rejected before the network
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

// MCP-UP-2: `cdnPath` traversal rejected before the network
test("resolveCdnPath: double-slash (empty segment) rejected", () => {
  const r = resolveCdnPath({ cdnPath: "assets//double" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "cdn_path_invalid");
});
