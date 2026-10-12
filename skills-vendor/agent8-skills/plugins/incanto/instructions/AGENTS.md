<!-- Composed into AGENTS.md whenever this plugin is active — which is only when the project depends on `incanto`. Every line here costs prompt budget on every message — keep only the rules that make an Incanto project behave differently from the React + Three.js projects the base instructions assume. -->

## Incanto Projects

Incanto is this platform's **3D** game engine. It belongs in a 3D game, and only when the project already depends on it or the user asks for Incanto by name. A 2D game uses the platform's 2D stack (the Phaser templates) — do not add Incanto to a 2D game, and do not start a 2D scene inside an Incanto project, unless the user explicitly asks for that. The engine can do 2D; on this platform it is not offered for it by default.

An Incanto game's structure is data: scenes, nodes, signals, input and multiplayer replication live in `src/*.scene.json` and the engine renders them. TypeScript is for the behaviours the JSON cannot express, and there is usually very little of it. The `incanto-*` skills are the engine's own documentation for the INSTALLED version — read them, do not write scene JSON from memory.

### Rules

- P0 (MANDATORY): The project already exists. It arrived from a start template, scaffolded and installed — never run `incanto new`, and never scaffold a second project inside it. `incanto-your-first-game` opens with a scaffold step (§1) written for someone starting from an empty directory; on this platform that section does not apply, so read it from §2
- P0 (MANDATORY): Read the `incanto-your-first-game` skill before the first edit, and `incanto-scene-json-authoring` before writing or changing any scene JSON. The engine hard-fails on an unknown prop, a wrong value kind, or a dangling connection — the skills are the difference between a scene that loads and one that does not
- P0 (MANDATORY): The Game Tuning Panel rule does not apply to an Incanto project. Gameplay and UI constants live in the scene — `constants`, node props, `script.props` — never in a `DebugPanel.define` schema. Do not add DebugPanel here; the panel the platform injects into the preview stays inert, and that is expected
- P0 (MANDATORY): Every asset URL is written in TWO places: `src/assets.json` (the platform's registry — the Resource tab reads and writes it) and the scene's `assets{}` (what the engine loads). Same URL in both. A scene entry needs `type` and `url`; a sprite sheet also needs `frameWidth` and `frameHeight`
- P0 (MANDATORY): Verify headless, in this container, before reporting done: `bunx incanto-check src` after every scene edit (add `--behaviors src/behaviors.ts` when the project has one), and `bun run verify` when the project ships a harness. Neither needs a browser
- P0 (MANDATORY): For multiplayer, read `gameserver-sdk` AND `incanto-multiplayer`. The server body is `node_modules/incanto/templates/agent8-server.ts`, dropped into the structured project the SDK's init creates — never hand-written
- P1 (RECOMMENDED): Reach for a built-in behaviour (`incanto-gameplay-behaviors`) before writing a class, and for a scene `connections[]` entry before a listener in code. Read `incanto-on-agent8` for how the preview, assets and publish work on this platform
