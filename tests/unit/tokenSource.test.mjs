// The login token is looked up in three places, in this order: the
// VERSE8_ACCESS_TOKEN env var, <project>/.verse8/token, and the config-folder
// token file. A fresh login only rewrites the last one, so a stale token in
// one of the first two kept being rejected with "log in again" as the only
// hint. These tests put a stale token in each place and check that
// verse8_status names the source, that following its hint fixes the login,
// that verse8_logout clears the local login, and that a project token file
// behind a link or tracked by git is never read.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";

import { createServer } from "../../dist/server.js";
import { loadToken, resolveToken } from "../../dist/context/token.js";
import { apiFail } from "../../dist/tools/creatorOps.js";

const GOOD = "good-token-value-0123456789";
const STALE = "stale-token-value-0123456789";

/** /v1/auth/verify accepts GOOD only; /v1/auth/device/token grants GOOD. */
async function startMockApi() {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/auth/verify") {
      if (req.headers.authorization === `Bearer ${GOOD}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ userId: "u1" }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Unauthorized" }));
      }
      return;
    }
    if (req.url === "/v1/auth/device/token") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: GOOD, token_type: "Bearer" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Run `fn({project, configToken, outside})` with an isolated config folder,
 * no env token, a mock API, and the cwd inside an empty project folder.
 */
async function withIsolatedLogin(fn) {
  const saved = {
    tok: process.env.VERSE8_ACCESS_TOKEN,
    xdg: process.env.XDG_CONFIG_HOME,
    api: process.env.VERSE8_API_URL,
    cwd: process.cwd(),
  };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verse8-token-source-")));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  const mock = await startMockApi();
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.VERSE8_API_URL = mock.baseUrl;
  delete process.env.VERSE8_ACCESS_TOKEN;
  process.chdir(project);
  try {
    await fn({ project, outside, configToken: path.join(root, "xdg", "verse8", "token") });
  } finally {
    process.chdir(saved.cwd);
    await mock.close();
    for (const [key, value] of [
      ["VERSE8_ACCESS_TOKEN", saved.tok],
      ["XDG_CONFIG_HOME", saved.xdg],
      ["VERSE8_API_URL", saved.api],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function writeToken(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
}

/** Call a tool through the server and return {text, json}; the text is what the host sees. */
async function call(name, args = {}) {
  const handler = createServer()._requestHandlers.get("tools/call");
  const res = await handler({ method: "tools/call", params: { name, arguments: args } }, {});
  const text = res.content[0].text;
  // No result may ever carry a token value.
  assert.ok(!text.includes(GOOD) && !text.includes(STALE), `${name} result leaked a token value: ${text}`);
  return JSON.parse(text);
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("stale env token: status names the env var, and removing it lets the saved login through", async () => {
  await withIsolatedLogin(async ({ configToken }) => {
    writeToken(configToken, GOOD);
    process.env.VERSE8_ACCESS_TOKEN = STALE;

    const stale = await call("verse8_status");
    assert.equal(stale.error, "token_invalid");
    assert.deepEqual(stale.tokenSource, { source: "env" });
    assert.match(stale.hint, /VERSE8_ACCESS_TOKEN environment variable/);
    assert.match(stale.hint, /logging in again does not replace it/);

    // What the hint asks for: the env var is gone after a server restart.
    delete process.env.VERSE8_ACCESS_TOKEN;
    const fixed = await call("verse8_status");
    assert.equal(fixed.ok, true);
    assert.deepEqual(fixed.tokenSource, { source: "config", path: configToken });
  });
});

test("stale project token: status names the file, and logout + login fixes it", async () => {
  await withIsolatedLogin(async ({ project, configToken }) => {
    const projectToken = path.join(project, ".verse8", "token");
    writeToken(projectToken, STALE);
    writeToken(configToken, GOOD);

    const stale = await call("verse8_status");
    assert.equal(stale.error, "token_invalid");
    assert.deepEqual(stale.tokenSource, { source: "project", path: projectToken });
    assert.match(stale.hint, /verse8_logout/);

    // What the hint asks for: verse8_logout, then log in.
    const out = await call("verse8_logout");
    assert.equal(out.ok, true);
    assert.deepEqual(
      out.removed.map((r) => r.source).sort(),
      ["config", "project"],
    );
    assert.equal(fs.existsSync(projectToken), false);
    const done = await call("verse8_login_complete", { device_code: "dc", max_wait_seconds: 5 });
    assert.equal(done.ok, true);
    assert.equal(done.warning, undefined);

    const fixed = await call("verse8_status");
    assert.equal(fixed.ok, true);
    assert.deepEqual(fixed.tokenSource, { source: "config", path: configToken });
  });
});

test("stale config token: status names the login file, and logging in again fixes it", async () => {
  await withIsolatedLogin(async ({ configToken }) => {
    writeToken(configToken, STALE);

    const stale = await call("verse8_status");
    assert.equal(stale.error, "token_invalid");
    assert.deepEqual(stale.tokenSource, { source: "config", path: configToken });
    assert.match(stale.hint, /To log in again: call verse8_login_start/);

    const done = await call("verse8_login_complete", { device_code: "dc", max_wait_seconds: 5 });
    assert.equal(done.ok, true);
    assert.equal((await call("verse8_status")).ok, true);
  });
});

test("verse8_logout: status turns into not_logged_in, and the result says the token is not revoked", async () => {
  await withIsolatedLogin(async ({ configToken }) => {
    writeToken(configToken, GOOD);
    assert.equal((await call("verse8_status")).ok, true);

    const out = await call("verse8_logout");
    assert.equal(out.ok, true);
    assert.deepEqual(out.removed, [{ source: "config", path: configToken }]);
    assert.deepEqual(out.left, []);
    assert.match(out.serverSide, /does not revoke it/);
    assert.match(out.serverSide, /stays valid on the server until it expires/);

    const after = await call("verse8_status");
    assert.equal(after.error, "not_logged_in");

    // Nothing left to remove: still a success, with nothing removed.
    const again = await call("verse8_logout");
    assert.equal(again.ok, true);
    assert.deepEqual(again.removed, []);
  });
});

test("verse8_logout: an env token keeps the login alive, so the result is logout_incomplete", async () => {
  await withIsolatedLogin(async ({ configToken }) => {
    writeToken(configToken, GOOD);
    process.env.VERSE8_ACCESS_TOKEN = GOOD;

    const out = await call("verse8_logout");
    assert.equal(out.ok, false);
    assert.equal(out.error, "logout_incomplete");
    assert.deepEqual(out.tokenSource, { source: "env" });
    assert.match(out.hint, /VERSE8_ACCESS_TOKEN/);
    assert.deepEqual(out.removed, [{ source: "config", path: configToken }]);
    assert.match(out.serverSide, /does not revoke it/);
    assert.equal((await call("verse8_status")).ok, true);
  });
});

test("verse8_login_complete: warns when an env token outranks the login it just saved", async () => {
  await withIsolatedLogin(async ({ configToken }) => {
    process.env.VERSE8_ACCESS_TOKEN = STALE;
    const done = await call("verse8_login_complete", { device_code: "dc", max_wait_seconds: 5 });
    assert.equal(done.ok, true);
    assert.equal(fs.existsSync(configToken), true);
    assert.match(done.warning, /NOT in use/);
    assert.match(done.warning, /VERSE8_ACCESS_TOKEN/);
  });
});

test("a rejected-token hint from another tool names the source the tool loaded its token from", async () => {
  await withIsolatedLogin(async ({ project }) => {
    const projectToken = path.join(project, ".verse8", "token");
    writeToken(projectToken, STALE);
    assert.equal(loadToken(project), STALE);
    const fail = apiFail("GET /v1/verse/my", { status: 401, body: "" });
    assert.equal(fail.error, "unauthorized");
    assert.ok(fail.hint.includes(projectToken), fail.hint);
    assert.match(fail.hint, /verse8_logout/);
    assert.ok(!fail.hint.includes(STALE));
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token behind a linked .verse8 folder is not read, and logout leaves the target alone", async (t) => {
  await withIsolatedLogin(async ({ project, outside, configToken }) => {
    const target = path.join(outside, "token");
    writeToken(target, STALE);
    try {
      // A junction needs no privilege on Windows; elsewhere this is a symlink.
      fs.symlinkSync(outside, path.join(project, ".verse8"), "junction");
    } catch (e) {
      t.skip(`cannot create a link here: ${e.code}`);
      return;
    }
    const projectToken = path.join(project, ".verse8", "token");

    const where = resolveToken(project);
    assert.equal(where.token, null);
    assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "symlink" });

    const status = await call("verse8_status");
    assert.equal(status.error, "not_logged_in");
    assert.equal(status.projectTokenRefused.reason, "symlink");
    assert.match(status.hint, /was ignored/);

    // With a real login the refused file only shows up as a warning.
    writeToken(configToken, GOOD);
    const ok = await call("verse8_status");
    assert.equal(ok.ok, true);
    assert.equal(ok.tokenSource.source, "config");
    assert.deepEqual(ok.warnings, ["project_token_refused"]);

    const out = await call("verse8_logout");
    assert.equal(out.ok, true);
    assert.equal(out.left.length, 1);
    assert.equal(out.left[0].source, "project");
    assert.equal(fs.readFileSync(target, "utf8").trim(), STALE, "the file behind the link must survive logout");
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token that is itself a symlink is not read", async (t) => {
  await withIsolatedLogin(async ({ project, outside }) => {
    const target = path.join(outside, "token");
    writeToken(target, STALE);
    fs.mkdirSync(path.join(project, ".verse8"));
    try {
      fs.symlinkSync(target, path.join(project, ".verse8", "token"), "file");
    } catch (e) {
      t.skip(`cannot create a file symlink here: ${e.code}`);
      return;
    }
    const where = resolveToken(project);
    assert.equal(where.token, null);
    assert.equal(where.refusedProjectToken.reason, "symlink");
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token tracked by git is not read; untracked in the same repo it is", async () => {
  await withIsolatedLogin(async ({ project, configToken }) => {
    const projectToken = path.join(project, ".verse8", "token");
    git(project, "init", "-q");
    writeToken(projectToken, GOOD);

    // Untracked: still honoured, as before.
    assert.deepEqual(resolveToken(project), { token: GOOD, source: "project", path: projectToken });

    git(project, "add", "-f", ".verse8/token");
    const where = resolveToken(project);
    assert.equal(where.token, null);
    assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "git_tracked" });

    const status = await call("verse8_status");
    assert.equal(status.error, "not_logged_in");
    assert.equal(status.projectTokenRefused.reason, "git_tracked");
    assert.match(status.hint, /git rm --cached/);

    // Logout does not delete a tracked file (it would dirty the repository).
    writeToken(configToken, GOOD);
    const out = await call("verse8_logout");
    assert.equal(out.ok, true);
    assert.deepEqual(out.removed, [{ source: "config", path: configToken }]);
    assert.equal(fs.existsSync(projectToken), true);
  });
});
