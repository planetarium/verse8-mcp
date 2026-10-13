// Usage: node eval/lab/probe-app.mjs <browser> <distDir>...  — boots an unmodified game build.
import { chromium, firefox, webkit } from "playwright";
import { serveStatic, screenStats, sleep } from "../evaluator/lib.mjs";
import * as path from "node:path";
const [bname, ...dists] = process.argv.slice(2);
const args = bname === "chromium" ? ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"] : [];
const browser = await { chromium, firefox, webkit }[bname].launch({ args });
for (const d of dists) {
  const srv = await serveStatic(path.resolve(d));
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  let gl = 0, pe = [];
  page.on("console", (m) => { if (/INVALID|WebGL: |GL_|texture format/i.test(m.text())) gl++; });
  page.on("pageerror", (e) => pe.push(e.message.slice(0, 80)));
  await page.goto(srv.url); await sleep(8000);
  const st = screenStats(await page.screenshot({ path: `/tmp/lab-${bname}-${path.basename(path.dirname(path.resolve(d)))}.png` }));
  console.log(`${bname.padEnd(8)} ${path.basename(path.dirname(path.resolve(d))).padEnd(24)} glErr=${gl} var=${Math.round(st.variance)} flat=${st.flat.toFixed(2)} pageErr=${pe.length ? pe[0] : 0}`);
  await page.close(); srv.close();
}
await browser.close();
