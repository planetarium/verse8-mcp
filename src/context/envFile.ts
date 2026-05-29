import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "../util/atomicWrite.js";

/**
 * Maintain the `<projectDir>/.env` file that the verse8 runtime loads.
 *
 * Contract (per product direction):
 *   - `VITE_AGENT8_ACCOUNT=<0x-wallet-address>` — identifies the user
 *   - `VITE_AGENT8_VERSE=<account>-<ms-epoch-timestamp>` — stable session id
 *   - Both fields are REQUIRED once a session is attached.
 *   - Once set, neither value is overwritten automatically. A different
 *     logged-in wallet does NOT replace an existing ACCOUNT/VERSE — the
 *     user must opt in via `verse8_attach({overwriteEnv: true})`.
 *   - Other keys in .env (unrelated to verse8) are preserved verbatim.
 *   - Missing parent directory doesn't apply — the .env lives at the
 *     project root which always exists when attach runs.
 */

export const ACCOUNT_KEY = "VITE_AGENT8_ACCOUNT";
export const VERSE_KEY = "VITE_AGENT8_VERSE";

export type EnsureVerse8EnvResult =
  | {
      status: "created" | "added-missing" | "already-present" | "overwrote";
      account: string;
      verse: string;
      path: string;
    }
  | {
      status: "mismatch-preserved";
      existingAccount: string;
      currentAccount: string;
      path: string;
      hint: string;
    }
  | { status: "skipped-not-logged-in"; hint: string };

export interface EnsureVerse8EnvOptions {
  /** When true, force-write both keys using the supplied wallet and a
   * fresh timestamp, regardless of existing values. Use to resolve
   * mismatch cases intentionally. */
  overwrite?: boolean;
}

/**
 * Parse a .env-style string into a key→value map. Skips blank/comment
 * lines. Only the LAST assignment for a given key is kept (matches how
 * Vite / dotenv handle duplicates).
 */
export function parseDotenv(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip a single layer of matching quotes — dotenv does the same.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Upsert a set of `key=value` pairs into a .env body string. The rule:
 *   - If a key already appears, REPLACE only the last occurrence in place.
 *   - If it doesn't appear, APPEND on its own line at the end of the file.
 *   - Other lines, including comments and blank lines, are preserved.
 */
export function upsertEnvLines(
  raw: string,
  updates: Array<[string, string]>,
): string {
  let body = raw ?? "";
  // Ensure we emit consistent \n; read `body` using a normalized view but
  // keep the original line endings visually the same when possible.
  const endsWithNewline = body.length === 0 || /\n$/.test(body);
  for (const [key, value] of updates) {
    const lineRe = new RegExp(`^(\\s*${escapeRegex(key)}\\s*=).*$`, "m");
    const replacement = `${key}=${value}`;
    if (lineRe.test(body)) {
      body = body.replace(lineRe, replacement);
    } else {
      if (body.length > 0 && !/\n$/.test(body)) body += "\n";
      body += `${replacement}\n`;
    }
  }
  if (!endsWithNewline && !/\n$/.test(body)) body += "\n";
  return body;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeAtomic(filePath: string, body: string): void {
  atomicWriteFileSync(filePath, body);
}

function loadRaw(envPath: string): string {
  try {
    return fs.readFileSync(envPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Materialize the verse8 account + verse keys into `<projectDir>/.env`.
 *
 * See the module doc for the full contract. Returns a discriminated union
 * describing what happened, so callers can relay the outcome to the LLM
 * (e.g. surfacing the override hint on a mismatch).
 */
export function ensureVerse8EnvFile(
  projectDir: string,
  walletAddress: string | null | undefined,
  opts: EnsureVerse8EnvOptions = {},
): EnsureVerse8EnvResult {
  const envPath = path.join(projectDir, ".env");

  if (!walletAddress) {
    return {
      status: "skipped-not-logged-in",
      hint: "No walletAddress available (token missing or verify failed). Log in via verse8_login_start + verse8_login_complete, then re-run verse8_attach.",
    };
  }

  const raw = loadRaw(envPath);
  const existing = parseDotenv(raw);
  const existingAccount = existing.get(ACCOUNT_KEY);
  const existingVerse = existing.get(VERSE_KEY);

  // Explicit override — write both keys from the currently logged-in wallet.
  if (opts.overwrite === true) {
    const account = walletAddress;
    const verse = `${walletAddress}-${Date.now()}`;
    const body = upsertEnvLines(raw, [
      [ACCOUNT_KEY, account],
      [VERSE_KEY, verse],
    ]);
    writeAtomic(envPath, body);
    return { status: "overwrote", account, verse, path: envPath };
  }

  // Account exists AND disagrees with current login — preserve, hint.
  if (existingAccount && existingAccount !== walletAddress) {
    const hint =
      `.env at ${envPath} binds to account ${existingAccount}, but the currently logged-in wallet is ${walletAddress}. ` +
      `Preserving the file — verse8 considers ACCOUNT/VERSE immutable once set. ` +
      `To replace intentionally (e.g. you swapped accounts and want the old .env gone), run: ` +
      `verse8_attach({projectDir: "${projectDir}", overwriteEnv: true}) — this mints a fresh VITE_AGENT8_VERSE timestamp under the new account.`;
    console.error(`[verse8-env] ${hint}`);
    return {
      status: "mismatch-preserved",
      existingAccount,
      currentAccount: walletAddress,
      path: envPath,
      hint,
    };
  }

  // Resolve effective account — prefer the existing value (spec: once set,
  // immutable), fall back to the current login.
  const account = existingAccount ?? walletAddress;
  // Reuse existing VERSE verbatim if it's set (timestamp stays stable).
  // Otherwise mint a fresh one anchored to the account prefix.
  const verse = existingVerse ?? `${account}-${Date.now()}`;

  const alreadyHas = existingAccount && existingVerse;
  if (alreadyHas) {
    return {
      status: "already-present",
      account,
      verse,
      path: envPath,
    };
  }

  const updates: Array<[string, string]> = [];
  if (!existingAccount) updates.push([ACCOUNT_KEY, account]);
  if (!existingVerse) updates.push([VERSE_KEY, verse]);
  const body = upsertEnvLines(raw, updates);
  writeAtomic(envPath, body);

  return {
    status: raw.trim().length === 0 ? "created" : "added-missing",
    account,
    verse,
    path: envPath,
  };
}

/**
 * Cheap read-only lookup for the ACCOUNT value without touching disk
 * beyond the .env file. Used by checkpoint/preview's lazy self-heal to
 * skip a verifyToken() round trip when the local copy already has a
 * valid wallet binding.
 */
export function readEnvAccount(projectDir: string): string | null {
  const envPath = path.join(projectDir, ".env");
  const raw = loadRaw(envPath);
  if (!raw) return null;
  const map = parseDotenv(raw);
  return map.get(ACCOUNT_KEY) ?? null;
}

/**
 * Symmetric helper to `readEnvAccount`. Returns the raw VITE_AGENT8_VERSE
 * value, or null if `.env` is missing or the key is absent. Used by
 * verse8_upload_asset to tag uploads with the project's verse id.
 */
export function readEnvVerse(projectDir: string): string | null {
  const envPath = path.join(projectDir, ".env");
  const raw = loadRaw(envPath);
  if (!raw) return null;
  const map = parseDotenv(raw);
  return map.get(VERSE_KEY) ?? null;
}

