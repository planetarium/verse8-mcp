import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "./atomicWrite.js";

/**
 * Filesystem writes confined to one folder (the project being attached).
 *
 * A cloned project can carry committed symlinks, and a user's checkout can
 * hold any link at all. A bare `fs.writeFileSync(path.join(projectDir, x))`
 * follows them, so `.claude/skills → ~/elsewhere` or `.gitignore →
 * ~/.bashrc` would make attach write or delete outside the project. Every
 * write, mkdir, delete and rename on the attach path goes through a
 * `ProjectWriter`, which checks the target before touching it:
 *
 *   - the target must sit lexically under the root;
 *   - every existing component from the root down that is a link (symlink
 *     or Windows junction), the target itself included, must lead to a
 *     location inside the root. Links are followed hop by hop, so a dangling
 *     link is judged by where it points: one aimed inside the root is
 *     allowed (writing through it creates that file), one aimed outside is
 *     refused, however many links it goes through. On Windows the target
 *     is also judged as text-folded, and both readings must pass;
 *   - a link outside `.git/` that leads into the root's real `.git/` folder
 *     is refused, so a working-tree path cannot rewrite git internals.
 *
 * The final component is checked even for atomic writes and deletes: a
 * rename would replace the link rather than follow it, but the caller
 * usually read the old content through that same link first (a snapshot,
 * an upsert), and writing it back would copy an outside file into the
 * project.
 *
 * The check runs immediately before each operation; it does not defend
 * against a concurrent process swapping a link in between.
 */

export class ProjectWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectWriteError";
  }
}

export interface ProjectWriter {
  /** The folder every operation must stay inside. */
  readonly root: string;
  /**
   * Throws `ProjectWriteError` when `target`, or a link on the way to it,
   * leads outside the root. Call it before reading a file whose content
   * will be written back (a snapshot), so outside content is never copied in.
   */
  assertInside(target: string): void;
  /** `fs.writeFileSync`; a final link is followed only when it stays inside. */
  writeFile(target: string, data: string | Buffer, opts?: { mode?: number }): void;
  /**
   * Write via a sibling temp file and rename (`util/atomicWrite.ts`), so a
   * failure leaves the destination untouched or fully written. `mode` is
   * applied exactly, regardless of the umask.
   */
  writeFileAtomic(target: string, data: string | Buffer, mode?: number): void;
  /** `fs.mkdirSync(dir, { recursive: true })`. */
  mkdirp(dir: string): void;
  /** `fs.rmSync(target, { force: true })` on a single file or link. */
  removeFile(target: string): void;
  /** Remove `dir` only when it is empty; best-effort, never throws. */
  removeDirIfEmpty(dir: string): void;
  chmod(target: string, mode: number): void;
}

/** True when `target` is `root` or lexically below it. */
export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return relIsInside(rel);
}

function relIsInside(rel: string): boolean {
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

const MAX_LINK_HOPS = 40;

/** Which OS's path rules apply; injectable so tests can run the win32 rules anywhere. */
export type PathPlatform = "win32" | "posix";

/** The one place the host platform is read for link resolution. */
export function hostPathPlatform(): PathPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

/**
 * Every place `p` may really lead to, following links hop by hop even when
 * the end of the chain does not exist (`realpath` gives up there). Throws
 * after `MAX_LINK_HOPS` links. A caller allows `p` only when every
 * candidate is acceptable.
 *
 * A dangling link's target is walked one component at a time as a POSIX
 * kernel does, never folded as a string first: `..` steps up from the real
 * location reached so far, so in `sub/../x` with `sub → ..` it leaves the
 * folder `sub` points at, not the folder `sub` sits in. Missing components
 * are taken as plain names.
 *
 * On win32 it is not established whether a relative link target's `..` is
 * applied after following the links before it or folded as text first, so
 * both readings are returned and both must pass.
 */
export function resolveCandidates(
  p: string,
  platform: PathPlatform = hostPathPlatform(),
): string[] {
  try {
    return [fs.realpathSync.native(p)]; // everything exists: the OS answer
  } catch {
    /* something on the way is missing or dangling — walk it */
  }
  const walked = resolveWalk(p, platform, false);
  if (platform !== "win32") return [walked];
  const folded = resolveWalk(p, platform, true);
  return folded === walked ? [walked] : [walked, folded];
}

/** The POSIX-walk reading only (see `resolveCandidates`). */
export function resolveLoose(p: string, platform: PathPlatform = hostPathPlatform()): string {
  return resolveCandidates(p, platform)[0];
}

function resolveWalk(p: string, platform: PathPlatform, foldTargets: boolean): string {
  const ctx = { hops: MAX_LINK_HOPS, platform, foldTargets, original: p };
  const start = path.isAbsolute(p) ? path.parse(p).root : fs.realpathSync.native(process.cwd());
  const rest = path.isAbsolute(p) ? p.slice(path.parse(p).root.length) : p;
  return walkComponents(start, splitComponents(rest, platform), ctx);
}

function splitComponents(rest: string, platform: PathPlatform): string[] {
  return rest.split(platform === "win32" ? /[\\/]/ : "/");
}

/**
 * Where a link's target starts and the components to walk from there.
 *
 * - relative: from the link's own real folder;
 * - absolute: from the target's root. On win32 a root without a drive
 *   (`\Project\x`) is on the link's drive, not the process's current one;
 *   `\\?\` / `\??\` prefixes are dropped (`\\?\UNC\srv\sh` is `\\srv\sh`),
 *   and a UNC root (`\\srv\sh\`) is kept whole;
 * - drive-relative (`C:x`, relative to that drive's unknown current folder)
 *   is refused.
 */
export function linkTargetStart(
  target: string,
  linkRealDir: string,
  platform: PathPlatform = hostPathPlatform(),
): { start: string; parts: string[] } {
  if (platform !== "win32") {
    return target.startsWith("/")
      ? { start: "/", parts: splitComponents(target.slice(1), platform) }
      : { start: linkRealDir, parts: splitComponents(target, platform) };
  }
  const W = path.win32;
  let t = target;
  if (/^\\\\\?\\UNC\\/i.test(t)) t = `\\\\${t.slice(8)}`;
  else if (/^(\\\\\?\\|\\\?\?\\)/.test(t)) t = t.slice(4);
  if (/^[A-Za-z]:(?![\\/])/.test(t)) {
    throw new ProjectWriteError(`link target ${target} is relative to a drive's current folder`);
  }
  if (!W.isAbsolute(t)) return { start: linkRealDir, parts: splitComponents(t, platform) };
  const root = W.parse(t).root;
  const rest = t.slice(root.length);
  const hasDriveOrShare = /^[A-Za-z]:/.test(root) || /^[\\/]{2}/.test(root);
  return {
    start: hasDriveOrShare ? root : W.parse(linkRealDir).root,
    parts: splitComponents(rest, platform),
  };
}

interface WalkContext {
  hops: number;
  platform: PathPlatform;
  /** Fold each link target as text before walking it (the other win32 reading). */
  foldTargets: boolean;
  original: string;
}

/** Walk `parts` from `start` (already a real path), following links as met. */
function walkComponents(start: string, parts: string[], ctx: WalkContext): string {
  let real = start;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      real = path.dirname(real); // up from where we really are
      continue;
    }
    const next = path.join(real, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch {
      real = next; // missing: a plain name from here on
      continue;
    }
    if (!st.isSymbolicLink()) {
      real = fs.realpathSync.native(next);
      continue;
    }
    try {
      real = fs.realpathSync.native(next);
      continue;
    } catch {
      /* dangling — follow it by hand */
    }
    if (--ctx.hops < 0) {
      throw new ProjectWriteError(`too many links while resolving ${ctx.original}`);
    }
    const { start: from, parts: targetParts } = linkTargetStart(
      fs.readlinkSync(next),
      real,
      ctx.platform,
    );
    if (ctx.foldTargets) {
      const folded = path.resolve(from, ...targetParts.filter((s) => s !== ""));
      const root = path.parse(folded).root;
      real = walkComponents(root, splitComponents(folded.slice(root.length), ctx.platform), ctx);
    } else {
      real = walkComponents(from, targetParts, ctx);
    }
  }
  return real;
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function projectWriter(
  rootDir: string,
  opts: { platform?: PathPlatform } = {},
): ProjectWriter {
  const platform = opts.platform ?? hostPathPlatform();
  const root = path.resolve(rootDir);
  const show = (p: string): string => {
    const rel = path.relative(root, p);
    return rel === "" ? "." : rel.split(path.sep).join("/");
  };
  const refuse = (target: string, why: string): never => {
    throw new ProjectWriteError(
      `refusing to write ${show(target)} in ${root}: ${why}. ` +
        "verse8_attach writes only inside the project folder; remove or replace the link and run verse8_attach again.",
    );
  };

  // INV-14: Attach writes never leave the project folder
  function check(target: string): string {
    // Folding `target` here is safe: the operation then uses this same
    // folded string, so what is checked is what the kernel resolves. Only
    // link targets (read from disk) must not be folded — see resolveCandidates.
    const abs = path.resolve(target);
    const rel = path.relative(root, abs);
    if (!relIsInside(rel)) {
      throw new ProjectWriteError(
        `refusing to write ${abs}: it is outside the project folder ${root}`,
      );
    }
    const segs = rel === "" ? [] : rel.split(path.sep);
    const realRoot = resolveLoose(root, platform);
    const lexGit = path.join(root, ".git");
    // The real .git folder: `.git` may itself be a link (to a folder inside
    // the project or elsewhere), and its metadata is protected either way.
    const realGits = resolveCandidates(lexGit, platform);

    let cur = root;
    for (const seg of segs) {
      cur = path.join(cur, seg);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break; // missing — nothing below it exists either
      }
      if (!st.isSymbolicLink()) continue;
      const missing = exists(cur) ? "" : " (missing)";
      // Every reading must pass (two on win32, see resolveCandidates).
      for (const resolved of resolveCandidates(cur, platform)) {
        const where = `${resolved}${missing}`;
        if (!isPathInside(realRoot, resolved)) {
          return refuse(abs, `${show(cur)} is a link to ${where}, which is outside the project folder`);
        }
        if (realGits.some((g) => isPathInside(g, resolved)) && !isPathInside(lexGit, cur)) {
          return refuse(abs, `${show(cur)} is a link to ${where}, inside the project's .git folder`);
        }
      }
    }
    return abs;
  }

  return {
    root,
    assertInside(target) {
      check(target);
    },
    writeFile(target, data, opts) {
      const p = check(target);
      fs.writeFileSync(p, data, opts?.mode === undefined ? undefined : { mode: opts.mode });
    },
    writeFileAtomic(target, data, mode) {
      const p = check(target);
      atomicWriteFileSync(p, data, mode === undefined ? {} : { mode, exactMode: true });
    },
    mkdirp(dir) {
      const p = check(dir);
      fs.mkdirSync(p, { recursive: true });
    },
    removeFile(target) {
      const p = check(target);
      fs.rmSync(p, { force: true });
    },
    removeDirIfEmpty(dir) {
      try {
        const p = check(dir);
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
      } catch {
        /* best-effort */
      }
    },
    chmod(target, mode) {
      const p = check(target);
      fs.chmodSync(p, mode);
    },
  };
}
