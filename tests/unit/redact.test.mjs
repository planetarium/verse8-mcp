import test from "node:test";
import assert from "node:assert/strict";

import {
  SECRET_SHAPES,
  safeHint,
  safeErrorHint,
} from "../../dist/util/redact.js";

test("redact: SECRET_SHAPES is a non-empty registry", () => {
  assert.ok(Array.isArray(SECRET_SHAPES));
  assert.ok(SECRET_SHAPES.length >= 7);
  for (const shape of SECRET_SHAPES) {
    assert.equal(typeof shape.name, "string");
    assert.ok(shape.pattern instanceof RegExp);
  }
});

test("redact: glpat-* token in plain text", () => {
  const got = safeHint("clone with glpat-aBc123_-XyZ token");
  assert.match(got, /glpat-\*\*\*/);
  assert.doesNotMatch(got, /glpat-aBc/);
});

test("redact: Bearer header in stderr", () => {
  const got = safeHint("Authorization: Bearer eyJhbGc.payload.sig");
  assert.match(got, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(got, /eyJhbGc/);
});

test("redact: oauth2:<PAT>@ inside a clone URL", () => {
  const got = safeHint(
    "git clone https://oauth2:glpat-secret123@gitlab.verse8.io/u/p.git proj",
  );
  assert.match(got, /oauth2:\*\*\*@gitlab\.verse8\.io/);
  assert.doesNotMatch(got, /glpat-secret/);
  assert.match(got, /gitlab\.verse8\.io/);
});

test("redact: JSON access_token field", () => {
  const got = safeHint('{"access_token":"eyJxxx","scope":"read"}');
  assert.match(got, /"access_token":"\[REDACTED\]"/);
  assert.doesNotMatch(got, /eyJxxx/);
});

test("redact: JSON refresh_token / id_token / device_code fields", () => {
  const got = safeHint(
    '{"refresh_token":"r1","id_token":"i1","device_code":"d1"}',
  );
  assert.match(got, /"refresh_token":"\[REDACTED\]"/);
  assert.match(got, /"id_token":"\[REDACTED\]"/);
  assert.match(got, /"device_code":"\[REDACTED\]"/);
});

test("redact: multi-line input scrubs every match", () => {
  const got = safeHint(
    [
      "line 1: glpat-aaa",
      "line 2: Bearer bbb_ccc",
      'line 3: {"access_token":"ddd"}',
    ].join("\n"),
  );
  assert.doesNotMatch(got, /glpat-aaa/);
  assert.doesNotMatch(got, /Bearer bbb/);
  assert.doesNotMatch(got, /"access_token":"ddd"/);
});

test("redact: idempotent — safeHint(safeHint(x)) === safeHint(x)", () => {
  const inputs = [
    "glpat-abcdef",
    "https://oauth2:glpat-x@host/p.git",
    "Bearer eyJ.x.y",
    '{"access_token":"a","refresh_token":"b"}',
    "no secrets here",
    "",
  ];
  for (const x of inputs) {
    const once = safeHint(x);
    const twice = safeHint(once);
    assert.equal(twice, once, `not idempotent for: ${x}`);
  }
});

test("redact: token-keyvalue catches `token=<opaque>` outside JSON", () => {
  // Long opaque token (>=16 chars).
  const got = safeHint("env: token=AbCdEfGhIjKlMnOpQrSt extra");
  assert.match(got, /token["'\s:=]+\[REDACTED\]/);
  const safe = safeHint("CLI flag: --token=foo");
  assert.match(safe, /--token=foo/);
});

test("redact: passes through clean strings unchanged", () => {
  const cases = [
    "",
    "no secrets here",
    "https://gitlab.verse8.io/u/p",
    "git clone https://github.com/me/proj.git",
    "exit code 0",
  ];
  for (const x of cases) {
    assert.equal(safeHint(x), x, `clean string mutated: ${x}`);
  }
});

test("redact: very long input does not crash or hang", () => {
  const big = "x".repeat(50_000) + " glpat-leak";
  const got = safeHint(big);
  assert.match(got, /glpat-\*\*\*/);
  assert.doesNotMatch(got, /glpat-leak/);
});

test("safeErrorHint: Error instance", () => {
  const e = new Error("clone failed: oauth2:glpat-x@host/p.git");
  const got = safeErrorHint(e);
  assert.match(got, /oauth2:\*\*\*@/);
  assert.doesNotMatch(got, /glpat-x/);
});

test("safeErrorHint: string", () => {
  assert.match(safeErrorHint("Bearer leakthis"), /Bearer \[REDACTED\]/);
});

test("safeErrorHint: undefined / null safe", () => {
  assert.equal(safeErrorHint(undefined), "");
  assert.equal(safeErrorHint(null), "");
});

test("safeErrorHint: arbitrary object never throws", () => {
  const got = safeErrorHint({ status: 500 });
  assert.equal(typeof got, "string");
});

test("safeErrorHint: object with throwing toString does not propagate", () => {
  const evil = {
    toString() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => safeErrorHint(evil));
  assert.equal(safeErrorHint(evil), "");
});
