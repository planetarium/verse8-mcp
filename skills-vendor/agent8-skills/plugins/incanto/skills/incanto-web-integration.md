---
name: incanto-web-integration
description: |
  Core document for embedding an Incanto game inside a web app.

  This document covers:
  - `incanto/react`: the `<IncantoCanvas>` component (StrictMode-safe boot/teardown),
    `useGame`/`useEngine`/`useNodeProp`/`useSignal` hooks, DOM HUD overlay children.
  - Choosing DOM overlays vs in-canvas `UILayer` UI, and pinning DOM to world positions.
  - Next.js / SSR notes (all entries import in Node), vanilla `createGame` embeds,
    responsive canvas sizing, bridging game state to web UI.

  Reference this document when a user wants the game inside a React/Next/website page,
  a React HUD, or web-UI ↔ game-state wiring.

  [Important] You must install the engine first: `bun add incanto three`
  (plus `react` for the React layer).
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-web-integration.md` and follow its
   instructions — it always matches the INSTALLED engine version.
