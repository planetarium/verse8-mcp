---
name: incanto-building-3d-games
description: |
  Core document for building 3D games with Incanto — meshes, lights, cameras,
  and the scene environment on three.js.

  This document covers:
  - The 3D node taxonomy: Node3D transforms (degrees), MeshInstance3D primitives + materials,
    Camera3D, DirectionalLight3D / OmniLight3D.
  - The scene-level `environment` header (ambient light, background color).
  - Composition patterns: pivots, transform inheritance, plain-Node transparency.
  - The Engine + Renderer3D boot sequence.

  Reference this document when a user requests 3D visuals: placing or styling meshes,
  lighting a scene, positioning cameras, or composing 3D hierarchies.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-building-3d-games.md` and follow its
   instructions — it always matches the INSTALLED engine version.
