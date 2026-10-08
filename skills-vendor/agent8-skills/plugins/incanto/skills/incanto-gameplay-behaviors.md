---
name: incanto-gameplay-behaviors
description: |
  The batteries-included game-logic library shipped with Incanto (incanto/gameplay).

  Ready-made Behaviors you wire from scene JSON with ZERO custom code:
  - Health (hit points, i-frames, regen), Lifetime (self-destruct timers)
  - ScoreKeeper (score / lives / win-lose state hub)
  - Pickup (collectibles) + Collector (collect-N tally)
  - DamageOnContact (projectiles, spikes, hazards)
  - Interactable (press-to-use doors / levers / NPCs)

  They auto-register in createGame2D/3D and compose through scene `connections`.

  Reference this document when a game needs health, score, pickups, damage,
  timers, or interaction — BEFORE hand-rolling them as custom behaviors.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-gameplay-behaviors.md`
   and follow its instructions — it always matches the INSTALLED engine version.
