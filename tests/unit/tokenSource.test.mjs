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
import { ensureVerse8GitIgnore } from "../../dist/context/gitIgnore.js";
import { runPreCommitHook, UNSTAGE_TOKEN_COMMAND } from "../../dist/cli/preCommitHook.js";
import { isNeverCommitFile, listChangedFiles, unstageNeverCommitFiles } from "../../dist/tools/checkpoint.js";

const GOOD = "good-token-value-0123456789";
const STALE = "stale-token-value-0123456789";

/** /v1/auth/verify accepts GOOD only; /v1/auth/device/token grants GOOD. */
async function startMockApi() {
  /** Tests set these: a status every verify call answers with, and a step to run before /v1/verse/my answers. */
  const knobs = { verifyStatus: null, beforeVerseMy: null };
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/v1/verse/my")) {
      if (knobs.beforeVerseMy) await knobs.beforeVerseMy();
      const ok = req.headers.authorization === `Bearer ${GOOD}`;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { total: 0, page: 1, limit: 20, items: [] } : { message: "Unauthorized" }));
      return;
    }
    if (req.url === "/v1/auth/verify") {
      if (knobs.verifyStatus) {
        res.writeHead(knobs.verifyStatus, { "content-type": "text/html" });
        res.end("<html>upstream unavailable</html>");
      } else if (req.headers.authorization === `Bearer ${GOOD}`) {
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
    knobs,
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
    await fn({ root, project, outside, mock, configToken: path.join(root, "xdg", "verse8", "token") });
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

function commit(cwd) {
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--no-verify", "-m", "x");
}

/** Run the pre-commit hook for `cwd`; returns its exit code and what it wrote to stderr. */
function runHook(cwd) {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    return { code: runPreCommitHook(cwd), out: writes.join("") };
  } finally {
    process.stderr.write = orig;
  }
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

test("a 401 hint from another tool names the source of the token that call used, whatever other calls do meanwhile", async () => {
  await withIsolatedLogin(async ({ project, outside, configToken, mock }) => {
    const projectToken = path.join(project, ".verse8", "token");
    writeToken(projectToken, STALE);
    writeToken(configToken, GOOD);
    // While this call waits for the API, another call loads the token for a
    // different folder (where the config token is the one in use).
    mock.knobs.beforeVerseMy = () => {
      assert.equal(loadToken(outside), GOOD);
    };

    const fail = await call("verse8_verse", { action: "mine", projectDir: project });
    assert.equal(fail.error, "unauthorized");
    assert.ok(fail.hint.includes(projectToken), fail.hint);
    assert.ok(!fail.hint.includes(configToken), fail.hint);
    assert.ok(fail.hint.includes(`verse8_logout with projectDir ${JSON.stringify(project)}`), fail.hint);
  });
});

// A hint has to work when it is followed to the letter.

test("project token in another folder than the server's: the hint names projectDir, and a logout without it is not reported as done", async () => {
  await withIsolatedLogin(async ({ outside, configToken }) => {
    // The project is `outside`; the server's working folder is elsewhere.
    const projectToken = path.join(outside, ".verse8", "token");
    writeToken(projectToken, STALE);
    writeToken(configToken, GOOD);

    const stale = await call("verse8_status", { projectDir: outside });
    assert.equal(stale.error, "token_invalid");
    assert.deepEqual(stale.tokenSource, { source: "project", path: projectToken });
    assert.ok(stale.hint.includes(`verse8_logout with projectDir ${JSON.stringify(outside)}`), stale.hint);

    // Without projectDir the token file that is in use is not touched.
    const bare = await call("verse8_logout");
    assert.equal(bare.ok, false);
    assert.equal(bare.error, "logout_incomplete");
    assert.deepEqual(bare.tokenSource, { source: "project", path: projectToken });
    assert.ok(bare.hint.includes(`verse8_logout with projectDir ${JSON.stringify(outside)}`), bare.hint);
    assert.equal(fs.existsSync(projectToken), true);

    // The call the hint asks for.
    const out = await call("verse8_logout", { projectDir: outside });
    assert.equal(out.ok, true);
    assert.equal(out.projectDir, outside);
    assert.deepEqual(out.removed, [{ source: "project", path: projectToken }]);
    assert.equal(fs.existsSync(projectToken), false);
    assert.equal((await call("verse8_status", { projectDir: outside })).error, "not_logged_in");

    // Nothing is remembered about that folder any more.
    assert.equal((await call("verse8_logout")).ok, true);
  });
});

test("verse8_login_complete: warns, with the projectDir to log out of, when a project token outranks the login it just saved", async () => {
  await withIsolatedLogin(async ({ project, configToken }) => {
    const projectToken = path.join(project, ".verse8", "token");
    writeToken(projectToken, STALE);
    const done = await call("verse8_login_complete", { device_code: "dc", max_wait_seconds: 5 });
    assert.equal(done.ok, true);
    assert.equal(fs.existsSync(configToken), true);
    assert.match(done.warning, /NOT in use/);
    assert.ok(done.warning.includes(projectToken), done.warning);
    assert.ok(done.warning.includes(`verse8_logout with projectDir ${JSON.stringify(project)}`), done.warning);
  });
});

// A failure that is not a rejection must not be answered as one.

test("verse8_status: a 503 from the verify call is not a rejected token", async () => {
  await withIsolatedLogin(async ({ configToken, mock }) => {
    writeToken(configToken, GOOD);
    process.env.VERSE8_ACCESS_TOKEN = GOOD;
    mock.knobs.verifyStatus = 503;

    const status = await call("verse8_status");
    assert.equal(status.ok, false);
    assert.equal(status.error, "auth_check_unavailable");
    assert.equal(status.status, 503);
    assert.deepEqual(status.tokenSource, { source: "env" });
    assert.match(status.hint, /NOT rejected/);
    assert.doesNotMatch(status.hint, /verse8_logout|remove \(or update\)|verse8_login_start/);

    // A 403 is about the account or a proxy in front of the API, not the
    // token: the verify endpoint answers 401 for every token problem.
    mock.knobs.verifyStatus = 403;
    const forbidden = await call("verse8_status");
    assert.equal(forbidden.error, "auth_check_unavailable");
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.hint, /upstream unavailable/, "the server's own message is shown");
    assert.doesNotMatch(forbidden.hint, /verse8_logout|remove \(or update\)|verse8_login_start/);

    // A real rejection still is one.
    mock.knobs.verifyStatus = 401;
    assert.equal((await call("verse8_status")).error, "token_invalid");
  });
});

test("verse8_logout: a token file in another folder that can no longer be checked is reported as unchecked, not as deletable", async () => {
  await withIsolatedLogin(async ({ outside }) => {
    const projectToken = path.join(outside, ".verse8", "token");
    writeToken(projectToken, GOOD);
    // The server uses it for that folder…
    assert.equal((await call("verse8_status", { projectDir: outside })).ok, true);
    // …and then git stops answering there.
    git(outside, "init", "-q");
    fs.writeFileSync(path.join(outside, ".git", "HEAD"), "garbage\n");

    const out = await call("verse8_logout");
    assert.equal(out.error, "logout_incomplete");
    assert.deepEqual(out.tokenSource, { source: "project", path: projectToken });
    assert.match(out.hint, /still on disk and could not be checked/);
    assert.match(out.hint, /Ask the user to delete that file/);
    // verse8_logout would not delete it either, so the hint must not send the caller back to it.
    assert.doesNotMatch(out.hint, /to delete it too|Call verse8_logout/);
    assert.match(out.left[0].reason, /not deleted and not checked/);
    assert.equal(fs.existsSync(projectToken), true);
  });
});

test("verse8_status: an unreachable API is not a rejected token", async () => {
  await withIsolatedLogin(async ({ configToken, mock }) => {
    writeToken(configToken, GOOD);
    await mock.close(); // nothing listens on that port any more
    const status = await call("verse8_status");
    assert.equal(status.error, "auth_check_unavailable");
    assert.equal(status.status, undefined);
    assert.deepEqual(status.tokenSource, { source: "config", path: configToken });
    assert.match(status.hint, /could not be reached/);
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

// The checks below can fail instead of answering. A failed check is not
// evidence that the file is safe, so each of them must refuse the file.

// INV-16: The project token file is never read through a link or from git
test("project token in a repository git cannot read (damaged HEAD, exit 128) is not read", async () => {
  await withIsolatedLogin(async ({ project, configToken }) => {
    const projectToken = path.join(project, ".verse8", "token");
    git(project, "init", "-q");
    writeToken(projectToken, GOOD);
    // git now answers "fatal: not a git repository" with exit 128 — the
    // same words as for a plain folder — although a `.git` folder is there.
    fs.writeFileSync(path.join(project, ".git", "HEAD"), "garbage\n");

    const where = resolveToken(project);
    assert.equal(where.token, null);
    assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "git_check_failed" });

    const status = await call("verse8_status");
    assert.equal(status.error, "not_logged_in");
    assert.equal(status.projectTokenRefused.reason, "git_check_failed");
    assert.match(status.projectTokenRefused.hint, /another reason than "not a git repository"/);

    // The file may become usable again once the repository is repaired, so
    // logout must not report the login as gone while it is still on disk.
    writeToken(configToken, GOOD);
    const out = await call("verse8_logout");
    assert.equal(out.error, "logout_incomplete");
    assert.deepEqual(out.tokenSource, { source: "project", path: projectToken });
    assert.deepEqual(out.removed, [{ source: "config", path: configToken }]);
    assert.equal(fs.existsSync(projectToken), true);
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token in a repository with a corrupt index (another exit 128) is not read", async () => {
  await withIsolatedLogin(async ({ project }) => {
    const projectToken = path.join(project, ".verse8", "token");
    git(project, "init", "-q");
    writeToken(projectToken, GOOD);
    fs.writeFileSync(path.join(project, ".git", "index"), "this is not a git index");

    const where = resolveToken(project);
    assert.equal(where.token, null);
    assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "git_check_failed" });
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token is not read when git cannot be started, and status tells that apart", async () => {
  await withIsolatedLogin(async ({ project, outside }) => {
    const projectToken = path.join(project, ".verse8", "token");
    writeToken(projectToken, GOOD);
    assert.equal(resolveToken(project).source, "project", "readable while git works");

    const savedPath = process.env.PATH;
    process.env.PATH = outside; // an empty folder: no git to start
    try {
      const where = resolveToken(project);
      assert.equal(where.token, null);
      assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "git_unavailable" });
      const status = await call("verse8_status");
      assert.equal(status.projectTokenRefused.reason, "git_unavailable");
      assert.match(status.projectTokenRefused.hint, /could not be started/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token tracked under a name that differs only in case is not read", async () => {
  await withIsolatedLogin(async ({ project }) => {
    const projectToken = path.join(project, ".verse8", "token");
    git(project, "init", "-q");
    writeToken(projectToken, GOOD);
    // What a clone made on a case-sensitive system leaves in the index: an
    // entry `.verse8/TOKEN`, which is this very file where case is ignored.
    const blob = execFileSync("git", ["hash-object", "-w", ".verse8/token"], { cwd: project, encoding: "utf8" }).trim();
    git(project, "update-index", "--add", "--cacheinfo", `100644,${blob},.verse8/TOKEN`);

    const where = resolveToken(project);
    assert.equal(where.token, null);
    assert.equal(where.refusedProjectToken.reason, "git_tracked");
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token whose .verse8 folder cannot be examined is refused, not treated as absent", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("needs POSIX permission bits and a non-root user");
    return;
  }
  await withIsolatedLogin(async ({ project }) => {
    const projectToken = path.join(project, ".verse8", "token");
    writeToken(projectToken, GOOD);
    fs.chmodSync(path.join(project, ".verse8"), 0o000); // lstat of the token now fails with EACCES
    try {
      const where = resolveToken(project);
      assert.equal(where.token, null);
      assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "unreadable" });
      const out = await call("verse8_logout");
      assert.equal(out.error, "logout_incomplete");
      assert.deepEqual(out.tokenSource, { source: "project", path: projectToken });
    } finally {
      fs.chmodSync(path.join(project, ".verse8"), 0o700);
    }
  });
});

test("verse8_logout: a token file that cannot be deleted makes the logout incomplete", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("needs POSIX permission bits and a non-root user");
    return;
  }
  await withIsolatedLogin(async ({ configToken }) => {
    writeToken(configToken, GOOD);
    // No write on the folder (unlink fails) and no read on the file, so no
    // token resolves afterwards although the file is still there.
    fs.chmodSync(configToken, 0o000);
    fs.chmodSync(path.dirname(configToken), 0o500);
    try {
      const out = await call("verse8_logout");
      assert.equal(out.ok, false);
      assert.equal(out.error, "logout_incomplete");
      assert.deepEqual(out.tokenSource, { source: "config", path: configToken });
      assert.deepEqual(out.removed, []);
    } finally {
      fs.chmodSync(path.dirname(configToken), 0o700);
    }
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token with a damaged .git inside another repository is not judged by the outer repository", async () => {
  await withIsolatedLogin(async ({ root, project }) => {
    // What a temp folder inside a work tree looks like: a healthy repository
    // above the project, where the token file is merely untracked.
    git(root, "init", "-q");
    const projectToken = path.join(project, ".verse8", "token");
    git(project, "init", "-q");
    writeToken(projectToken, GOOD);
    fs.writeFileSync(path.join(project, ".git", "HEAD"), "garbage\n");

    const where = resolveToken(project);
    assert.equal(where.token, null);
    assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "git_check_failed" });
  });
});

// INV-16: The project token file is never read through a link or from git
test("project token tracked by git is not read when an inherited git variable changes how the check is read", async () => {
  await withIsolatedLogin(async ({ project }) => {
    const projectToken = path.join(project, ".verse8", "token");
    git(project, "init", "-q");
    writeToken(projectToken, GOOD);
    git(project, "add", "-f", ".verse8/token");

    const saved = { ...process.env };
    // Each of these made a tracked file look untracked, or pointed git at
    // another index, when it reached the check.
    const hostile = {
      GIT_LITERAL_PATHSPECS: "1",
      GIT_INDEX_FILE: path.join(project, "empty-index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: path.join(project, "nowhere"),
    };
    try {
      for (const [key, value] of Object.entries(hostile)) {
        if (key.startsWith("GIT_CONFIG_")) continue;
        process.env[key] = value;
        const where = resolveToken(project);
        assert.equal(where.token, null, key);
        assert.equal(where.refusedProjectToken.reason, "git_tracked", key);
        delete process.env[key];
      }
      Object.assign(process.env, hostile);
      const where = resolveToken(project);
      assert.equal(where.token, null, "all together");
      assert.equal(where.refusedProjectToken.reason, "git_tracked", "all together");
    } finally {
      for (const key of Object.keys(hostile)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

// INV-16: The project token file is never read through a link or from git
test("a folder named .verse8/token is refused as not a file", async () => {
  await withIsolatedLogin(async ({ project, configToken }) => {
    const projectToken = path.join(project, ".verse8", "token");
    fs.mkdirSync(projectToken, { recursive: true });
    writeToken(configToken, GOOD);

    const where = resolveToken(project);
    assert.equal(where.source, "config");
    assert.deepEqual(where.refusedProjectToken, { path: projectToken, reason: "not_a_file" });
    const status = await call("verse8_status");
    assert.equal(status.ok, true);
    assert.equal(status.projectTokenRefused.reason, "not_a_file");
    // Not a login and not deleted: logout is complete.
    const out = await call("verse8_logout");
    assert.equal(out.ok, true);
    assert.equal(fs.existsSync(projectToken), true);
  });
});

// Refusing a tracked token file only detects the damage. These keep the file
// from getting tracked in the first place.

// INV-16: The project token file is never read through a link or from git
test("the managed .verse8/.gitignore keeps a hand-placed project token out of `git add -A`", async () => {
  await withIsolatedLogin(async ({ project }) => {
    git(project, "init", "-q");
    writeToken(path.join(project, ".verse8", "token"), GOOD);
    // Only `.verse8/token` is ours to hide: a file of that name further down stays visible to git.
    fs.mkdirSync(path.join(project, ".verse8", "notes"));
    fs.writeFileSync(path.join(project, ".verse8", "notes", "token"), "not a login");
    fs.writeFileSync(path.join(project, "game.js"), "play()");
    ensureVerse8GitIgnore(project);

    git(project, "add", "-A");
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: project, encoding: "utf8" });
    assert.deepEqual(staged.split("\n").filter(Boolean).sort(), [".verse8/.gitignore", ".verse8/notes/token", "game.js"]);
    assert.equal(resolveToken(project).source, "project", "and so the token stays usable");
  });
});

// INV-16: The project token file is never read through a link or from git
test("a checkpoint drops a staged project token (any letter case) but keeps its staged removal", async () => {
  await withIsolatedLogin(async ({ project }) => {
    git(project, "init", "-q");
    writeToken(path.join(project, ".verse8", "token"), GOOD);
    fs.writeFileSync(path.join(project, "game.js"), "play()");
    git(project, "add", "-f", ".verse8/token", "game.js");
    assert.deepEqual(unstageNeverCommitFiles(project), [".verse8/token"]);
    assert.deepEqual(listChangedFiles(project).includes(".verse8/token"), false);
    assert.equal(isNeverCommitFile(".verse8/Token"), true);

    // A token committed before this rule existed: its removal must go through.
    git(project, "add", "-f", ".verse8/token");
    git(project, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x");
    git(project, "rm", "-q", "--cached", ".verse8/token");
    assert.deepEqual(unstageNeverCommitFiles(project), []);
  });
});

// INV-16: The project token file is never read through a link or from git
test("the pre-commit hook rejects a commit that adds a project token, and lets its removal through", async () => {
  await withIsolatedLogin(async ({ project }) => {
    git(project, "init", "-q");
    git(project, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
    const nested = path.join(project, "games", "demo", ".verse8", "token");
    writeToken(nested, GOOD);
    fs.writeFileSync(path.join(project, "game.js"), "play()");
    git(project, "add", "game.js");

    const run = () => runHook(project);
    assert.equal(run().code, 0, "nothing but game.js staged (no commit yet)");

    git(project, "add", "-f", "games/demo/.verse8/token");
    const rejected = run();
    assert.equal(rejected.code, 1);
    assert.match(rejected.out, /a Verse8 login token must not be committed\. Staged: "games\/demo\/\.verse8\/token"/);
    assert.ok(!rejected.out.includes(GOOD));

    commit(project);
    git(project, "rm", "-q", "--cached", "games/demo/.verse8/token");
    assert.equal(run().code, 0, "a staged removal passes");
    commit(project);

    // With commits in place: a token added again, in another letter case,
    // and with an inherited variable that would read the pathspec literally.
    const blob = execFileSync("git", ["hash-object", "-w", "game.js"], { cwd: project, encoding: "utf8" }).trim();
    git(project, "update-index", "--add", "--cacheinfo", `100644,${blob},games/demo/.verse8/Token`);
    const savedLiteral = process.env.GIT_LITERAL_PATHSPECS;
    process.env.GIT_LITERAL_PATHSPECS = "1";
    try {
      assert.equal(run().code, 1);
    } finally {
      if (savedLiteral === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
      else process.env.GIT_LITERAL_PATHSPECS = savedLiteral;
    }
  });
});

// A name that comes from the repository must never become part of a command
// the user is told to run.

// INV-16: The project token file is never read through a link or from git
test("the pre-commit hook's unstage command is fixed text, works, and never carries a staged path", async () => {
  await withIsolatedLogin(async ({ project }) => {
    git(project, "init", "-q");
    git(project, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
    // A folder name a clone could carry: pasted inside double quotes, `$(…)` would run.
    const evil = "games/$(touch pwned)/.verse8/token";
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: project, input: "x", encoding: "utf8" }).trim();
    git(project, "update-index", "--add", "--cacheinfo", `100644,${blob},${evil}`);
    git(project, "update-index", "--add", "--cacheinfo", `100644,${blob},.verse8/token`);

    const rejected = runHook(project);
    assert.equal(rejected.code, 1);
    const [diagnostic, command] = rejected.out.trimEnd().split("\n");
    assert.ok(diagnostic.includes(JSON.stringify(evil)), diagnostic); // shown as quoted data
    assert.equal(command, `[verse8 pre-commit] unstage it with: ${UNSTAGE_TOKEN_COMMAND}`);
    assert.ok(!command.includes("$("), command);
    assert.ok(!UNSTAGE_TOKEN_COMMAND.includes("'"), "single quotes do not quote in cmd.exe");

    // The command does what it says: both token entries leave the index.
    const pathspec = UNSTAGE_TOKEN_COMMAND.match(/"([^"]+)"$/)[1];
    git(project, "rm", "-q", "--cached", "--", pathspec);
    assert.equal(runHook(project).code, 0);
  });
});

// The hook must only stop commits that carry a token.

// INV-16: The project token file is never read through a link or from git
test("the pre-commit hook lets a token-free commit through whatever its size and whatever diff settings say", async () => {
  await withIsolatedLogin(async ({ project }) => {
    git(project, "init", "-q");
    git(project, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
    fs.writeFileSync(path.join(project, "game.js"), "play()");
    git(project, "add", "game.js");
    commit(project);

    // More than 1 MiB of staged path names (the default output buffer).
    const blob = execFileSync("git", ["hash-object", "-w", "game.js"], { cwd: project, encoding: "utf8" }).trim();
    const longName = "d".repeat(200);
    const entries = Array.from({ length: 6000 }, (_, i) => `100644 ${blob}\tassets/${longName}/${i}.bin\n`).join("");
    assert.ok(entries.length > 1024 * 1024);
    execFileSync("git", ["update-index", "--index-info"], { cwd: project, input: entries });
    assert.deepEqual(runHook(project), { code: 0, out: "" }, "large staged list");

    // A diff setting that makes `git diff` fail outright.
    git(project, "config", "diff.orderFile", "no-such-order-file");
    assert.deepEqual(runHook(project), { code: 0, out: "" }, "broken diff.orderFile");

    // The token is still caught in that very repository.
    git(project, "update-index", "--add", "--cacheinfo", `100644,${blob},.verse8/token`);
    assert.equal(runHook(project).code, 1);
  });
});

// INV-16: The project token file is never read through a link or from git
test("the pre-commit hook rejects, and says why and what to do, when git cannot list the staged files", async () => {
  await withIsolatedLogin(async ({ project }) => {
    git(project, "init", "-q");
    git(project, "remote", "add", "origin", "https://gitlab.verse8.io/u/demo.git");
    fs.writeFileSync(path.join(project, "game.js"), "play()");
    git(project, "add", "game.js");
    commit(project);
    fs.writeFileSync(path.join(project, ".git", "index"), "this is not a git index");

    const res = runHook(project);
    assert.equal(res.code, 1);
    assert.match(res.out, /git could not say whether a Verse8 login token/);
    assert.match(res.out, /run `git status`/);
    assert.doesNotMatch(res.out, /no-verify/);
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
