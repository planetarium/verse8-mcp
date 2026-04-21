import { execFileSync } from "node:child_process";
import { type V8ToolCallEntry } from "./v8CommitMessage.js";

/**
 * Read the staged diff and synthesize one toolCall entry per changed file.
 * Captures what this turn wrote on disk so the V8 commit message includes
 * filePath + content/diff entries even for host-side Write/Edit calls.
 * (M1b-5 — extracted from src/tools/checkpoint.ts.)
 */
export function synthesizeFileChangesFromDiff(cwd: string): V8ToolCallEntry[] {
  let nameStatus = "";
  try {
    nameStatus = execFileSync("git", ["diff", "--cached", "--name-status"], {
      cwd,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  const MAX_INLINE = 2000;
  const truncate = (s: string): string =>
    s.length > MAX_INLINE ? s.slice(0, MAX_INLINE) + " ...(truncated)" : s;

  const changedLines = nameStatus.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Configurable cap — at 1000+ file commits the per-file `git show` /
  // `git diff --cached` spawns dominate checkpoint latency. Beyond the cap
  // we emit a single summary entry so the commit message still captures the
  // shape of the change without spawning hundreds of git processes.
  const capRaw = process.env.VERSE8_CHECKPOINT_FILE_CAP;
  const capParsed = capRaw ? parseInt(capRaw, 10) : NaN;
  const cap = Number.isFinite(capParsed) && capParsed > 0 ? capParsed : 100;

  if (changedLines.length > cap) {
    const samplePaths: string[] = [];
    for (const line of changedLines.slice(0, 5)) {
      const parts = line.split("\t");
      // "R<score>\tfrom\tto" → take the destination; otherwise parts[1].
      const p = parts[0]?.startsWith("R") && parts[2] ? parts[2] : parts[1];
      if (p) samplePaths.push(p);
    }
    return [
      {
        name: "bulk_change",
        status: "completed",
        input: { totalFiles: changedLines.length, sample: samplePaths },
      },
    ];
  }

  const entries: V8ToolCallEntry[] = [];
  for (const line of changedLines) {
    const parts = line.split("\t");
    const status = parts[0];
    if (status.startsWith("A") && parts[1]) {
      try {
        const content = execFileSync("git", ["show", `:${parts[1]}`], {
          cwd,
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
        });
        entries.push({
          name: "write",
          status: "completed",
          input: { filePath: parts[1], content: truncate(content) },
        });
      } catch {
        entries.push({
          name: "write",
          status: "completed",
          input: { filePath: parts[1] },
        });
      }
    } else if (status.startsWith("M") && parts[1]) {
      try {
        const diff = execFileSync(
          "git",
          ["diff", "--cached", "--unified=2", "--", parts[1]],
          { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
        );
        entries.push({
          name: "edit",
          status: "completed",
          input: { filePath: parts[1], diff: truncate(diff) },
        });
      } catch {
        entries.push({
          name: "edit",
          status: "completed",
          input: { filePath: parts[1] },
        });
      }
    } else if (status.startsWith("D") && parts[1]) {
      entries.push({
        name: "delete",
        status: "completed",
        input: { filePath: parts[1] },
      });
    } else if (status.startsWith("R") && parts[1] && parts[2]) {
      entries.push({
        name: "rename",
        status: "completed",
        input: { from: parts[1], to: parts[2] },
      });
    } else if (status.startsWith("C") && parts[1] && parts[2]) {
      entries.push({
        name: "copy",
        status: "completed",
        input: { from: parts[1], to: parts[2] },
      });
    } else if (parts[1]) {
      entries.push({
        name: "change",
        status: "completed",
        input: { filePath: parts[1], gitStatus: status },
      });
    }
  }
  return entries;
}
