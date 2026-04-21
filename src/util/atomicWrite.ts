import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Atomic `tmp + rename` write. Used by every code path that updates a
 * runtime-critical file (the verse8 access token, the project `.env`).
 * On any failure the tmp file is best-effort unlinked so partial writes
 * never leak. Caller propagates the original error.
 */

export interface AtomicWriteOptions {
  mode?: number;
}

export function atomicWriteFileSync(
  filePath: string,
  body: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  const writeOpts: fs.WriteFileOptions =
    opts.mode !== undefined ? { mode: opts.mode } : {};
  try {
    fs.writeFileSync(tmp, body, writeOpts);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp already gone or unreachable — best-effort */
    }
    throw e;
  }
}
