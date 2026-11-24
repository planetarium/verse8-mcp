import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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
 *     or Windows junction) must resolve to a real location inside the root;
 *   - a dangling link is refused (writing through it would create the file
 *     wherever it points);
 *   - a link outside `.git/` that resolves into the root's `.git/` is
 *     refused, so a working-tree path cannot be used to rewrite git
 *     internals (hooks, config).
 *
 * Links that stay inside the root (e.g. `CLAUDE.md → AGENTS.md`) are allowed.
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
  /** Throws `ProjectWriteError` when `target` would escape the root. */
  assertInside(target: string): void;
  /** `fs.writeFileSync`, following a final link only when it stays inside. */
  writeFile(target: string, data: string | Buffer, opts?: { mode?: number }): void;
  /**
   * Write via a sibling temp file and rename, so a failure leaves the
   * destination untouched or fully written. The rename replaces a final link
   * rather than following it, so only the parent directory is checked.
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

/** realpath of the nearest existing ancestor, with the missing tail re-joined. */
function realpathLoose(p: string): string {
  const tail: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function readLinkText(p: string): string {
  try {
    return fs.readlinkSync(p);
  } catch {
    return "<unreadable>";
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
  function check(target: string, opts: { followFinal: boolean }): string {
    const abs = path.resolve(target);
    const rel = path.relative(root, abs);
    if (!relIsInside(rel)) {
      throw new ProjectWriteError(
        `refusing to write ${abs}: it is outside the project folder ${root}`,
      );
    }
    const segs = rel === "" ? [] : rel.split(path.sep);
    const walk = opts.followFinal ? segs : segs.slice(0, -1);
    const realRoot = realpathLoose(root);
    const realGit = path.join(realRoot, ".git");
    const lexGit = path.join(root, ".git");

    let cur = root;
    for (const seg of walk) {
      cur = path.join(cur, seg);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break; // missing — nothing below it exists either
      }
      if (!st.isSymbolicLink()) continue;
      let resolved: string;
      try {
        resolved = fs.realpathSync.native(cur);
      } catch {
        return refuse(
          abs,
          `${show(cur)} is a link to ${readLinkText(cur)}, which does not exist`,
        );
      }
      if (!isPathInside(realRoot, resolved)) {
        return refuse(
          abs,
          `${show(cur)} is a link to ${resolved}, which is outside the project folder`,
        );
      }
      if (isPathInside(realGit, resolved) && !isPathInside(lexGit, cur)) {
        return refuse(
          abs,
          `${show(cur)} is a link to ${resolved}, inside the project's .git folder`,
        );
      }
    }
    return abs;
  }

  return {
    root,
    assertInside(target) {
      check(target, { followFinal: true });
    },
    writeFile(target, data, opts) {
      const p = check(target, { followFinal: true });
      fs.writeFileSync(p, data, opts?.mode === undefined ? undefined : { mode: opts.mode });
    },
    writeFileAtomic(target, data, mode) {
      const p = check(target, { followFinal: false });
      const tmp = path.join(
        path.dirname(p),
        `.${path.basename(p)}.verse8-tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
      );
      try {
        fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
        if (mode !== undefined) fs.chmodSync(tmp, mode);
        fs.renameSync(tmp, p);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },
    mkdirp(dir) {
      const p = check(dir, { followFinal: true });
      fs.mkdirSync(p, { recursive: true });
    },
    removeFile(target) {
      // rm on a link removes the link itself, so the final component is not followed.
      const p = check(target, { followFinal: false });
      fs.rmSync(p, { force: true });
    },
    removeDirIfEmpty(dir) {
      try {
        const p = check(dir, { followFinal: true });
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
      } catch {
        /* best-effort */
      }
    },
    chmod(target, mode) {
      const p = check(target, { followFinal: true });
      fs.chmodSync(p, mode);
    },
  };
}
