import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Pin resolution for @agent8 packages in preview preflight (M4.2).
// Precedence: VERSE8_GAMESERVER_BUILD_PIN env > package.json verse8.gameserverPin > unpinned.

export type GameserverPinMap = Record<string, string>;

function parseEnvPins(raw: string | undefined): GameserverPinMap {
  const out: GameserverPinMap = {};
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const [name, ver] = entry.split("=");
    if (!name || !ver) continue;
    const trimmedName = name.trim();
    const trimmedVer = ver.trim();
    if (!trimmedName || !trimmedVer) continue;
    out[trimmedName] = trimmedVer;
  }
  return out;
}

function readPackageJsonPins(): GameserverPinMap {
  try {
    // dist/util/gameserverPin.js → dist/util → dist → <pkg root>
    const hereDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(hereDir, "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as {
      verse8?: { gameserverPin?: GameserverPinMap };
    };
    return parsed?.verse8?.gameserverPin ?? {};
  } catch {
    return {};
  }
}

export interface ResolvedPin {
  /** The `@agent8/<name>` argument to pass to `npx -y`. */
  nameArg: string;
  /** Source of the pin — informational only. */
  source: "env" | "package.json" | "default";
}

export function resolveAgent8Pin(
  pkgBasename: string,
  envOverride?: string,
): ResolvedPin {
  const envPins = parseEnvPins(envOverride ?? process.env.VERSE8_GAMESERVER_BUILD_PIN);
  if (envPins[pkgBasename]) {
    return {
      nameArg: `@agent8/${pkgBasename}@${envPins[pkgBasename]}`,
      source: "env",
    };
  }
  const pkgPins = readPackageJsonPins();
  if (pkgPins[pkgBasename]) {
    return {
      nameArg: `@agent8/${pkgBasename}@${pkgPins[pkgBasename]}`,
      source: "package.json",
    };
  }
  return { nameArg: `@agent8/${pkgBasename}`, source: "default" };
}
