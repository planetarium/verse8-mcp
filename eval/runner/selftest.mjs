#!/usr/bin/env node
// Checks a prepared run directory works offline without starting Claude:
// the verse8 MCP server boots from mcp.json, lists the tools, and
// verse8_checkpoint commits and pushes to the local bare remote only.
// The preview guard is exercised with a synthetic hook event, and its
// rewritten input is fed to the real verse8_preview: the dev server must come
// up on the run's own port.
//
// Usage: node eval/runner/selftest.mjs <runDir>
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { EVAL_DIR, REPO_DIR } from "../config.mjs";

const require = createRequire(path.join(REPO_DIR, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const dir = path.resolve(process.argv[2]);
const project = path.join(dir, "project");
const server = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")).mcpServers.verse8;
const git = (...a) => spawnSync("git", a, { cwd: project, encoding: "utf8" }).stdout.trim();

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

const client = new Client({ name: "eval-selftest", version: "0" });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: server.env, cwd: project, stderr: "ignore" }));
const tools = (await client.listTools()).tools.map((t) => t.name);
check("verse8 tools listed", tools.includes("verse8_checkpoint") && tools.includes("verse8_preview"), tools.join(","));
check("no proxied tools", tools.every((t) => t.startsWith("verse8_")), tools.filter((t) => !t.startsWith("verse8_")).join(","));

fs.writeFileSync(path.join(project, "SELFTEST.txt"), "selftest\n");
const before = git("rev-parse", "HEAD");
const res = await client.callTool({
  name: "verse8_checkpoint",
  arguments: { projectDir: project, userPrompt: "selftest", workSummary: "selftest", problemStatement: "selftest", toolCalls: [] },
});
const body = res.content?.[0]?.text ?? "";
const after = git("rev-parse", "HEAD");
check("checkpoint committed", before !== after, body.slice(0, 300));
const remoteHead = spawnSync("git", ["--git-dir", path.join(dir, "remote.git"), "rev-parse", "refs/heads/develop"], { encoding: "utf8" }).stdout.trim();
check("checkpoint pushed to local bare remote only", remoteHead === after, `remote=${remoteHead}`);

// Undo the selftest commit so the run starts from the seed.
spawnSync("git", ["reset", "-q", "--hard", before], { cwd: project });
spawnSync("git", ["--git-dir", path.join(dir, "remote.git"), "update-ref", "-d", "refs/heads/develop"]);
fs.rmSync(path.join(project, "SELFTEST.txt"), { force: true });

// The hook command in settings.json carries the run's port as its last word.
const hookCmd = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
const runPort = Number(hookCmd.split(" ").pop());
const hook = spawnSync("node", [path.join(EVAL_DIR, "runner", "preview-guard.mjs"), String(runPort)], {
  input: JSON.stringify({ cwd: project, tool_input: { projectDir: project } }),
  encoding: "utf8",
});
let out = {};
try {
  out = JSON.parse(hook.stdout);
} catch {
  /* reported below */
}
const updated = out.hookSpecificOutput?.updatedInput ?? {};
check("preview guard: frozen install then skipPreflight", hook.status === 0 && updated.skipPreflight === true, hook.stderr.slice(0, 300));
check("preview guard: default port moved to the run's", runPort > 0 && updated.previewPort === runPort && updated.previewCommand?.includes(`--port ${runPort}`), JSON.stringify(updated));

if (updated.previewPort) {
  const pv = await client.callTool({ name: "verse8_preview", arguments: { ...updated, startOnly: true, readinessTimeoutMs: 30000 } });
  const pvBody = pv.content?.[0]?.text ?? "";
  const res2 = await fetch(`http://127.0.0.1:${runPort}/`).catch(() => null);
  check("preview serves on the run's port", res2?.ok === true, pvBody.slice(0, 300));
  const pids = spawnSync("lsof", ["-tiTCP:" + runPort, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const pid of pids) process.kill(Number(pid));
}
await client.close();

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : `  — ${c.detail}`}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
