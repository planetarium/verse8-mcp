// Unit tests for the MCP service registry / enable-disable resolution.
//
// Each test isolates the env vars it depends on so order doesn't matter.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  resolveMcpServices,
  VERSE8_MCP_SERVICES,
} from "../../dist/proxy/registry.js";

const ENV_KEYS = [
  "VERSE8_MCP_PROXIES",
  "VERSE8_MCP_PROXIES_DISABLED",
];

function withCleanEnv(fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("default: all 9 services enabled", () => {
  withCleanEnv(() => {
    const { services, enabled, source } = resolveMcpServices();
    assert.equal(services.length, 9, `expected 9 services, got ${services.length}`);
    assert.equal(enabled.length, 9);
    assert.equal(source, "default");
  });
});

test("VERSE8_MCP_PROXIES=image,audio → allow-list mode enables just those", () => {
  withCleanEnv(() => {
    process.env.VERSE8_MCP_PROXIES = "image,audio";
    const { enabled, source } = resolveMcpServices();
    assert.deepEqual(enabled.sort(), ["audio", "image"].sort());
    assert.equal(source, "env-allowlist");
  });
});

test("VERSE8_MCP_PROXIES='' → empty string means none", () => {
  withCleanEnv(() => {
    process.env.VERSE8_MCP_PROXIES = "";
    const { enabled, source } = resolveMcpServices();
    assert.equal(enabled.length, 0, `expected 0 enabled, got: ${enabled.join(",")}`);
    assert.equal(source, "env-allowlist");
  });
});

test("VERSE8_MCP_PROXIES=none → explicit none sentinel disables all", () => {
  withCleanEnv(() => {
    process.env.VERSE8_MCP_PROXIES = "none";
    const { enabled, source } = resolveMcpServices();
    assert.equal(enabled.length, 0);
    assert.equal(source, "env-allowlist");
  });
});

test("VERSE8_MCP_PROXIES_DISABLED=crossramp → 8 enabled", () => {
  withCleanEnv(() => {
    process.env.VERSE8_MCP_PROXIES_DISABLED = "crossramp";
    const { enabled, source } = resolveMcpServices();
    assert.equal(enabled.length, 8);
    assert.ok(!enabled.includes("crossramp"));
    assert.equal(source, "env-blocklist");
  });
});

test("project file disabledMcpProxies honored when env unset", () => {
  withCleanEnv(() => {
    // Create a temp projectDir with .verse8/project.json
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-registry-test-"));
    try {
      const v8dir = path.join(tmp, ".verse8");
      fs.mkdirSync(v8dir, { recursive: true });
      fs.writeFileSync(
        path.join(v8dir, "project.json"),
        JSON.stringify({
          version: 1,
          projectId: "p",
          disabledMcpProxies: ["claythis"],
        }),
      );
      const { enabled, source } = resolveMcpServices(tmp);
      assert.equal(enabled.length, 8);
      assert.ok(!enabled.includes("claythis"));
      assert.equal(source, "project-blocklist");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("VERSE8_MCP_SERVICES carries exactly 9 entries", () => {
  // Safety net against accidental service additions/removals that the other
  // tests wouldn't catch.
  assert.equal(VERSE8_MCP_SERVICES.length, 9);
  const keys = VERSE8_MCP_SERVICES.map((s) => s.key).sort();
  assert.deepEqual(keys, [
    "audio",
    "cinematic",
    "claythis",
    "crossramp",
    "image",
    "skybox",
    "spritesheet",
    "ui",
    "vectorsearch",
  ]);
});
