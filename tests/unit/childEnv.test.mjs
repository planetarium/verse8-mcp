import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeChildEnv } from "../../dist/util/childEnv.js";

test("childEnv: VERSE8_ACCESS_TOKEN stripped", () => {
  const out = sanitizeChildEnv({ VERSE8_ACCESS_TOKEN: "secret", PATH: "/bin" });
  assert.equal(out.VERSE8_ACCESS_TOKEN, undefined);
  assert.equal(out.PATH, "/bin");
});

test("childEnv: every VERSE8_*_MCP_URL stripped", () => {
  const out = sanitizeChildEnv({
    VERSE8_IMAGE_MCP_URL: "https://attacker/mcp",
    VERSE8_AUDIO_MCP_URL: "https://other/mcp",
    VERSE8_VECTORSEARCH_MCP_URL: "https://x/mcp",
    PATH: "/bin",
  });
  assert.equal(out.VERSE8_IMAGE_MCP_URL, undefined);
  assert.equal(out.VERSE8_AUDIO_MCP_URL, undefined);
  assert.equal(out.VERSE8_VECTORSEARCH_MCP_URL, undefined);
  assert.equal(out.PATH, "/bin");
});

test("childEnv: VERSE8_API_URL / VERSE8_AGENT8_BACKEND_URL / VERSE8_CREATE_URL stripped", () => {
  const out = sanitizeChildEnv({
    VERSE8_API_URL: "https://attacker.api/",
    VERSE8_AGENT8_BACKEND_URL: "https://attacker.backend/",
    VERSE8_CREATE_URL: "https://attacker.create/",
    HOME: "/home/u",
  });
  assert.equal(out.VERSE8_API_URL, undefined);
  assert.equal(out.VERSE8_AGENT8_BACKEND_URL, undefined);
  assert.equal(out.VERSE8_CREATE_URL, undefined);
  assert.equal(out.HOME, "/home/u");
});

test("childEnv: unrelated VERSE8_* keys are preserved", () => {
  // E.g. VERSE8_MCP_PROXIES is a config flag, not a URL — child should see it.
  const out = sanitizeChildEnv({
    VERSE8_MCP_PROXIES: "image,audio",
    VERSE8_ALLOW_NONCOMPLIANT: "1",
    PATH: "/bin",
  });
  assert.equal(out.VERSE8_MCP_PROXIES, "image,audio");
  assert.equal(out.VERSE8_ALLOW_NONCOMPLIANT, "1");
  assert.equal(out.PATH, "/bin");
});

test("childEnv: input is not mutated", () => {
  const input = {
    VERSE8_ACCESS_TOKEN: "secret",
    VERSE8_IMAGE_MCP_URL: "https://x/mcp",
    PATH: "/bin",
  };
  const snapshot = { ...input };
  sanitizeChildEnv(input);
  assert.deepEqual(input, snapshot, "input env was mutated");
});

test("childEnv: defaults to process.env", () => {
  const orig = process.env.VERSE8_ACCESS_TOKEN;
  process.env.VERSE8_ACCESS_TOKEN = "leak";
  try {
    const out = sanitizeChildEnv();
    assert.equal(out.VERSE8_ACCESS_TOKEN, undefined);
  } finally {
    if (orig === undefined) delete process.env.VERSE8_ACCESS_TOKEN;
    else process.env.VERSE8_ACCESS_TOKEN = orig;
  }
});
