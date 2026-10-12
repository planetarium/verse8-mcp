---
name: incanto-assets
description: |
  Core document for sourcing game art in Incanto.

  This document covers:
  - The built-in asset catalog shipped IN the npm package (animated characters,
    tiles, items) and the `incanto-assets` CLI (list / info / copy + ready-to-paste
    scene JSON snippets).
  - Using external/MCP-provided asset URLs in scene `assets{}` and converting
    library-convention animation JSONs via `spriteFromLibraryMeta`.
  - Art-free prototyping: ColorRect2D, particle presets, data-URI sprites.

  Reference this document whenever a game needs sprites, tiles, characters,
  models, or any visual asset — BEFORE inventing asset URLs.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-assets.md` and follow its
   instructions — it always matches the INSTALLED engine version.
