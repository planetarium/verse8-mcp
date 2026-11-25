// Shared by toolDocsMatchBehavior.test.mjs and runtimeHints.test.mjs: finds
// references to files inside this repo in text that agents read inside a
// game project (installed docs, tool hints, hook messages).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const REPO_PATH_RE = /(?<![\w./~-])((?:src|scripts|tests|docs|hooks|sample|skills-vendor)\/[\w.-]+(?:\/[\w.-]+)*)/g;

/**
 * Repo paths in `text` that resolve to a file or folder in this repo, plus
 * any `sample/…` path (that folder was removed). A path like `src/player.ts`
 * that only exists in a game project is not reported. Sentence-ending dots
 * are dropped first, so "see src/foo.ts." is still caught.
 */
export function repoPathRefs(text) {
  const out = [];
  for (const [, raw] of text.matchAll(REPO_PATH_RE)) {
    const ref = raw.replace(/\.+$/, "");
    if (ref.startsWith("sample/") || fs.existsSync(path.join(REPO_ROOT, ref))) out.push(ref);
  }
  return out;
}
