#!/usr/bin/env node
// Runner for the Incanto vs R3F eval.
//
//   node eval/runner/run.mjs schedule [--repeats N] [--seed S]
//       Write eval/runs/schedule.json: every (arm, prompt, repeat) once, in a
//       seeded random order so arms interleave over time, then the
//       DIAGNOSTIC_RUNS (not scored per arm).
//   node eval/runner/run.mjs list
//       Show the schedule and which runs are done.
//   node eval/runner/run.mjs run <runId|--next|--all> [--dry-run] [--no-followups]
//       Clone the seed (--next / --all: the first run not yet claimed; start
//       several --all workers to run in parallel), run the first build and F1..F3 in one Claude Code
//       session, tag the project after each step.
//
// A run costs Claude usage. --dry-run prepares the project and prints the
// exact commands without starting a session.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ARMS,
  DIAGNOSTIC_RUNS,
  EVAL_DIR,
  FOLLOWUPS,
  OFFLINE_TOKEN,
  PILOT,
  PROMPTS,
  REPO_DIR,
  RUN_BUDGET,
  RUNS_DIR,
  SEED_FOR,
  SEEDS_DIR,
} from "../config.mjs";

const SCHEDULE = path.join(RUNS_DIR, "schedule.json");
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

// Tools a verse8 user would have but the eval must not touch: they publish,
// spend credits, create remote projects, or vary the asset set.
const DISALLOWED_TOOLS = [
  "mcp__verse8__verse8_deploy",
  "mcp__verse8__verse8_upload_asset",
  "mcp__verse8__verse8_upload_thumbnail",
  "mcp__verse8__verse8_new_project_start",
  "mcp__verse8__verse8_new_project_confirm",
  "mcp__verse8__verse8_login_start",
  "mcp__verse8__verse8_login_complete",
  "WebSearch",
  "WebFetch",
];

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSchedule(repeats = PILOT.repeats, seed = PILOT.shuffleSeed) {
  const runs = [];
  for (const arm of Object.keys(ARMS))
    for (const prompt of PROMPTS)
      for (let rep = 1; rep <= repeats; rep++) runs.push({ id: `${arm}-${prompt}-r${rep}`, arm, prompt, rep, seed: SEED_FOR[arm][prompt] });
  const rand = mulberry32(seed);
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }
  // Diagnostic runs go last so they never displace a scored one.
  runs.push(...DIAGNOSTIC_RUNS.map((r) => ({ ...r, diagnostic: true })));
  return { createdAt: new Date().toISOString(), repeats, shuffleSeed: seed, budget: RUN_BUDGET, runs: runs.map((r, i) => ({ order: i + 1, ...r })) };
}

// One dev-server port per run, so parallel workers never share 5173 (where
// verse8_preview would report another run's server as "already_running").
const previewPort = (run) => 5200 + run.order;

const readSchedule = () => JSON.parse(fs.readFileSync(SCHEDULE, "utf8"));
const runDir = (id) => path.join(RUNS_DIR, id);
const isDone = (id) => fs.existsSync(path.join(runDir(id), "meta.json")) && JSON.parse(fs.readFileSync(path.join(runDir(id), "meta.json"), "utf8")).finishedAt;

function prepareProject(run) {
  const dir = runDir(run.id);
  const project = path.join(dir, "project");
  // Non-recursive mkdir is the claim: two workers cannot both take a run.
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code === "EEXIST") throw Object.assign(new Error(`${dir} exists — remove it to rerun ${run.id}`), { code: "CLAIMED" });
    throw e;
  }
  // APFS clone: node_modules comes along without a copy or a network install.
  sh("cp", ["-cR", path.join(SEEDS_DIR, run.seed), project]);
  const remote = path.join(dir, "remote.git");
  sh("git", ["init", "-q", "--bare", remote]);
  sh("git", ["config", "remote.origin.pushurl", remote], { cwd: project });
  sh("bun", ["install", "--frozen-lockfile"], { cwd: project });

  // verse8-mcp as a user would get it, but offline: dummy token (checkpoint
  // reads the account from .env and never calls out), proxies off.
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const shim = path.join(binDir, "verse8-mcp");
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "${path.join(REPO_DIR, "dist", "index.js")}" "$@"\n`, { mode: 0o755 });
  const mcpConfig = path.join(dir, "mcp.json");
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify(
      {
        mcpServers: {
          verse8: {
            command: "node",
            args: [path.join(REPO_DIR, "dist", "index.js")],
            env: { VERSE8_ACCESS_TOKEN: OFFLINE_TOKEN, VERSE8_MCP_PROXIES: "none", PATH: `${binDir}:${process.env.PATH}` },
          },
        },
      },
      null,
      2,
    ),
  );
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(
    settings,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__verse8__verse8_preview",
              hooks: [{ type: "command", command: `node "${path.join(EVAL_DIR, "runner", "preview-guard.mjs")}" ${previewPort(run)}` }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  return { dir, project, mcpConfig, settings, binDir };
}

function childEnv(binDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Drop the parent session's markers so the run is not seen as nested.
    if (k === "CLAUDECODE" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN")) continue;
    env[k] = v;
  }
  env.PATH = `${binDir}:${process.env.PATH}`;
  env.VERSE8_ACCESS_TOKEN = OFFLINE_TOKEN;
  env.VERSE8_MCP_PROXIES = "none";
  return env;
}

function claudeArgs(prompt, ctx, sessionId, resume) {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    RUN_BUDGET.model,
    "--effort",
    RUN_BUDGET.effort,
    "--max-budget-usd",
    String(RUN_BUDGET.maxBudgetUsd),
    "--dangerously-skip-permissions",
    // Project + local only: the operator's user-level plugins and settings
    // must not reach the agent.
    "--setting-sources",
    "project,local",
    "--settings",
    ctx.settings,
    "--strict-mcp-config",
    "--mcp-config",
    ctx.mcpConfig,
    "--disallowed-tools",
    DISALLOWED_TOOLS.join(","),
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];
}

// Runs one agent turn, streaming the transcript to disk. Enforces the wall
// clock and tool-call caps from RUN_BUDGET by killing the session.
function runTurn(step, prompt, ctx, sessionId, resume) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(ctx.dir, `${step}.stream.jsonl`));
    const err = fs.createWriteStream(path.join(ctx.dir, `${step}.stderr.log`));
    const started = Date.now();
    const child = spawn("claude", claudeArgs(prompt, ctx, sessionId, resume), {
      cwd: ctx.project,
      env: childEnv(ctx.binDir),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let buf = "";
    let toolCalls = 0;
    const toolsByName = {};
    let result = null;
    let init = null;
    let stopReason = null;
    const kill = (why) => {
      if (stopReason) return;
      stopReason = why;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => kill("wall_clock"), RUN_BUDGET.wallClockMin * 60_000);
    child.stdout.on("data", (d) => {
      out.write(d);
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "system" && ev.subtype === "init") init = ev;
        if (ev.type === "assistant")
          for (const c of ev.message?.content ?? [])
            if (c.type === "tool_use") {
              toolCalls++;
              toolsByName[c.name] = (toolsByName[c.name] ?? 0) + 1;
              if (toolCalls > RUN_BUDGET.maxToolCalls) kill("tool_calls");
            }
        if (ev.type === "result") result = ev;
      }
    });
    child.stderr.pipe(err);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end();
      err.end();
      resolve({
        step,
        exitCode: code,
        stopReason: stopReason ?? (result?.subtype && result.subtype !== "success" ? result.subtype : null),
        wallSec: (Date.now() - started) / 1000,
        toolCalls,
        toolsByName,
        costUsd: result?.total_cost_usd ?? null,
        numTurns: result?.num_turns ?? null,
        usage: result?.usage ?? null,
        finalText: result?.result ?? null,
        init: init && {
          model: init.model,
          tools: init.tools,
          mcpServers: init.mcp_servers,
          skills: init.skills,
          slashCommands: init.slash_commands,
          plugins: init.plugins,
        },
      });
    });
  });
}

// Captures whatever the agent left uncommitted, then tags the step.
function snapshot(project, tag) {
  sh("git", ["add", "-A"], { cwd: project });
  try {
    sh("git", ["add", "-f", "bun.lock"], { cwd: project });
  } catch {
    /* no lockfile */
  }
  try {
    sh("git", ["commit", "-q", "--no-verify", "-m", `eval: snapshot after ${tag}`], { cwd: project });
  } catch {
    /* nothing to commit */
  }
  sh("git", ["tag", "-f", tag], { cwd: project });
  return sh("git", ["rev-parse", "HEAD"], { cwd: project });
}

function depsViolation(project, arm) {
  const pkg = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return deps.filter((d) => ARMS[arm].forbiddenDeps.includes(d));
}

function cleanupProcesses(dir) {
  // Dev servers started by verse8_preview outlive the session.
  try {
    sh("pkill", ["-f", dir]);
  } catch {
    /* none */
  }
}

async function runOne(run, { dryRun, followups }) {
  const ctx = prepareProject(run);
  const sessionId = randomUUID();
  const steps = [{ step: "build", file: `${run.prompt}.md` }, ...(followups && run.followups !== false ? FOLLOWUPS.map((f) => ({ step: f, file: `${run.prompt}-${f}.md` })) : [])];
  const meta = {
    ...run,
    sessionId,
    startedAt: new Date().toISOString(),
    budget: RUN_BUDGET,
    disallowedTools: DISALLOWED_TOOLS,
    seedCommit: sh("git", ["rev-parse", "seed"], { cwd: ctx.project }),
    verse8Mcp: sh("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR }),
    claudeVersion: sh("claude", ["--version"]),
    steps: [],
  };
  if (dryRun) {
    for (const [i, s] of steps.entries()) {
      const args = claudeArgs(`<${s.file}>`, ctx, sessionId, i > 0);
      console.log(`[${run.id}] ${s.step}: (cd ${ctx.project} && claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")})`);
    }
    fs.writeFileSync(path.join(ctx.dir, "meta.dry-run.json"), JSON.stringify(meta, null, 2) + "\n");
    return meta;
  }
  for (const [i, s] of steps.entries()) {
    const prompt = fs.readFileSync(path.join(EVAL_DIR, "prompts", s.file), "utf8");
    const r = await runTurn(s.step, prompt, ctx, sessionId, i > 0);
    cleanupProcesses(ctx.dir);
    r.commit = snapshot(ctx.project, s.step);
    r.forbiddenDeps = depsViolation(ctx.project, run.arm);
    meta.steps.push(r);
    fs.writeFileSync(path.join(ctx.dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    console.log(`[${run.id}] ${s.step}: ${r.stopReason ?? "ok"} $${r.costUsd ?? "?"} ${Math.round(r.wallSec)}s tools=${r.toolCalls}`);
    // A session that died (budget, wall clock) cannot take the next request.
    if (r.stopReason) break;
  }
  meta.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ctx.dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => rest.includes(n);
  const opt = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  if (cmd === "schedule") {
    if (fs.existsSync(SCHEDULE) && !flag("--force")) throw new Error(`${SCHEDULE} exists (use --force)`);
    const s = makeSchedule(Number(opt("--repeats", PILOT.repeats)), Number(opt("--seed", PILOT.shuffleSeed)));
    fs.writeFileSync(SCHEDULE, JSON.stringify(s, null, 2) + "\n");
    for (const r of s.runs) console.log(`${String(r.order).padStart(2)}. ${r.id}  (seed ${r.seed})`);
    return;
  }
  if (cmd === "list") {
    for (const r of readSchedule().runs) console.log(`${String(r.order).padStart(2)}. ${r.id}  ${isDone(r.id) ? "done" : ""}`);
    return;
  }
  if (cmd === "run") {
    const target = rest.find((a) => !a.startsWith("--"));
    const sched = readSchedule().runs;
    const opts = { dryRun: flag("--dry-run"), followups: !flag("--no-followups") };
    // --all / --next take the first run nobody has claimed, so several
    // `run --all` workers can share one schedule.
    const unclaimed = () => sched.find((r) => !fs.existsSync(runDir(r.id)));
    if (flag("--all") || flag("--next")) {
      for (let r = unclaimed(); r; r = flag("--all") ? unclaimed() : null) {
        try {
          await runOne(r, opts);
        } catch (e) {
          if (e.code !== "CLAIMED") throw e;
        }
      }
      return;
    }
    const r = sched.find((x) => x.id === target);
    if (!r) throw new Error(`unknown run ${target}`);
    await runOne(r, opts);
    return;
  }
  console.error("usage: run.mjs schedule|list|run <runId|--next|--all> [--dry-run] [--no-followups]");
  process.exit(2);
}

await main();
