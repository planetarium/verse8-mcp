// Unit tests for the agent8-backend client.
//
// Covers:
//   - VERSE8_AGENT8_BACKEND_URL host allow-list (rejects non-verse8 hosts)
//   - parseCloneCommand for the 3 expected backend shapes + passthrough flags
//     + oauth token handling + slug derivation from URL
//
// Runs against dist/ so the published compile output is what's tested.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getAgent8BackendBaseUrl,
  parseCloneCommand,
  tolerantJsonParse,
} from "../../dist/api/agent8Backend.js";
import { pickString } from "../../dist/tools/newProject.js";

const ENV_KEY = "VERSE8_AGENT8_BACKEND_URL";

function withEnv(value, fn) {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

test("getAgent8BackendBaseUrl: unset → default", () => {
  withEnv(undefined, () => {
    assert.equal(getAgent8BackendBaseUrl(), "https://agent8-backend.verse8.io");
  });
});

test("getAgent8BackendBaseUrl: *.verse8.io override accepted", () => {
  withEnv("https://staging.verse8.io", () => {
    assert.equal(getAgent8BackendBaseUrl(), "https://staging.verse8.io");
  });
});

test("getAgent8BackendBaseUrl: localhost override accepted", () => {
  withEnv("http://127.0.0.1:9090", () => {
    assert.equal(getAgent8BackendBaseUrl(), "http://127.0.0.1:9090");
  });
});

test("getAgent8BackendBaseUrl: evil.example.com override REJECTED → default", () => {
  const originalError = console.error;
  console.error = () => {}; // silence the expected stderr warning
  try {
    withEnv("https://evil.example.com", () => {
      assert.equal(
        getAgent8BackendBaseUrl(),
        "https://agent8-backend.verse8.io",
      );
    });
  } finally {
    console.error = originalError;
  }
});

test("getAgent8BackendBaseUrl: malformed URL → default", () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    withEnv("not a url", () => {
      assert.equal(
        getAgent8BackendBaseUrl(),
        "https://agent8-backend.verse8.io",
      );
    });
  } finally {
    console.error = originalError;
  }
});

test("parseCloneCommand: short -b flag with oauth URL", () => {
  const parsed = parseCloneCommand(
    "git clone -b develop https://oauth2:glpat-XXX@gitlab.verse8.io/user/proj-1234.git proj-1234",
  );
  assert.equal(parsed.branch, "develop");
  assert.equal(
    parsed.url,
    "https://oauth2:glpat-XXX@gitlab.verse8.io/user/proj-1234.git",
  );
  assert.equal(parsed.slug, "proj-1234");
  assert.deepEqual(parsed.passthroughFlags, []);
});

test("parseCloneCommand: long --branch flag", () => {
  const parsed = parseCloneCommand(
    "git clone --branch develop https://oauth2:glpat-XXX@gitlab.verse8.io/user/proj-1234.git proj-1234",
  );
  assert.equal(parsed.branch, "develop");
  assert.equal(parsed.slug, "proj-1234");
});

test("parseCloneCommand: --branch=develop equals form", () => {
  const parsed = parseCloneCommand(
    "git clone --branch=develop https://oauth2:glpat-XXX@gitlab.verse8.io/user/proj-1234.git proj-1234",
  );
  assert.equal(parsed.branch, "develop");
});

test("parseCloneCommand: unknown flag is pass-through", () => {
  const parsed = parseCloneCommand(
    "git clone --depth 1 -b develop https://oauth2:glpat-XXX@gitlab.verse8.io/user/proj-1234.git proj-1234",
  );
  assert.equal(parsed.branch, "develop");
  assert.equal(parsed.slug, "proj-1234");
  // Either "--depth", or "--depth" + "1" as passthrough — both are acceptable
  // shapes so long as the flag was not dropped.
  assert.ok(parsed.passthroughFlags.includes("--depth"));
});

test("parseCloneCommand: slug derived from URL tail when absent", () => {
  const parsed = parseCloneCommand(
    "git clone -b develop https://oauth2:glpat-XXX@gitlab.verse8.io/user/hello-1776673901019.git",
  );
  assert.equal(parsed.slug, "hello-1776673901019");
});

test("parseCloneCommand: rejects command that is not git clone", () => {
  assert.throws(() => parseCloneCommand("rm -rf /"), /git/);
  assert.throws(() => parseCloneCommand("git pull origin main"), /git clone/);
});

test("parseCloneCommand: rejects command with no URL", () => {
  assert.throws(
    () => parseCloneCommand("git clone -b develop proj-1234"),
    /URL/,
  );
});

test("parseCloneCommand: rejects command with no -b/--branch", () => {
  assert.throws(
    () =>
      parseCloneCommand(
        "git clone https://oauth2:glpat-XXX@gitlab.verse8.io/user/proj.git proj",
      ),
    /branch/,
  );
});

test("parseCloneCommand: rejects -b without following value", () => {
  assert.throws(
    () =>
      parseCloneCommand(
        "git clone -b",
      ),
    /value/,
  );
});

test("parseCloneCommand: rejects undefined input with a clear message", () => {
  assert.throws(
    () => parseCloneCommand(undefined),
    /not a string|omitted the field/i,
  );
});

test("parseCloneCommand: rejects empty string", () => {
  assert.throws(() => parseCloneCommand(""), /empty/i);
});

test("parseCloneCommand: rejects whitespace-only string", () => {
  assert.throws(() => parseCloneCommand("   \n\t"), /empty/i);
});

// ------------------------------------------------------------------
// tolerantJsonParse — response-body shape-tolerance for agent8-backend
// ------------------------------------------------------------------

test("tolerantJsonParse: plain JSON body", () => {
  const r = tolerantJsonParse('{"cloneCommand":"git clone x y"}');
  assert.deepEqual(r, { cloneCommand: "git clone x y" });
});

test("tolerantJsonParse: SSE-wrapped JSON (data: ...)", () => {
  const r = tolerantJsonParse(
    'event: message\ndata: {"cloneCommand":"git clone u v"}\n\n',
  );
  assert.deepEqual(r, { cloneCommand: "git clone u v" });
});

test("tolerantJsonParse: JSON with leading/trailing garbage is recovered", () => {
  const r = tolerantJsonParse(
    '<!DOCTYPE html><html>junk</html>\n{"gitUrl":"https://x/"}\n<!-- trailer -->',
  );
  assert.deepEqual(r, { gitUrl: "https://x/" });
});

test("tolerantJsonParse: empty input → undefined", () => {
  assert.equal(tolerantJsonParse(""), undefined);
  assert.equal(tolerantJsonParse("   \n "), undefined);
});

test("tolerantJsonParse: unrecoverable garbage → undefined", () => {
  assert.equal(tolerantJsonParse("not json, not sse, no braces"), undefined);
});

// ------------------------------------------------------------------
// pickString — tolerant field lookup across schema drift
// ------------------------------------------------------------------

test("pickString: returns first matching camelCase path", () => {
  const r = pickString({ cloneCommand: "a", clone_command: "b" }, [
    "cloneCommand",
    "clone_command",
  ]);
  assert.equal(r, "a");
});

test("pickString: falls through to snake_case when camelCase missing", () => {
  const r = pickString({ clone_command: "b" }, ["cloneCommand", "clone_command"]);
  assert.equal(r, "b");
});

test("pickString: handles one-level nesting via 'data.foo'", () => {
  const r = pickString({ data: { gitUrl: "https://y/" } }, [
    "gitUrl",
    "data.gitUrl",
  ]);
  assert.equal(r, "https://y/");
});

test("pickString: skips empty / whitespace-only matches, continues down the list", () => {
  const r = pickString({ cloneCommand: "   ", clone_command: "real" }, [
    "cloneCommand",
    "clone_command",
  ]);
  assert.equal(r, "real");
});

test("pickString: returns undefined when nothing matches", () => {
  assert.equal(pickString({ foo: "bar" }, ["cloneCommand", "gitUrl"]), undefined);
});

test("pickString: tolerates non-object inputs without throwing", () => {
  assert.equal(pickString(null, ["x"]), undefined);
  assert.equal(pickString(undefined, ["x"]), undefined);
  assert.equal(pickString("string", ["x"]), undefined);
});
