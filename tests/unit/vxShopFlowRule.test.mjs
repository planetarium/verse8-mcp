import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { VXSHOP_TOOL } from "../../dist/server.js";
import { AGENTS_MD_TEMPLATE } from "../../dist/prompts/agentsMdTemplate.js";
import { REPO_ROOT } from "./_repoPaths.mjs";

/**
 * #66: the vendored agent8-skills `vx-shop-impl` skill stops and asks the
 * user to register an item on the web and paste its Product ID — the Agent8
 * web editor has no shop tool. Through this MCP the agent makes the item
 * with `verse8_vxshop` instead: seller status first, reuse an item the user
 * already made, otherwise propose → create hidden → wire the returned
 * productId → the user confirms the sale start. The AGENTS.md template
 * carries the full flow; the tool description carries it short, for
 * projects whose AGENTS.md predates it.
 */

test("AGENTS_MD_TEMPLATE: the VX Shop flow, in order, overriding the skill's Product ID step", () => {
  const t = AGENTS_MD_TEMPLATE;
  const section = t.indexOf("## 🚨 VX Shop items — make them with `verse8_vxshop`, hidden first");
  const steps = ["1. **Seller status first.**", "2. **Reuse what the user already made.**", "3. **Otherwise propose the item.**", "4. **Wire the code with the returned productId.**", "5. **Starting the sale is the user's call.**"].map((s) => t.indexOf(s));
  const next = t.indexOf("## You are operating inside a Verse8 project");
  const catalog = t.indexOf("{{SKILLS_CATALOG}}");
  assert.ok(section >= 0, "section present");
  for (const [i, at] of steps.entries()) assert.ok(at > section && at < next && (i === 0 || at > steps[i - 1]), `step ${i + 1} in order`);
  assert.ok(next < catalog, "before the skills it overrides");
  assert.match(t, /Do NOT stop and ask the user to register it on the web\s+and paste a Product ID — that is the `vx-shop-impl` skill's Step 0/);
  assert.match(t, /This rule overrides that step\./);
  assert.match(t, /`seller\.applyUrl`/);
  assert.match(t, /stop the VX Shop\s+work/);
  assert.match(t, /The item is created \*\*hidden\*\*: players cannot buy it\./);
  assert.match(t, /Never ask the user to copy it\./);
  assert.match(t, /confirmation \(item name, price, purchase limits\)/);
  assert.match(t, /Changing the price of an item on\s+sale asks them the same way\./);
});

test("verse8_vxshop description: the same flow, short, within 2,048 characters", () => {
  const d = VXSHOP_TOOL.description;
  assert.ok(d.length <= 2048, `${d.length}`);
  assert.match(d, /overrides the vx-shop-impl skill's Step 0/);
  assert.match(d, /not a seller: tell the user where to apply \(applyUrl\) and stop/);
  assert.match(d, /create it hidden \(preview, then planId\); \(3\) put the returned productId in the code; \(4\) starting the sale is a later edit the user confirms/);
});

test("the skill step this rule overrides is still in the vendored skill (else drop the override text)", () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, "skills-vendor/agent8-skills/skills/vx-shop-impl.md"), "utf8");
  assert.match(skill, /## Step 0: Verify Product ID/);
});
