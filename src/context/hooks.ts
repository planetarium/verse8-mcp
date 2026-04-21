import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve where git hooks should live. Honors `git config core.hooksPath`
 * when set — otherwise falls back to `<projectDir>/.git/hooks`. A relative
 * `core.hooksPath` is resolved against `projectDir`. (M1b-2)
 */
export function resolveHooksDir(projectDir: string): string {
  let custom = "";
  try {
    custom = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* exit code 1 when unset — fall through to default */
  }
  if (!custom) return path.join(projectDir, ".git", "hooks");
  return path.isAbsolute(custom) ? custom : path.resolve(projectDir, custom);
}

/**
 * Write a verse8-mcp git hook script. Idempotent — returns
 * `already-present` when the hook already carries the verse8 signature.
 */
export function writeHook(
  hooksDir: string,
  name: string,
  script: string,
): "created" | "already-present" {
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, name);
  let existing = "";
  try {
    existing = fs.readFileSync(hookPath, "utf8");
  } catch {
    /* missing — will create below */
  }
  if (existing.includes(`verse8-mcp hook ${name}`)) {
    return "already-present";
  }
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    /* non-fatal */
  }
  return "created";
}
