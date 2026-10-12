<!-- Composed into AGENTS.md whenever this plugin is active — which is only when the project depends on @react-three/fiber. Every line here costs prompt budget on every message. -->

## React Three Fiber Projects

This project's 3D is React Three Fiber: the scene is a JSX tree under `<Canvas>`, physics is `@react-three/rapier`, and state lives in Zustand stores.

### Rules

- P0 (MANDATORY): Read `r3f-rapier-essentials` before adding physics, colliders or sensors — the collider-group and body-type choices are where an R3F scene goes wrong, and the skill names the ones that matter
- P0 (MANDATORY): Never put a component that renders HTML inside `<Canvas>`. UI lives outside it in `src/components/ui/`, 3D inside it in `src/components/r3f/`
- P1 (RECOMMENDED): Reach for the matching `r3f-*` skill before writing the code yourself — `r3f-projectile-systems` for anything fired, `r3f-character-sync` for multiplayer characters, `r3f-tree` for vegetation, `r3f-input-system` for unified mobile and desktop input
