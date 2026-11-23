import test from "node:test";
import assert from "node:assert/strict";

import { AGENTS_MD_TEMPLATE } from "../../dist/prompts/agentsMdTemplate.js";

/**
 * `$sender.account` is the player's wallet address on verse8.io (the web
 * passes the checksummed walletAddress with the game token), but on the
 * local preview the gameserver client falls back to `?account=` or a random
 * `anonymous-…` id (GameServer.getInitialAccount) — not VITE_AGENT8_ACCOUNT.
 * Agents had to guess and put both ids into admin allow-lists.
 */
test("AGENTS_MD_TEMPLATE: explains what $sender.account is, in prod and on the local preview", () => {
  const i = AGENTS_MD_TEMPLATE.indexOf("**Who is `$sender.account`?**");
  assert.ok(i >= 0);
  const section = AGENTS_MD_TEMPLATE.slice(i, i + 800);
  assert.match(section, /wallet\s+address/);
  assert.match(section, /not the numeric\s+Verse8 user id/);
  assert.match(section, /anonymous-…/);
  assert.match(section, /\?account=<VITE_AGENT8_ACCOUNT>/);
  assert.match(section, /not a security boundary/);
  // It belongs to the preview policy section.
  assert.ok(i > AGENTS_MD_TEMPLATE.indexOf("## Preview policy"));
  assert.ok(i < AGENTS_MD_TEMPLATE.indexOf("## Commit policy"));
});
