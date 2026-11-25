// node --test runs these files in parallel against one shared dist/. A test
// that rebuilds dist/ (npm run build / tsc without --outDir) rewrites modules
// another file is importing at that moment — CI saw "./deploy.js does not
// provide an export named …" from exactly that. A test that writes the real
// ~/.config/verse8/token races every file that reads the login. Both must use
// a temp dir instead.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { REPO_ROOT } from "./_repoPaths.mjs";

const UNIT = path.join(REPO_ROOT, "tests", "unit");
const SELF = path.basename(new URL(import.meta.url).pathname);

test("unit tests: none rebuilds the shared dist/ or writes the real home config", () => {
  const bad = [];
  for (const name of fs.readdirSync(UNIT).filter((n) => n.endsWith(".mjs") && n !== SELF)) {
    const text = fs.readFileSync(path.join(UNIT, name), "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      const where = `${name}:${i + 1}`;
      if (/\[\s*"run"\s*,\s*"build"\s*\]/.test(line)) bad.push(`${where}: npm run build`);
      if (/\b(execFileSync|execSync|spawnSync|spawn|exec)\(/.test(line) && /\btsc\b/.test(line) && !/--outDir/.test(line)) {
        bad.push(`${where}: tsc without --outDir`);
      }
      if (/process\.env\.HOME\b|os\.homedir\(\)/.test(line)) bad.push(`${where}: real home directory`);
    });
  }
  assert.deepEqual(bad, []);
});
