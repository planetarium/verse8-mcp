---
name: incanto-localization
description: |
  Ship a game in more than one language: a scene-header `strings` table, `"@t:key"` text
  props, `engine.t()`, and a ready-made UiLanguageSelect that switches live and persists.
  English is the base — a key a locale omits falls back to it silently, on purpose. Use
  whenever a game needs a language other than English, or a language setting.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-localization.md` and
   follow its instructions — it always matches the INSTALLED engine version.
