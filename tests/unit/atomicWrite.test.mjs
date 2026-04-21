import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFileSync } from "../../dist/util/atomicWrite.js";

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-atomic-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("atomicWrite: tmp file name is unique across rapid back-to-back calls", () => {
  withTmpDir((dir) => {
    const target = path.join(dir, "out.txt");
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      atomicWriteFileSync(target, `iteration-${i}`);
      const entries = fs.readdirSync(dir);
      const leakedTmp = entries.filter((e) =>
        /\.out\.txt\.\d+-[a-f0-9]+\.tmp$/.test(e),
      );
      assert.equal(leakedTmp.length, 0, `iteration ${i} leaked tmp: ${leakedTmp.join(",")}`);
      seen.add(fs.readFileSync(target, "utf8"));
    }
    assert.equal(seen.size, 50, "every iteration left a distinct value");
  });
});

test("atomicWrite: mode is preserved on the destination file", () => {
  if (process.platform === "win32") {
    return;
  }
  withTmpDir((dir) => {
    const target = path.join(dir, "secret");
    atomicWriteFileSync(target, "secret-content", { mode: 0o600 });
    const mode = fs.statSync(target).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  });
});

test("atomicWrite: rename atomicity — destination is the new content (no half-write)", () => {
  withTmpDir((dir) => {
    const target = path.join(dir, "out");
    atomicWriteFileSync(target, "v1");
    assert.equal(fs.readFileSync(target, "utf8"), "v1");
    atomicWriteFileSync(target, "v2-replacement");
    assert.equal(fs.readFileSync(target, "utf8"), "v2-replacement");
  });
});

test("atomicWrite: cleanup-on-failure unlinks tmp when rename throws", () => {
  withTmpDir((dir) => {
    // Inject failure: target is a directory, so renameSync must fail with
    // EISDIR (POSIX) / EPERM (Windows). Either way the tmp must be unlinked.
    const target = path.join(dir, "blocked");
    fs.mkdirSync(target);
    assert.throws(() => atomicWriteFileSync(target, "should-fail"));
    const entries = fs.readdirSync(dir);
    const leakedTmp = entries.filter((e) => /\.blocked\..*\.tmp$/.test(e));
    assert.equal(
      leakedTmp.length,
      0,
      `tmp file leaked after failed rename: ${leakedTmp.join(",")}`,
    );
  });
});

test("atomicWrite: accepts Buffer body", () => {
  withTmpDir((dir) => {
    const target = path.join(dir, "buf");
    atomicWriteFileSync(target, Buffer.from([0xff, 0x00, 0x42]));
    const got = fs.readFileSync(target);
    assert.deepEqual([...got], [0xff, 0x00, 0x42]);
  });
});
