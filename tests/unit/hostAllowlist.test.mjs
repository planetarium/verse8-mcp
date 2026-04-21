import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { parseOverrideHost } from "../../dist/util/hostAllowlist.js";
import { isAllowedOverrideHost } from "../../dist/proxy/registry.js";

test("parseOverrideHost: returns null for empty string", () => {
  assert.equal(parseOverrideHost(""), null);
});

test("parseOverrideHost: returns null for malformed URL", () => {
  assert.equal(parseOverrideHost("not-a-url"), null);
  assert.equal(parseOverrideHost("https://"), null);
});

test("parseOverrideHost: parses https URL", () => {
  const p = parseOverrideHost("https://Example.Verse8.IO/path");
  assert.deepEqual(p, {
    host: "example.verse8.io",
    protocol: "https:",
    isHttp: true,
    isLoopback: false,
  });
});

test("parseOverrideHost: parses http URL", () => {
  const p = parseOverrideHost("http://example.com");
  assert.equal(p.isHttp, true);
  assert.equal(p.protocol, "http:");
});

test("parseOverrideHost: marks 127.0.0.1 / localhost / ::1 as loopback", () => {
  for (const url of [
    "http://127.0.0.1:5000",
    "https://localhost",
    "http://[::1]:9000",
  ]) {
    const p = parseOverrideHost(url);
    assert.equal(p.isLoopback, true, `expected loopback for ${url}`);
  }
});

test("parseOverrideHost: non-loopback host has isLoopback=false", () => {
  const p = parseOverrideHost("https://gitlab.verse8.io");
  assert.equal(p.isLoopback, false);
});

test("parseOverrideHost: non-http schemes have isHttp=false", () => {
  for (const url of ["file:///tmp/x", "unix:///run/sock"]) {
    const p = parseOverrideHost(url);
    assert.equal(p.isHttp, false, `expected isHttp=false for ${url}`);
  }
});

test("parseOverrideHost: rejects non-string input", () => {
  assert.equal(parseOverrideHost(undefined), null);
  assert.equal(parseOverrideHost(null), null);
  assert.equal(parseOverrideHost(123), null);
});

test("isAllowedOverrideHost (proxy/registry): accepts verse8.io subdomains + loopback", () => {
  assert.equal(isAllowedOverrideHost("https://mcp-image-svc.verse8.io/mcp"), true);
  assert.equal(isAllowedOverrideHost("https://verse8.io"), true);
  assert.equal(isAllowedOverrideHost("http://localhost:3000"), true);
  assert.equal(isAllowedOverrideHost("http://127.0.0.1:9999"), true);
});

test("isAllowedOverrideHost: rejects foreign hosts and malformed URLs", () => {
  assert.equal(isAllowedOverrideHost("https://evil.example.com"), false);
  assert.equal(isAllowedOverrideHost("https://verse8.io.evil.com"), false);
  assert.equal(isAllowedOverrideHost("not a url"), false);
  assert.equal(isAllowedOverrideHost(""), false);
});

test("isAllowedOverrideHost: passes through non-http schemes", () => {
  assert.equal(isAllowedOverrideHost("file:///tmp/x"), true);
});

test("AC-STRUCTURE-2: parseOverrideHost is exported from exactly one file", () => {
  const dirsToScan = [
    new URL("../../src/util/", import.meta.url),
    new URL("../../src/proxy/", import.meta.url),
    new URL("../../src/api/", import.meta.url),
    new URL("../../src/tools/", import.meta.url),
  ];
  let exportSites = 0;
  for (const dir of dirsToScan) {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const src = fs.readFileSync(new URL(entry, dir), "utf8");
      if (/export\s+function\s+parseOverrideHost\b/.test(src)) {
        exportSites += 1;
      }
    }
  }
  assert.equal(exportSites, 1, "parseOverrideHost must be exported from exactly one file");
});

test("AC-STRUCTURE-2: each per-caller predicate sources the parser, not raw new URL", () => {
  const callerFiles = [
    "../../src/proxy/registry.ts",
    "../../src/api/v8MemeApi.ts",
    "../../src/api/agent8Backend.ts",
    "../../src/tools/preview.ts",
  ];
  for (const rel of callerFiles) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(
      src,
      /parseOverrideHost/,
      `${rel} must reference parseOverrideHost (no raw new URL host parsing)`,
    );
  }
});
