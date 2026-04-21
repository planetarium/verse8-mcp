import test from "node:test";
import assert from "node:assert/strict";

import {
  runNewProjectStart,
  _resetNewProjectStateForTests,
} from "../../dist/tools/newProject.js";

// US-M2-4 — process-local rolling-window rate-limit (5 calls / 60s).
// Tests use a 200ms window via VERSE8_RATE_WINDOW_MS so the slide is fast.
//
// We point VERSE8_AGENT8_BACKEND_URL at a deliberately unreachable port so
// network attempts fail fast without external state. The rate-limit gate
// runs BEFORE any HTTP call, so the first 5 attempts increment the counter
// (even though their network call returns startcall_failed) and the 6th
// short-circuits with rate_limited.

const SHORT_WINDOW_MS = 200;

function withRateLimitEnv(fn) {
  const orig = {
    token: process.env.VERSE8_ACCESS_TOKEN,
    backend: process.env.VERSE8_AGENT8_BACKEND_URL,
    window: process.env.VERSE8_RATE_WINDOW_MS,
  };
  process.env.VERSE8_ACCESS_TOKEN = "fake-test-token";
  // Unreachable loopback port — passes the verse8.io host-allow-list.
  process.env.VERSE8_AGENT8_BACKEND_URL = "http://127.0.0.1:39523";
  process.env.VERSE8_RATE_WINDOW_MS = String(SHORT_WINDOW_MS);
  return Promise.resolve(fn()).finally(() => {
    if (orig.token === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = orig.token;
    if (orig.backend === undefined) delete process.env.VERSE8_AGENT8_BACKEND_URL;
    else process.env.VERSE8_AGENT8_BACKEND_URL = orig.backend;
    if (orig.window === undefined) delete process.env.VERSE8_RATE_WINDOW_MS;
    else process.env.VERSE8_RATE_WINDOW_MS = orig.window;
  });
}

test("rate-limit: under-limit calls reach the network (5 in a row are NOT rate_limited)", async () => {
  await withRateLimitEnv(async () => {
    _resetNewProjectStateForTests();
    for (let i = 0; i < 5; i++) {
      const r = await runNewProjectStart({ userRequest: `req-${i}` });
      assert.notEqual(r.error, "rate_limited", `call ${i + 1} pre-cap should not be rate_limited`);
    }
  });
});

test("rate-limit: 6th call within window returns rate_limited with retryAfterMs", async () => {
  await withRateLimitEnv(async () => {
    _resetNewProjectStateForTests();
    for (let i = 0; i < 5; i++) {
      await runNewProjectStart({ userRequest: `req-${i}` });
    }
    const r6 = await runNewProjectStart({ userRequest: "req-6" });
    assert.equal(r6.ok, false);
    assert.equal(r6.error, "rate_limited");
    assert.match(r6.hint, /rate limit/i);
    assert.match(r6.hint, /process-local|restart/i);
    assert.equal(typeof r6.retryAfterMs, "number");
    assert.ok(r6.retryAfterMs > 0 && r6.retryAfterMs <= SHORT_WINDOW_MS);
  });
});

test("rate-limit: window slide restores capacity", async () => {
  await withRateLimitEnv(async () => {
    _resetNewProjectStateForTests();
    for (let i = 0; i < 5; i++) {
      await runNewProjectStart({ userRequest: `req-${i}` });
    }
    // Confirm we're capped.
    const capped = await runNewProjectStart({ userRequest: "capped" });
    assert.equal(capped.error, "rate_limited");
    // Wait for the window to slide; add a small buffer.
    await new Promise((r) => setTimeout(r, SHORT_WINDOW_MS + 50));
    const restored = await runNewProjectStart({ userRequest: "after-slide" });
    assert.notEqual(restored.error, "rate_limited", "post-slide call should be admitted");
  });
});

test("rate-limit: _resetNewProjectStateForTests clears the rolling window", async () => {
  await withRateLimitEnv(async () => {
    _resetNewProjectStateForTests();
    for (let i = 0; i < 5; i++) {
      await runNewProjectStart({ userRequest: `req-${i}` });
    }
    const capped = await runNewProjectStart({ userRequest: "capped" });
    assert.equal(capped.error, "rate_limited");
    _resetNewProjectStateForTests();
    const r = await runNewProjectStart({ userRequest: "post-reset" });
    assert.notEqual(r.error, "rate_limited", "post-reset call should be admitted");
  });
});
