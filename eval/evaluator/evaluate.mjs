#!/usr/bin/env node
// Evaluator: production build → static serve → Playwright probes, perf
// instrumentation, monkey test, video and screenshots → result.json.
//
//   node eval/evaluator/evaluate.mjs --run <runId> [--tags build,F1,F2,F3]
//   node eval/evaluator/evaluate.mjs --seed <seedId> --prompt P1|P2   (starting-point score)
//   node eval/evaluator/evaluate.mjs --dist <dir> --prompt P1|P2 [--query broken=1] --out <dir>
//       (serve a prebuilt directory as is — used with evaluator/fixtures to check the probes)
// Options: --perf-sec 60  --monkey-sec 300  --headed  --out <dir>
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createRequire } from "node:module";
import { EVAL_DIR, FOLLOWUPS, RUNS_DIR, SEEDS, SEEDS_DIR } from "../config.mjs";
import { callQa, clickText, isVec, mulberry32, qa, screenStats, serveStatic, sleep, waitQa } from "./lib.mjs";
import { probeP1, probeP1Followups } from "./probes-p1.mjs";
import { probeP2, probeP2Followups } from "./probes-p2.mjs";

const require = createRequire(path.join(EVAL_DIR, "package.json"));
const { chromium } = require("playwright");

const VIEWPORT = { width: 1280, height: 720 };
// Canvas-only luma variance (DOM hidden) at or below this is one uniform clear
// colour. A quarter-view floor with one small character measures ~11.
const BLANK_VARIANCE = 1;
const INSTRUMENT = fs.readFileSync(path.join(EVAL_DIR, "evaluator", "instrument.js"), "utf8");
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });

function prepareWorkdir(source, ref, wd) {
  fs.rmSync(wd, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", source, wd]);
  execFileSync("git", ["-c", "advice.detachedHead=false", "checkout", "-q", ref], { cwd: wd });
  for (const f of [".env"]) if (fs.existsSync(path.join(source, f))) fs.copyFileSync(path.join(source, f), path.join(wd, f));
  if (fs.existsSync(path.join(source, "node_modules"))) execFileSync("cp", ["-cR", path.join(source, "node_modules"), path.join(wd, "node_modules")]);
  let r = run("bun", ["install", "--frozen-lockfile"], wd);
  const install = { frozen: r.status === 0 };
  if (r.status !== 0) {
    r = run("bun", ["install"], wd);
    install.fallback = r.status === 0;
    install.log = (r.stderr || "").slice(-1500);
  }
  return install;
}

function tscErrors(wd) {
  const app = path.join(wd, "tsconfig.app.json");
  const cfg = fs.existsSync(app) ? app : path.join(wd, "tsconfig.json");
  const r = run("bunx", ["tsc", "--noEmit", "-p", cfg], wd);
  return { config: path.basename(cfg), errors: ((r.stdout || "") + (r.stderr || "")).match(/error TS\d+/g)?.length ?? 0, exit: r.status };
}

function build(wd) {
  const t0 = Date.now();
  const r = run("bunx", ["vite", "build", "--base", "./", "--outDir", "dist-eval", "--emptyOutDir"], wd);
  return { ok: r.status === 0, exit: r.status, sec: (Date.now() - t0) / 1000, log: ((r.stdout || "") + (r.stderr || "")).slice(-3000) };
}

// Blind the build: neutral title, no favicon. Reports what it found.
function neutralize(distDir) {
  const f = path.join(distDir, "index.html");
  let html = fs.readFileSync(f, "utf8");
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1] ?? null;
  // Attribute values may contain ">" (inline SVG data URIs), so match quoted
  // strings as units.
  const icons = (html.match(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []).filter((t) => /rel\s*=\s*["'][^"']*icon/i.test(t));
  for (const t of icons) html = html.replace(t, "");
  html = html.replace(/<title>.*?<\/title>/s, "<title>Game</title>");
  fs.writeFileSync(f, html);
  return { originalTitle: title, faviconsRemoved: icons.length };
}

function bundleSizes(distDir) {
  const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
  const initial = new Set([...html.matchAll(/(?:src|href)=["']\.?\/?([^"']+\.js)["']/g)].map((m) => m[1]));
  let initialGz = 0, totalGz = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        const gz = zlib.gzipSync(fs.readFileSync(p)).length;
        totalGz += gz;
        files++;
        if (initial.has(path.relative(distDir, p))) initialGz += gz;
      }
    }
  };
  walk(distDir);
  return { initialJsGzip: initialGz, totalJsGzip: totalGz, lazyJsGzip: totalGz - initialGz, jsFiles: files };
}

async function openPage(browser, url, opts = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, ...opts });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  const log = { consoleErrors: [], pageErrors: [], webglWarnings: 0, engineMentions: 0 };
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error") log.consoleErrors.push(text.slice(0, 300));
    if (/webgl|GL_|GPU stall/i.test(text) && m.type() === "warning") log.webglWarnings++;
    if (/incanto|vibe-starter|react-three/i.test(text)) log.engineMentions++;
  });
  page.on("pageerror", (e) => log.pageErrors.push(String(e).slice(0, 300)));
  await page.goto(url, { waitUntil: "load", timeout: 60000 }).catch((e) => log.pageErrors.push(`goto: ${e}`));
  return { context, page, log };
}

// Booted = a canvas covering most of the viewport whose pixels are not one
// flat colour (a blank or loading-only screen fails).
async function bootCheck(page) {
  const t0 = Date.now();
  let last = { variance: 0, flat: 1, canvas: null };
  while (Date.now() - t0 < 10000) {
    const box = await page
      .evaluate(() => {
        const c = [...document.querySelectorAll("canvas")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .catch(() => null);
    if (box && box.width * box.height >= 0.5 * VIEWPORT.width * VIEWPORT.height) {
      // Judge the canvas alone: DOM overlays (touch buttons, HUD, loaders) on a
      // background-only canvas otherwise look like a sparse but drawn scene.
      const style = await page.addStyleTag({ content: "body * { visibility: hidden !important; } canvas { visibility: visible !important; }" }).catch(() => null);
      const s = screenStats(await page.screenshot({ clip: box }));
      await style?.evaluate((el) => el.remove()).catch(() => {});
      last = { ...s, canvas: box };
      if (s.variance > BLANK_VARIANCE) return { ok: true, firstNonBlankMs: Date.now() - t0, ...last };
    } else last.canvas = box;
    await sleep(500);
  }
  return { ok: false, firstNonBlankMs: null, ...last };
}

async function startPlaying(page) {
  await waitQa(page, () => true, 20000);
  await clickText(page, /^\s*(시작|start|play)\s*$/i);
  const t0 = Date.now();
  const r = await waitQa(page, (q) => q.state === "playing", 5000);
  return { ...r, titleToPlayMs: r.ok ? Date.now() - t0 : null };
}

async function perfScenario(page, prompt, sec) {
  const s = await startPlaying(page);
  if (prompt === "P2") {
    await callQa(page, "setInvincible", true);
    await callQa(page, "skipToWave", 5);
    await sleep(3000);
  }
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2).catch(() => {});
  await page.evaluate(() => window.__eval.start());
  const rand = mulberry32(7);
  const end = Date.now() + sec * 1000;
  const keys = ["w", "a", "s", "d"];
  if (prompt === "P2") await page.mouse.down();
  while (Date.now() < end) {
    const k = keys[Math.floor(rand() * 4)];
    await page.keyboard.down(k);
    if (prompt === "P1" && rand() < 0.3) await page.keyboard.press("Space");
    await page.mouse.move(VIEWPORT.width * (0.3 + rand() * 0.4), VIEWPORT.height * (0.3 + rand() * 0.4), { steps: 3 });
    await sleep(500);
    await page.keyboard.up(k);
  }
  if (prompt === "P2") await page.mouse.up();
  const stats = await page.evaluate(() => window.__eval.stop());
  return { started: s.ok, titleToPlayMs: s.titleToPlayMs, ...stats };
}

const VALID_STATES = new Set(["title", "playing", "won", "lost"]);

async function monkey(page, sec, log) {
  await startPlaying(page);
  const rand = mulberry32(42);
  const keys = ["w", "a", "s", "d", "ArrowUp", "ArrowLeft", "Space", "Shift", "e", "Escape"];
  const errors0 = log.pageErrors.length;
  let invalidState = 0, outOfWorld = 0, samples = 0, keyStuck = false;
  const end = Date.now() + sec * 1000;
  let lastCheck = 0;
  while (Date.now() < end) {
    const r = rand();
    if (r < 0.5) await page.keyboard.press(keys[Math.floor(rand() * keys.length)], { delay: Math.floor(rand() * 400) });
    else if (r < 0.8) await page.mouse.move(rand() * VIEWPORT.width, rand() * VIEWPORT.height, { steps: 4 });
    else if (r < 0.95) await page.mouse.click(rand() * VIEWPORT.width, rand() * VIEWPORT.height);
    else {
      // Focus loss and resize mid-input: keys must not stay held.
      await page.keyboard.down("w");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.keyboard.up("w");
      await page.setViewportSize({ width: 900 + Math.floor(rand() * 400), height: 600 + Math.floor(rand() * 200) });
    }
    if (Date.now() - lastCheck > 250) {
      lastCheck = Date.now();
      const q = await qa(page).catch(() => null);
      if (q) {
        samples++;
        if (!VALID_STATES.has(q.state)) invalidState++;
        const p = q.player;
        if (!isVec(p) || [p.x, p.y, p.z].some((v) => !Number.isFinite(v) || Math.abs(v) > 1000)) outOfWorld++;
        // A state other than playing ends the round; restart to keep pressure on.
        if (q.state === "won" || q.state === "lost") await clickText(page, /다시\s*하기|retry|restart|play again/i);
        if (q.state === "title") await clickText(page, /^\s*(시작|start|play)\s*$/i);
      }
    }
  }
  await page.setViewportSize(VIEWPORT);
  // Input stickiness: idle 1 s, the player should not drift.
  const a = await qa(page).catch(() => null);
  await sleep(1000);
  const b = await qa(page).catch(() => null);
  if (a?.state === "playing" && isVec(a.player) && isVec(b?.player)) keyStuck = Math.hypot(a.player.x - b.player.x, a.player.z - b.player.z) > 1;
  return { sec, exceptions: log.pageErrors.length - errors0, exceptionSamples: log.pageErrors.slice(errors0, errors0 + 5), invalidState, outOfWorld, samples, keyStuckAfter: keyStuck };
}

async function restartLeak(page, prompt) {
  if (prompt !== "P1") return { skipped: "P2 has no quick way to end a round" };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const m = await cdp.send("Performance.getMetrics");
    return m.metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? null;
  };
  const started = await startPlaying(page);
  if (!started.ok) return { skipped: "could not reach state playing through __qa" };
  const before = await heap();
  let ok = 0;
  let cycles = 0;
  for (let i = 0; i < 10; i++) {
    const q = await qa(page);
    if (!q?.goal) break;
    cycles++;
    await callQa(page, "teleport", q.goal.x, q.goal.y + 0.2, q.goal.z);
    if (!(await waitQa(page, (x) => x.state === "won", 3000)).ok) break;
    await clickText(page, /다시\s*하기|retry|restart|play again/i);
    let r = await waitQa(page, (x) => x.state === "playing" || x.state === "title", 3000);
    if (r.qa?.state === "title") r = await startPlaying(page);
    const fresh = r.qa && r.qa.coins === 0 && r.qa.lives === 3;
    if (fresh) ok++;
  }
  const after = await heap();
  return { cycles, cleanResets: ok, heapBefore: before, heapAfter: after, heapGrowth: before && after ? after - before : null };
}

async function evaluateTarget({ source, ref, prompt, step, outDir, opts, prebuilt }) {
  fs.mkdirSync(outDir, { recursive: true });
  const shotsDir = path.join(outDir, "shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  const wd = path.join(outDir, "work");
  const result = { source: path.relative(EVAL_DIR, prebuilt ?? source), ref, prompt, step, startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");

  let distDir;
  if (prebuilt) {
    distDir = path.resolve(prebuilt);
    result.build = { ok: true, skipped: "prebuilt" };
  } else {
    result.install = prepareWorkdir(source, ref, wd);
    result.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wd, encoding: "utf8" }).trim();
    const pkg = JSON.parse(fs.readFileSync(path.join(wd, "package.json"), "utf8"));
    result.deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /incanto|three|vibe-starter|rapier|drei|fiber/.test(d));
    result.tsc = tscErrors(wd);
    result.build = build(wd);
    if (!result.build.ok) {
      result.gate = { build: false };
      save();
      return result;
    }
    distDir = path.join(wd, "dist-eval");
    result.blind = neutralize(distDir);
    result.bundle = bundleSizes(distDir);
  }

  const served = await serveStatic(distDir);
  const server = { ...served, url: served.url + (opts.query ? `?${opts.query}` : "") };
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    // Main session (recorded): boot, requirement probes.
    const main = await openPage(browser, server.url, { recordVideo: { dir: path.join(outDir, "video"), size: VIEWPORT } });
    const ctx = {
      viewport: VIEWPORT,
      shot: async (name, p = main.page) => p.screenshot({ path: path.join(shotsDir, `${name}.png`) }).catch(() => {}),
      openMobile: async () => {
        try {
          const m = await openPage(browser, server.url, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
          const cdp = await m.context.newCDPSession(m.page);
          return { page: m.page, cdp, close: () => m.context.close() };
        } catch {
          return null;
        }
      },
    };
    result.boot = await bootCheck(main.page);
    result.gl = await main.page.evaluate(() => window.__eval.gl);
    result.documentTitle = await main.page.title();
    await ctx.shot("boot");
    result.gate = { build: true, boot: result.boot.ok };
    if (result.boot.ok) {
      try {
        // Every snapshot gets the full base probe set — reruns on F1..F3
        // are how regressions are counted.
        result.requirements = await (prompt === "P1" ? probeP1 : probeP2)(main.page, ctx);
      } catch (e) {
        result.probeError = String(e).slice(0, 500);
      }
    }
    result.console = main.log;
    await main.context.close();

    if (result.boot.ok && FOLLOWUPS.includes(step)) {
      const f = await openPage(browser, server.url);
      try {
        result.followup = await (prompt === "P1" ? probeP1Followups : probeP2Followups)(f.page, { ...ctx, shot: (n, p = f.page) => p.screenshot({ path: path.join(shotsDir, `${n}.png`) }).catch(() => {}) }, step);
      } catch (e) {
        result.followupError = String(e).slice(0, 500);
      }
      await f.context.close();
    }

    if (result.boot.ok) {
      const p = await openPage(browser, server.url);
      const software = /swiftshader|llvmpipe|software/i.test(result.gl?.renderer ?? "");
      try {
        const perf = await perfScenario(p.page, prompt, opts.perfSec);
        result.perf = { ...perf, gpuRenderer: result.gl?.renderer ?? null, fpsValid: !software };
        if (software) for (const k of ["fpsMedian", "fps1pctLow", "frameTimeP95"]) result.perf[k] = null;
      } catch (e) {
        result.perf = { error: String(e).slice(0, 300) };
      }
      try {
        result.restart = await restartLeak(p.page, prompt);
      } catch (e) {
        result.restart = { error: String(e).slice(0, 300) };
      }
      await p.context.close();

      const m = await openPage(browser, server.url);
      try {
        result.monkey = await monkey(m.page, opts.monkeySec, m.log);
      } catch (e) {
        result.monkey = { error: String(e).slice(0, 300) };
      }
      await m.context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (!opts.keepWork) fs.rmSync(wd, { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  save();
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const opts = {
    perfSec: Number(opt("--perf-sec", 60)),
    monkeySec: Number(opt("--monkey-sec", 300)),
    headed: argv.includes("--headed"),
    keepWork: argv.includes("--keep-work"),
    query: opt("--query", ""),
  };
  const targets = [];
  if (opt("--run")) {
    const id = opt("--run");
    const meta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, "meta.json"), "utf8"));
    const tags = opt("--tags", ["build", ...FOLLOWUPS].join(",")).split(",");
    const project = path.join(RUNS_DIR, id, "project");
    for (const tag of tags) {
      const exists = run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], project).status === 0;
      if (exists) targets.push({ source: project, ref: tag, prompt: meta.prompt, step: tag, outDir: path.join(opt("--out", path.join(RUNS_DIR, id, "eval")), tag) });
    }
  } else if (opt("--seed")) {
    const seed = opt("--seed");
    if (!SEEDS[seed]) throw new Error(`unknown seed ${seed}`);
    const prompt = opt("--prompt");
    if (!["P1", "P2"].includes(prompt)) throw new Error("--prompt P1|P2 required with --seed");
    targets.push({ source: path.join(SEEDS_DIR, seed), ref: "seed", prompt, step: "seed", outDir: opt("--out", path.join(EVAL_DIR, "baseline", `${seed}-${prompt}`)) });
  } else if (opt("--dist")) {
    const prompt = opt("--prompt");
    if (!["P1", "P2"].includes(prompt)) throw new Error("--prompt P1|P2 required with --dist");
    targets.push({ prebuilt: opt("--dist"), prompt, step: opt("--step", "build"), outDir: opt("--out", path.join(EVAL_DIR, ".cache", "dist-eval")) });
  } else {
    console.error("usage: evaluate.mjs --run <runId> [--tags build,F1] | --seed <seedId> --prompt P1|P2");
    process.exit(2);
  }
  for (const t of targets) {
    process.stderr.write(`evaluating ${path.relative(EVAL_DIR, t.outDir)}…\n`);
    const r = await evaluateTarget({ ...t, opts });
    const scored = Object.values(r.requirements ?? {}).filter((x) => typeof x.score === "number");
    process.stderr.write(
      `  build=${r.build?.ok} boot=${r.boot?.ok} auto-scored=${scored.length} sum=${scored.reduce((a, b) => a + b.score, 0)} gl=${r.gl?.renderer ?? "-"}\n`,
    );
  }
}

await main();
