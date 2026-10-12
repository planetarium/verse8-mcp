// Unit tests for the V8 commit-message builder / parser.
//
// Uses `node:test` so there are no framework deps. Runs against compiled JS
// (dist/) so the test matches what ships in the published package. Before
// this file runs, `npm run build` must have produced dist/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildV8CommitMessage,
  parseV8CommitMessage,
} from "../../dist/format/v8CommitMessage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// INV-8: V8 commit format is the on-wire contract
test("deterministic build: same input produces identical output", () => {
  const input = {
    userPrompt: "add a red sprite",
    model: "claude-opus-4-7",
    provider: "anthropic",
    mcpServers: ["image"],
    toolCalls: [{ name: "write", status: "completed", input: { filePath: "x.ts" } }],
  };
  const a = buildV8CommitMessage(input);
  const b = buildV8CommitMessage(input);
  assert.equal(a, b);
  // Sanity: not empty and carries all three sections.
  assert.ok(a.includes("<V8AgentMessage>"));
  assert.ok(a.includes("<V8UserMessage>"));
  assert.ok(a.includes("<V8AssistantMessage>"));
});

// INV-8: V8 commit format is the on-wire contract
test("round-trip: build then parse yields valid message", () => {
  const msg = buildV8CommitMessage({
    userPrompt: "fix combo animation",
    model: "claude-opus-4-7",
    provider: "anthropic",
    mcpServers: [],
    reasoning: "adjusted the scale factor",
    toolCalls: [
      { name: "edit", status: "completed", input: { filePath: "a.ts", diff: "..." } },
      { name: "write", status: "completed", input: { filePath: "b.ts" } },
    ],
  });
  const parsed = parseV8CommitMessage(msg);
  assert.equal(parsed.valid, true, `issues: ${JSON.stringify(parsed.issues)}`);
  assert.equal(parsed.subject, "fix combo animation");
  assert.equal(parsed.model, "claude-opus-4-7");
  assert.equal(parsed.provider, "anthropic");
  assert.deepEqual(parsed.toolCallNames, ["edit", "write"]);
  assert.equal(parsed.hasReasoning, true);
});

// INV-8: V8 commit format is the on-wire contract
test("parser rejects message missing V8AgentMessage", () => {
  const broken = [
    "subject",
    "",
    "<V8UserMessage>",
    "[Model: x]",
    "",
    "body",
    "</V8UserMessage>",
    "<V8AssistantMessage>",
    "</V8AssistantMessage>",
  ].join("\n");
  const p = parseV8CommitMessage(broken);
  assert.equal(p.valid, false);
  assert.ok(p.issues.some((i) => /V8AgentMessage/.test(i)));
});

// INV-8: V8 commit format is the on-wire contract
test("parser rejects message missing V8UserMessage", () => {
  const broken = [
    "subject",
    "",
    "<V8AgentMessage>",
    '{"messageId":"msg_ext_zzz","status":"completed","mcpServers":[]}',
    "</V8AgentMessage>",
    "<V8AssistantMessage>",
    "</V8AssistantMessage>",
  ].join("\n");
  const p = parseV8CommitMessage(broken);
  assert.equal(p.valid, false);
  assert.ok(p.issues.some((i) => /V8UserMessage/.test(i)));
});

// INV-8: V8 commit format is the on-wire contract
test("parser rejects message missing V8AssistantMessage", () => {
  const broken = [
    "subject",
    "",
    "<V8AgentMessage>",
    '{"messageId":"msg_ext_zzz","status":"completed","mcpServers":[]}',
    "</V8AgentMessage>",
    "<V8UserMessage>",
    "[Model: x]",
    "",
    "body",
    "</V8UserMessage>",
  ].join("\n");
  const p = parseV8CommitMessage(broken);
  assert.equal(p.valid, false);
  assert.ok(p.issues.some((i) => /V8AssistantMessage/.test(i)));
});

// INV-8: V8 commit format is the on-wire contract
test("parser accepts existing sample commit from sample/match-three-game", () => {
  // Pick the most recent V8-format commit on the sample repo and verify our
  // parser treats it as valid. This protects against drift between the
  // sample corpus and the parser grammar.
  const sampleRepo = path.join(REPO_ROOT, "sample", "match-three-game");
  if (!fs.existsSync(path.join(sampleRepo, ".git"))) {
    // No local git checkout of the sample — skip silently. Smoke suite runs
    // in many environments that may not have cloned the sample subtree.
    return;
  }
  let body = "";
  try {
    body = execFileSync("git", ["log", "-1", "--format=%B", "fd0ce09"], {
      cwd: sampleRepo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Commit ref may not exist in shallow clones — tolerate.
    return;
  }
  if (!body.includes("<V8AgentMessage>")) return;
  const p = parseV8CommitMessage(body);
  assert.equal(
    p.valid,
    true,
    `sample commit did not validate — issues: ${JSON.stringify(p.issues)}`,
  );
  assert.equal(p.hasReasoning, true);
});

test("truncation applies past 4000-char toolCall payloads", () => {
  const bigString = "x".repeat(5000);
  const msg = buildV8CommitMessage({
    userPrompt: "huge change",
    toolCalls: [{ name: "write", input: { filePath: "a.ts", content: bigString } }],
  });
  assert.ok(
    msg.includes("...(truncated)"),
    "expected truncation marker in message body for >4000 char payload",
  );
  // Ensure the oversized payload did not land verbatim.
  assert.equal(msg.includes(bigString), false);
});

// INV-9: Narrative location = inside `<V8AssistantMessage>`
test("narrative: problemStatement + workSummary nest inside V8AssistantMessage AND duplicate into V8AgentMessage JSON", () => {
  const msg = buildV8CommitMessage({
    userPrompt: "add a start screen",
    problemStatement:
      "User wants a dedicated start screen before gameplay; keep current score logic untouched.",
    workSummary:
      "Added src/screens/StartScreen.tsx, wired it into the router, and added a Play button that transitions to the existing GameScreen.",
  });
  // Canonical location: XML tags INSIDE <V8AssistantMessage>.
  const assist = msg.match(/<V8AssistantMessage>([\s\S]*?)<\/V8AssistantMessage>/)?.[1] ?? "";
  assert.match(assist, /<problemStatement id="prs_ext_[a-f0-9]+" status="completed">`[\s\S]+?`<\/problemStatement>/);
  assert.match(assist, /<workSummary id="wsm_ext_[a-f0-9]+" status="completed">`[\s\S]+?`<\/workSummary>/);
  assert.ok(assist.includes("User wants a dedicated start screen"));
  assert.ok(assist.includes("src/screens/StartScreen.tsx"));
  // Legacy markdown sections must NOT be emitted anymore.
  assert.equal(msg.includes("## Problem"), false, "## Problem markdown should not appear — narrative lives in XML now");
  assert.equal(msg.includes("## Work"), false, "## Work markdown should not appear — narrative lives in XML now");
  // Narrative also round-trips through V8AgentMessage JSON.
  assert.ok(msg.match(/"problemStatement":"[^"]+/));
  assert.ok(msg.match(/"workSummary":"[^"]+/));
});

// INV-9: Narrative location = inside `<V8AssistantMessage>`
test("narrative: XML order inside V8AssistantMessage — problemStatement, workSummary, reasoning, toolCall", () => {
  const msg = buildV8CommitMessage({
    userPrompt: "refactor X",
    problemStatement: "ps",
    workSummary: "ws",
    reasoning: "rs",
    toolCalls: [{ name: "edit", input: { filePath: "a.ts" } }],
  });
  const assist = msg.match(/<V8AssistantMessage>([\s\S]*?)<\/V8AssistantMessage>/)?.[1] ?? "";
  const psIdx = assist.indexOf("<problemStatement");
  const wsIdx = assist.indexOf("<workSummary");
  const reasonIdx = assist.indexOf("<reasoning");
  const toolIdx = assist.indexOf("<toolCall");
  assert.ok(psIdx >= 0 && wsIdx > psIdx, "problemStatement must precede workSummary");
  assert.ok(wsIdx < reasonIdx, "workSummary must precede reasoning");
  assert.ok(reasonIdx < toolIdx, "reasoning must precede toolCall");
});

test("narrative: parser extracts problemStatement + workSummary (from JSON)", () => {
  const msg = buildV8CommitMessage({
    userPrompt: "x",
    problemStatement: "ps1",
    workSummary: "ws1",
  });
  const p = parseV8CommitMessage(msg);
  assert.equal(p.valid, true, `issues: ${JSON.stringify(p.issues)}`);
  assert.equal(p.problemStatement, "ps1");
  assert.equal(p.workSummary, "ws1");
  assert.equal(p.warnings.length, 0);
});

test("narrative: parser extracts XML narrative even when V8AgentMessage JSON lacks fields", () => {
  // A hand-crafted commit (e.g. future human edit) where the XML narrative is
  // present inside V8AssistantMessage but the V8AgentMessage JSON does NOT
  // duplicate it. Parser must still return the narrative.
  const handCrafted = [
    "rework the checkout path",
    "",
    "<V8AgentMessage>",
    '{"messageId":"msg_ext_q","status":"completed","mcpServers":[]}',
    "</V8AgentMessage>",
    "<V8UserMessage>",
    "rework the checkout path",
    "</V8UserMessage>",
    "<V8AssistantMessage>",
    '<problemStatement id="prs_ext_a" status="completed">`Checkout had a race between payment auth and inventory hold.`</problemStatement>',
    "",
    '<workSummary id="wsm_ext_b" status="completed">`Serialised auth→hold by awaiting the auth promise before calling hold; added a rollback on hold failure.`</workSummary>',
    "</V8AssistantMessage>",
  ].join("\n");
  const p = parseV8CommitMessage(handCrafted);
  assert.equal(p.valid, true);
  assert.equal(
    p.problemStatement,
    "Checkout had a race between payment auth and inventory hold.",
  );
  assert.equal(
    p.workSummary,
    "Serialised auth→hold by awaiting the auth promise before calling hold; added a rollback on hold failure.",
  );
});

// INV-9: Narrative location = inside `<V8AssistantMessage>`
test("narrative: parser falls back to markdown section scrape when JSON lacks fields", () => {
  // Hand-craft a message where the markdown headers are present but the
  // V8AgentMessage JSON doesn't carry the narrative. Simulates a
  // human-edited commit or an older build that only wrote the markdown.
  const handCrafted = [
    "fix the footer layout",
    "",
    "## Problem",
    "Footer overflowed on mobile widths.",
    "",
    "## Work",
    "Switched flex to column below 480px and clamped padding.",
    "",
    "<V8AgentMessage>",
    '{"messageId":"msg_ext_z","status":"completed","mcpServers":[]}',
    "</V8AgentMessage>",
    "<V8UserMessage>",
    "fix the footer layout",
    "</V8UserMessage>",
    "<V8AssistantMessage>",
    "</V8AssistantMessage>",
  ].join("\n");
  const p = parseV8CommitMessage(handCrafted);
  assert.equal(p.valid, true);
  assert.equal(p.problemStatement, "Footer overflowed on mobile widths.");
  assert.equal(
    p.workSummary,
    "Switched flex to column below 480px and clamped padding.",
  );
});

test("narrative: parser emits warnings when V8 message omits narrative", () => {
  const noNarrative = buildV8CommitMessage({
    userPrompt: "trivial bump",
    model: "claude-opus-4-7",
    provider: "anthropic",
  });
  const p = parseV8CommitMessage(noNarrative);
  // Structurally valid — warnings do NOT affect validity.
  assert.equal(p.valid, true, `issues: ${JSON.stringify(p.issues)}`);
  assert.ok(
    p.warnings.some((w) => /problemStatement/i.test(w) && /V8AssistantMessage/i.test(w)),
    `expected problemStatement warning citing V8AssistantMessage, got: ${JSON.stringify(p.warnings)}`,
  );
  assert.ok(
    p.warnings.some((w) => /workSummary/i.test(w) && /V8AssistantMessage/i.test(w)),
    `expected workSummary warning citing V8AssistantMessage, got: ${JSON.stringify(p.warnings)}`,
  );
});

test("narrative: parser does NOT warn on merge / revert (no userPrompt)", () => {
  // A structurally-valid V8 message with no V8UserMessage body is the
  // non-V8 / bootstrap path; we should not nag it with narrative warnings.
  const bootstrap = [
    "[verse8] bootstrap commit",
    "",
    "<V8AgentMessage>",
    '{"messageId":"msg_ext_b","status":"completed","mcpServers":[]}',
    "</V8AgentMessage>",
    "<V8UserMessage>",
    "</V8UserMessage>",
    "<V8AssistantMessage>",
    "</V8AssistantMessage>",
  ].join("\n");
  const p = parseV8CommitMessage(bootstrap);
  // Missing userPrompt body → `issues` will include that, but no narrative
  // warnings should be emitted.
  assert.ok(
    !p.warnings.some((w) => /problemStatement|workSummary/.test(w)),
    `expected no narrative warnings on non-V8 path, got: ${JSON.stringify(p.warnings)}`,
  );
});
