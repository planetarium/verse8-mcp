import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GUARD = path.join(REPO_ROOT, "scripts", "prepublish-guard.sh");

function runGuard(cwd) {
  const res = spawnSync("bash", [GUARD], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Stand up a scratch package mirroring the repo layout the guard expects:
 * package.json with a `files` allow-list, plus whatever fixture content
 * the caller wants to seed into dist/ or skills/. `npm pack --dry-run`
 * walks the allow-list from this cwd, so the guard scans ONLY our
 * seeded files.
 */
function scratchPkg(seedFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-prepublish-"));
  const pkg = {
    name: "verse8-guard-test",
    version: "0.0.0",
    files: ["dist/**/*.js", "dist/**/*.d.ts", "skills/**", "README.md"],
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, "README.md"), "# test fixture\n");
  for (const [rel, body] of Object.entries(seedFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

test("prepublish-guard: clean tree exits 0", () => {
  const pkg = scratchPkg({
    "dist/index.js": "export const hello = 'world';\n",
    "dist/index.d.ts": "export declare const hello: string;\n",
  });
  try {
    const res = runGuard(pkg.dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /0 secret matches/);
  } finally {
    pkg.cleanup();
  }
});

test("prepublish-guard: glpat-* token in dist/ fails", () => {
  const pkg = scratchPkg({
    "dist/index.js":
      "export const leaked = 'token=glpat-abcdefghijklmnopqrstuvwxyz1234';\n",
  });
  try {
    const res = runGuard(pkg.dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /glpat-shape/);
  } finally {
    pkg.cleanup();
  }
});

test("prepublish-guard: sourcemap (.map) in tarball fails even when not a real secret", () => {
  const pkg = scratchPkg({
    "dist/leaked.js": "export const safe = 1;\n",
  });
  // Seed the .map file separately so we can also list it explicitly in
  // files; the scratchPkg uses dist/**/*.js allow-list which excludes .map.
  // So add a broader allow-list for this test.
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkg.dir, "package.json"), "utf8"));
  pkgJson.files = ["dist/**"];
  fs.writeFileSync(
    path.join(pkg.dir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );
  fs.writeFileSync(path.join(pkg.dir, "dist", "leaked.js.map"), "{}\n");
  try {
    const res = runGuard(pkg.dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /sourcemap in tarball/);
  } finally {
    pkg.cleanup();
  }
});

test("prepublish-guard: docstring reference to 'Bearer token' does NOT false-positive", () => {
  const pkg = scratchPkg({
    "dist/docs.js":
      "// Authorization: Bearer token — this is documentation, not a secret.\n",
  });
  try {
    const res = runGuard(pkg.dir);
    assert.equal(res.status, 0, `false-positive on documentation: ${res.stderr}`);
  } finally {
    pkg.cleanup();
  }
});

test("prepublish-guard: realistic Bearer value (20+ chars) fails", () => {
  const pkg = scratchPkg({
    "dist/leak.js":
      "const h = 'Bearer eyJabc.xyzpayloadLongEnoughToTrip.sig';\n",
  });
  try {
    const res = runGuard(pkg.dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /bearer-shape/);
  } finally {
    pkg.cleanup();
  }
});

test("prepublish-guard: wallet env binding with hex value fails; placeholder text does not", () => {
  // Realistic leak → fail.
  const hotPkg = scratchPkg({
    "dist/env.js":
      "export const x = 'VITE_AGENT8_ACCOUNT=0xdeadBEEFdeadBEEFdeadBEEFdeadBEEFdeadBEEF';\n",
  });
  try {
    const hotRes = runGuard(hotPkg.dir);
    assert.notEqual(hotRes.status, 0);
    assert.match(hotRes.stderr, /wallet_env-shape/);
  } finally {
    hotPkg.cleanup();
  }
  // Docstring reference → pass.
  const coldPkg = scratchPkg({
    "dist/docs.js": "// VITE_AGENT8_ACCOUNT= 0x…is the wallet key.\n",
  });
  try {
    const coldRes = runGuard(coldPkg.dir);
    assert.equal(coldRes.status, 0);
  } finally {
    coldPkg.cleanup();
  }
});

test("prepublish-guard: real repo tarball passes the guard (integration)", () => {
  // Rebuild + run against the actual repo.
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT });
  const res = runGuard(REPO_ROOT);
  assert.equal(res.status, 0, `guard failed on real repo: ${res.stderr}`);
});
