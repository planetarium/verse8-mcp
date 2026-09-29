import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgent8Pin } from "../../dist/util/gameserverPin.js";
import { buildPreflightSteps } from "../../dist/tools/preview.js";

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("resolveAgent8Pin: package.json pin (exact version) is used by default", () => {
  // package.json pins exact versions — the Claude plugin directory blocks
  // unpinned launchers, and `latest` would change what users run silently.
  const gs = withEnv("VERSE8_GAMESERVER_BUILD_PIN", undefined, () =>
    resolveAgent8Pin("gameserver-node"),
  );
  assert.equal(gs.source, "package.json");
  assert.match(gs.nameArg, /^@agent8\/gameserver-node@\d+\.\d+\.\d+$/);
  const dep = withEnv("VERSE8_GAMESERVER_BUILD_PIN", undefined, () =>
    resolveAgent8Pin("deploy"),
  );
  assert.equal(dep.source, "package.json");
  assert.match(dep.nameArg, /^@agent8\/deploy@\d+\.\d+\.\d+$/);
});

test("resolveAgent8Pin: VERSE8_GAMESERVER_BUILD_PIN env overrides package.json", () => {
  const gs = withEnv(
    "VERSE8_GAMESERVER_BUILD_PIN",
    "gameserver-node=1.2.3,deploy=4.5.6",
    () => resolveAgent8Pin("gameserver-node"),
  );
  assert.equal(gs.source, "env");
  assert.equal(gs.nameArg, "@agent8/gameserver-node@1.2.3");
  const dep = withEnv(
    "VERSE8_GAMESERVER_BUILD_PIN",
    "gameserver-node=1.2.3,deploy=4.5.6",
    () => resolveAgent8Pin("deploy"),
  );
  assert.equal(dep.nameArg, "@agent8/deploy@4.5.6");
});

test("resolveAgent8Pin: missing env entry falls through to package.json pin", () => {
  // Env pin only mentions `deploy`; gameserver-node falls through.
  const gs = withEnv("VERSE8_GAMESERVER_BUILD_PIN", "deploy=9.9.9", () =>
    resolveAgent8Pin("gameserver-node"),
  );
  assert.equal(gs.source, "package.json");
  const dep = withEnv("VERSE8_GAMESERVER_BUILD_PIN", "deploy=9.9.9", () =>
    resolveAgent8Pin("deploy"),
  );
  assert.equal(dep.source, "env");
  assert.equal(dep.nameArg, "@agent8/deploy@9.9.9");
});

test("buildPreflightSteps: gameserver=true threads pinned argv into npx invocation (package.json pin)", () => {
  withEnv("VERSE8_GAMESERVER_BUILD_PIN", undefined, () => {
    const steps = buildPreflightSteps("bun update", true);
    // install + gameserver build + deploy --preview
    assert.equal(steps.length, 3);
    const build = steps[1];
    assert.equal(build.cmd, "npx");
    assert.ok(
      build.args.some((a) => a.startsWith("@agent8/gameserver-node@")),
      `build argv missing pinned package: ${JSON.stringify(build.args)}`,
    );
    const deploy = steps[2];
    assert.ok(
      deploy.args.some((a) => a.startsWith("@agent8/deploy@")),
      `deploy argv missing pinned package: ${JSON.stringify(deploy.args)}`,
    );
  });
});

test("buildPreflightSteps: VERSE8_GAMESERVER_BUILD_PIN env wins over package.json", () => {
  withEnv(
    "VERSE8_GAMESERVER_BUILD_PIN",
    "gameserver-node=7.7.7,deploy=8.8.8",
    () => {
      const steps = buildPreflightSteps("bun update", true);
      const build = steps[1];
      assert.ok(build.args.includes("@agent8/gameserver-node@7.7.7"));
      const deploy = steps[2];
      assert.ok(deploy.args.includes("@agent8/deploy@8.8.8"));
    },
  );
});
