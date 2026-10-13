// Single source of truth for the Incanto vs R3F eval: pins, arms, seeds,
// run budget. Everything else imports from here.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.dirname(EVAL_DIR);
export const CACHE_DIR = path.join(EVAL_DIR, ".cache");
export const TEMPLATES_DIR = path.join(CACHE_DIR, "agent8-templates");
export const SEEDS_DIR = path.join(EVAL_DIR, "seeds");
export const RUNS_DIR = path.join(EVAL_DIR, "runs");

export const TEMPLATES_REPO = "planetarium/agent8-templates";
// main as of 2026-10-13 — the seven basic-3d templates are Incanto.
export const INCANTO_REF = "6f0fff50dfd53e822fcd98bcee5b9e86e201f762";
// Parent of 78f2ba5df ("the seven basic-3d templates are Incanto") — the
// last commit where the official 3D templates were vibe-starter-3d on R3F.
export const R3F_REF = "56b2e9e9f43ba0f08f0cf3a44fb4157f60668cd4";

// Plugins whose gate is `requiresPackage`. Ungated plugins (gameserver,
// localization) attach for every project and are reported separately.
export const ARMS = {
  incanto: { label: "Incanto", expectedGatedPlugins: ["incanto"], forbiddenDeps: [] },
  vibe: {
    label: "vibe-starter-3d (pre-switch official template)",
    expectedGatedPlugins: ["r3f", "vibe-starter-3d"],
    forbiddenDeps: ["incanto"],
  },
  r3f: {
    label: "Pure R3F",
    expectedGatedPlugins: ["r3f"],
    // A run that pulls either in has left the "R3F only" condition.
    forbiddenDeps: ["incanto", "vibe-starter-3d", "vibe-starter-3d-environment"],
  },
};

// One seed per (arm, template). The pure R3F arm uses a single seed for both
// prompts because there is no R3F-only character template.
//
// `patch: "sun-shadow-map-size"` drops `shadowMapSize` from the scene's
// DirectionalLight3D. The Incanto templates ship 4096, which renders only the
// background with three >= 0.182 (eval/README.md, Known issue); without the
// patch every Incanto run would start from a white screen. The shipped seed is
// kept for one diagnostic run (DIAGNOSTIC_RUNS) that is not scored per arm.
export const SEEDS = {
  "incanto-freeview": { arm: "incanto", ref: INCANTO_REF, template: "basic-3d-freeview", patch: "sun-shadow-map-size" },
  "incanto-quarterview": { arm: "incanto", ref: INCANTO_REF, template: "basic-3d-quarterview", patch: "sun-shadow-map-size" },
  "incanto-freeview-shipped": { arm: "incanto", ref: INCANTO_REF, template: "basic-3d-freeview" },
  "vibe-freeview": { arm: "vibe", ref: R3F_REF, template: "basic-3d-freeview" },
  "vibe-quarterview": { arm: "vibe", ref: R3F_REF, template: "basic-3d-quarterview" },
  "r3f-basic": { arm: "r3f", ref: R3F_REF, template: "basic-3d" },
};

export const SEED_FOR = {
  incanto: { P1: "incanto-freeview", P2: "incanto-quarterview" },
  vibe: { P1: "vibe-freeview", P2: "vibe-quarterview" },
  r3f: { P1: "r3f-basic", P2: "r3f-basic" },
};

// Does an agent notice the shipped white screen on its own? P1 requires
// real-time shadows, so the agent cannot sidestep it by turning them off. The
// first build answers that, so no follow-ups.
export const DIAGNOSTIC_RUNS = [{ id: "incanto-P1-shipped", arm: "incanto", prompt: "P1", rep: 1, seed: "incanto-freeview-shipped", followups: false }];

export const PROMPTS = ["P1", "P2"];
export const FOLLOWUPS = ["F1", "F2", "F3"];

// Fixed for every agent turn (first build and each follow-up).
export const RUN_BUDGET = {
  model: "claude-opus-5-5",
  effort: "high",
  maxToolCalls: 300, // design doc: 300 tool calls per turn
  maxBudgetUsd: 25, // per turn; a stop is recorded, the output is still scored
  wallClockMin: 60,
};

export const PILOT = { repeats: 2, shuffleSeed: 20261013 };

// Offline verse8 identity: checkpoint needs *a* token and an account in .env
// but never reaches the network with these (see eval/README.md).
export const OFFLINE_TOKEN = "eval-offline-token";
export const OFFLINE_ACCOUNT = "0x0000000000000000000000000000000000e5a1";
export const FAKE_ORIGIN = (id) => `https://gitlab.verse8.io/eval-local/${id}.git`;
