// MCP Registry packaging invariants (server.json + package.json `mcpName`).
//
// The official MCP Registry (registry.modelcontextprotocol.io) lists the
// server from server.json and checks npm ownership through the published
// package's `mcpName`. Both names must match, and server.json has to name the
// version being published — so a release moves server.json's two `version`
// fields together with package.json `version` (see pluginManifest.test.mjs
// for the plugin's numbers).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const pkg = readJson("package.json");
const server = readJson("server.json");

test("server.json name equals package.json mcpName in the GitHub org namespace", () => {
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.planetarium\/[a-zA-Z0-9._-]+$/);
});

test("server.json versions equal package.json version", () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].version, pkg.version);
});

test("server.json points at this npm package over stdio", () => {
  assert.deepEqual(
    { registryType: server.packages[0].registryType, identifier: server.packages[0].identifier },
    { registryType: "npm", identifier: pkg.name },
  );
  assert.equal(server.packages[0].transport.type, "stdio");
});

test("server.json stays within the registry's field limits", () => {
  assert.ok(server.description.length >= 1 && server.description.length <= 100, "description is 1–100 chars");
  assert.ok(!server.title || server.title.length <= 100, "title is at most 100 chars");
  assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
});
