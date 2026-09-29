// Claude plugin packaging invariants (plugins/verse8 + .claude-plugin/marketplace.json).
//
// The plugin launches the published npm package with `npx`, and the Claude
// plugin directory blocks unpinned launchers. Every release therefore has to
// move three numbers together: package.json `version`, the `@verse8/mcp@x`
// pin in plugins/verse8/.mcp.json, and plugins/verse8/.claude-plugin/plugin.json
// `version` (which is what makes installed users pick up the update).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "verse8");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

const pkg = readJson("package.json");
const plugin = readJson("plugins/verse8/.claude-plugin/plugin.json");
const mcp = readJson("plugins/verse8/.mcp.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const EXACT = /^\d+\.\d+\.\d+$/;

test("plugin.json version equals package.json version", () => {
  assert.match(plugin.version, EXACT);
  assert.equal(plugin.version, pkg.version);
});

test(".mcp.json launches the exact package.json version of @verse8/mcp", () => {
  const server = mcp.mcpServers.verse8;
  assert.ok(server, "mcpServers.verse8 missing");
  assert.equal(server.command, "npx");
  const spec = server.args.find((a) => a.startsWith("@verse8/mcp"));
  assert.equal(spec, `@verse8/mcp@${pkg.version}`);
});

test("runtime @agent8 launchers are pinned to exact versions", () => {
  for (const [name, ver] of Object.entries(pkg.verse8.gameserverPin)) {
    assert.match(ver, EXACT, `verse8.gameserverPin.${name} must be an exact version, got ${ver}`);
  }
});

test("marketplace entry points at the plugin folder under the same name", () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `marketplace.json has no entry named ${plugin.name}`);
  assert.equal(path.resolve(ROOT, entry.source), PLUGIN_DIR);
});

test("plugin folder carries README (≥40 words outside code blocks) and LICENSE", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_DIR, "README.md"), "utf8");
  const prose = readme.replace(/```[\s\S]*?```/g, " ");
  assert.ok(prose.split(/\s+/).filter(Boolean).length >= 40);
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "LICENSE")));
});

test("plugin folder has no lockfile or package manager config (directory holds/blocks)", () => {
  for (const f of ["package.json", "package-lock.json", "bun.lock", "bun.lockb", ".npmrc", "bunfig.toml"]) {
    assert.ok(!fs.existsSync(path.join(PLUGIN_DIR, f)), `${f} must not be in the plugin folder`);
  }
});
