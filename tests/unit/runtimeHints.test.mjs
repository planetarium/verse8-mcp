// Tool hints and hook messages are read by an agent inside a game project,
// which has no copy of this repo. They must not send it to `scripts/…` or
// other repo paths, or to commands that only work in a checkout of this repo.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { createServer } from "../../dist/server.js";
import { LOGIN_HINT } from "../../dist/util/hints.js";
import { runCommitMsgHook } from "../../dist/cli/commitMsgHook.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

/** Every string literal and template-literal chunk in src/ — comments excluded. */
function sourceStrings() {
  const out = [];
  for (const file of tsFiles(path.join(REPO_ROOT, "src"))) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
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
  const repoPath = /(?<![\w./~-])((?:scripts|tests|docs|hooks|sample|skills-vendor)\/[\w.-]+(?:\/[\w.-]+)*|src\/(?:tools|api|util|cli|format|context|prompts|resources|proxy)\/[\w./-]+)/g;
  const bad = [];
  for (const { where, text } of strings) {
    for (const [, ref] of text.matchAll(repoPath)) {
      if (ref.startsWith("sample/") || fs.existsSync(path.join(REPO_ROOT, ref))) bad.push(`${where}: ${ref}`);
    }
    if (/\bbash scripts\b|\bnpm run (sync|check|test)\b/.test(text)) bad.push(`${where}: ${text.slice(0, 80)}`);
  }
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
  assert.match(err, /<V8AgentMessage>[\s\S]*<V8UserMessage>[\s\S]*<V8AssistantMessage>/);
  assert.doesNotMatch(err, /scripts\//);
});
