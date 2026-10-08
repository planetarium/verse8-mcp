<!-- Composed into AGENTS.md whenever this plugin is staged. Every line here costs prompt budget on every message — keep only what a later refactor cannot recover. -->

## Localization-Ready Text

CRITICAL:
Player-visible text is data, not code. It lives in one locale file from the very first build, so that adding a language later means adding a file — not hunting string literals through canvas calls, template strings, and conditionals.

The file is `src/locales/<language-code>.json`, named for the language the game's own text is written in — `en.json` for an English game, `ko.json` for a Korean one. There is no `strings.json`. A single-language game reads it directly, exactly like `assets.json`:

```js
import Text from './locales/en.json'
<button>{Text.ui.start}</button>
```

### Rules

- P0 (MANDATORY): Every string a player can see comes from the locale file — UI labels, dialogue, button text, tooltips, win/lose messages, and text drawn to canvas or Phaser. No display-string literals in code
- P0 (MANDATORY): Never assemble a sentence with `+`. Put a placeholder in the locale value (`"score": "Score: {n}"`) and substitute where it is used. A sentence carrying a grammatical particle (Korean 을/를, 이/가) lives in the value as one whole sentence, never assembled from fragments
- P0 (MANDATORY): When renaming a locale key, grep for every reference BEFORE changing it and update them all in the same response — the same rule `assets.json` keys already follow
- P0 (MANDATORY): Read the `localization` skill BEFORE adding a second language, translating existing text, or adding a language switcher, and `localization-proofread` before checking or cleaning up the game's wording
- P1 (RECOMMENDED): Group keys by where they appear (`ui.*`, `dialogue.*`, `hud.*`), and reuse one key wherever the same text appears — shared keys are what keep one item from being called three different things on three screens

### Not localized — leave these as they are

`console.log` and other dev-only logs, `DebugPanel.define` labels (builder-facing; players never see them), code identifiers, and `assets.json` keys.
