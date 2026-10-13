#!/usr/bin/env node
// Generates the shared local asset files every seed gets (sound effects and a
// sky panorama). The CDN has no SFX or skybox, and the asset-generation proxy
// is off for the eval, so these are synthesized deterministically: running
// this twice yields byte-identical files.
//
// Usage: node eval/assets/make-assets.mjs <outDir>
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const RATE = 22050;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Deterministic noise (mulberry32) so the files never change between runs.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synth(durSec, fn) {
  const n = Math.floor(durSec * RATE);
  const out = new Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const { freq = 0, amp = 0, noise = 0 } = fn(t, t / durSec);
    phase += (2 * Math.PI * freq) / RATE;
    out[i] = amp * Math.sin(phase) + noise;
  }
  return out;
}

const SOUNDS = {
  jump: () => synth(0.18, (t, u) => ({ freq: 300 + 500 * u, amp: 0.5 * (1 - u) })),
  land: () => {
    const r = rng(1);
    return synth(0.12, (t, u) => ({ freq: 90, amp: 0.5 * (1 - u), noise: (r() - 0.5) * 0.4 * (1 - u) }));
  },
  coin: () => synth(0.25, (t, u) => ({ freq: u < 0.35 ? 988 : 1319, amp: 0.4 * (1 - u) })),
  shoot: () => {
    const r = rng(2);
    return synth(0.1, (t, u) => ({ freq: 800 - 600 * u, amp: 0.3 * (1 - u), noise: (r() - 0.5) * 0.3 * (1 - u) }));
  },
  hit: () => {
    const r = rng(3);
    return synth(0.15, (t, u) => ({ freq: 160, amp: 0.4 * (1 - u), noise: (r() - 0.5) * 0.5 * (1 - u) }));
  },
  explode: () => {
    const r = rng(4);
    return synth(0.5, (t, u) => ({ noise: (r() - 0.5) * 0.9 * Math.pow(1 - u, 2) }));
  },
};

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x / (width - 1), y / (height - 1));
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Equirectangular sky: zenith blue → horizon haze → dim ground.
function sky(u, v) {
  const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  if (v < 0.5) return lerp([64, 120, 200], [190, 215, 240], Math.pow(v / 0.5, 1.5));
  return lerp([170, 180, 190], [70, 80, 90], (v - 0.5) / 0.5);
}

export function makeAssets(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, gen] of Object.entries(SOUNDS)) fs.writeFileSync(path.join(outDir, `${name}.wav`), wav(gen()));
  fs.writeFileSync(path.join(outDir, "sky.png"), png(1024, 512, sky));
  return [...Object.keys(SOUNDS).map((n) => `${n}.wav`), "sky.png"];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: make-assets.mjs <outDir>");
    process.exit(2);
  }
  console.log(makeAssets(out).join("\n"));
}
