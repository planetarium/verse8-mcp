<!-- Composed into AGENTS.md whenever this plugin is active — which is only when the project depends on vibe-starter-3d-environment. Every line here costs prompt budget on every message. -->

## vibe-starter-3d-environment Projects

This project has `vibe-starter-3d-environment` installed: terrain, water, grass, weather, stages, triggers and the model placer come from it rather than being built by hand.

### Rules

- P0 (MANDATORY): Read the matching `vibe-starter-3d-environment-*` skill before generating terrain, water, vegetation, weather or a stage layout. Each one points at the package's own doc for the installed version
- P0 (MANDATORY): Initialize the player's starting position against the terrain the way `vibe-starter-3d-environment-terrain` describes — a character placed without it falls through the world
