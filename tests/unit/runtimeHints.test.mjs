// Tool hints and hook messages are read by an agent inside a game project,
// which has no copy of this repo. They must not send it to `scripts/…` or
// other repo paths, or to commands that only work in a checkout of this repo.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";

import { LOGIN_HINT } from "../../dist/util/hints.js";
import { runCommitMsgHook } from "../../dist/cli/commitMsgHook.js";
import { REPO_ROOT, repoPathRefs } from "./_repoPaths.mjs";

function tsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** Every string literal and template-literal chunk in src/ — comments excluded. */
function sourceStrings() {
  const out = [];
  for (const file of tsFiles(path.join(REPO_ROOT, "src"))) {
    const sf = parse(file);
    const visit = (node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        out.push({ where: `${path.relative(REPO_ROOT, file)}:${line + 1}`, text: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

test("runtime strings in src/: no pointers to files or scripts inside the verse8-mcp repo", () => {
  const strings = sourceStrings();
  assert.ok(strings.length > 1000, `only ${strings.length} strings found`);
  const bad = [];
  for (const { where, text } of strings) {
    for (const ref of repoPathRefs(text)) bad.push(`${where}: ${ref}`);
    if (/\bbash scripts\b|\bnpm run (sync|check|test)\b/.test(text)) bad.push(`${where}: ${text.slice(0, 80)}`);
  }
  assert.deepEqual(bad, []);
});

// Every place that returns `not_logged_in` — `{ error: "not_logged_in", hint }`
// or `fail(…, "not_logged_in", hint)` — must pass LOGIN_HINT, not its own text.
test("not_logged_in results in src/: every hint is LOGIN_HINT", () => {
  const sites = [];
  const bad = [];
  for (const file of tsFiles(path.join(REPO_ROOT, "src"))) {
    const sf = parse(file);
    const visit = (node) => {
      if (ts.isStringLiteral(node) && node.text === "not_logged_in") {
        const p = node.parent;
        const where = `${path.relative(REPO_ROOT, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        let hint;
        if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "error" && ts.isObjectLiteralExpression(p.parent)) {
          hint = p.parent.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === "hint");
          hint = hint ? hint.initializer.getText(sf) : "<no hint>";
        } else if (ts.isCallExpression(p) && p.arguments.includes(node)) {
          hint = p.arguments.slice(p.arguments.indexOf(node) + 1).map((a) => a.getText(sf)).join(", ") || "<no hint>";
        }
        if (hint !== undefined) {
          sites.push(where);
          if (!/\bLOGIN_HINT\b/.test(hint)) bad.push(`${where}: ${hint.slice(0, 80)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.ok(sites.length >= 12, `only ${sites.length} not_logged_in sites found`);
  assert.deepEqual(bad, []);
});

test("not_logged_in hint: start → user approves → complete, the same order as the verse8-login skill", async () => {
  assert.match(LOGIN_HINT, /verse8_login_start[\s\S]*approve[\s\S]*verse8_login_complete/);
  const saved = { tok: process.env.VERSE8_ACCESS_TOKEN, xdg: process.env.XDG_CONFIG_HOME, cwd: process.cwd() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-hint-"));
  delete process.env.VERSE8_ACCESS_TOKEN;
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  process.chdir(dir);
  try {
    // Only this test needs the whole server; the scans above read src/ only.
    const { createServer } = await import("../../dist/server.js");
    const res = await createServer()._requestHandlers.get("tools/call")(
      { method: "tools/call", params: { name: "verse8_status", arguments: {} } },
      {},
    );
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.error, "not_logged_in");
    assert.equal(body.hint, LOGIN_HINT);
  } finally {
    process.chdir(saved.cwd);
    if (saved.tok !== undefined) process.env.VERSE8_ACCESS_TOKEN = saved.tok;
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.xdg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("commit-msg hook rejection: points at verse8_checkpoint and states the format, no repo script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-hookmsg-"));
  const file = path.join(dir, "COMMIT_EDITMSG");
  fs.writeFileSync(file, "just a plain message\n");
  const saved = { write: process.stderr.write, allow: process.env.VERSE8_ALLOW_NONCOMPLIANT };
  delete process.env.VERSE8_ALLOW_NONCOMPLIANT;
  let err = "";
  process.stderr.write = (chunk) => ((err += String(chunk)), true);
  let code;
  try {
    code = runCommitMsgHook(file);
  } finally {
    process.stderr.write = saved.write;
    if (saved.allow !== undefined) process.env.VERSE8_ALLOW_NONCOMPLIANT = saved.allow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(err, /verse8_checkpoint/);
  assert.match(err, /Format:[^\n]*<V8AgentMessage>[\s\S]*<V8UserMessage>[\s\S]*<V8AssistantMessage>/);
  assert.doesNotMatch(err, /scripts\//);
});
