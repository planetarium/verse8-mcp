---
name: incanto-node-reference
description: |
  The complete GENERATED reference of every Incanto node type — exact prop names,
  defaults, kinds, and signals — plus the machine-readable JSON Schema for scene files.

  This document covers:
  - All node types across `incanto`, `incanto/2d`, `incanto/3d`, and `incanto/net`.
  - Every prop with its default value (props are delta-only: write only non-default values).
  - The signals each node emits.
  - `node_modules/incanto/schemas/scene.schema.json` for validating whole scene files.

  Reference this document when you need an exact prop name or default, when choosing which
  node type to use, or when validating a scene JSON before loading it.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-node-reference.md` and follow its
   instructions — it always matches the INSTALLED engine version.
