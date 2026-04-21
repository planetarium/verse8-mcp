import test from "node:test";
import assert from "node:assert/strict";

import {
  recordToolCall,
  drainSinceLastCheckpoint,
  peekAll,
  clearLog,
} from "../../dist/util/v8CallLog.js";

function base(overrides = {}) {
  return {
    name: "image_asset_generate",
    status: "completed",
    input: { prompt: "hi" },
    output: { ok: true },
    timestampMs: Date.now(),
    ...overrides,
  };
}

test("v8CallLog: record then drain returns the recorded entry (global bucket)", () => {
  clearLog();
  recordToolCall(base({ name: "a" }));
  const drained = drainSinceLastCheckpoint();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].name, "a");
});

test("v8CallLog: drain a second time returns [] (checkpoint advances watermark)", () => {
  clearLog();
  recordToolCall(base({ name: "a", timestampMs: 1 }));
  drainSinceLastCheckpoint();
  // Further record after drain is still visible on a later drain
  // (watermark advanced past ts=1 but new entries have higher ts).
  const drained2 = drainSinceLastCheckpoint();
  assert.deepEqual(drained2, []);
});

test("v8CallLog: per-project isolation — drain A does not return B's entries", () => {
  clearLog();
  const A = "/tmp/projA";
  const B = "/tmp/projB";
  recordToolCall(base({ name: "a1", projectDir: A, timestampMs: 10 }));
  recordToolCall(base({ name: "b1", projectDir: B, timestampMs: 20 }));
  const aDrain = drainSinceLastCheckpoint(A);
  assert.equal(aDrain.length, 1);
  assert.equal(aDrain[0].name, "a1");
  const bDrain = drainSinceLastCheckpoint(B);
  assert.equal(bDrain.length, 1);
  assert.equal(bDrain[0].name, "b1");
});

test("v8CallLog: capacity eviction — oldest entries dropped FIFO after > 200", () => {
  clearLog();
  const proj = "/tmp/cap";
  const cap = 200;
  for (let i = 0; i < cap + 25; i++) {
    recordToolCall(base({ name: `t${i}`, projectDir: proj, timestampMs: i + 1 }));
  }
  const peeked = peekAll(proj);
  assert.equal(peeked.length, cap);
  // First survivor should be t25 (t0..t24 evicted).
  assert.equal(peeked[0].name, "t25");
  assert.equal(peeked[peeked.length - 1].name, `t${cap + 24}`);
});

test("v8CallLog: drain returns entries in record order", () => {
  clearLog();
  const proj = "/tmp/order";
  recordToolCall(base({ name: "first", projectDir: proj, timestampMs: 100 }));
  recordToolCall(base({ name: "second", projectDir: proj, timestampMs: 101 }));
  recordToolCall(base({ name: "third", projectDir: proj, timestampMs: 102 }));
  const drained = drainSinceLastCheckpoint(proj);
  assert.equal(drained.length, 3);
  assert.equal(drained[0].name, "first");
  assert.equal(drained[1].name, "second");
  assert.equal(drained[2].name, "third");
});

test("v8CallLog: record for never-drained projectDir still works", () => {
  clearLog();
  const proj = "/tmp/never-drained";
  recordToolCall(base({ name: "x", projectDir: proj, timestampMs: 999 }));
  const peeked = peekAll(proj);
  assert.equal(peeked.length, 1);
  assert.equal(peeked[0].name, "x");
});

test("v8CallLog: interleaved record/drain preserves per-project isolation", () => {
  clearLog();
  const A = "/tmp/intA";
  const B = "/tmp/intB";
  recordToolCall(base({ name: "a1", projectDir: A, timestampMs: 10 }));
  recordToolCall(base({ name: "b1", projectDir: B, timestampMs: 20 }));
  recordToolCall(base({ name: "a2", projectDir: A, timestampMs: 30 }));
  recordToolCall(base({ name: "b2", projectDir: B, timestampMs: 40 }));
  const aDrain = drainSinceLastCheckpoint(A);
  const bDrain = drainSinceLastCheckpoint(B);
  assert.deepEqual(
    aDrain.map((e) => e.name),
    ["a1", "a2"],
  );
  assert.deepEqual(
    bDrain.map((e) => e.name),
    ["b1", "b2"],
  );
});

test("v8CallLog: peekAll returns an array-level defensive copy (push on result does not affect bucket)", () => {
  clearLog();
  const proj = "/tmp/defense";
  recordToolCall(base({ name: "orig", projectDir: proj, timestampMs: 50 }));
  const snap = peekAll(proj);
  snap.push({ name: "forged", status: "completed", timestampMs: 51 });
  const real = peekAll(proj);
  assert.equal(real.length, 1);
  assert.equal(real[0].name, "orig");
});

test("v8CallLog: clearLog drops every bucket", () => {
  recordToolCall(base({ name: "a", projectDir: "/tmp/c1", timestampMs: 1 }));
  recordToolCall(base({ name: "b", projectDir: "/tmp/c2", timestampMs: 2 }));
  clearLog();
  assert.deepEqual(peekAll("/tmp/c1"), []);
  assert.deepEqual(peekAll("/tmp/c2"), []);
});
