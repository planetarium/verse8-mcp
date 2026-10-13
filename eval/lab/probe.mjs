// Usage: node eval/lab/probe.mjs <distDir> [browser=chromium|firefox|webkit] [gpu=metal|swiftshader] scene...
// Prints one line per scene: GL error count, draw calls, screen variance/flat.
import { chromium, firefox, webkit } from "playwright";
import { serveStatic, screenStats, sleep } from "../evaluator/lib.mjs";
import * as path from "node:path";
const [dist, bname = "chromium", gpu = "metal", ...scenes] = process.argv.slice(2);
const args = bname === "chromium" && gpu === "metal" ? ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"] : [];
const browser = await { chromium, firefox, webkit }[bname].launch({ args });
const srv = await serveStatic(path.resolve(dist));
const rows = [];
for (const s of scenes) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  let glErr = 0, firstErr = "";
  page.on("console", (m) => { const t = m.text(); if (/INVALID|WebGL: |GL_/.test(t)) { glErr++; firstErr ||= t.slice(0, 140); } });
  page.on("pageerror", (e) => { glErr++; firstErr ||= "pageerror " + e.message.slice(0, 120); });
  await page.goto(`${srv.url}?s=${s}`);
  await page.waitForFunction(() => window.labReady || window.labError, null, { timeout: 30000 }).catch(() => {});
  await sleep(2500);
  const info = await page.evaluate(() => {
    if (window.labError) return { err: window.labError };
    const r = window.game?.renderer?.webgl;
    return { calls: r?.info?.render?.calls, tris: r?.info?.render?.triangles, shadowType: r?.shadowMap?.type, shadowOn: r?.shadowMap?.enabled };
  });
  const st = screenStats(await page.screenshot());
  rows.push({ scene: s, glErr, var: Math.round(st.variance), flat: +st.flat.toFixed(2), ...info, firstErr });
  await page.close();
}
console.table(rows.map(({ firstErr, ...r }) => r));
const e = rows.find((r) => r.firstErr); if (e) console.log("first error:", e.firstErr);
srv.close(); await browser.close();
