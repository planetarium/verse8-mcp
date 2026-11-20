import * as path from "node:path";
import { z } from "zod";
import { readEnvVerse } from "../context/envFile.js";
import { loadToken } from "../context/token.js";
import { isSafeAbsPath } from "../util/safePath.js";

/**
 * Shared inputs + resolution for tools that act on "this project's verse":
 * the verse id comes from `<projectDir>/.env` VITE_AGENT8_VERSE unless the
 * caller names one, and the Verse8 login token from the usual lookup.
 */

/** A verse id as the platform mints it (`<wallet>-<n>`) — one safe path segment. */
export const VERSE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const projectDirField = z
  .string()
  .min(1)
  .refine(isSafeAbsPath, {
    message:
      "projectDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
  })
  .optional()
  .describe("Absolute path to the verse8 project. Defaults to the MCP server's cwd.");

export const verseIdField = z
  .string()
  .regex(VERSE_ID, "verseId must be letters, digits, `_` or `-`")
  .optional()
  .describe("Verse id to act on. Defaults to VITE_AGENT8_VERSE in <projectDir>/.env.");

export type VerseContext =
  | { ok: true; projectDir: string; verseId: string; token: string }
  | { ok: false; error: "not_logged_in" | "missing_verse_env" | "invalid_input"; hint: string };

export function resolveVerseContext(
  input: { projectDir?: string; verseId?: string },
  serverCwd: string,
): VerseContext {
  const projectDir = path.resolve(input.projectDir ?? serverCwd);
  const token = loadToken(projectDir);
  if (!token) {
    return {
      ok: false,
      error: "not_logged_in",
      hint: "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
    };
  }
  const verseId = input.verseId ?? readEnvVerse(projectDir);
  if (!verseId) {
    return {
      ok: false,
      error: "missing_verse_env",
      hint: `No verseId given and VITE_AGENT8_VERSE is absent from ${path.join(projectDir, ".env")}. Pass verseId, or projectDir of an attached verse8 project.`,
    };
  }
  if (!VERSE_ID.test(verseId)) {
    return { ok: false, error: "invalid_input", hint: "VITE_AGENT8_VERSE in .env contains unexpected characters." };
  }
  return { ok: true, projectDir, verseId, token };
}
