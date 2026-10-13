// Usage: node eval/lab/hook.mjs <distDir> <scene>
// Records who writes the Sun's shadow.map / shadow.mapSize for 0.5 s, with
// stacks — shows the per-frame tug of war between DirectionalLight3D and
// Environment3D.applySunLight.
import * as path from "node:path";
import { chromium } from "playwright";
import { serveStatic, sleep } from "../evaluator/lib.mjs";
const srv = await serveStatic(path.resolve(process.argv[2]));
const b = await chromium.launch({ args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"] });
const p = await b.newPage();
await p.goto(`${srv.url}?s=${process.argv[3]}`);
await p.waitForFunction(() => window.labReady || window.labError);
console.log(JSON.stringify(await p.evaluate(async () => {
  const r = game.renderer, log = [];
  let L; r.threeScene.traverse((o) => { if (o.isDirectionalLight) L = o; });
  const sh = L.shadow, before = { map: !!sh.map, mapSize: [sh.mapSize.x, sh.mapSize.y], auto: sh.autoUpdate, need: sh.needsUpdate, glAuto: r.webgl.shadowMap.autoUpdate, glEn: r.webgl.shadowMap.enabled };
  let m = sh.map;
  const st = () => new Error().stack.split("\n").slice(2, 6).map((s) => s.trim().replace(/https?:\/\/[^/]+\//, "")).join(" < ");
  Object.defineProperty(sh, "map", { get: () => m, set: (v) => { log.push(`map=${v ? v.width : null} @ ${st()}`); m = v; }, configurable: true });
  const set0 = sh.mapSize.set.bind(sh.mapSize);
  sh.mapSize.set = (x, y) => { if (x !== sh.mapSize.x) log.push(`mapSize ${sh.mapSize.x}->${x} @ ${st()}`); return set0(x, y); };
  await new Promise((res) => setTimeout(res, 500));
  return { before, log: [...new Set(log)].slice(0, 8), n: log.length };
}), null, 1));
srv.close(); await b.close();
