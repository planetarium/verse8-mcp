// Helpers shared by the probes: static server, screenshot analysis, input,
// and the score record format.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as zlib from "node:zlib";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".hdr": "application/octet-stream",
};

export function serveStatic(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.join(root, url);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })),
  );
}

// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced — what Chromium writes).
export function decodePng(buf) {
  let pos = 8;
  let width, height, colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}

/**
 * Luma variance of a screenshot and the share of pixels in its most common
 * luma bucket — a blank screen has low variance or one dominant bucket.
 */
export function screenStats(pngBuf) {
  const { width, height, bpp, data } = decodePng(pngBuf);
  const hist = new Array(32).fill(0);
  let n = 0, sum = 0, sq = 0;
  for (let y = 0; y < height; y += 4)
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * bpp;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
      sum += l;
      sq += l * l;
      hist[Math.min(31, Math.floor(l / 8))]++;
    }
  const mean = sum / n;
  return { variance: sq / n - mean * mean, flat: Math.max(...hist) / n };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function qa(page) {
  return page.evaluate(() => {
    const q = window.__qa;
    if (!q || typeof q !== "object") return null;
    // Copy plain data only; functions are reported as "fn".
    const plain = (v, d = 0) => {
      if (typeof v === "function") return "fn";
      if (v === null || typeof v !== "object" || d > 3) return v;
      if (Array.isArray(v)) return v.slice(0, 200).map((x) => plain(x, d + 1));
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x, d + 1)]));
    };
    return plain(q);
  });
}

export async function waitQa(page, pred, timeoutMs = 5000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await qa(page).catch(() => null);
    if (last && pred(last)) return { ok: true, qa: last };
    await sleep(stepMs);
  }
  return { ok: false, qa: last };
}

export const callQa = (page, fn, ...args) =>
  page.evaluate(([fn, args]) => {
    const f = window.__qa && window.__qa[fn];
    if (typeof f !== "function") return { ok: false, error: `__qa.${fn} missing` };
    try {
      f.apply(window.__qa, args);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, [fn, args]);

/** Click the first visible element whose text matches — button first. */
export async function clickText(page, re) {
  for (const loc of [page.getByRole("button", { name: re }), page.getByText(re)]) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

export async function visibleText(page, re) {
  const loc = page.getByText(re);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
  return false;
}

export async function hold(page, key, ms) {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

export const dist = (a, b) => (a && b ? Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0)) : NaN);
export const distXZ = (a, b) => (a && b ? Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0)) : NaN);
export const isVec = (v) => v && typeof v === "object" && ["x", "y", "z"].every((k) => typeof v[k] === "number");

/** Score record: 0 / 0.5 / 1, or null when the probe could not decide. */
export const score = (value, method, detail = {}) => ({ score: value, method, ...detail });
export const manual = (why) => ({ score: null, method: "vision/manual", note: why });

/** Touch drag through CDP — Playwright's touchscreen only taps. */
export async function touchDrag(page, cdp, from, to, ms = 800, steps = 16) {
  const pt = (p) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(from) });
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(p) });
    await sleep(ms / steps);
  }
  await sleep(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
