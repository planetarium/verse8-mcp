---
name: incanto-building-2d-games
description: |
  Core document for building 2D games with Incanto — sprites, spritesheet
  animation, cameras, text, and HUD on a y-down pixel coordinate system.

  This document covers:
  - The 2D coordinate convention (1 unit = 1px, (0,0) top-left, +y down, clockwise degrees).
  - Declaring textures/spritesheets in scene JSON assets and referencing them as `$key`.
  - Sprite2D / AnimatedSprite2D (JSON animation maps, frame ranges, autoplay).
  - Camera2D follow/smoothing/zoom/limits, Label text, and screen-space UILayer HUDs.
  - Group queries and `queueFree` patterns for pickups.

  Reference this document when a user requests 2D visuals: characters, sprites, animations,
  cameras, score displays, or anything drawn in a 2D scene.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-building-2d-games.md` and follow its
   instructions — it always matches the INSTALLED engine version.
