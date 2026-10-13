#!/usr/bin/env node
// PreToolUse hook for mcp__verse8__verse8_preview.
//
// verse8_preview's preflight defaults to `bun update`, which moves dependency
// versions on every run, and on a project with server.js it also builds and
// deploys a game server. The eval wants neither: run a frozen install here,
// then let the preview through with its own preflight skipped.
//
// argv[2] is this run's dev-server port (see run.mjs previewPort): the default
// 5173 is moved there so parallel runs never see each other's server. The
// server is bound to 127.0.0.1 because verse8_preview's readiness probe only
// connects there, and vite on this setup binds `localhost` as [::1] alone.
import { spawnSync } from "node:child_process";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw);
const input = event.tool_input ?? {};
const cwd = input.projectDir || event.cwd || process.cwd();

const r = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd, encoding: "utf8" });
if (r.status !== 0) {
  // Exit 2 blocks the call and shows stderr to the agent, like a failed preflight.
  process.stderr.write(
    `Preflight aborted at: bun install --frozen-lockfile (exit ${r.status}).\n${(r.stderr || r.stdout || "").slice(-2000)}`,
  );
  process.exit(2);
}

function portOverride() {
  const port = Number(process.argv[2]);
  if (!port || (input.previewPort ?? 5173) !== 5173) return {};
  const cmd = input.previewCommand ?? "bun run dev";
  // `bun run dev --port N` hands the flags to vite; strictPort makes a clash fail loudly.
  return { previewPort: port, previewCommand: /--port\b/.test(cmd) ? cmd : `${cmd} --port ${port} --strictPort --host 127.0.0.1` };
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input, skipPreflight: true, ...portOverride() },
    },
  }),
);
