<!-- Composed into AGENTS.md whenever this plugin is active — which is only when the project depends on vibe-starter-3d. Every line here costs prompt budget on every message. -->

## vibe-starter-3d Projects

This project is built on `vibe-starter-3d`: the scene is React Three Fiber, the player is a `RigidBodyPlayer`, and the camera comes from a view controller.

### Rules

- P0 (MANDATORY): Read the `vibe-starter-3d-*` skills before changing the player, the camera or a rigid body. The package's own docs under `node_modules/vibe-starter-3d/docs/` are what those skills point at, and they match the installed version
- P0 (MANDATORY): Do not add a second 3D engine to this project. If the user asks for something this stack cannot do, say so rather than installing another one alongside it
