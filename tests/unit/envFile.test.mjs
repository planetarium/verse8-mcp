// Unit tests for `.env` materialization.
//
// The verse8 runtime requires VITE_AGENT8_ACCOUNT + VITE_AGENT8_VERSE to
// exist in every attached project. `ensureVerse8EnvFile` enforces this with
// an "once set, never auto-overwritten" policy: a different logged-in
// wallet does NOT replace an existing binding — the user must opt into
// overwrite explicitly.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ACCOUNT_KEY,
  VERSE_KEY,
  ensureVerse8EnvFile,
  parseDotenv,
  readEnvAccount,
  readEnvVerse,
  upsertEnvLines,
} from "../../dist/context/envFile.js";

const WALLET_A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-env-"));
}

function readEnv(projectDir) {
  return fs.readFileSync(path.join(projectDir, ".env"), "utf8");
}

// ------------------------------------------------------------------
// parseDotenv
// ------------------------------------------------------------------

test("parseDotenv: parses KEY=value pairs, ignores blanks and comments", () => {
  const raw = ["# header", "", "A=1", "B = two", "# inline-comment=no", "C=\"quoted\""].join("\n");
  const m = parseDotenv(raw);
  assert.equal(m.get("A"), "1");
  assert.equal(m.get("B"), "two");
  assert.equal(m.get("C"), "quoted");
  assert.equal(m.has("inline-comment"), false);
});

test("parseDotenv: last assignment wins", () => {
  const m = parseDotenv("X=old\nX=new\n");
  assert.equal(m.get("X"), "new");
});

// ------------------------------------------------------------------
// upsertEnvLines
// ------------------------------------------------------------------

test("upsertEnvLines: appends missing keys, preserves others", () => {
  const out = upsertEnvLines("EXISTING=1\n", [["VITE_AGENT8_ACCOUNT", "0xDEAD"]]);
  assert.match(out, /^EXISTING=1$/m);
  assert.match(out, /^VITE_AGENT8_ACCOUNT=0xDEAD$/m);
});

test("upsertEnvLines: replaces only the matching line", () => {
  const out = upsertEnvLines("A=old\nB=keep\n", [["A", "new"]]);
  assert.match(out, /^A=new$/m);
  assert.match(out, /^B=keep$/m);
});

// ------------------------------------------------------------------
// ensureVerse8EnvFile — lifecycle
// ------------------------------------------------------------------

test("ensureVerse8EnvFile: creates fresh .env with ACCOUNT + VERSE", () => {
  const dir = tmpProject();
  try {
    const r = ensureVerse8EnvFile(dir, WALLET_A);
    assert.equal(r.status, "created");
    assert.equal(r.account, WALLET_A);
    assert.match(r.verse, /^0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-\d{13}$/);
    const body = readEnv(dir);
    assert.match(body, new RegExp(`^${ACCOUNT_KEY}=${WALLET_A}$`, "m"));
    assert.match(body, new RegExp(`^${VERSE_KEY}=${WALLET_A}-\\d{13}$`, "m"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: idempotent when both keys already match", () => {
  const dir = tmpProject();
  try {
    ensureVerse8EnvFile(dir, WALLET_A);
    const body1 = readEnv(dir);
    const mtime1 = fs.statSync(path.join(dir, ".env")).mtimeMs;
    // wait a tick to ensure any write would change mtime
    const r = ensureVerse8EnvFile(dir, WALLET_A);
    assert.equal(r.status, "already-present");
    const body2 = readEnv(dir);
    assert.equal(body2, body1);
    const mtime2 = fs.statSync(path.join(dir, ".env")).mtimeMs;
    assert.equal(mtime2, mtime1, "already-present path must not rewrite the file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: account mismatch → preserve + hint (no overwrite)", () => {
  const dir = tmpProject();
  try {
    ensureVerse8EnvFile(dir, WALLET_A);
    const before = readEnv(dir);
    // Silence the expected warn so test output stays clean.
    const origErr = console.error;
    console.error = () => {};
    let r;
    try {
      r = ensureVerse8EnvFile(dir, WALLET_B);
    } finally {
      console.error = origErr;
    }
    assert.equal(r.status, "mismatch-preserved");
    assert.equal(r.existingAccount, WALLET_A);
    assert.equal(r.currentAccount, WALLET_B);
    assert.match(r.hint, /overwriteEnv: true/);
    // File unchanged.
    assert.equal(readEnv(dir), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: overwrite: true replaces account AND verse", () => {
  const dir = tmpProject();
  try {
    ensureVerse8EnvFile(dir, WALLET_A);
    const r = ensureVerse8EnvFile(dir, WALLET_B, { overwrite: true });
    assert.equal(r.status, "overwrote");
    assert.equal(r.account, WALLET_B);
    assert.match(r.verse, /^0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-\d{13}$/);
    const body = readEnv(dir);
    assert.match(body, new RegExp(`^${ACCOUNT_KEY}=${WALLET_B}$`, "m"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: VERSE reused verbatim when present", () => {
  const dir = tmpProject();
  try {
    // Hand-craft a .env with a specific VERSE timestamp we control.
    const fixedVerse = `${WALLET_A}-1000000000000`;
    fs.writeFileSync(
      path.join(dir, ".env"),
      `${ACCOUNT_KEY}=${WALLET_A}\n${VERSE_KEY}=${fixedVerse}\n`,
    );
    const r = ensureVerse8EnvFile(dir, WALLET_A);
    assert.equal(r.status, "already-present");
    assert.equal(r.verse, fixedVerse, "existing VERSE must not be regenerated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: only VERSE missing → repair using existing ACCOUNT", () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, ".env"), `${ACCOUNT_KEY}=${WALLET_A}\n`);
    const r = ensureVerse8EnvFile(dir, WALLET_A);
    assert.equal(r.status, "added-missing");
    assert.match(r.verse, /^0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-\d{13}$/);
    const body = readEnv(dir);
    assert.match(body, new RegExp(`^${VERSE_KEY}=${WALLET_A}-\\d{13}$`, "m"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: only ACCOUNT missing → patch without touching VERSE", () => {
  const dir = tmpProject();
  try {
    const keepVerse = `${WALLET_A}-1234567890123`;
    fs.writeFileSync(path.join(dir, ".env"), `${VERSE_KEY}=${keepVerse}\nOTHER=preserve\n`);
    const r = ensureVerse8EnvFile(dir, WALLET_A);
    assert.equal(r.status, "added-missing");
    assert.equal(r.verse, keepVerse);
    const body = readEnv(dir);
    assert.match(body, new RegExp(`^${ACCOUNT_KEY}=${WALLET_A}$`, "m"));
    assert.match(body, /^OTHER=preserve$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: skips when no wallet address", () => {
  const dir = tmpProject();
  try {
    const r = ensureVerse8EnvFile(dir, null);
    assert.equal(r.status, "skipped-not-logged-in");
    assert.equal(fs.existsSync(path.join(dir, ".env")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureVerse8EnvFile: preserves unrelated keys and comments", () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      path.join(dir, ".env"),
      `# top comment\nDEBUG=true\nOTHER_KEY=value\n`,
    );
    ensureVerse8EnvFile(dir, WALLET_A);
    const body = readEnv(dir);
    assert.match(body, /^# top comment$/m);
    assert.match(body, /^DEBUG=true$/m);
    assert.match(body, /^OTHER_KEY=value$/m);
    assert.match(body, new RegExp(`^${ACCOUNT_KEY}=${WALLET_A}$`, "m"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------
// readEnvAccount — lazy read helper
// ------------------------------------------------------------------

test("readEnvAccount: returns null when .env is absent", () => {
  const dir = tmpProject();
  try {
    assert.equal(readEnvAccount(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readEnvAccount: returns the account when present", () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, ".env"), `${ACCOUNT_KEY}=${WALLET_A}\n`);
    assert.equal(readEnvAccount(dir), WALLET_A);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readEnvVerse: returns VITE_AGENT8_VERSE when present", () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(
      path.join(dir, ".env"),
      `${ACCOUNT_KEY}=${WALLET_A}\n${VERSE_KEY}=${WALLET_A}-999\n`,
    );
    assert.equal(readEnvVerse(dir), `${WALLET_A}-999`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readEnvVerse: returns null when VITE_AGENT8_VERSE missing", () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, ".env"), "UNRELATED=x\n");
    assert.equal(readEnvVerse(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readEnvVerse: returns null when .env absent", () => {
  const dir = tmpProject();
  try {
    assert.equal(readEnvVerse(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
