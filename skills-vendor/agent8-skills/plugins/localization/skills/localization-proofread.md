---
name: localization-proofread
description: "Use when the builder asks to check or clean up the game's text — proofreading, typos, spelling, spacing, wording, tone, or whether the translations are any good (맞춤법, 오타, 문장 검수, 텍스트 다듬어줘, 번역 확인, 어색한 문장), and before shipping a game whose text has grown. Checks the locale files two ways: a script for the things that break at runtime (missing keys, lost placeholders, glossary violations) and a reading pass for language."
---

# Proofreading the game's text

Every player-visible string already lives in `src/locales/`. That makes this job small and worth doing well: one file to read, one file to fix, and a diff the builder can see.

## If you remember nothing else

1. **Only locale files change.** Never edit code during a proofread, and never rename a key — the code references it by name.
2. **Run the script before reading anything.** Missing keys and dropped placeholders are the failures that reach players as blank text or a literal `{n}`, and they are exactly what an eye skips in a list of two hundred strings.
3. **The glossary is off limits.** Terms listed there were fixed on purpose; "correcting" them is the one edit guaranteed to be wrong.
4. **Report what changed, not that you checked.** The builder wants the list of before/after, in their language.

## Step 1: the mechanical pass

Write this to a file and run it. It reports only problems; silence means clean.

```bash
cat > /tmp/locale-check.mjs <<'EOF'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'src/locales'
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'glossary.json')
if (files.length === 0) { console.log('no locale files'); process.exit(0) }

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

const locales = {}
for (const f of files) locales[f.replace(/\.json$/, '')] = flatten(JSON.parse(readFileSync(join(dir, f), 'utf8')))

const names = Object.keys(locales)
const base = names[0]
const problems = []
const placeholders = (s) => (typeof s === 'string' ? [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort() : [])

// Keys present in one locale but not another: the missing side renders nothing.
const allKeys = new Set(names.flatMap((n) => Object.keys(locales[n])))
for (const key of allKeys) {
  const missing = names.filter((n) => !(key in locales[n]))
  if (missing.length) problems.push(`MISSING KEY  ${key} — absent in ${missing.join(', ')}`)
}

for (const key of allKeys) {
  // A placeholder dropped in translation prints the sentence without its number.
  const sets = names.filter((n) => key in locales[n]).map((n) => [n, placeholders(locales[n][key]).join(',')])
  const distinct = new Set(sets.map(([, p]) => p))
  if (distinct.size > 1) {
    problems.push(`PLACEHOLDER  ${key} — ${sets.map(([n, p]) => `${n}:{${p || 'none'}}`).join(' vs ')}`)
  }
  for (const n of names) {
    const v = locales[n][key]
    if (typeof v === 'string' && v.trim() === '') problems.push(`EMPTY        ${key} — blank in ${n}`)
  }
}

// Glossary: terms that were pinned on purpose.
const glossaryPath = join(dir, 'glossary.json')
if (existsSync(glossaryPath)) {
  const glossary = JSON.parse(readFileSync(glossaryPath, 'utf8'))
  for (const [key, entry] of Object.entries(glossary)) {
    const present = names.filter((n) => key in locales[n])
    if (entry.policy === 'fixed') {
      const values = new Set(present.map((n) => locales[n][key]))
      if (values.size > 1) problems.push(`GLOSSARY     ${key} — 'fixed' but differs across locales`)
    }
    if (entry.policy === 'official') {
      for (const n of present) {
        if (entry[n] !== undefined && locales[n][key] !== entry[n]) {
          problems.push(`GLOSSARY     ${key} — ${n} is "${locales[n][key]}", official form is "${entry[n]}"`)
        }
      }
    }
  }
}

// Keys the code asks for that no locale defines: these render as empty space.
const referenced = new Set()
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(d, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!/\.(ts|tsx|js|jsx)$/.test(e.name)) continue
    const src = readFileSync(p, 'utf8')
    for (const m of src.matchAll(/\bt\(\s*['"`]([\w.]+)['"`]/g)) referenced.add(m[1])
  }
}
if (existsSync('src')) walk('src')
for (const key of referenced) {
  if (!(key in locales[base])) problems.push(`NO SUCH KEY  ${key} — used in code, not in ${base}.json`)
}

console.log(problems.length ? problems.join('\n') : 'clean')
EOF
bun /tmp/locale-check.mjs
```

Fix what it reports before reading a single sentence:

- `MISSING KEY` / `NO SUCH KEY` — write the missing string. If the key is used in code but nothing defines it, read the call site to see what it should say.
- `PLACEHOLDER` — the translation lost `{n}`. Rewrite that value so the placeholder is back in a position the sentence supports.
- `EMPTY` — same as missing.
- `GLOSSARY` — take the glossary's wording. It is the source of truth, not the locale file.

## Step 2: the reading pass

Now read the values themselves. Look for, in this order:

1. **Spelling and spacing.** Korean spacing is where machine-written text slips most (`할수있다`, `안됩니다` vs `안 됩니다`).
2. **Speech level, held constant.** A game that says `시작하기` on one button and `게임을 시작하시겠습니까?` in the next dialog is two games. Pick whichever the majority already uses and bring the rest to it — do not "upgrade" everything to formal.
3. **Translationese.** Text produced alongside another language often keeps that language's shape: `당신의 점수` for `Your score`, `~것을 시도하다`. Write what a Korean game would actually say.
4. **Length.** A value several times longer than its neighbours in the same group is about to break the button it sits in. Shorten it or tell the builder.

Skip anything listed in `glossary.json`, and leave invented proper nouns alone — an item called `무한의 검` is a name, not a phrase to improve.

**Do not touch what you are unsure about.** A deliberate stylistic choice reads exactly like a mistake to a proofreader: slang, a character's verbal tic, a deliberately clumsy tutorial voice. When a line looks wrong but might be intentional, list it as a question instead of changing it.

## Applying and reporting

Edit the locale files only, then tell the builder what moved, grouped and in their language:

```
텍스트 검수 완료 — 7곳 수정

맞춤법·띄어쓰기 (4)
  ui.start_hint    "게임을 시작할수 있습니다" → "게임을 시작할 수 있습니다"
  ...

말투 통일 (2)  — 존댓말이 다수라 반말 2곳을 맞췄습니다
  ...

무결성 (1)
  hud.score        en에 {n}이 빠져 있어 점수가 표시되지 않던 것을 복구

확인이 필요한 1곳
  dialogue.npc_greet  "안녕하신가 젊은이여" — 캐릭터 말투로 보여 그대로 두었습니다
```

Numbers first, details after: a builder scanning that block wants to know how much changed before they read what.

## When the game has one language

All of this still applies except the cross-locale checks, which have nothing to compare. The script reports what it can and stays quiet about the rest.
