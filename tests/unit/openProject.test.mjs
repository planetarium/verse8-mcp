// Unit + mock-backed tests for verse8_open_project.
//
//   - resolveProjectRef: path / editor URL / gitlab URL / other-environment
//     editor URL / malformed input (pure, no HTTP)
//   - happy path against the agent8-backend mock: token GET+POST once each,
//     no startcall / select-template, clone + attach, no PAT in the response
//   - existing target folder → clone_target_exists with ZERO HTTP calls
//   - project the caller does not own → backend status + body passed through
//   - not_logged_in
//
// Uses its own mock state dir and fixture repo under os.tmpdir(). Runs
// against dist/.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  resolveProjectRef,
  runOpenProject,
  _resetOpenProjectStateForTests,
} from "../../dist/tools/openProject.js";
import { grantCloneAccess } from "../../dist/tools/projectClone.js";
import { createServer } from "../../dist/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const MOCK_SCRIPT = path.join(REPO_ROOT, "tests/mocks/agent8-backend-mock.ts");
// Own mock state + fixture repo: node --test runs files in parallel, and
// newProjectConfirm.test.mjs owns /tmp/agent8-mock-* and the smoke bundle.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-open-mock-"));
const PORT_FILE = path.join(STATE_DIR, "agent8-mock-port.txt");
const CALLS_FILE = path.join(STATE_DIR, "agent8-mock-calls.jsonl");
const FIXTURE = path.join(STATE_DIR, "fixture.git");
const PROD_CREATE = "https://create.verse8.io";
const STAGING_CREATE = "https://create.staging.vibe.verse8.io";

async function waitForFile(p, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Same single-process spawn as newProjectConfirm.test.mjs (npx would orphan
// the real server and hang `node --test`).
async function startMock(extraArgs = []) {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {}
  try {
    fs.unlinkSync(CALLS_FILE);
  } catch {}
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      MOCK_SCRIPT,
      `--state-dir=${STATE_DIR}`,
      `--clone-fixture=${FIXTURE}`,
      ...extraArgs,
    ],
    { stdio: "ignore" },
  );
  const ok = await waitForFile(PORT_FILE);
  if (!ok) {
    await stopMock({ proc });
    throw new Error("agent8-backend-mock did not start in time");
  }
  return { proc, port: Number(fs.readFileSync(PORT_FILE, "utf8").trim()) };
}

async function stopMock(handle) {
  const proc = handle && handle.proc;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

function readCalls() {
  if (!fs.existsSync(CALLS_FILE)) return [];
  const raw = fs.readFileSync(CALLS_FILE, "utf8").trim();
  return raw.length === 0 ? [] : raw.split("\n").map((l) => JSON.parse(l));
}

function calls(method, pathname) {
  return readCalls().filter((c) => c.method === method && c.pathname === pathname).length;
}

let tmpRoots = [];
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-open-test-"));
  tmpRoots.push(dir);
  return dir;
}

async function withMock(extraArgs, fn) {
  const handle = await startMock(extraArgs);
  process.env.VERSE8_AGENT8_BACKEND_URL = `http://127.0.0.1:${handle.port}`;
  process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";
  try {
    await fn();
  } finally {
    await stopMock(handle);
    delete process.env.VERSE8_AGENT8_BACKEND_URL;
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
}

before(() => {
  // A bare repo with a `develop` branch — what the mock's file:// clone
  // command points at.
  const work = path.join(STATE_DIR, "work");
  const git = (...a) => execFileSync("git", a, { stdio: "ignore" });
  git("init", "-q", work);
  git("-C", work, "checkout", "-q", "-b", "develop");
  git("-C", work, "-c", "user.email=t@verse8.io", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("clone", "-q", "--bare", work, FIXTURE);
});

beforeEach(() => {
  _resetOpenProjectStateForTests();
});

after(() => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  tmpRoots = [];
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveProjectRef
// ---------------------------------------------------------------------------

test("resolveProjectRef: accepted forms resolve to the GitLab project path", () => {
  const cases = [
    ["owner/my-platformer-1abc", "path"],
    ["  /owner/my-platformer-1abc.git/ ", "path"],
    [`${PROD_CREATE}/creator/editor?chat=owner/my-platformer-1abc`, "editor_url"],
    [`${PROD_CREATE}/creator/editor?chat=owner%2Fmy-platformer-1abc`, "editor_url"],
    // The editor appends its own query inside `chat` (encodeURIComponent of
    // `path?query`).
    [`${PROD_CREATE}/creator/editor?chat=owner%2Fmy-platformer-1abc%3Fprompt%3Dhi`, "editor_url"],
    ["create.verse8.io/creator/editor?chat=owner/my-platformer-1abc", "editor_url"],
    ["https://gitlab.verse8.io/owner/my-platformer-1abc.git", "gitlab_url"],
    // GitLab page URLs: everything from the first `/-/` is the page, not the project.
    ["https://gitlab.verse8.io/owner/my-platformer-1abc/-/tree/develop", "gitlab_url"],
    ["https://gitlab.verse8.io/owner/my-platformer-1abc/-/blob/develop/src/main.ts", "gitlab_url"],
    ["https://gitlab.verse8.io/owner/my-platformer-1abc/-/merge_requests/3", "gitlab_url"],
    ["owner/my-platformer-1abc/-/tree/develop", "path"],
  ];
  for (const [raw, source] of cases) {
    const r = resolveProjectRef(raw, PROD_CREATE);
    assert.equal(r.ok, true, `${raw} → ${JSON.stringify(r)}`);
    assert.equal(r.projectPath, "owner/my-platformer-1abc", raw);
    assert.equal(r.source, source, raw);
  }
});

test("resolveProjectRef: editor URL of another environment → environment_mismatch", () => {
  const staging = `${STAGING_CREATE}/creator/editor?chat=a/b`;
  const r = resolveProjectRef(staging, PROD_CREATE);
  assert.equal(r.ok, false);
  assert.equal(r.error, "environment_mismatch");
  assert.match(r.hint, /create\.staging\.vibe\.verse8\.io/);
  assert.match(r.hint, /create\.verse8\.io/);
  // The same URL is fine when the server is configured for staging.
  const ok = resolveProjectRef(staging, STAGING_CREATE);
  assert.equal(ok.ok, true);
  assert.equal(ok.projectPath, "a/b");
  // GitLab is shared across environments, so its URL never mismatches.
  assert.equal(resolveProjectRef("https://gitlab.verse8.io/a/b", STAGING_CREATE).ok, true);
});

test("resolveProjectRef: malformed input → invalid_input without echoing credentials", () => {
  const bad = [
    "just-a-slug",
    "a/../b",
    "a/b c",
    "",
    "https://example.com/a/b",
    `${PROD_CREATE}/creator/editor`,
    `${PROD_CREATE}/creator/editor?chat=onlyone`,
    "https://gitlab.verse8.io/onlyone",
    // Malformed percent-encoding must be invalid_input, not a thrown URIError.
    "https://gitlab.verse8.io/owner/bad%E0%A4%A",
    "https://gitlab.verse8.io/owner/%",
    `${PROD_CREATE}/creator/editor?chat=owner%2Fbad%E0%A4%A`,
  ];
  for (const raw of bad) {
    const r = resolveProjectRef(raw, PROD_CREATE);
    assert.equal(r.ok, false, raw);
    assert.equal(r.error, "invalid_input", raw);
  }
  const cred = resolveProjectRef("https://oauth2:glpat-secretsecret@gitlab.verse8.io/a/b.git", PROD_CREATE);
  assert.equal(cred.error, "invalid_input");
  assert.ok(!cred.hint.includes("glpat-secretsecret"), cred.hint);
});

// ---------------------------------------------------------------------------
// runOpenProject against the mock backend
// ---------------------------------------------------------------------------

test("open happy path: token GET+POST once, no project creation, clone + attach", async () => {
  await withMock([], async () => {
    const targetDir = mkTmp();
    const r = await runOpenProject({ project: "someone/open-demo", targetDir });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.projectDir, path.join(targetDir, "open-demo"));
    assert.equal(r.nextCallRequires.projectDir, r.projectDir);
    assert.equal(r.projectPath, "someone/open-demo");
    assert.equal(r.branch, "develop");
    assert.match(r.webEditor.url, /\/creator\/editor\?chat=someone%2Fopen-demo$/);
    assert.ok(fs.existsSync(path.join(r.projectDir, ".git")));
    assert.ok(fs.existsSync(path.join(r.projectDir, ".verse8", "project.json")));
    assert.ok(fs.existsSync(path.join(r.projectDir, "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(r.projectDir, ".git", "hooks", "commit-msg")));
    // The project already exists: never startcall / select-template.
    assert.equal(calls("POST", "/api/startcall"), 0);
    assert.equal(calls("GET", "/api/select-template"), 0);
    assert.equal(calls("GET", "/api/gitlab/project-access-token"), 1);
    assert.equal(calls("POST", "/api/gitlab/project-access-token"), 1);
    assert.ok(!JSON.stringify(r).includes("glpat-"), "response must not carry the PAT");
  });
});

test("open: clone URL userinfo is stripped from the returned gitUrl", async () => {
  // --oauth-git-url: gitUrl in the real https://oauth2:<PAT>@ shape, while the
  // clone command still points at the local fixture — so the call succeeds
  // and the returned gitUrl can be asserted exactly.
  await withMock(["--oauth-git-url"], async () => {
    const r = await runOpenProject({ project: "someone/oauth-demo", targetDir: mkTmp() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.gitUrl, "https://gitlab.verse8.io/someone/oauth-demo.git");
    assert.ok(!JSON.stringify(r).includes("glpat-"), JSON.stringify(r));
  });
});

test("open: a second call for the same project while one runs → open_in_flight", async () => {
  await withMock([], async () => {
    const a = runOpenProject({ project: "someone/race-demo", targetDir: mkTmp() });
    const b = runOpenProject({ project: "someone/race-demo", targetDir: mkTmp() });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true, JSON.stringify(ra));
    assert.equal(rb.ok, false);
    assert.equal(rb.error, "open_in_flight");
    assert.equal(calls("POST", "/api/gitlab/project-access-token"), 1, "only one token minted");
  });
});

test("open: token limit reached → hint says where to revoke; no folder", async () => {
  await withMock(["--token-limit"], async () => {
    const targetDir = mkTmp();
    const r = await runOpenProject({ project: "someone/limit-demo", targetDir });
    assert.equal(r.ok, false);
    assert.equal(r.error, "token_grant_failed");
    assert.equal(r.status, 400);
    assert.match(r.hint, /TOKEN_LIMIT_EXCEEDED/);
    assert.match(r.hint, /web editor, open the Git Clone menu, and Revoke/);
    assert.match(r.hint, /Do not call the revoke API yourself/);
    assert.ok(!fs.existsSync(path.join(targetDir, "limit-demo")));
  });
});

test("open: other 4xx from the token grant carries no revoke hint", async () => {
  await withMock(["--deny-token=403"], async () => {
    const r = await runOpenProject({ project: "someone-else/x", targetDir: mkTmp() });
    assert.doesNotMatch(r.hint, /Revoke/);
  });
});

test("open: local targets that cannot be cloned into fail BEFORE any token request", async () => {
  await withMock([], async () => {
    const root = mkTmp();
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "x");
    // targetDir is a file, and targetDir is under a file.
    for (const targetDir of [file, path.join(file, "sub")]) {
      const r = await runOpenProject({ project: "someone/local-demo", targetDir });
      assert.equal(r.ok, false, targetDir);
      assert.equal(r.error, "invalid_parent", `${targetDir}: ${JSON.stringify(r)}`);
      assert.match(r.hint, /is not a directory/);
    }
    // A parent the user cannot write to (POSIX non-root only).
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const ro = path.join(root, "read-only");
      fs.mkdirSync(ro);
      fs.chmodSync(ro, 0o555);
      try {
        const r = await runOpenProject({ project: "someone/local-demo", targetDir: path.join(ro, "games") });
        assert.equal(r.error, "invalid_parent", JSON.stringify(r));
        assert.match(r.hint, /not writable/);
      } finally {
        fs.chmodSync(ro, 0o755);
      }
    }
    // git not runnable.
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const r = await runOpenProject({ project: "someone/local-demo", targetDir: mkTmp() });
      assert.equal(r.error, "missing_git", JSON.stringify(r));
    } finally {
      process.env.PATH = savedPath;
    }
    assert.equal(readCalls().length, 0, "no backend call — no token minted");
  });
});

test("open: existing target folder → clone_target_exists with zero HTTP calls", async () => {
  await withMock([], async () => {
    const targetDir = mkTmp();
    const existing = path.join(targetDir, "open-demo");
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "keep.txt"), "mine");
    const r = await runOpenProject({ project: "someone/open-demo", targetDir });
    assert.equal(r.ok, false);
    assert.equal(r.error, "clone_target_exists");
    assert.equal(r.projectDir, existing);
    assert.match(r.hint, /not a clone of someone\/open-demo/);
    assert.equal(readCalls().length, 0, "no backend call — no token minted");
    assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "mine");
  });
});

test("open: existing clone of the same project → hint points at verse8_attach", async () => {
  const targetDir = mkTmp();
  const existing = path.join(targetDir, "open-demo");
  execFileSync("git", ["init", "-q", existing]);
  execFileSync("git", ["-C", existing, "remote", "add", "origin", "https://gitlab.verse8.io/someone/open-demo.git"]);
  process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";
  try {
    const r = await runOpenProject({ project: "someone/open-demo", targetDir });
    assert.equal(r.error, "clone_target_exists");
    assert.match(r.hint, /verse8_attach/);
  } finally {
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("open: plain subfolder inside a clone of the same project → no verse8_attach hint", async () => {
  const targetDir = mkTmp();
  const repo = path.join(targetDir, "outer");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://gitlab.verse8.io/someone/open-demo.git"]);
  // `<repo>/open-demo` is not a repository root, but `git remote` inside it
  // would report the outer clone's origin.
  fs.mkdirSync(path.join(repo, "open-demo"));
  process.env.VERSE8_ACCESS_TOKEN = "test-token-xyz";
  try {
    const r = await runOpenProject({ project: "someone/open-demo", targetDir: repo });
    assert.equal(r.error, "clone_target_exists");
    assert.doesNotMatch(r.hint, /verse8_attach/);
    assert.match(r.hint, /not a clone of someone\/open-demo/);
  } finally {
    delete process.env.VERSE8_ACCESS_TOKEN;
  }
});

test("open: project the caller does not own → backend status + body passed through", async () => {
  await withMock(["--deny-token=403"], async () => {
    const targetDir = mkTmp();
    const r = await runOpenProject({ project: "someone-else/their-game", targetDir });
    assert.equal(r.ok, false);
    assert.equal(r.error, "token_check_failed");
    assert.equal(r.status, 403);
    assert.equal(r.projectPath, "someone-else/their-game");
    assert.match(r.hint, /HTTP 403: .*Access denied: You are not the owner of this project/);
    assert.match(r.hint, /PERMISSION_DENIED/);
    assert.ok(!fs.existsSync(path.join(targetDir, "their-game")));
  });
});

test("open: INV-13: secret-shaped values in a backend error body never reach the tool result", async () => {
  // Through the real tools/call handler, so the dispatch boundary is covered.
  await withMock(["--deny-token=403", "--secret-in-error"], async () => {
    const server = createServer();
    const call = server._requestHandlers.get("tools/call");
    assert.ok(call, "no tools/call handler");
    const result = await call(
      {
        method: "tools/call",
        params: { name: "verse8_open_project", arguments: { project: "someone-else/leaky", targetDir: mkTmp() } },
      },
      {},
    );
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.ok(!text.includes("glpat-leakFromBackendBody"), text);
    assert.ok(!text.includes("eyJleakedAccessTokenValue"), text);
    // Status and the rest of the backend message stay visible.
    const r = JSON.parse(text);
    assert.equal(r.error, "token_check_failed");
    assert.equal(r.status, 403);
    assert.match(r.hint, /HTTP 403: .*Access denied: You are not the owner of this project/);
    assert.match(r.hint, /upstream rejected credential glpat-\*\*\*/);
  });
});

test("open: INV-13: a secret cut by the 500-char hint limit is still redacted", async () => {
  // Redacting after the cut would miss "access_token":"… — its closing quote
  // is past the limit — and leak the head of the value.
  // The value starts at char 486, so a 500-char cut keeps its first 14 chars.
  const body = `{"pad":"${"x".repeat(460)}","access_token":"eyJstraddlesTheCut0123456789abcdef"}`;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 500 });
  try {
    const r = await grantCloneAccess("someone/cut", "test-token-xyz");
    assert.equal(r.ok, false);
    assert.equal(r.error, "token_check_failed");
    assert.ok(!r.hint.includes("eyJstr"), r.hint);
  } finally {
    globalThis.fetch = saved;
  }
});

test("open: not_logged_in without a token", async () => {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkTmp();
  delete process.env.VERSE8_ACCESS_TOKEN;
  try {
    const r = await runOpenProject({ project: "a/b" }, mkTmp());
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_logged_in");
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});
