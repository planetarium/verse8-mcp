---
name: incanto-behaviors-and-scripts
description: |
  Core document for attaching game logic to Incanto's JSON nodes — the Behavior
  system, Timer, and the zero-code CharacterController2D.

  This document covers:
  - Writing a Behavior class, registering it, and attaching it via `"script"` in scene JSON.
  - The three-artifact contract (JSON name ↔ TS class ↔ registerBehavior call).
  - Routing JSON `connections` to behavior methods.
  - Timer (the serializable game clock) and CharacterController2D (JSON-only playable
    platformer/top-down characters).

  Reference this document when a user requests game rules, scoring, custom logic on a node,
  timed events, or a playable character without writing movement code.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-behaviors-and-scripts.md` and follow its
   instructions — it always matches the INSTALLED engine version.
