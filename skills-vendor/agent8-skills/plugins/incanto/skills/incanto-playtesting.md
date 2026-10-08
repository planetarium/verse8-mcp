---
name: incanto-playtesting
description: |
  The engine plays your game and reports whether it works — `bunx incanto-playtest` runs
  seeded headless bot sessions and reports win rate, unreachable destinations, wires that
  never fire, falls out of the world, and whether anything can hurt the player. Failing
  runs come back as replays. Use after a level or game loop is in place, before handing
  the game back.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-playtesting.md` and
   follow its instructions — it always matches the INSTALLED engine version.
