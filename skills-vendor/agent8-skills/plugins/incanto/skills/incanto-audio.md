---
name: incanto-audio
description: |
  Core document for sound in Incanto.

  This document covers:
  - Zero-asset PROCEDURAL SFX presets (coin / jump / hurt / explosion / laser /
    win …) — the art-free audio analog of the particle presets, synthesized on
    the fly with no files.
  - The AudioPlayer node: preset vs `src` file playback, autoplay + the browser
    gesture-unlock, the `finished` signal, and looping music.
  - Global volume buses (`engine.audio` master / sfx / music + mute).
  - The built-in audio catalog (real owner-licensed sound files) and the URL
    drop-in contract for more.

  Reference this document whenever a game needs sound, sfx, audio effects,
  music, or volume control.

  [Important] You must install the engine first: `bun add incanto three`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-audio.md` and follow its
   instructions — it always matches the INSTALLED engine version.
