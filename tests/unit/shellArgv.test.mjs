// Unit tests for the Windows-shell helpers shared by verse8_preview's
// preflight and verse8_deploy (src/util/shellArgv.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

import { stepsUseShell, unsafeShellTokens } from "../../dist/util/shellArgv.js";

test("child steps use the shell on Windows only", () => {
  assert.equal(stepsUseShell("win32"), true);
  assert.equal(stepsUseShell("linux"), false);
  assert.equal(stepsUseShell("darwin"), false);
});

test("unsafeShellTokens accepts paths and flags, refuses shell syntax", () => {
  assert.deepEqual(
    unsafeShellTokens(["npm", "ci", "--no-audit", "@agent8/deploy@1.5.5", "C:\\Users\\RUNNER~1\\x.cjs", "/tmp/x.cjs", "--registry=https://r.example/"]),
    [],
  );
  for (const bad of ["&&", "a|b", "x;y", ">out", "%PATH%", "^", "(x)", '"q"', "'q'", "$(id)", "`id`", "a&b", "*"]) {
    assert.deepEqual(unsafeShellTokens(["bun", bad]), [bad], bad);
  }
});

test("unsafeShellTokens ignores empty tokens", () => {
  assert.deepEqual(unsafeShellTokens(["", "bun", "update"]), []);
});
