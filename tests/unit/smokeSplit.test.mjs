import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SMOKE_DIR = path.join(REPO_ROOT, "tests", "smoke");
const SMOKE_SH = path.join(REPO_ROOT, "tests", "smoke.sh");

const SUITES = ["login", "attach", "new-project", "preview", "skills", "upload-asset"];

test("M4.1: each split suite file exists and is executable", () => {
  assert.ok(fs.existsSync(path.join(SMOKE_DIR, "_runner.sh")));
  for (const name of SUITES) {
    const p = path.join(SMOKE_DIR, `${name}.sh`);
    assert.ok(fs.existsSync(p), `missing suite: ${name}`);
    const mode = fs.statSync(p).mode & 0o777;
    assert.ok(mode & 0o100, `${name}.sh not executable (mode=${mode.toString(8)})`);
  }
});

test("M4.1: each split suite sources _runner.sh", () => {
  for (const name of SUITES) {
    const body = fs.readFileSync(path.join(SMOKE_DIR, `${name}.sh`), "utf8");
    assert.match(body, /_runner\.sh/, `${name}.sh does not reference _runner.sh`);
    assert.match(body, /SUITE_TESTS/, `${name}.sh does not export SUITE_TESTS`);
  }
});

test("M4.1: _runner.sh forwards SUITE_TESTS as VERSE8_SMOKE_ONLY to smoke.sh", () => {
  const body = fs.readFileSync(path.join(SMOKE_DIR, "_runner.sh"), "utf8");
  assert.match(body, /VERSE8_SMOKE_ONLY=.*SUITE_TESTS/);
  assert.match(body, /smoke\.sh/);
});

test("M4.1: smoke.sh honors VERSE8_SMOKE_ONLY filter", () => {
  const body = fs.readFileSync(SMOKE_SH, "utf8");
  assert.match(body, /VERSE8_SMOKE_ONLY/);
});

test("M4.1: every test_* in smoke.sh's ALL_TESTS appears in exactly one split file", () => {
  const smoke = fs.readFileSync(SMOKE_SH, "utf8");
  const allMatch = smoke.match(/ALL_TESTS="([^"]+)"/);
  assert.ok(allMatch, "ALL_TESTS block missing from smoke.sh");
  const names = allMatch[1]
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("test_"));
  assert.ok(names.length > 0);
  const owners = {};
  for (const n of names) owners[n] = [];
  for (const suite of SUITES) {
    const body = fs.readFileSync(path.join(SMOKE_DIR, `${suite}.sh`), "utf8");
    for (const n of names) {
      if (new RegExp(`\\b${n}\\b`).test(body)) owners[n].push(suite);
    }
  }
  const missing = names.filter((n) => owners[n].length === 0);
  const duplicated = names.filter((n) => owners[n].length > 1);
  assert.deepEqual(missing, [], `tests not owned by any split file: ${missing}`);
  assert.deepEqual(
    duplicated,
    [],
    `tests owned by multiple split files: ${JSON.stringify(
      Object.fromEntries(duplicated.map((n) => [n, owners[n]])),
    )}`,
  );
});
