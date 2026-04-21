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
