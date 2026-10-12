#!/usr/bin/env node
// sync-skip-check.mjs
//
// Decide whether an upstream commit is already vendored, i.e. whether
// `.github/workflows/sync-agent8-skills.yml` should skip it.
//
// A requested commit is "already vendored" when it is one of the pinned
// commits or an ancestor of one. Two pins matter: the one on `main`
// (`package.json :: verse8.skillsVendor.upstream.commit`) and the one on the
// open sync branch, if any. Checking only main's pin lets a stale dispatch —
// delivered late, re-run, or started by hand with an old `sha` — rewind a
// sync PR that already carries a newer commit: it would force-push the branch
// back to the old commit, or close the PR because the old commit vendors
// identically to main.
//
//   node scripts/sync-skip-check.mjs --upstream <agent8-skills checkout> \
//     --sha <40-hex> --pin main=<40-hex or empty> --pin sync/agent8-skills=<…>
//
// Prints exactly one line to stdout, `skip=true` or `skip=false`, and the
// reasoning to stderr. Exit 2 on bad arguments.

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function commitExists(upstreamDir, sha) {
  return git(upstreamDir, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/** `ancestor` is `descendant` itself or reachable from it. */
export function isAncestor(upstreamDir, ancestor, descendant) {
  return git(upstreamDir, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

/**
 * @param {{ upstreamDir: string, sha: string, pins: Array<{ label: string, commit: string }> }} opts
 * @returns {{ skip: boolean, by?: string, pin?: string, warnings: string[] }}
 */
export function alreadyVendored({ upstreamDir, sha, pins }) {
  if (!SHA_RE.test(sha)) throw new Error(`--sha must be a full 40-hex sha, got ${JSON.stringify(sha)}`);
  const warnings = [];
  for (const { label, commit } of pins) {
    if (!commit) continue;
    if (!SHA_RE.test(commit)) {
      warnings.push(`${label}: pin ${JSON.stringify(commit)} is not a full sha; ignored`);
      continue;
    }
    if (!commitExists(upstreamDir, commit)) {
      warnings.push(`${label}: pinned upstream commit ${commit} is not in upstream main's history; ignored`);
      continue;
    }
    if (isAncestor(upstreamDir, sha, commit)) {
      return { skip: true, by: label, pin: commit, warnings };
    }
  }
  return { skip: false, warnings };
}

function parseArgs(argv) {
  const opts = { upstream: undefined, sha: undefined, pins: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "--upstream") opts.upstream = next();
    else if (a === "--sha") opts.sha = next();
    else if (a === "--pin") {
      const v = next();
      const eq = v.indexOf("=");
      if (eq <= 0) throw new Error(`--pin expects <label>=<sha>, got ${JSON.stringify(v)}`);
      opts.pins.push({ label: v.slice(0, eq), commit: v.slice(eq + 1).trim() });
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.upstream) throw new Error("--upstream <dir> is required");
  if (!opts.sha) throw new Error("--sha <sha> is required");
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`sync-skip-check: ${e.message}`);
    process.exit(2);
  }
  const upstreamDir = path.resolve(opts.upstream);
  let result;
  try {
    result = alreadyVendored({ upstreamDir, sha: opts.sha, pins: opts.pins });
  } catch (e) {
    console.error(`sync-skip-check: ${e.message}`);
    process.exit(2);
  }
  for (const w of result.warnings) {
    console.error(process.env.GITHUB_ACTIONS ? `::warning::${w}` : `sync-skip-check: warning: ${w}`);
  }
  if (result.skip) {
    console.error(`sync-skip-check: ${opts.sha} is the ${result.by} pin ${result.pin} or an ancestor of it — already vendored.`);
  } else {
    const pinned = opts.pins.filter((p) => p.commit).map((p) => `${p.label}=${p.commit}`).join(", ") || "none";
    console.error(`sync-skip-check: ${opts.sha} is newer than every pin (${pinned}) — vendor it.`);
  }
  console.log(`skip=${result.skip ? "true" : "false"}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
