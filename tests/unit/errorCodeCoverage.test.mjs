import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import ts from "typescript";
import { ERROR_CODES, isErrorCode } from "../../dist/util/errors.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

function loadSrcTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...loadSrcTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function collectErrorLiteralsFromSource(srcText) {
  const sf = ts.createSourceFile("x.ts", srcText, ts.ScriptTarget.ES2022, true);
  const found = new Set();
  function visit(node) {
    // Match object-literal property assignments: `error: "code"`
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "error") ||
        (ts.isStringLiteral(node.name) && node.name.text === "error"))
    ) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        found.add(init.text);
      }
    }
    // Match property signatures in types: `error: "code"` or `error: "a" | "b"`
    if (
      ts.isPropertySignature(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "error" &&
      node.type
    ) {
      const collect = (tn) => {
        if (
          ts.isLiteralTypeNode(tn) &&
          (ts.isStringLiteral(tn.literal) ||
            ts.isNoSubstitutionTemplateLiteral(tn.literal))
        ) {
          found.add(tn.literal.text);
        } else if (ts.isUnionTypeNode(tn)) {
          for (const t of tn.types) collect(t);
        } else if (ts.isParenthesizedTypeNode(tn)) {
          collect(tn.type);
        }
      };
      collect(node.type);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

test("errors: ERROR_CODES is non-empty and every entry is unique", () => {
  assert.ok(Array.isArray(ERROR_CODES));
  assert.ok(ERROR_CODES.length >= 30);
  const seen = new Set();
  for (const c of ERROR_CODES) {
    assert.equal(typeof c, "string");
    assert.ok(!seen.has(c), `duplicate error code: ${c}`);
    seen.add(c);
  }
});

test("errors: isErrorCode narrows known and rejects unknown", () => {
  assert.equal(isErrorCode("not_logged_in"), true);
  assert.equal(isErrorCode("attach_failed"), true);
  assert.equal(isErrorCode("definitely_not_a_code"), false);
  assert.equal(isErrorCode(""), false);
  assert.equal(isErrorCode(undefined), false);
  assert.equal(isErrorCode(42), false);
});

test("errors: every error-literal in src/ is present in ERROR_CODES (AC-TYPES-1)", () => {
  const union = new Set(ERROR_CODES);
  const files = loadSrcTsFiles(SRC_ROOT);
  assert.ok(files.length >= 10, "expected to find TS files under src/");

  // Device-flow polling states (RFC 8628) — not MCP-facing error codes.
  const nonToolLiterals = new Set(["authorization_pending"]);
  // HTTP status literals (e.g. `http_${resp.status}` template) can't be
  // enumerated; the test handles them via the template-literal skip.

  const missing = new Set();
  const seen = new Set();
  for (const file of files) {
    if (file.endsWith("util/errors.ts")) continue;
    const text = fs.readFileSync(file, "utf8");
    const literals = collectErrorLiteralsFromSource(text);
    for (const lit of literals) {
      seen.add(lit);
      if (nonToolLiterals.has(lit)) continue;
      if (!union.has(lit)) missing.add(`${path.relative(SRC_ROOT, file)}::${lit}`);
    }
  }

  assert.ok(seen.size > 0, "AST walk found zero error literals — detector broken");
  assert.deepEqual(
    [...missing].sort(),
    [],
    `error literals in src/ missing from ERROR_CODES: ${[...missing].sort().join(", ")}`,
  );
});
