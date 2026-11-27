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
 * with `verse8_vxshop` instead. The tool description carries the full flow;
 * the AGENTS.md template carries a short version as its LAST section, so a
 * host that reads only the first N bytes (Codex `project_doc_max_bytes`,
 * 32 KiB) cuts it before any existing rule (PR #77 review).
 */

const HEAD = "## VX Shop items (only when the game sells something for VX)";

test("AGENTS_MD_TEMPLATE: the VX Shop section is the last section, after the skills catalog and plugin rules", () => {
  const t = AGENTS_MD_TEMPLATE;
  const at = t.indexOf(HEAD);
  assert.ok(at > 0, "section present");
  assert.ok(at > t.indexOf("{{SKILLS_CATALOG}}"), "after the catalog marker (the catalog and the plugin rules go there)");
  assert.ok(at > t.indexOf("## If you are not sure this project is attached"), "after the last existing section");
  assert.equal(t.slice(at + HEAD.length).search(/^## /m), -1, "no section follows it");
});

test("AGENTS_MD_TEMPLATE: nothing about the VX flow comes before the existing rules", () => {
  const before = AGENTS_MD_TEMPLATE.slice(0, AGENTS_MD_TEMPLATE.indexOf("{{SKILLS_CATALOG}}"));
  for (const s of ["verse8_vxshop", "vx-shop-impl", "Sell an in-game item"]) assert.ok(!before.includes(s), `${s} before the catalog`);
  // As attach renders it: plugin rules replace the marker; the VX section still comes after them.
  const rendered = AGENTS_MD_TEMPLATE.replace("{{SKILLS_CATALOG}}", () => "## Available Verse8 skills\n\n### Rules\n- Read gameserver-sdk first.\n");
  assert.ok(rendered.indexOf(HEAD) > rendered.indexOf("### Rules"));
});

test("AGENTS_MD_TEMPLATE: the short VX flow — seller, publish first, reuse/restore, hidden, wire, user confirms", () => {
  const s = AGENTS_MD_TEMPLATE.slice(AGENTS_MD_TEMPLATE.indexOf(HEAD));
  assert.match(s, /do not ask the user to register it\s+on the web and paste a Product ID \(that is the `vx-shop-impl` skill's\s+Step 0/);
  assert.match(s, /`seller\.isSeller` false → give the user\s+`seller\.applyUrl` and stop/);
  assert.match(s, /`needsPublish` → the game must be\s+published first: tell the user, never deploy on your own/);
  assert.match(s, /an archived one comes back with `archive`,\s+`archived: false`/);
  assert.match(s, /It is created\s+hidden: nobody can buy it, and `getItem` misses it, on PREVIEW too/);
  assert.match(s, /Put the returned `productId` exactly/);
  // A deploy only if the grant is not live yet, and only on the user's ask (PR #77 re-review 3, note 3).
  assert.match(s, /ask\s+the user in a confirmation you cannot answer\. If the game is published\s+and the granting code is not live there yet, tell the user a deploy is\s+needed and deploy only when they ask\./);
  // A restore of an item whose on-sale flag is set starts the sale (PR #77 re-review).
  assert.match(s, /with its `isActive` still true that restore starts\s+the sale, so do it after the step-5 conditions or set `isActive: false`\s+first/);
  // The client code always; only the grant follows the delivery setting (note 2).
  assert.match(s, /Put the returned `productId` exactly in the client's `getItem` \/\s+`buyItem`, always; grant it in `\$onItemPurchased`, or in the external\s+receiver if the game uses external-only delivery\./);
  // Every deploy mention in the VX guidance waits for the user.
  for (const m of s.matchAll(/[^.]*\bdeploy\b[^.]*\./gi)) assert.match(m[0], /never deploy|only when they ask|deploy is needed/, m[0]);
  // Last section, so its size moves no rule; kept short so it is rarely cut either.
  assert.ok(Buffer.byteLength(s) < 1500, `short: ${Buffer.byteLength(s)} B`);
});

test("verse8_vxshop description: the flow, matching what list does, within 2,048 characters", () => {
  const d = VXSHOP_TOOL.description;
  assert.ok(d.length <= 2048, `${d.length}`);
  assert.match(d, /overrides the vx-shop-impl skill's Step 0/);
  assert.match(d, /not a seller: tell the user where to apply \(applyUrl\) and stop; needsPublish: the game must be published first/);
  // list does not search by name; a plain list is paged and leaves archived items out.
  assert.doesNotMatch(d, /productId or name/);
  assert.match(d, /list with its productId: all pages, archived too; a plain list is 20 a page, no archived unless includeArchived/);
  assert.match(d, /archived: restore with archive, archived: false — with isActive true that starts the sale/);
  assert.match(d, /create it hidden \(preview, then planId\); \(3\) put the returned productId in getItem \/ buyItem always, and grant it in \$onItemPurchased \(or the external receiver, for external-only delivery\); \(4\) starting the sale is a later edit the user confirms — if the grant is not live on the published game yet, say a deploy is needed, deploy only if they ask\./);
  // Every deploy mention in the description waits for the user (verse8_deploy as a name is not an instruction).
  for (const m of d.replace(/verse8_deploy/g, "").matchAll(/[^.;]*\bdeploy\b[^.;]*/gi)) assert.match(m[0], /never deploy|only if they ask|deploy is needed/, m[0]);
});

test("the skill step this rule overrides is still in the vendored skill (else drop the override text)", () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, "skills-vendor/agent8-skills/skills/vx-shop-impl.md"), "utf8");
  assert.match(skill, /## Step 0: Verify Product ID/);
});
