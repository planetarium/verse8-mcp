// INV-17: A user-confirmation action writes nothing without the user's "Run".
// verse8_git_tokens — the project's Git access tokens (the web editor's Git
// Clone menu): list, revoke one (preview → planId), revoke all (preview →
// planId → the user's Run in the host's prompt). fetch is mocked.
//  - the list and the call log never carry a token value
//  - revoking one sends its tokenId; no path sends a DELETE without one
//    except revoke_all after the user's Run
//  - the token-limit hint points to this tool (openProject.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { gitTokensInputSchema, presentTokens, runGitTokens } from "../../dist/tools/gitTokens.js";
import { revokeProjectAccessToken } from "../../dist/api/agent8Backend.js";
import { createServer } from "../../dist/server.js";
import { clearLog, peekAll } from "../../dist/util/v8CallLog.js";

const PROJECT = "someone/token-demo";
const ROUTE = "/api/gitlab/project-access-token";
// What a token value looks like; the backend's list carries none, but a
// stray one must still not come out.
const SECRET = "glpat-shouldNeverAppear0123456789";

const json = (status, body) => new Response(JSON.stringify(body), { status });
const entry = (id, name, created) => ({
  id,
  name,
  expires_at: "2026-12-20",
  daysLeft: 23,
  created_at: created,
  revoked: false,
  // Not part of the real list; here to prove only named fields are passed on.
  token: SECRET,
  scopes: ["read_repository", "write_repository"],
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-gittokens-"));
}

/** Runs f with a mocked agent8-backend holding `tokens` (mutable) and a login. */
async function withBackend(f, { listStatus = 200 } = {}) {
  const tokens = [entry(31, "tokend-a1b2c3", "2026-11-20T01:00:00.000Z"), entry(30, "tokend-z9y8x7", "2026-11-01T01:00:00.000Z")];
  const saved = { fetch: globalThis.fetch, tok: process.env.VERSE8_ACCESS_TOKEN };
  const calls = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = new URL(u);
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : undefined });
    if (url.pathname !== ROUTE) return json(599, { message: `unrouted ${method} ${url.pathname}` });
    if (method === "GET") {
      if (listStatus !== 200) return json(listStatus, { success: false, message: "Access denied: You are not the owner of this project", error: "PERMISSION_DENIED" });
      return json(200, { success: true, data: { projectPath: url.searchParams.get("projectPath"), hasToken: tokens.length > 0, tokenName: tokens[0]?.name, tokens } });
    }
    if (method === "DELETE") {
      const b = JSON.parse(init.body);
      if (b.tokenId) {
        const i = tokens.findIndex((t) => t.id === b.tokenId);
        if (i >= 0) tokens.splice(i, 1);
        return json(200, { success: true, data: { message: "Token revoked successfully", projectPath: b.projectPath, tokenId: b.tokenId } });
      }
      tokens.splice(0);
      return json(200, { success: true, data: { message: "All project access tokens have been revoked", projectPath: b.projectPath } });
    }
    return json(599, { message: `unrouted ${method}` });
  };
  process.env.VERSE8_ACCESS_TOKEN = "tok";
  try {
    return await f(calls, tokens);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.tok === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.tok;
  }
}

const run = (input, host) => runGitTokens(gitTokensInputSchema.parse({ project: PROJECT, ...input }), tmpDir(), host);
const deletes = (calls) => calls.filter((c) => c.method === "DELETE");
function hostThat(answer, { canAsk = true } = {}) {
  const asked = [];
  return { asked, canAsk, ask: async (message) => (asked.push(message), typeof answer === "function" ? answer() : answer) };
}
const RUN = { action: "accept", content: { choice: "Run" } };

// ── list ──

test("list: id, name, created, expires and days left per token — no token value, newest first", async () => {
  await withBackend(async (calls) => {
    const r = await run({ action: "list" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.projectPath, PROJECT);
    assert.deepEqual(r.tokens, [
      { tokenId: 31, name: "tokend-a1b2c3", createdAt: "2026-11-20T01:00:00.000Z", expiresAt: "2026-12-20", daysLeft: 23 },
      { tokenId: 30, name: "tokend-z9y8x7", createdAt: "2026-11-01T01:00:00.000Z", expiresAt: "2026-12-20", daysLeft: 23 },
    ]);
    assert.ok(!JSON.stringify(r).includes(SECRET));
    assert.match(r.webEditor.url, /\/creator\/editor\?chat=someone%2Ftoken-demo$/);
    assert.deepEqual(calls.map((c) => [c.method, c.query.projectPath]), [["GET", PROJECT]]);
  });
});

test("list: the project comes from projectDir's gitlab.verse8.io origin when `project` is left out", async () => {
  const dir = tmpDir();
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://gitlab.verse8.io/${PROJECT}.git`]);
  await withBackend(async (calls) => {
    const r = await runGitTokens(gitTokensInputSchema.parse({ action: "list", projectDir: dir }), dir);
    assert.equal(r.projectPath, PROJECT, JSON.stringify(r));
    assert.equal(calls[0].query.projectPath, PROJECT);
    const none = await runGitTokens(gitTokensInputSchema.parse({ action: "list", projectDir: tmpDir() }), tmpDir());
    assert.equal(none.error, "invalid_input");
    assert.equal(calls.length, 1);
  });
});

test("list: the owner check of the backend comes back as forbidden with its message", async () => {
  await withBackend(async () => {
    const r = await run({ action: "list" });
    assert.equal(r.error, "forbidden");
    assert.match(r.hint, /not the owner of this project/);
  }, { listStatus: 403 });
});

test("presentTokens: entries without a usable id are dropped and counted; no list → null", () => {
  assert.deepEqual(presentTokens({ data: { tokens: [{ name: "x" }, { id: 0 }, { id: 2, name: "b" }] } }), {
    tokens: [{ tokenId: 2, name: "b", createdAt: null, expiresAt: null, daysLeft: null }],
    dropped: 2,
  });
  assert.equal(presentTokens({ data: { hasToken: false } }), null);
});

test("list through the MCP server: neither the tool result nor the call log carries a token value", async () => {
  clearLog();
  const dir = tmpDir();
  await withBackend(async () => {
    const server = createServer();
    const client = new Client({ name: "test-host", version: "0" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = await client.callTool({ name: "verse8_git_tokens", arguments: { action: "list", project: PROJECT, projectDir: dir } });
      const text = res.content[0].text;
      assert.equal(JSON.parse(text).tokens.length, 2);
      assert.ok(!text.includes(SECRET));
      const log = peekAll(dir);
      assert.equal(log.length, 1);
      assert.equal(log[0].name, "verse8_git_tokens");
      assert.ok(!JSON.stringify(log).includes(SECRET));
    } finally {
      await client.close();
    }
  });
});

// ── revoke one ──

test("revoke: previews without a DELETE, then revokes exactly that tokenId with the preview's planId", async () => {
  await withBackend(async (calls, tokens) => {
    const pre = await run({ action: "revoke", tokenId: 30 });
    assert.equal(pre.dryRun, true, JSON.stringify(pre));
    assert.equal(pre.runCondition, "preview");
    assert.equal(pre.revokes.name, "tokend-z9y8x7");
    assert.equal(pre.activeAfter, 1);
    assert.match(pre.warnings[0], /can no longer push or pull/);
    assert.deepEqual(deletes(calls), []);

    const r = await run({ action: "revoke", tokenId: 30, planId: pre.planId });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.revoked.tokenId, 30);
    assert.deepEqual(deletes(calls).map((c) => c.body), [{ projectPath: PROJECT, tokenId: 30 }]);
    assert.deepEqual(tokens.map((t) => t.id), [31]);

    const after = await run({ action: "list" });
    assert.deepEqual(after.tokens.map((t) => t.tokenId), [31]);
  });
});

test("revoke: refused with no DELETE — no tokenId, an id not in the list, a planId of another token, a token gone since the preview", async () => {
  await withBackend(async (calls, tokens) => {
    assert.equal((await run({ action: "revoke" })).error, "invalid_input");
    assert.equal((await run({ action: "revoke", tokenId: 99 })).error, "not_found");
    const pre31 = await run({ action: "revoke", tokenId: 31 });
    assert.equal((await run({ action: "revoke", tokenId: 30, planId: pre31.planId })).error, "plan_mismatch");
    tokens.splice(0, 1); // 31 revoked elsewhere (the web editor, another machine)
    assert.equal((await run({ action: "revoke", tokenId: 31, planId: pre31.planId })).error, "not_found");
    assert.deepEqual(deletes(calls), []);
  });
});

test("an input the action does not use is refused before any request, never ignored", async () => {
  await withBackend(async (calls) => {
    const host = hostThat(RUN);
    // revoke_all with a tokenId: the agent meant one token — no "revoke every token" preview or prompt.
    const all = await run({ action: "revoke_all", tokenId: 30 }, host);
    assert.equal(all.error, "invalid_input", JSON.stringify(all));
    assert.match(all.hint, /takes no tokenId\. To revoke only token 30, use action revoke with that tokenId/);
    assert.equal(all.confirmation, undefined);
    const allRun = await run({ action: "revoke_all", tokenId: 30, planId: "v1.x" }, host);
    assert.equal(allRun.error, "invalid_input");
    // list reads only.
    for (const extra of [{ tokenId: 30 }, { planId: "v1.x" }, { tokenId: 30, planId: "v1.x" }]) {
      const r = await run({ action: "list", ...extra });
      assert.equal(r.error, "invalid_input", JSON.stringify(extra));
      assert.match(r.hint, /^list takes no /);
    }
    // revoke without a tokenId, with or without a planId.
    for (const extra of [{}, { planId: "v1.x" }]) {
      const r = await run({ action: "revoke", ...extra });
      assert.equal(r.error, "invalid_input");
      assert.match(r.hint, /revoke needs tokenId/);
    }
    assert.deepEqual(calls, [], "not even the list is read");
    assert.equal(host.asked.length, 0);
  });
});

test("revoking one never sends a body without a positive tokenId (the backend would revoke them all)", async () => {
  await withBackend(async (calls) => {
    for (const id of [0, -1, Number.NaN, 1.5, undefined]) {
      const r = await revokeProjectAccessToken(PROJECT, id, "tok");
      assert.equal(r.ok, false, String(id));
      assert.equal(r.status, 0);
    }
    assert.deepEqual(calls, []);
  });
});

// ── revoke all ──

test("revoke_all: the preview asks for the user's confirmation and names every token, in one line, Cancel first", async () => {
  await withBackend(async (calls) => {
    const pre = await run({ action: "revoke_all" });
    assert.equal(pre.dryRun, true, JSON.stringify(pre));
    assert.equal(pre.runCondition, "user_confirm");
    assert.doesNotMatch(pre.confirmation, /\n/);
    assert.match(pre.confirmation, /^Revoke EVERY Git access token of this project\? Project: "someone\/token-demo"/);
    assert.match(pre.confirmation, /all 2 active tokens: "tokend-a1b2c3" \(created 2026-11-20, expires 2026-12-20\), "tokend-z9y8x7"/);
    assert.match(pre.confirmation, /Undo: none/);
    assert.deepEqual(deletes(calls), []);

    const host = hostThat({ action: "decline" });
    await run({ action: "revoke_all", planId: pre.planId }, host);
    assert.equal(host.asked.length, 1);
  });
});

test("revoke_all: decline, cancel, an accept without Run, a failed prompt, a host that cannot ask → no DELETE", async () => {
  const cases = [
    [hostThat({ action: "decline" }), "user_cancelled"],
    [hostThat({ action: "cancel" }), "user_cancelled"],
    [hostThat({ action: "accept", content: { choice: "Cancel" } }), "user_cancelled"],
    [hostThat(() => { throw new Error("prompt failed"); }), "confirm_unavailable"],
    [hostThat(RUN, { canAsk: false }), "confirm_unavailable"],
    [undefined, "confirm_unavailable"],
  ];
  for (const [host, error] of cases) {
    await withBackend(async (calls, tokens) => {
      const pre = await run({ action: "revoke_all" });
      const r = await run({ action: "revoke_all", planId: pre.planId }, host);
      assert.equal(r.error, error, JSON.stringify(r));
      assert.deepEqual(deletes(calls), []);
      assert.equal(tokens.length, 2);
      if (error === "confirm_unavailable") {
        assert.match(r.hint, /web editor: https:\/\/create\.verse8\.io\/creator\/editor\?chat=someone%2Ftoken-demo \(open the Git Clone menu/);
      }
    });
  }
});

test("revoke_all: on Run sends one DELETE without a tokenId; a token granted while the prompt is open stops it", async () => {
  await withBackend(async (calls, tokens) => {
    const pre = await run({ action: "revoke_all" });
    const r = await run({ action: "revoke_all", planId: pre.planId }, hostThat(RUN));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.revoked.map((t) => t.tokenId), [31, 30]);
    assert.deepEqual(deletes(calls).map((c) => c.body), [{ projectPath: PROJECT }]);
    assert.equal(tokens.length, 0);
  });
  await withBackend(async (calls, tokens) => {
    const pre = await run({ action: "revoke_all" });
    const host = hostThat(() => {
      tokens.unshift(entry(32, "tokend-new111", "2026-11-27T01:00:00.000Z"));
      return RUN;
    });
    const r = await run({ action: "revoke_all", planId: pre.planId }, host);
    assert.equal(r.error, "plan_mismatch", JSON.stringify(r));
    assert.deepEqual(deletes(calls), []);
  });
});

test("revoke_all: with no active token there is nothing to do and no DELETE", async () => {
  await withBackend(async (calls, tokens) => {
    tokens.splice(0);
    const r = await run({ action: "revoke_all" });
    assert.equal(r.ok, true);
    assert.equal(r.unchanged, true);
    assert.deepEqual(deletes(calls), []);
  });
});
