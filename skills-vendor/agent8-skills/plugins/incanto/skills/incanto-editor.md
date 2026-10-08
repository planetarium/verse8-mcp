---
name: incanto-editor
description: |
  Core document for Incanto's visual scene composer — a page served from the installed
  package that renders a scene with the real engine and lets you arrange nodes and edit
  every prop (physics values included).

  This document covers:
  - Launching it: `bunx incanto-editor` (project mode — discovers every *.scene.json,
    picker + new-scene creation) or `bunx incanto-editor <scene.json>` (single file).
  - The three panes: scene tree (add/delete/select nodes), live engine viewport,
    schema-driven inspector (props, scene header, physics gravity, colliders).
  - Dirty tracking and saving back to the file (Save activates only on changes).
  - The postMessage protocol (ready/change/save/error) for embedding the editor in a
    host frontend's iframe — e.g. an agent8 container preview flow.

  Reference this document when a user wants to visually compose or tweak a scene, or
  when integrating the scene editor into a service UI.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-editor.md` and follow its
   instructions — it always matches the INSTALLED engine version.
