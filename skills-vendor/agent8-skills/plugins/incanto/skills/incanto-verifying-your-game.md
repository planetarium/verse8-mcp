---
name: incanto-verifying-your-game
description: |
  Core document for verifying an Incanto game WITHOUT a browser — the agent's
  self-verification loop.

  This document covers:
  - `bunx incanto-check`: headless validation of every *.scene.json (run after every edit).
  - `runScript` from `incanto/test`: scripted gameplay by action intent with inline
    assertions, periodic snapshots, seeded determinism.
  - `captureScene`/`describeCapture`: the scene state as a grep-able text screenshot.
  - `validateScene` for programmatic checks and the `incanto/vite` save-time validator.
  - Reading behavior logs (`this.log`) from a headless run.

  Reference this document after every scene/behavior change, before declaring any
  game feature done, or when a user asks whether the game actually works.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-verifying-your-game.md` and follow its
   instructions — it always matches the INSTALLED engine version.
