// Integration-ish unit test for runNewProjectStart / runNewProjectConfirm.
//
// Spawns the agent8-backend mock as a child process, exercises:
//   - template_mismatch guardrail (AC-11) — zero HTTP calls when startCallId
//     digest disagrees with the passed templateName/repo/path
//   - happy-path confirm (AC-2, AC-3, AC-12) including the
//     nextCallRequires.projectDir envelope and post-clone attach
//   - retry safety (AC-13) — second confirm with projectPath skips
//     /api/select-template (call count stays at 1)
//   - concurrency guard (AC-14) — parallel confirms → one gets confirm_in_flight
//
// Runs against dist/, so the published compile output is what's tested.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  runNewProjectStart,
  runNewProjectConfirm,
  _resetNewProjectStateForTests,
} from "../../dist/tools/newProject.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const MOCK_SCRIPT = path.join(REPO_ROOT, "tests/mocks/agent8-backend-mock.ts");
const FIXTURE_BUNDLE = "/tmp/verse8-smoke-bundle.git";
const PORT_FILE = "/tmp/agent8-mock-port.txt";
const CALLS_FILE = "/tmp/agent8-mock-calls.jsonl";

function ensureFixtureBundle() {
  // fixture-bundle.sh builds the bare repo the mock's file:// cloneCommand
  // points at. Rebuild each test run so we always start from a known state.
  execFileSync("bash", [path.join(REPO_ROOT, "tests/mocks/fixture-bundle.sh")], {
    stdio: "ignore",
  });
}

async function waitForFile(p, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function startMock(extraArgs = []) {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {}
  try {
    fs.unlinkSync(CALLS_FILE);
  } catch {}
  const proc = spawn("npx", ["--yes", "tsx", MOCK_SCRIPT, ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ok = await waitForFile(PORT_FILE);
  if (!ok) {
    proc.kill();
    throw new Error("agent8-backend-mock did not start in time");
  }
  const port = fs.readFileSync(PORT_FILE, "utf8").trim();
  return { proc, port: Number(port) };
}

function stopMock(handle) {
  if (handle && handle.proc) {
    handle.proc.kill("SIGTERM");
  }
}

function readCalls() {
  if (!fs.existsSync(CALLS_FILE)) return [];
  const raw = fs.readFileSync(CALLS_FILE, "utf8").trim();
  if (raw.length === 0) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

function countCalls(pathname) {
  return readCalls().filter((c) => c.pathname === pathname).length;
}

let tmpRoots = [];
function mkTmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-confirm-test-"));
  tmpRoots.push(dir);
  return dir;
}

before(() => {
  ensureFixtureBundle();
});

beforeEach(() => {
  _resetNewProjectStateForTests();
});

after(() => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  tmpRoots = [];
});

test("start → happy path returns template + startCallId", async () => {
  const handle = await startMock();
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";
    const r = await runNewProjectStart({ userRequest: "2D shooter game" });
    assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);
    assert.ok(r.startCallId && r.startCallId.startsWith("scid_"));
    assert.equal(r.templateName, "basic-vite-react");
    assert.equal(r.repo, "planetarium/agent8-templates");
    assert.equal(r.path, "basic-vite-react");
    assert.ok(r.template);
    assert.ok(r.suggestedTitle.length > 0);
    assert.ok(r.suggestedProjectRepo.length > 0);
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm template_mismatch: no HTTP after digest mismatch (AC-11)", async () => {
  const handle = await startMock();
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const start = await runNewProjectStart({ userRequest: "puzzle" });
    assert.equal(start.ok, true);

    // Drop the happy-path call log entries from start — we only care about
    // whether confirm fires any HTTP.
    const baselineSelect = countCalls("/api/select-template");

    const bad = await runNewProjectConfirm({
      templateName: "THIS-IS-NOT-THE-REAL-TEMPLATE",
      repo: start.repo,
      path: start.path,
      title: "Whatever",
      projectRepo: "whatever",
      startCallId: start.startCallId,
    });

    assert.equal(bad.ok, false);
    assert.equal(bad.error, "template_mismatch");
    // US-M2-6: hint mentions restart recovery so a host that restarted
    // mid-flow knows the action is to re-run verse8_new_project_start.
    assert.match(bad.hint, /MCP server may have restarted/);
    // Zero new select-template calls.
    assert.equal(countCalls("/api/select-template"), baselineSelect);
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm template_mismatch: unknown startCallId fails loud without HTTP", async () => {
  const handle = await startMock();
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const baselineSelect = countCalls("/api/select-template");
    const bad = await runNewProjectConfirm({
      templateName: "basic-vite-react",
      repo: "planetarium/agent8-templates",
      path: "basic-vite-react",
      title: "Hi",
      projectRepo: "hi",
      startCallId: "scid_unknown_ffffffffffffffffffffffffffffffff",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "template_mismatch");
    // US-M2-6: hint mentions restart recovery so a host that restarted
    // mid-flow knows the action is to re-run verse8_new_project_start.
    assert.match(bad.hint, /MCP server may have restarted/);
    assert.equal(countCalls("/api/select-template"), baselineSelect);
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm happy path: clones fixture + attaches + nextCallRequires.projectDir (AC-2/3/12)", async () => {
  const handle = await startMock();
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const start = await runNewProjectStart({ userRequest: "match three" });
    assert.equal(start.ok, true);

    const targetDir = mkTmpCwd();
    const confirm = await runNewProjectConfirm({
      templateName: start.templateName,
      repo: start.repo,
      path: start.path,
      title: "Match Three",
      projectRepo: "match-three",
      targetDir,
      startCallId: start.startCallId,
    });

    assert.equal(confirm.ok, true, `expected ok, got: ${JSON.stringify(confirm)}`);
    assert.equal(confirm.nextCallRequires.projectDir, confirm.projectDir);
    assert.ok(
      path.isAbsolute(confirm.projectDir),
      "projectDir should be absolute",
    );
    assert.ok(fs.existsSync(path.join(confirm.projectDir, ".git")));
    assert.ok(
      fs.existsSync(path.join(confirm.projectDir, ".verse8", "project.json")),
    );
    assert.ok(fs.existsSync(path.join(confirm.projectDir, "AGENTS.md")));
    // AC-4: token never in .verse8/project.json
    const projectJson = fs.readFileSync(
      path.join(confirm.projectDir, ".verse8", "project.json"),
      "utf8",
    );
    assert.ok(
      !projectJson.includes("glpat-"),
      ".verse8/project.json must not contain a GitLab PAT",
    );
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm retry safety: projectPath skips select-template (AC-13)", async () => {
  // First run with a token-grant failure to obtain a projectPath in the envelope.
  const fail = await startMock(["--fail=token-grant", "--fixed-project-path=smoke-user/retry-test"]);
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${fail.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const start = await runNewProjectStart({ userRequest: "retry" });
    assert.equal(start.ok, true);

    const targetDir1 = mkTmpCwd();
    const first = await runNewProjectConfirm({
      templateName: start.templateName,
      repo: start.repo,
      path: start.path,
      title: "Retry Demo",
      projectRepo: "retry-demo",
      targetDir: targetDir1,
      startCallId: start.startCallId,
    });
    assert.equal(first.ok, false);
    assert.equal(first.error, "token_grant_failed");

    const firstSelectCount = countCalls("/api/select-template");
    assert.equal(firstSelectCount, 1, "first confirm should have called select-template once");
  } finally {
    stopMock(fail);
  }

  // Now start a healthy mock. Second confirm echoes projectPath back; it MUST
  // NOT call select-template again.
  const healthy = await startMock(["--fixed-project-path=smoke-user/retry-test"]);
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${healthy.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const targetDir2 = mkTmpCwd();
    const second = await runNewProjectConfirm({
      templateName: "basic-vite-react",
      repo: "planetarium/agent8-templates",
      path: "basic-vite-react",
      title: "Retry Demo",
      projectRepo: "retry-demo",
      targetDir: targetDir2,
      projectPath: "smoke-user/retry-test",
    });
    assert.equal(second.ok, true, `expected ok, got: ${JSON.stringify(second)}`);
    assert.equal(
      countCalls("/api/select-template"),
      0,
      "retry must not call select-template",
    );
    // Token endpoints MUST have been called.
    assert.equal(countCalls("/api/gitlab/project-access-token"), 2);
  } finally {
    stopMock(healthy);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm concurrency guard: parallel returns confirm_in_flight (AC-14)", async () => {
  const handle = await startMock(["--fixed-project-path=smoke-user/conc"]);
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const start = await runNewProjectStart({ userRequest: "conc" });
    assert.equal(start.ok, true);

    const targetA = mkTmpCwd();
    const targetB = mkTmpCwd();

    // Same projectPath (via --fixed-project-path). Kick both without awaiting.
    const pA = runNewProjectConfirm({
      templateName: start.templateName,
      repo: start.repo,
      path: start.path,
      title: "A",
      projectRepo: "a",
      targetDir: targetA,
      projectPath: "smoke-user/conc",
      startCallId: start.startCallId,
    });
    const pB = runNewProjectConfirm({
      templateName: start.templateName,
      repo: start.repo,
      path: start.path,
      title: "B",
      projectRepo: "b",
      targetDir: targetB,
      projectPath: "smoke-user/conc",
      startCallId: start.startCallId,
    });

    const [a, b] = await Promise.all([pA, pB]);
    const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.error));
    outcomes.sort();
    assert.deepEqual(
      outcomes.filter((o) => o === "confirm_in_flight").length,
      1,
      `expected exactly one confirm_in_flight, got outcomes: ${outcomes.join(",")}`,
    );
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm tolerates snake_case response shape (clone_command, git_url)", async () => {
  // Reproduces the production environment where the agent8-backend
  // drifted from the documented camelCase shape to snake_case. The
  // confirm tool must still extract the clone URL without user intervention.
  const handle = await startMock([
    "--fixed-project-path=smoke-user/verse8-smoke-bundle",
    "--snake-case",
  ]);
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const targetDir = mkTmpCwd();
    const r = await runNewProjectConfirm({
      templateName: "basic-vite-react",
      repo: "planetarium/agent8-templates",
      path: "basic-vite-react",
      title: "Snake",
      projectRepo: "snake",
      targetDir,
      projectPath: "smoke-user/verse8-smoke-bundle",
    });
    assert.equal(r.ok, true, `expected snake_case tolerance to succeed, got: ${JSON.stringify(r)}`);
    assert.ok(fs.existsSync(path.join(r.projectDir, ".git")));
    // Server-returned snake_case `expires_at` must populate tokenExpiresAt.
    assert.ok(typeof r.tokenExpiresAt === "string" && r.tokenExpiresAt.length > 0);
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm synthesizes cloneCommand from gitUrl when backend omits it", async () => {
  // Reproduces the real-world retry path: when POST /api/gitlab/project-
  // access-token is called for a project whose PAT was already granted,
  // production can answer with the token + gitUrl but no pre-formatted
  // cloneCommand. Confirm must synthesize the command rather than crash.
  const handle = await startMock([
    "--fixed-project-path=smoke-user/verse8-smoke-bundle",
    "--omit-clone-command",
  ]);
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const targetDir = mkTmpCwd();
    const r = await runNewProjectConfirm({
      templateName: "basic-vite-react",
      repo: "planetarium/agent8-templates",
      path: "basic-vite-react",
      title: "Synth",
      projectRepo: "synth",
      targetDir,
      projectPath: "smoke-user/verse8-smoke-bundle",
    });
    assert.equal(r.ok, true, `expected synth fallback to clone, got: ${JSON.stringify(r)}`);
    assert.ok(fs.existsSync(path.join(r.projectDir, ".git")));
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("confirm: when backend omits BOTH cloneCommand and gitUrl → token_grant_failed", async () => {
  const handle = await startMock([
    "--fixed-project-path=smoke-user/verse8-smoke-bundle",
    "--omit-clone-command",
    "--omit-git-url",
  ]);
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const targetDir = mkTmpCwd();
    const r = await runNewProjectConfirm({
      templateName: "basic-vite-react",
      repo: "planetarium/agent8-templates",
      path: "basic-vite-react",
      title: "Blank",
      projectRepo: "blank",
      targetDir,
      projectPath: "smoke-user/verse8-smoke-bundle",
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "token_grant_failed");
    assert.match(
      r.hint,
      /neither cloneCommand\/clone_command nor gitUrl\/git_url/,
      `hint should diagnose the missing fields, got: ${r.hint}`,
    );
    assert.match(
      r.hint,
      /Observed top-level keys:/,
      `hint should surface observed keys for debugging, got: ${r.hint}`,
    );
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

// INV-1: Token never hits a shell
test("confirm rejects traversal slug: hostile backend slug '..' → clone_parse_failed", async () => {
  // The mock derives its slug from projectPath.split('/').pop().
  // Pinning projectPath to 'user/..' makes the slug '..', which the
  // confirm path MUST reject before calling execFileSync.
  const handle = await startMock(["--fixed-project-path=user/.."]);
  try {
    process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
    process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";

    const targetDir = mkTmpCwd();
    const r = await runNewProjectConfirm({
      templateName: "basic-vite-react",
      repo: "planetarium/agent8-templates",
      path: "basic-vite-react",
      title: "Bad",
      projectRepo: "bad",
      targetDir,
      projectPath: "user/..",
    });
    assert.equal(r.ok, false, `expected rejection, got: ${JSON.stringify(r)}`);
    assert.equal(r.error, "clone_parse_failed");
    // No clone attempt should have occurred — the targetDir stays empty.
    const entries = fs.readdirSync(targetDir);
    assert.equal(
      entries.length,
      0,
      `expected empty targetDir after rejection, saw: ${entries.join(",")}`,
    );
  } finally {
    stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("not_logged_in: start returns structured error with no token", async () => {
  delete process.env.VERSE8_ACCESS_TOKEN;
  // Also isolate from a real token file — point XDG_CONFIG_HOME at an empty dir.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-xdg-"));
  const savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = isolated;
  try {
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-cwd-"));
    try {
      const r = await runNewProjectStart({ userRequest: "x" }, emptyCwd);
      assert.equal(r.ok, false);
      assert.equal(r.error, "not_logged_in");
    } finally {
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});
