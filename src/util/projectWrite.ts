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
 *     refused, however many links it goes through;
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

/**
 * Where `p` really leads, following every link hop by hop even when the
 * end of the chain does not exist (`realpath` gives up there). Missing
 * components are joined on lexically. Throws after `MAX_LINK_HOPS` links.
 */
export function resolveLoose(p: string, budget = { hops: MAX_LINK_HOPS }): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* something on the way is missing or dangling — walk it */
  }
  const { root } = path.parse(abs);
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean);
  let real = root;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(real, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch {
      return path.join(next, ...parts.slice(i + 1)); // missing from here on
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
    if (--budget.hops < 0) {
      throw new ProjectWriteError(`too many links while resolving ${abs}`);
    }
    real = resolveLoose(path.resolve(real, fs.readlinkSync(next)), budget);
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

export function projectWriter(rootDir: string): ProjectWriter {
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
    const abs = path.resolve(target);
    const rel = path.relative(root, abs);
    if (!relIsInside(rel)) {
      throw new ProjectWriteError(
        `refusing to write ${abs}: it is outside the project folder ${root}`,
      );
    }
    const segs = rel === "" ? [] : rel.split(path.sep);
    const realRoot = resolveLoose(root);
    const lexGit = path.join(root, ".git");
    // The real .git folder: `.git` may itself be a link (to a folder inside
    // the project or elsewhere), and its metadata is protected either way.
    const realGit = resolveLoose(lexGit);

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
      const resolved = resolveLoose(cur);
      const where = exists(cur) ? resolved : `${resolved} (missing)`;
      if (!isPathInside(realRoot, resolved)) {
        return refuse(abs, `${show(cur)} is a link to ${where}, which is outside the project folder`);
      }
      if (isPathInside(realGit, resolved) && !isPathInside(lexGit, cur)) {
        return refuse(abs, `${show(cur)} is a link to ${where}, inside the project's .git folder`);
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
