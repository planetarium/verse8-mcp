---
name: incanto-physics-and-input
description: |
  Core document for physics bodies and keyboard input in Incanto — Rapier-backed
  2D/3D physics with colliders-as-props and a declarative InputMap.

  This document covers:
  - Enabling physics (`enablePhysics2D`/`enablePhysics3D`, async, lazily loaded).
  - StaticBody / RigidBody / Area (trigger signals) / CharacterBody (moveAndSlide, isOnFloor).
  - Collider prop shapes per dimension, units, and gravity configuration.
  - Declaring input actions in scene JSON and querying them (isPressed/justPressed/getVector).
  - Pickup, teleport, and launch patterns.

  Reference this document when a user requests movement, jumping, collisions, gravity,
  triggers/pickups, or keyboard controls.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-physics-and-input.md` and follow its
   instructions — it always matches the INSTALLED engine version.
