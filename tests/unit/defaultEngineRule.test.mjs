import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "../../dist/server.js";
import { AGENTS_MD_TEMPLATE } from "../../dist/prompts/agentsMdTemplate.js";
import { listSkillResources } from "../../dist/resources/skills.js";

/**
 * #12 C — the package gate installs a 3D stack's skills only when the
 * project already depends on it, so a project with no 3D library gets no
 * engine guidance at all. The "Incanto by default" rule covers that gap in
 * both the server instructions and the AGENTS.md template.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginsRoot = path.resolve(here, "..", "..", "skills-vendor", "agent8-skills", "plugins");

/** Vendored plugins whose `requiresPackage` marks a project as already on a 3D stack. */
const THREE_D_PLUGINS = ["incanto", "r3f", "vibe-starter-3d", "vibe-starter-3d-environment"];

function gatePackages() {
  const packages = [];
  for (const name of THREE_D_PLUGINS) {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginsRoot, name, "plugin.json"), "utf8"));
    assert.ok(
      Array.isArray(manifest.requiresPackage) && manifest.requiresPackage.length > 0,
      `${name}/plugin.json no longer declares requiresPackage — revisit the default-engine rule`,
    );
    packages.push(...manifest.requiresPackage);
  }
  return packages;
}

const sources = {
  SERVER_INSTRUCTIONS: () => createServer()._instructions,
  AGENTS_MD_TEMPLATE: () => AGENTS_MD_TEMPLATE,
};

for (const [label, read] of Object.entries(sources)) {
  test(`${label}: names Incanto as the default 3D engine`, () => {
    const text = read();
    assert.match(text, /3D engine: Incanto by default/);
    assert.match(text, /bun add incanto three/);
    assert.match(text, /verse8_attach` with `overwriteAgentsDoc: true`/);
    assert.match(text, /never add a second 3D engine/);
    // Incanto upstream keeps 2D games off the engine; the default must not override that.
    assert.match(text, /2D game stays on the 2D stack \(Phaser\)/);
  });

  test(`${label}: lists every 3D stack the vendored plugins are gated on`, () => {
    const text = read();
    for (const pkg of gatePackages()) {
      assert.ok(text.includes(`\`${pkg}\``), `${label} does not mention \`${pkg}\``);
    }
  });

  test(`${label}: points at Incanto skills the server actually serves`, () => {
    const text = read();
    const uris = [...text.matchAll(/verse8:\/\/skill\/(incanto-[\w-]+)\/SKILL\.md/g)].map((m) => m[0]);
    assert.ok(uris.length >= 2, `expected Incanto skill URIs in ${label}`);
    const served = new Set(listSkillResources().map((s) => s.uri));
    for (const uri of uris) assert.ok(served.has(uri), `${uri} is not in resources/list`);
  });
}

test("AGENTS_MD_TEMPLATE: the rule precedes the skills catalog and plugin instructions", () => {
  const rule = AGENTS_MD_TEMPLATE.indexOf("## 3D engine: Incanto by default");
  const catalog = AGENTS_MD_TEMPLATE.indexOf("{{SKILLS_CATALOG}}");
  assert.ok(rule >= 0 && rule < catalog);
});
