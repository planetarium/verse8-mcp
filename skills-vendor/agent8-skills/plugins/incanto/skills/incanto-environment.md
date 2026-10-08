---
name: incanto-environment
description: |
  Core document for generating game environments in Incanto.

  This document covers:
  - The deterministic `incanto-env` CLI: seeded generators that emit
    scene-insertable NodeJson (FPS arenas, voxel heightfield terrain, 2D
    platform courses) and `--into scene.json --at <path>` insertion.
  - The `incanto/env` library: generateArena / generateTerrain /
    generateScatter (weighted item templates) / generatePlatforms2D and the
    pure insertIntoScene helper.
  - The shader-water `Water3D` node — FBM waves, CubeCamera reflections,
    opt-in shoreline foam, and character interaction (`entered`/`exited`
    signals + ripple ring waves when bodies hit the surface).

  Reference this document whenever a game needs a level, stage, arena,
  terrain, platform course, scattered props, or water — BEFORE hand-authoring
  large repetitive scene subtrees.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-environment.md` and follow its
   instructions — it always matches the INSTALLED engine version.
