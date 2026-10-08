---
name: incanto-3d-models
description: |
  Core document for using 3D model files (GLB/glTF and VRM) in Incanto.

  This document covers:
  - The `bunx incanto-model <file>` inspector CLI: reports a model's REAL size
    (transformed bounding box), node hierarchy, animation clip names + durations,
    materials, and VRM avatar meta — the numbers an agent needs to size and place a
    model instead of guessing from the file name.
  - Declaring model assets in scene JSON and the ModelInstance3D node (model,
    targetHeight sizing, animation autoplay, shadows).
  - VRM specifics (facing fix, humanoid info) and v1 limitations.

  Reference this document whenever a scene should display a .glb/.gltf/.vrm file —
  and ALWAYS run the inspector before placing an unfamiliar model.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-3d-models.md` and follow its
   instructions — it always matches the INSTALLED engine version.
