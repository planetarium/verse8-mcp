// Unit tests for the verse8_preview readiness probe.
//
// After spawning the dev-server command, runPreview must wait for the
// preview port to be bound before claiming success. Three observable
// scenarios:
//   (1) port binds quickly → ok:true, preview.status === "started"
//   (2) child exits immediately → ok:false, error === "dev_server_exited"
//   (3) child stays alive but never binds → ok:false, error === "dev_server_not_ready"
//
// We exercise runPreview with startOnly:true (to skip the checkpoint path,
// which isn't what this test is about).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { runPreview } from "../../dist/tools/preview.js";

// Run these tests from a directory that verse8_preview can accept. Checkpoint
// is skipped via startOnly:true; runPreview still resolves cwd off
// `input.projectDir ?? serverCwd`, but it doesn't require a verse8 project
// when startOnly is true — it only needs to write to logPath and spawn.

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "verse8-preview-ready-"));
}

// Pick a likely-free high port. We probe isPortInUse-style with a throwaway
// socket — if it's already bound, advance.
import { createServer } from "node:net";
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

const spawnedPids = [];
after(() => {
  // Kill anything the tests left running. SIGKILL because the node -e
  // children don't listen for SIGTERM during `setTimeout`.
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
});

// Write a tiny JS payload to a file and return `node <file>`. Avoids the
// whitespace-split mangling `node -e "…"` runs into.
function writeNodeScript(dir, body) {
  const scriptPath = path.join(dir, `_script_${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(scriptPath, body, "utf8");
  return `node ${scriptPath}`;
}

test("runPreview: happy path — dev server binds port quickly", async () => {
  const dir = tmpdir();
  const port = await reservePort();
  try {
    const cmd = writeNodeScript(
      dir,
      `require('net').createServer(c => c.end()).listen(${port}, '127.0.0.1');\n`,
    );

    const result = await runPreview(
      {
        projectDir: dir,
        previewCommand: cmd,
        previewPort: port,
        logPath: "preview.log",
        startOnly: true,
        readinessTimeoutMs: 5000,
        useAutoToolLog: true,
        skipAttachCheck: false,
        installCommand: "bun update",
        skipPreflight: true,
        preflightTimeoutMs: 30000,
      },
      dir,
    );
    if (result.ok && typeof result.preview === "object" && "pid" in result.preview && typeof result.preview.pid === "number") {
      spawnedPids.push(result.preview.pid);
    }
    assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
    assert.equal(result.preview.status, "started");
    assert.equal(result.preview.url, `http://localhost:${port}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreview: child exits immediately → dev_server_exited", async () => {
  const dir = tmpdir();
  const port = await reservePort();
  try {
    const cmd = writeNodeScript(dir, "process.exit(1);\n");
    const result = await runPreview(
      {
        projectDir: dir,
        previewCommand: cmd,
        previewPort: port,
        logPath: "preview.log",
        startOnly: true,
        readinessTimeoutMs: 5000,
        useAutoToolLog: true,
        skipAttachCheck: false,
        installCommand: "bun update",
        skipPreflight: true,
        preflightTimeoutMs: 30000,
      },
      dir,
    );
    assert.equal(result.ok, false);
    assert.equal(result.stage, "dev_server_not_ready");
    assert.equal(result.error, "dev_server_exited");
    assert.ok(
      /exited before binding port/.test(result.hint),
      `expected exit hint, got: ${result.hint}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreview: child stays alive without binding → dev_server_not_ready (timeout)", async () => {
  const dir = tmpdir();
  const port = await reservePort();
  try {
    // Long setTimeout — process alive but never binds.
    const cmd = writeNodeScript(dir, "setTimeout(() => {}, 60000);\n");
    const result = await runPreview(
      {
        projectDir: dir,
        previewCommand: cmd,
        previewPort: port,
        logPath: "preview.log",
        startOnly: true,
        readinessTimeoutMs: 1200,
        useAutoToolLog: true,
        skipAttachCheck: false,
        installCommand: "bun update",
        skipPreflight: true,
        preflightTimeoutMs: 30000,
      },
      dir,
    );
    if (result.ok === false && result.stage === "dev_server_not_ready" && typeof result.pid === "number") {
      spawnedPids.push(result.pid);
    }
    assert.equal(result.ok, false);
    assert.equal(result.stage, "dev_server_not_ready");
    assert.equal(result.error, "dev_server_not_ready");
    assert.ok(
      /did not bind port/.test(result.hint),
      `expected timeout hint, got: ${result.hint}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreview: already_running path returns webEditor:null for non-gitlab cwd", async () => {
  // If the port is already bound (another server on 127.0.0.1:PORT),
  // runPreview must report status:"already_running" without spawning.
  const dir = tmpdir();
  const port = await reservePort();
  // Prime the port with a background listener.
  const primer = createServer();
  await new Promise((r) => primer.listen(port, "127.0.0.1", r));
  try {
    const cmd = writeNodeScript(dir, "process.exit(0);\n");
    const result = await runPreview(
      {
        projectDir: dir,
        previewCommand: cmd,
        previewPort: port,
        logPath: "preview.log",
        startOnly: true,
        readinessTimeoutMs: 5000,
        useAutoToolLog: true,
        skipAttachCheck: false,
        installCommand: "bun update",
        skipPreflight: true,
        preflightTimeoutMs: 30000,
      },
      dir,
    );
    assert.equal(result.ok, true);
    assert.equal(result.preview.status, "already_running");
    // No git origin in tmpdir → webEditor is null, not invented.
    assert.equal(result.webEditor, null);
  } finally {
    await new Promise((r) => primer.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
