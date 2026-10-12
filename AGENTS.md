# verse8-mcp — contributor notes

## Language

Write PR titles and bodies, commit messages, code comments and `docs/` in
English — this is a public repo and PRs #14–#19 set the convention.

## Commits and PRs

- Commit prefixes: `feat` · `fix` · `chore` · `docs` · `refactor` · `ci`,
  with an optional scope, e.g. `fix(instructions): …`.
- PR body sections, in this order: `## Problem` · `## How it was confirmed`
  (only when measured) · `## Why it diverged` · `## Changes` ·
  `## Verification` · `## Left out`.

## Checks

```bash
npm run build                       # tsc
npm test                            # smoke (needs GNU `timeout`) + unit
npm run check:subtree-sha           # skills-vendor/ matches package.json
bash scripts/verify-invariants.sh   # every listed invariant is tagged
```

More in [docs/development.md](docs/development.md).
