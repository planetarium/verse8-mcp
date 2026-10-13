#!/usr/bin/env node
// Aggregates run metadata, transcripts and evaluator results into
// eval/report/runs.csv (one row per run × step) and eval/report/summary.md.
//
// Usage: node eval/aggregate/aggregate.mjs [--main-n 8]
import * as fs from "node:fs";
import * as path from "node:path";
import { ARMS, EVAL_DIR, FOLLOWUPS, PROMPTS, RUNS_DIR } from "../config.mjs";

const OUT = path.join(EVAL_DIR, "report");
const R_KEYS = { P1: Array.from({ length: 16 }, (_, i) => `R${i + 1}`), P2: Array.from({ length: 13 }, (_, i) => `R${i + 1}`) };
const VERIFY_RE = /incanto-(check|playtest|verify|frame|play|logs)\b/;
const BUILD_RE = /\b(bun|npm|pnpm|yarn)\s+(run\s+)?build\b|\btsc\b|vite build/;
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

// Tool usage the stream summary does not split out: verification commands
// and build attempts (the self-correction loop), skill/doc reads.
function transcriptStats(file) {
  const s = { verifyCalls: 0, buildCalls: 0, failedBuilds: 0, skillReads: 0, mcpCalls: {} };
  if (!fs.existsSync(file)) return s;
  const pending = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_use") {
        const cmd = c.name === "Bash" ? String(c.input?.command ?? "") : "";
        if (VERIFY_RE.test(cmd)) s.verifyCalls++;
        if (BUILD_RE.test(cmd)) {
          s.buildCalls++;
          pending.set(c.id, "build");
        }
        if (c.name === "Skill" || (c.name === "Read" && /\/skills\/|SKILL\.md|node_modules\/incanto\/skills/.test(String(c.input?.file_path ?? "")))) s.skillReads++;
        if (c.name.startsWith("mcp__")) s.mcpCalls[c.name] = (s.mcpCalls[c.name] ?? 0) + 1;
      }
      if (c.type === "tool_result" && pending.get(c.tool_use_id) === "build" && c.is_error) s.failedBuilds++;
    }
  }
  return s;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : "");

function rowFor(meta, step, ev) {
  const st = meta?.steps?.find((x) => x.step === step);
  const t = transcriptStats(path.join(RUNS_DIR, meta.id, `${step}.stream.jsonl`));
  const req = ev?.requirements ?? {};
  const keys = R_KEYS[meta.prompt];
  const auto = keys.map((k) => req[k]).filter((x) => x && typeof x.score === "number");
  const row = {
    run: meta.id,
    arm: meta.arm,
    prompt: meta.prompt,
    rep: meta.rep,
    order: meta.order,
    diagnostic: meta.diagnostic ? 1 : 0,
    step,
    stopReason: st?.stopReason ?? "",
    costUsd: num(st?.costUsd),
    wallSec: num(st?.wallSec),
    numTurns: num(st?.numTurns),
    toolCalls: num(st?.toolCalls),
    inputTokens: num(st?.usage?.input_tokens),
    outputTokens: num(st?.usage?.output_tokens),
    cacheReadTokens: num(st?.usage?.cache_read_input_tokens),
    cacheWriteTokens: num(st?.usage?.cache_creation_input_tokens),
    verifyCalls: t.verifyCalls,
    buildCalls: t.buildCalls,
    failedBuilds: t.failedBuilds,
    skillReads: t.skillReads,
    forbiddenDeps: (st?.forbiddenDeps ?? []).join(" "),
    buildOk: ev ? (ev.build?.ok ? 1 : 0) : "",
    tscErrors: num(ev?.tsc?.errors),
    bootOk: ev ? (ev.boot?.ok ? 1 : 0) : "",
    consoleErrors: ev?.console ? ev.console.consoleErrors.length : "",
    pageErrors: ev?.console ? ev.console.pageErrors.length : "",
    webglWarnings: num(ev?.console?.webglWarnings),
    autoScored: auto.length,
    autoScoreSum: auto.reduce((a, b) => a + b.score, 0),
    autoScoreRate: auto.length ? auto.reduce((a, b) => a + b.score, 0) / auto.length : "",
    hookPresent: ev ? (req[meta.prompt === "P1" ? "R15" : "R12"]?.score > 0 ? 1 : 0) : "",
    fpsMedian: num(ev?.perf?.fpsMedian),
    fps1pctLow: num(ev?.perf?.fps1pctLow),
    frameTimeP95: num(ev?.perf?.frameTimeP95),
    drawCallsMedian: num(ev?.perf?.drawCallsMedian),
    verticesMedian: num(ev?.perf?.verticesMedian),
    firstNonBlankMs: num(ev?.boot?.firstNonBlankMs),
    titleToPlayMs: num(ev?.perf?.titleToPlayMs),
    initialJsGzip: num(ev?.bundle?.initialJsGzip),
    totalJsGzip: num(ev?.bundle?.totalJsGzip),
    monkeyExceptions: num(ev?.monkey?.exceptions),
    monkeyInvalidState: num(ev?.monkey?.invalidState),
    monkeyOutOfWorld: num(ev?.monkey?.outOfWorld),
    keyStuck: ev?.monkey ? (ev.monkey.keyStuckAfter ? 1 : 0) : "",
    heapGrowth: num(ev?.restart?.heapGrowth),
    followupScore: ev?.followup ? Object.values(ev.followup).map((x) => x.score ?? "?").join(" ") : "",
  };
  for (const k of keys) row[k] = req[k] && typeof req[k].score === "number" ? req[k].score : req[k] ? "?" : "";
  return row;
}

function regressions(rows) {
  const byRun = Map.groupBy(rows, (r) => r.run);
  for (const rs of byRun.values()) {
    const base = rs.find((r) => r.step === "build");
    for (const r of rs) {
      if (r.step === "build" || !base) continue;
      const keys = R_KEYS[r.prompt];
      r.regressions = keys.filter((k) => base[k] === 1 && typeof r[k] === "number" && r[k] < 1).length;
    }
  }
}

const median = (a) => {
  const v = a.filter((x) => typeof x === "number").sort((x, y) => x - y);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
const sum = (a) => a.filter((x) => typeof x === "number").reduce((x, y) => x + y, 0);
const fmt = (x, d = 2) => (x === null || x === undefined || x === "" ? "–" : typeof x === "number" ? x.toFixed(d) : x);

function summary(allRows, baseline, mainN) {
  const L = [];
  // Diagnostic runs start from a different seed; they get their own section.
  const rows = allRows.filter((r) => !r.diagnostic);
  const diag = allRows.filter((r) => r.diagnostic);
  L.push(`# Incanto vs R3F — pilot summary`, "", `Generated ${new Date().toISOString()}. Rows: ${rows.length}.`, "");
  if (baseline.length) {
    L.push("## Starting-point scores (seeds, no agent)", "", "| seed | prompt | build | boot | auto score | fps median |", "|---|---|---|---|---|---|");
    for (const b of baseline) L.push(`| ${b.seed} | ${b.prompt} | ${b.build} | ${b.boot} | ${b.score} | ${fmt(b.fps, 1)} |`);
    L.push("");
  }
  L.push("## First build, by arm × prompt", "", "| arm | prompt | runs | build ok | boot ok | auto score rate (median) | cost $ (median) | wall min (median) | tool calls (median) | verify calls (median) | fps median | forbidden deps |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of Object.keys(ARMS))
    for (const p of PROMPTS) {
      const rs = rows.filter((r) => r.arm === arm && r.prompt === p && r.step === "build");
      if (!rs.length) continue;
      L.push(
        `| ${arm} | ${p} | ${rs.length} | ${sum(rs.map((r) => r.buildOk))}/${rs.length} | ${sum(rs.map((r) => r.bootOk))}/${rs.length} | ${fmt(median(rs.map((r) => r.autoScoreRate)))} | ${fmt(median(rs.map((r) => r.costUsd)))} | ${fmt(median(rs.map((r) => (typeof r.wallSec === "number" ? r.wallSec / 60 : ""))), 1)} | ${fmt(median(rs.map((r) => r.toolCalls)), 0)} | ${fmt(median(rs.map((r) => r.verifyCalls)), 0)} | ${fmt(median(rs.map((r) => r.fpsMedian)), 1)} | ${rs.filter((r) => r.forbiddenDeps).length} |`,
      );
    }
  L.push("", "## Follow-ups", "", "| arm | prompt | step | runs | new-requirement scores | regressions (median) | cost $ (median) |", "|---|---|---|---|---|---|---|");
  for (const arm of Object.keys(ARMS))
    for (const p of PROMPTS)
      for (const f of FOLLOWUPS) {
        const rs = rows.filter((r) => r.arm === arm && r.prompt === p && r.step === f);
        if (!rs.length) continue;
        L.push(`| ${arm} | ${p} | ${f} | ${rs.length} | ${rs.map((r) => r.followupScore || "–").join(", ")} | ${fmt(median(rs.map((r) => r.regressions)), 0)} | ${fmt(median(rs.map((r) => r.costUsd)))} |`);
      }
  if (diag.length) {
    L.push("", "## Diagnostic runs (not in the arm tables)", "", "| run | step | build ok | boot ok | auto score rate | verify calls | cost $ |", "|---|---|---|---|---|---|---|");
    for (const r of diag) L.push(`| ${r.run} | ${r.step} | ${r.buildOk} | ${r.bootOk} | ${fmt(r.autoScoreRate)} | ${r.verifyCalls} | ${fmt(r.costUsd)} |`);
  }
  const perRun = [...Map.groupBy(rows, (r) => r.run).values()].map((rs) => ({ cost: sum(rs.map((r) => r.costUsd)), wall: sum(rs.map((r) => r.wallSec)) }));
  if (perRun.length) {
    const meanCost = sum(perRun.map((r) => r.cost)) / perRun.length;
    const meanWall = sum(perRun.map((r) => r.wall)) / perRun.length;
    const mainRuns = Object.keys(ARMS).length * PROMPTS.length * mainN;
    L.push(
      "",
      "## Cost",
      "",
      `Pilot: ${perRun.length} scored runs, total $${fmt(sum(perRun.map((r) => r.cost)))}, mean $${fmt(meanCost)} and ${fmt(meanWall / 60, 1)} min per run (first build + follow-ups).`,
      ...(diag.length ? [`Diagnostic runs: $${fmt(sum(diag.map((r) => r.costUsd)))} on top.`] : []),
      `Main run at N=${mainN}: ${mainRuns} runs ≈ $${fmt(meanCost * mainRuns, 0)} and ≈ ${fmt((meanWall * mainRuns) / 3600, 1)} h sequential.`,
    );
  }
  return L.join("\n") + "\n";
}

function main() {
  const mainN = Number(process.argv.includes("--main-n") ? process.argv[process.argv.indexOf("--main-n") + 1] : 8);
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  const sched = readJson(path.join(RUNS_DIR, "schedule.json"));
  for (const r of sched?.runs ?? []) {
    const meta = readJson(path.join(RUNS_DIR, r.id, "meta.json"));
    if (!meta) continue;
    for (const step of ["build", ...FOLLOWUPS]) {
      if (!meta.steps.some((s) => s.step === step)) continue;
      rows.push(rowFor(meta, step, readJson(path.join(RUNS_DIR, r.id, "eval", step, "result.json"))));
    }
  }
  regressions(rows);
  const baseline = [];
  const bdir = path.join(EVAL_DIR, "baseline");
  if (fs.existsSync(bdir))
    for (const d of fs.readdirSync(bdir)) {
      const ev = readJson(path.join(bdir, d, "result.json"));
      if (!ev) continue;
      const auto = Object.values(ev.requirements ?? {}).filter((x) => typeof x.score === "number");
      baseline.push({ seed: d.replace(/-P\d$/, ""), prompt: ev.prompt, build: ev.build?.ok ? "ok" : "fail", boot: ev.boot?.ok ? "ok" : "fail", score: `${sum(auto.map((x) => x.score))}/${auto.length}`, fps: ev.perf?.fpsMedian ?? null });
    }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
  fs.writeFileSync(path.join(OUT, "runs.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "summary.md"), summary(rows, baseline, mainN));
  console.log(`wrote ${path.relative(EVAL_DIR, OUT)}/runs.csv (${rows.length} rows) and summary.md`);
}

main();
