<!-- Composed into AGENTS.md whenever this plugin is active — which is only when the project depends on @react-three/fiber. Every line here costs prompt budget on every message. -->

## React Three Fiber Projects

3D is React Three Fiber (JSX under `<Canvas>`); the template's AGENTS.md and PROJECT/Structure.md take precedence. basic-3d-r3f-* templates: player = kinematic `src/game/player.ts`, frame state = mutable objects in `src/game/state.ts` (no React state), rapier only for dynamic bodies in lazy `src/physics/`.

### Rules

- P0 (MANDATORY): Read `r3f-rapier-essentials` before adding physics, colliders or sensors — the collider-group and body-type choices are where an R3F scene goes wrong, and the skill names the ones that matter
- P0 (MANDATORY): Never put a component that renders HTML inside `<Canvas>`. UI lives outside it in `src/components/ui/`, 3D inside it in `src/components/r3f/`
- P1 (RECOMMENDED): Reach for the matching `r3f-*` skill before writing the code yourself — `r3f-projectile-systems` for anything fired, `r3f-character-sync` for multiplayer characters, `r3f-tree` for vegetation, `r3f-input-system` for unified mobile and desktop input
- P1 (RECOMMENDED): Before building terrain, a maze / 미로 / labyrinth / dungeon / 던전 / arena / 아레나, water, grass, weather, prop placement, NPC movement or trigger zones, read `r3f-terrain`, `r3f-stage-maze`, `r3f-water`, `r3f-grass`, `r3f-weather`, `r3f-model-placer`, `r3f-navigator` or `r3f-trigger` — paste-in project code, no extra package
- P1 (RECOMMENDED): Don't leave ground, walls, cover or platforms flat-colored when a texture exists; prefer resource-context models for enemies, NPCs, props and trees over primitives; a user-chosen style wins
- P1 (RECOMMENDED): When environment assets load lazily (textures, ez-tree), connect their ready signal (`envReady` in the r3f-* recipes) to the title / loading gate so the play screen never shows placeholders
- P1 (RECOMMENDED): Never replace the player character (`Character.tsx`, verse8 base-model) with a capsule or another model unless the user asks
- P1 (RECOMMENDED): Leave three's shared `DefaultLoadingManager` alone — no `.abort()` (the character GLB's embedded textures load through it after the file arrives: aborted → white character, "GLTFLoader: Couldn't load texture blob:") and no `onLoad`/`onProgress`/`onStart`/`onError` overrides (they replace drei `useProgress`, so `envReady` and the loading gate never see the end); for "stop waiting", end your `envTask` instead
