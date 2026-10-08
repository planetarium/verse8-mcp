---
name: localization
description: "Use when the builder asks to add a language, translate the game, support English/Korean/Japanese, add a language switcher, or make the game playable for another region (영어로도 되게 해줘, 다국어, 번역, 언어 선택, 글로벌), and when text has to be pulled out of an existing game that never followed the locale-file rule. Covers the second-locale procedure, the glossary of terms that must not be freely translated, and the four things that actually break when a game changes language."
---

# Adding a language to a game

The always-on rules already put every player-visible string in `src/locales/<language-code>.json`. This skill covers what happens the moment a second language appears — the mechanics, and the four failures that only show up after the switch.

## If you remember nothing else

1. **Adding a language adds a file. It never renames the first one.** The game's original locale file keeps its name forever, and that first language is the fallback for every other.
2. **A missing key never reaches the player.** Fall back to the default locale, and if that fails too, render nothing and warn in the console — a bare `ui.start` on screen is worse than empty space.
3. **The glossary is an exception list, not a dictionary.** Only terms that must not be freely translated go in it. A made-up item name is an ordinary key.
4. **Translating is not enough.** Length, fonts, and grammar break independently of whether the words are right.

## Procedure: adding the second language

1. **Copy the file, translate the values, keep every key identical.** An English game adding Korean copies `src/locales/en.json` → `src/locales/ko.json`; a Korean game adding English goes the other way. A key present in one file and missing in the other is the bug this structure exists to prevent.
2. **Add `src/locales/index.ts`** (it does not exist while the game is single-language):

```ts
import en from './en.json'
import ko from './ko.json'

const DEFAULT_LOCALE = 'en'          // the language the game's text was written in
const LOCALES = { en, ko } as const
type Locale = keyof typeof LOCALES

function resolve(): Locale {
  const saved = localStorage.getItem('locale')
  if (saved && saved in LOCALES) return saved as Locale
  const want = navigator.language.slice(0, 2)
  return (want in LOCALES ? want : DEFAULT_LOCALE) as Locale
}

const current = resolve()

function read(locale: Locale, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
    LOCALES[locale],
  )
}

export function t(path: string, vars?: Record<string, string | number>): string {
  const raw = read(current, path) ?? read(DEFAULT_LOCALE, path)
  if (typeof raw !== 'string') {
    console.warn(`[i18n] missing key: ${path}`)
    return ''
  }
  return vars ? raw.replace(/\{(\w+)\}/g, (whole, key) => String(vars[key] ?? whole)) : raw
}

export function setLocale(next: Locale): void {
  localStorage.setItem('locale', next)
  location.reload()
}

export const locales = Object.keys(LOCALES) as Locale[]
export const activeLocale = current
```

3. **Replace direct reads with `t()`.** `Text.ui.start` → `t('ui.start')`, `Text.hud.score` with a number → `t('hud.score', { n: score })`. Grep for the old import to find every call site:

```bash
grep -rn "locales/en.json" src   # whichever file the game already imports
```

4. **Add a switcher only if the builder asked for one.** Without it the language follows the player's browser, which is the right default. With it, call `setLocale('ko')` — the reload keeps the implementation to one line instead of threading locale state through the whole game.

## The glossary: `src/locales/glossary.json`

Created when translation starts, not before. It holds **only** terms that must not be freely translated:

```json
{
  "brand.studio_name": { "policy": "fixed" },
  "npc.guide":         { "policy": "official", "ko": "안내인", "en": "Guide" }
}
```

- **`fixed`** — identical in every language: brand and service names, player-entered nicknames, code-like strings. Translating them makes them wrong.
- **`official`** — the term already has an established form in each language. This is not "do not translate", it is "do not invent a translation — use the established one". Take the wording from wherever that term is defined for this project; never make one up. If no source is available, ask the builder rather than guessing.
- **Everything else stays out.** An invented item name (`Infinite Sword` → `무한의 검`) is an ordinary locale key. Consistency across screens is already guaranteed by keys being shared, not by listing nouns here.

## What actually breaks

**Length.** Korean ↔ English swings 1.5–2×. Fixed-width buttons, `white-space: nowrap`, and text positioned by absolute pixel coordinates on canvas all clip or overflow the moment the language changes. Let containers size to their content, and measure canvas text (`ctx.measureText`) instead of assuming a width.

**Glyphs.** A bitmap font or a webfont without the target language's characters renders tofu boxes (□□□). Prefer a system stack (`sans-serif` resolves to a font with the local glyphs on every platform); if a webfont is required it must come from an approved resource in `assets.json` like any other asset. This bites hardest in Phaser and raw canvas text, where nothing warns you.

**Grammar.** English pluralizes (`1 coin` / `2 coins`); Korean attaches particles by the preceding syllable's final consonant (`검을` / `방패를`). Neither survives sentence fragments glued together in code. Keep the whole sentence in the value — write two keys if a language genuinely needs two forms, rather than building one from parts.

**Word order.** `t('found', { item: … })` works with `"Found {item}!"` in English and `"{item}을(를) 찾았다!"` in Korean only because the placeholder moves with the sentence. Never concatenate around a variable in code — the other language will need it somewhere else in the sentence.

## Retrofitting a game that ignored the rule

Some games predate these rules. Extract before translating — translating scattered literals guarantees missed ones.

```bash
grep -rn "'[^']*[가-힣][^']*'" src                 # Korean literals
grep -rnE '>[^<>{}]{2,}<' src --include='*.tsx'    # JSX text nodes
grep -rnE '\.(setText|fillText|strokeText)\(' src  # canvas / Phaser text
```

The first pattern works because Hangul cannot appear in an identifier — every hit is display text. English has no such tell (`'player'` is a key, `'Player'` may be a label), so for an English game the structural greps above are the reliable ones, and quoted strings have to be judged by where they are passed.

Move each hit into the locale file with a key named for where it appears, replace it at the call site, then re-run the greps until only non-display strings remain (dev logs, `DebugPanel.define` labels, identifiers). Do this as one pass and tell the builder what moved — a half-extracted game is worse than an untouched one, because the remaining literals are now invisible.

## Reply language

Everything said to the builder is written in the builder's language. Key paths (`ui.start`), file names, and policy words (`fixed`, `official`) stay as they are.
