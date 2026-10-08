---
name: incanto-save-slots
description: |
  Continue where you left off — Behavior serialize()/deserialize(),
  engine.captureState()/restoreState(), and a SaveSlots layer over the save store. A save
  carries behavior state keyed by node uid and reloads the scene from source rather than
  snapshotting the tree. Use for any game with progress worth keeping.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-save-slots.md` and
   follow its instructions — it always matches the INSTALLED engine version.
