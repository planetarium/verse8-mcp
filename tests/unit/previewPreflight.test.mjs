// Unit tests for the verse8_preview preflight pipeline.
//
// The preflight runs BEFORE the dev server is spawned:
//   1. installCommand (default `bun update`) — always
//   2. If gameserver detected:
//        - npx -y @agent8/gameserver-node build
//        - npx -y @agent8/deploy --preview
//
// Detection: server.ts, server.js, or server/ directory at projectDir root.
// Failure of any step aborts the preview with `preflight_failed`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnection, createServer } from "node:net";

import {
  detectGameserver,
  buildPreflightSteps,
  runPreview,
} from "../../dist/tools/preview.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-preflight-"));
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function writeNodeScript(dir, body) {
  const scriptPath = path.join(dir, `_pf_${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(scriptPath, body, "utf8");
  return `node ${scriptPath}`;
}

const spawnedPids = [];
after(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
});

// ------------------------------------------------------------------
// detectGameserver
// ------------------------------------------------------------------

test("detectGameserver: returns false when no server entry exists", () => {
  const dir = tmp();
  try {
    assert.equal(detectGameserver(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectGameserver: triggers on server.ts at root", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "server.ts"), "export const x = 1;");
    assert.equal(detectGameserver(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectGameserver: triggers on server.js at root", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "server.js"), "module.exports = {};");
    assert.equal(detectGameserver(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectGameserver: triggers on bare server/ directory", () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, "server"));
    assert.equal(detectGameserver(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectGameserver: a `server` regular file (not dir) does NOT trigger", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "server"), "decoy");
    assert.equal(detectGameserver(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------
// buildPreflightSteps
// ------------------------------------------------------------------

test("buildPreflightSteps: non-gameserver project → install only (1 step)", () => {
  const steps = buildPreflightSteps("bun update", false);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, "bun update");
  assert.equal(steps[0].cmd, "bun");
  assert.deepEqual(steps[0].args, ["update"]);
});

test("buildPreflightSteps: gameserver project → install + build + deploy (3 steps)", () => {
  const steps = buildPreflightSteps("bun update", true);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].command, "bun update");
  // M4.2: npx argv now carries a version pin (from package.json or env),
  // e.g. `@agent8/gameserver-node@latest`. Assert shape without binding to
  // a specific pin value so the test survives future bumps.
  assert.equal(steps[1].cmd, "npx");
  assert.equal(steps[1].args[0], "-y");
  assert.match(steps[1].args[1], /^@agent8\/gameserver-node(@.+)?$/);
  assert.equal(steps[1].args[2], "build");
  assert.equal(steps[2].cmd, "npx");
  assert.equal(steps[2].args[0], "-y");
  assert.match(steps[2].args[1], /^@agent8\/deploy(@.+)?$/);
  assert.equal(steps[2].args[2], "--preview");
});

test("buildPreflightSteps: only the preview deploy step gets V8_ACCESS_TOKEN", () => {
  const baseEnv = { PATH: "/usr/bin", KEEP: "1" };
  const steps = buildPreflightSteps("bun update", true, { baseEnv, token: "dummy-token" });
  assert.equal(steps.length, 3);
  assert.equal(steps[0].env.V8_ACCESS_TOKEN, undefined, "install must not see the token");
  assert.equal(steps[1].env.V8_ACCESS_TOKEN, undefined, "gameserver build must not see the token");
  assert.equal(steps[2].env.V8_ACCESS_TOKEN, "dummy-token");
  assert.equal(steps[2].env.KEEP, "1");
  assert.equal(baseEnv.V8_ACCESS_TOKEN, undefined, "baseEnv is not mutated");
});

test("buildPreflightSteps: default base env strips verse8 secrets from every step", () => {
  const saved = { a: process.env.VERSE8_ACCESS_TOKEN, b: process.env.V8_ACCESS_TOKEN };
  process.env.VERSE8_ACCESS_TOKEN = "dummy-env-token";
  process.env.V8_ACCESS_TOKEN = "dummy-shell-token";
  try {
    const steps = buildPreflightSteps("bun update", true, { token: "dummy-token" });
    for (const step of steps) {
      assert.equal(step.env.VERSE8_ACCESS_TOKEN, undefined, `${step.command} saw VERSE8_ACCESS_TOKEN`);
    }
    assert.equal(steps[0].env.V8_ACCESS_TOKEN, undefined);
    assert.equal(steps[1].env.V8_ACCESS_TOKEN, undefined);
    assert.equal(steps[2].env.V8_ACCESS_TOKEN, "dummy-token");
  } finally {
    if (saved.a === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = saved.a;
    if (saved.b === undefined) delete process.env.V8_ACCESS_TOKEN;
    else process.env.V8_ACCESS_TOKEN = saved.b;
  }
});

test("buildPreflightSteps: custom installCommand with extra flags is split correctly", () => {
  const steps = buildPreflightSteps("bun install --frozen-lockfile", false);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].cmd, "bun");
  assert.deepEqual(steps[0].args, ["install", "--frozen-lockfile"]);
});

// ------------------------------------------------------------------
// runPreview integration — preflight runs and reports
// ------------------------------------------------------------------

test("runPreview: preflight runs install step on success path", async () => {
  const dir = tmp();
  const port = await reservePort();
  try {
    // Custom installCommand that exits 0 instantly so we can verify the
    // preflight ran without depending on `bun` being present.
    const installCmd = writeNodeScript(dir, "process.exit(0);\n");
    const previewCmd = writeNodeScript(
      dir,
      `require('net').createServer(c => c.end()).listen(${port}, '127.0.0.1');\n`,
    );
    const result = await runPreview(
      {
        projectDir: dir,
        previewCommand: previewCmd,
        previewPort: port,
        logPath: "preview.log",
        startOnly: true, // skip checkpoint (no real verse project here)
        readinessTimeoutMs: 5000,
        useAutoToolLog: true,
        skipAttachCheck: false,
        installCommand: installCmd,
        skipPreflight: false,
        preflightTimeoutMs: 30000,
      },
      dir,
    );
    if (result.ok && typeof result.preview === "object" && "pid" in result.preview && typeof result.preview.pid === "number") {
      spawnedPids.push(result.preview.pid);
    }
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.equal(result.preflight.ran, true);
    assert.equal(result.preflight.gameserver, false);
    assert.equal(result.preflight.steps.length, 1);
    assert.equal(result.preflight.steps[0].exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreview: preflight failure aborts with preflight_failed (no spawn)", async () => {
  const dir = tmp();
  const port = await reservePort();
  try {
    const installCmd = writeNodeScript(
      dir,
      "console.error('boom: deps unreachable'); process.exit(7);\n",
    );
    const previewCmd = writeNodeScript(
      dir,
      `require('net').createServer(c => c.end()).listen(${port}, '127.0.0.1');\n`,
    );
    const result = await runPreview(
      {
        projectDir: dir,
        previewCommand: previewCmd,
        previewPort: port,
        logPath: "preview.log",
        startOnly: true,
        readinessTimeoutMs: 5000,
        useAutoToolLog: true,
        skipAttachCheck: false,
        installCommand: installCmd,
        skipPreflight: false,
        preflightTimeoutMs: 30000,
      },
      dir,
    );
    assert.equal(result.ok, false);
    assert.equal(result.stage, "preflight_failed");
    assert.equal(result.failedStep.exitCode, 7);
    assert.match(result.hint, /Preflight aborted/);
    assert.match(result.failedStep.stderrTail, /boom: deps unreachable/);
    // No dev server should have been spawned — port stays unused.
    assert.equal(
      await new Promise((resolve) => {
        const probe = createConnection({ port, host: "127.0.0.1" });
        probe.setTimeout(200);
        const done = (used) => {
          probe.destroy();
          resolve(used);
        };
        probe.once("connect", () => done(true));
        probe.once("timeout", () => done(false));
        probe.once("error", () => done(false));
      }),
      false,
      "dev server must not be running after preflight failure",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreview: skipPreflight: true bypasses preflight entirely", async () => {
  const dir = tmp();
  const port = await reservePort();
  try {
    // Install command would fail, but skipPreflight skips it.
    const installCmd = writeNodeScript(dir, "process.exit(99);\n");
    const previewCmd = writeNodeScript(
      dir,
      `require('net').createServer(c => c.end()).listen(${port}, '127.0.0.1');\n`,
    );
    const result = await runPreview(
      {
        projectDir: dir,
        previewCommand: previewCmd,
        previewPort: port,
        logPath: "preview.log",
        startOnly: true,
        readinessTimeoutMs: 5000,
        useAutoToolLog: true,
        skipAttachCheck: false,
        installCommand: installCmd,
        skipPreflight: true,
        preflightTimeoutMs: 30000,
      },
      dir,
    );
    if (result.ok && typeof result.preview === "object" && "pid" in result.preview && typeof result.preview.pid === "number") {
      spawnedPids.push(result.preview.pid);
    }
    assert.equal(result.ok, true);
    assert.equal(result.preflight.ran, false);
    assert.equal(result.preflight.skipReason, "skipPreflight_flag");
    assert.equal(result.preflight.steps.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------
// runPreview integration — the preview deploy gets the stored login
// ------------------------------------------------------------------

// A fake `npx` first on PATH records, per step, only whether the token
// variables are set — never their values.
function withFakeNpx(dir) {
  const binDir = path.join(dir, "_bin");
  fs.mkdirSync(binDir);
  const record = path.join(dir, "_record.txt");
  fs.writeFileSync(
    path.join(binDir, "npx"),
    [
      "#!/bin/sh",
      'case "$2" in @agent8/deploy*) name=deploy ;; *) name=build ;; esac',
      'if [ "$V8_ACCESS_TOKEN" = "dummy-preview-token" ]; then v8=match; elif [ -n "$V8_ACCESS_TOKEN" ]; then v8=other; else v8=absent; fi',
      'if [ -n "$VERSE8_ACCESS_TOKEN" ]; then verse8=present; else verse8=absent; fi',
      'echo "$name v8=$v8 verse8=$verse8" >> "$PREVIEW_PF_RECORD"',
      // PREVIEW_PF_ECHO=ok|fail makes the deploy step echo the token, like a
      // server.js that logs its env would.
      'if [ "$name" = deploy ] && [ -n "$PREVIEW_PF_ECHO" ]; then echo "leak $V8_ACCESS_TOKEN"; echo "leak $V8_ACCESS_TOKEN" >&2; if [ "$PREVIEW_PF_ECHO" = fail ]; then exit 1; fi; fi',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { binDir, record };
}

function envSnapshot(keys) {
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

function previewInput(dir, port, installCmd, previewCmd) {
  return {
    projectDir: dir,
    previewCommand: previewCmd,
    previewPort: port,
    logPath: "preview.log",
    startOnly: true,
    readinessTimeoutMs: 5000,
    useAutoToolLog: true,
    skipAttachCheck: false,
    installCommand: installCmd,
    skipPreflight: false,
    preflightTimeoutMs: 30000,
  };
}

test("runPreview: gameserver preflight hands the login to `deploy --preview` only", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const port = await reservePort();
  const restore = envSnapshot(["PATH", "VERSE8_ACCESS_TOKEN", "V8_ACCESS_TOKEN", "PREVIEW_PF_RECORD"]);
  try {
    fs.mkdirSync(path.join(dir, "server"));
    const { binDir, record } = withFakeNpx(dir);
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
    process.env.VERSE8_ACCESS_TOKEN = "dummy-preview-token";
    delete process.env.V8_ACCESS_TOKEN;
    process.env.PREVIEW_PF_RECORD = record;
    const installCmd = writeNodeScript(
      dir,
      `require('fs').appendFileSync(process.env.PREVIEW_PF_RECORD, 'install v8=' + (process.env.V8_ACCESS_TOKEN ? 'set' : 'absent') + ' verse8=' + (process.env.VERSE8_ACCESS_TOKEN ? 'present' : 'absent') + '\\n');\n`,
    );
    const previewCmd = writeNodeScript(
      dir,
      `require('net').createServer(c => c.end()).listen(${port}, '127.0.0.1');\n`,
    );
    const result = await runPreview(previewInput(dir, port, installCmd, previewCmd), dir);
    if (result.ok && typeof result.preview === "object" && "pid" in result.preview && typeof result.preview.pid === "number") {
      spawnedPids.push(result.preview.pid);
    }
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.equal(result.preflight.gameserver, true);
    assert.equal(result.preflight.steps.length, 3);
    assert.deepEqual(fs.readFileSync(record, "utf8").trim().split("\n"), [
      "install v8=absent verse8=absent",
      "build v8=absent verse8=absent",
      "deploy v8=match verse8=absent",
    ]);
    assert.doesNotMatch(JSON.stringify(result), /dummy-preview-token/);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreview: gameserver preflight without a login stops before any step", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const port = await reservePort();
  const restore = envSnapshot(["PATH", "VERSE8_ACCESS_TOKEN", "XDG_CONFIG_HOME", "PREVIEW_PF_RECORD"]);
  try {
    fs.mkdirSync(path.join(dir, "server"));
    const { binDir, record } = withFakeNpx(dir);
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
    delete process.env.VERSE8_ACCESS_TOKEN;
    process.env.XDG_CONFIG_HOME = path.join(dir, "_empty_config");
    process.env.PREVIEW_PF_RECORD = record;
    const installCmd = writeNodeScript(
      dir,
      "require('fs').appendFileSync(process.env.PREVIEW_PF_RECORD, 'install\\n');\n",
    );
    const previewCmd = writeNodeScript(
      dir,
      `require('net').createServer(c => c.end()).listen(${port}, '127.0.0.1');\n`,
    );
    const result = await runPreview(previewInput(dir, port, installCmd, previewCmd), dir);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "preflight_failed");
    assert.match(result.hint, /verse8_login_start/);
    assert.match(result.failedStep.command, /@agent8\/deploy(@.+)? --preview$/);
    assert.deepEqual(result.stepsCompleted, []);
    assert.equal(fs.existsSync(record), false, "no preflight step may run without a login");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ["ok", "fail"]) {
  test(`runPreview: a deploy step that echoes the token is masked (${mode})`, { skip: process.platform === "win32" }, async () => {
    const dir = tmp();
    const port = await reservePort();
    const restore = envSnapshot(["PATH", "VERSE8_ACCESS_TOKEN", "PREVIEW_PF_RECORD", "PREVIEW_PF_ECHO"]);
    try {
      fs.mkdirSync(path.join(dir, "server"));
      const { binDir, record } = withFakeNpx(dir);
      process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
      process.env.VERSE8_ACCESS_TOKEN = "dummy-preview-token";
      process.env.PREVIEW_PF_RECORD = record;
      process.env.PREVIEW_PF_ECHO = mode;
      const installCmd = writeNodeScript(dir, "process.exit(0);\n");
      const previewCmd = writeNodeScript(
        dir,
        `require('net').createServer(c => c.end()).listen(${port}, '127.0.0.1');\n`,
      );
      const result = await runPreview(previewInput(dir, port, installCmd, previewCmd), dir);
      if (result.ok && typeof result.preview === "object" && "pid" in result.preview && typeof result.preview.pid === "number") {
        spawnedPids.push(result.preview.pid);
      }
      assert.equal(result.ok, mode === "ok", JSON.stringify(result));
      const text = JSON.stringify(result);
      assert.doesNotMatch(text, /dummy-preview-token/);
      assert.match(text, /leak \[REDACTED\]/);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
