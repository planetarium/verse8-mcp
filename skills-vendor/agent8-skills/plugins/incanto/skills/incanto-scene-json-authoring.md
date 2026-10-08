---
name: incanto-scene-json-authoring
description: |
  Core document for reading and writing Incanto `*.scene.json` files — the JSON
  source of truth for every Incanto game.

  This document covers:
  - The scene file shape: format header, assets, input, physics, multiplayer, root tree, connections.
  - Node structure rules: delta-only props, unique sibling names, groups vs tags.
  - NodePath grammar (`Child/Grand`, `..`, `/Root/...`, `%Unique`).
  - Serialized signal wiring via `connections` (once, group/tag filters).
  - Sub-scene composition with `instance` + `overrides`.
  - Every hard error code the loader can raise and how to fix each one.

  Reference this document FIRST whenever you create, inspect, or modify any Incanto scene,
  node, or signal wiring — every other Incanto skill builds on it.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-scene-json-authoring.md` and follow its
   instructions — it always matches the INSTALLED engine version.
