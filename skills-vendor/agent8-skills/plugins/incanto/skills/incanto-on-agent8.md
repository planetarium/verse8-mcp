---
name: incanto-on-agent8
description: |
  How an Incanto game lives on the agent8 platform — the parts the engine's own
  skills cannot know because they belong to this container, not to the engine.

  This document covers:
  - No `incanto new` here — a project arrives from a start template; the vite
    plugin, what restarts the preview and what hot-reloads.
  - Assets in two places: `src/assets.json` for the platform, the scene's `assets{}`
    for the engine — and the exact shape of each.
  - The preview: the platform's own dev server, editor saves arriving as user commits,
    the ☰ debug overlay for the preview only, why the 🔧 tuning panel is inert.
  - Verifying without a browser (`incanto-check`, `incanto-playtest`, `incanto-verify`).
  - Publishing (`vite build`, `base: './'`, `dist/index.html`) and multiplayer wiring order
    with the GameServer SDK.

  Read this whenever the task touches assets, the preview, verification, publishing
  or multiplayer. Read the `incanto-*` engine skills for the engine itself.
---

# Incanto on agent8

The `incanto-*` skills are the engine's documentation, shipped inside the package so they
always match the installed version. This one is the platform's half: what is different
about building an Incanto game *in this container*.

## 3D only, here

Incanto is offered on this platform for 3D games. The engine has a full 2D half
(`incanto-building-2d-games`), and a user who asks for Incanto in 2D by name can have
it — but a 2D request on its own goes to the platform's Phaser templates, not here. Do not
add the engine to a 2D project, and do not start a 2D scene inside an Incanto project,
without that explicit ask.

## The project already exists

Every project here is created from a start template and handed to you scaffolded, with its
dependencies installed. **There is no `incanto new` step on this platform** — the engine's
own walkthrough (`incanto-your-first-game` §1) opens with one because it is written for
someone starting in an empty directory, and that is the one section of it that does not
apply here. Read it from §2.

The 3D start templates already depend on `incanto`. If you are somehow in a project that
does not, `bun add incanto three` adds it — but check `package.json` before assuming you
need to.

`react` and `react-dom` are already in every platform template; Incanto's scaffold shape is
the same — `src/main.tsx` mounts `<App />`, `src/App.tsx` owns one `<canvas>` and boots the
engine into it. The `incanto-web-integration` skill shows that component; copy it rather
than reaching for `<IncantoCanvas>`, which is for embedding a game inside a larger site.

`vite.config.ts` needs the engine's plugin next to `react()`:

```ts
import react from '@vitejs/plugin-react';
import { incantoScenes } from 'incanto/vite';
export default defineConfig({ base: './', plugins: [react(), incantoScenes()] });
```

`incantoScenes()` validates every `*.scene.json` the moment it is saved and serves the
project's scenes to the in-game editor. It is dev-only; nothing of it reaches a build.

**What restarts the preview and what does not.** The platform keeps its dev server alive
across your turns and lets Vite HMR pick your edits up. Editing a scene, a behaviour or
`App.tsx` hot-reloads. Editing `package.json` (a `bun add`), `vite.config.ts`, `.env` or
anything under `server/` makes the platform rebuild and restart the preview after your
turn — expected, and a few seconds.

## Assets live in two places

The platform's registry is `src/assets.json` — the Resource tab reads it and writes to it
when the user uploads or picks something, and the base rules say every URL you use must be
in it. The engine reads the scene's `assets{}` and nothing else. So the same URL is written
twice, once in each shape:

```json
// src/assets.json — platform: CATEGORY → KEY → { url, description?, metadata? }
{ "characters": { "knight": { "url": "https://agent8-games.verse8.io/assets/3d/characters/human/knight.glb",
                              "description": "Knight, humanoid, Mixamo rig" } } }
```

```json
// src/game.scene.json — engine: key → { type, url } (a sheet also needs frameWidth/frameHeight)
"assets": { "knight": { "type": "model", "url": "https://agent8-games.verse8.io/assets/3d/characters/human/knight.glb" } }
```

Nodes reference the scene entry as `"$knight"`. Keep the keys the same in both files so a
rename is one grep. Only `agent8-games.verse8.io` URLs and user uploads are allowed — the
base rules apply unchanged.

## The preview

It is the platform's Vite dev server, proxied into the user's browser. You never start it,
and the base rule stands: never run `bun run dev`, `vite`, or any server command.

**Editor saves come back to you as user commits.** The in-game editor (☰ debug ▸ ✎ edit
this scene) writes the scene through `incantoScenes()` into `src/*.scene.json`. The
platform commits that as `The user changed the files.` and injects a notice into this
session. Treat it as an intentional edit: re-read the scene before touching it, and build
on it rather than reverting it.

**The ☰ debug overlay, the editor and the 📚 asset library are on in the preview
without any file in the project.** The platform sets `VITE_INCANTO_DEBUG=1` and
`V8_ACCESS_TOKEN` on the preview's dev server; `createGame3D({ debug, editor })` and
`incantoLibrary()` read them from there. A published build sees neither, so it stays clean.
Do not write either variable into `.env`, `.env.development` or any other project file —
`.env` is the platform's, and a file would carry the flag into `vite build`.

**The 🔧 panel is inert here, on purpose.** The platform injects its tuning panel into every
preview. An Incanto game registers nothing with it: tuning values live in the scene and the
☰ overlay's Inspector edits them live. Leave the wrench alone and do not wire
`DebugPanel.define`.

## Verifying without a browser

This container has no browser, and the headless tools are what the engine's own gate uses:

```bash
bunx incanto-check src --behaviors src/behaviors.ts   # every scene loads; every prop is real
bunx incanto-playtest src/game.scene.json --behaviors src/behaviors.ts   # a seeded bot plays it
bunx incanto-verify src/game.scene.json --behaviors src/behaviors.ts     # the whole ladder
bun run verify                                         # the project's own harness, if it ships one
```

`incanto-check` after every scene edit; `bun run verify` (or `incanto-verify`) before you
report done. `incanto-frame` and `incanto-logs` ask a page over the dev server's HMR channel
and are for a workstation with a browser — the `incanto-verifying-your-game` skill explains
every rung.

## Publishing

The platform publishes with `vite build --base ./` and needs `dist/index.html`. Incanto's
config already has `base: './'`, the Rapier physics builds load lazily only when a scene has
bodies, and the editor chunk only if someone opens it — nothing to configure. A 3D game's
eager payload is around 1.4 MB.

## Multiplayer on this platform

Read `gameserver-sdk` for the server side and `incanto-multiplayer` for the engine side,
then wire them in this order:

1. `bun add @agent8/gameserver` — the optional peer the agent8 transport needs.
2. `bunx @agent8/gameserver-node init` — creates the structured `server/` project. Do not
   hand-create it.
3. Replace `server/src/server.ts` with the body of
   `node_modules/incanto/templates/agent8-server.ts`. It implements exactly the room
   protocol the engine's `NetworkManager` speaks; a game proven on the in-memory Loopback
   transport runs live by swapping the transport and nothing else.
4. On the client, boot the manager with `createAgent8Server()` and **no arguments** — verse,
   account and auth resolve from the platform's own `.env`. Never write a token or a verse
   id into source.
5. Replace init's example test (it tests `ping`, which the kernel does not have) with tests of the
   kernel functions you keep, then `bunx @agent8/gameserver-node test` and `build`; the platform
   deploys `server/` with the next publish.
