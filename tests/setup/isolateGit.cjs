// Preloaded by `npm run test:unit` (node --require). Unit tests run real
// `git` in temp repos; a developer's global or system git config (e.g. a
// global core.hooksPath) would otherwise leak in, and attach tests would
// write hooks into, and roll back out of, the developer's own hooks folder.
// Child processes inherit this env, including node --test's per-file runners.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.env.VERSE8_TEST_GIT_ISOLATED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-gitcfg-"));
  const empty = path.join(dir, "gitconfig");
  fs.writeFileSync(empty, "");
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.VERSE8_TEST_GIT_ISOLATED = "1";
}
