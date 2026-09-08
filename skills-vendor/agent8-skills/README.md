# agent8-skills

Skill documents for Agent8 AI.

## Setup

> **Important:** You must run the following command after cloning. Without this, the pre-commit validation will not work.

```bash
git config core.hooksPath .githooks
```

Validation needs [Bun](https://bun.sh) — the hook refuses to run without it. The same
checks run in CI on every pull request, so nothing merges unvalidated. To check the
whole repository at any time:

```bash
bun scripts/validate.ts
```

## Project Structure

```
skills/
  <skill-name>.md
plugins/
  <plugin-name>/       # manifest + assets + skills — see plugins/README.md
scripts/
  validate.ts          # rules enforced by the pre-commit hook and CI
.githooks/
  pre-commit
```

All skill documents are placed in the `skills/` directory. Only `.md` files are allowed.

Skills that ship **assets** (drop-in libraries, shims, config files) live under `plugins/`
instead — see **[plugins/README.md](plugins/README.md)** for the manifest format, delivery
semantics, and the develop-first branch discipline.

## Writing a Skill Document

### Filename Rules

- Extension: `.md`
- Length: 1-64 characters (excluding `.md`)
- Format: lowercase alphanumeric with single hyphen separators
- Regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

**Valid examples:** `gameserver-sdk-v2.md`, `environment-terrain.md`

**Invalid examples:** `My_Skill.md`, `--double-hyphen.md`, `UPPER.md`

### Frontmatter

Each skill document must start with YAML frontmatter. Only these fields are recognized:

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | Yes | Must match the filename (without `.md`), 1-64 characters |
| `description` | Yes | 1-1024 characters, supports multi-line YAML values |
| `license` | No | |
| `compatibility` | No | |
| `metadata` | No | String-to-string map |

Unknown frontmatter fields are ignored.

**Single-line example:**

```yaml
---
name: my-skill
description: A short description of what this skill does.
---
```

**Multi-line example (must use block scalar `|`):**

```yaml
---
name: my-skill
description: |
  Core document on managing something in a project.

  This document covers:
  - Feature A
  - Feature B

  [Important] You must install the package using `bun add my-package` before you can use it.
---
```

> **Note:** Multi-line descriptions without block scalar syntax (`|`) are **not valid YAML** and will be rejected by the pre-commit hook. After writing or editing a skill document, verify that the frontmatter renders correctly on GitHub.

The `name` field must exactly match the filename. For example, `my-skill.md` must have `name: my-skill`.

### Body

The content after the frontmatter closing `---` is the skill body. Use the `## Instructions` section to guide the AI on how to use the skill.

Common patterns (see [vibe-starter-3d-character.md](skills/vibe-starter-3d-character.md) for a full example):

1. **Instruct to install a package** — Tell the AI to install the required package before use.
   ```markdown
   1. Ensure the package is installed. If not, run: `bun add vibe-starter-3d`
   ```

2. **Instruct to read documentation from the package** — Point the AI to a docs file inside `node_modules/` so it can follow the detailed instructions.
   ```markdown
   2. Read the documentation file at `node_modules/vibe-starter-3d/docs/read_vibe_starter_3d_character.md` and follow its instructions.
   ```

## Skill Verification with skill-creator

> **Required:** Before submitting a PR for any new or modified skill document, you must verify the skill using the `skill-creator` plugin.

Run `/skill-creator:skill-creator` in Claude Code to perform the following verification steps:

1. **Structure check** — Validate frontmatter fields, filename rules, and document structure.
2. **Execution test** — Run test prompts with the skill applied (`with_skill`) and without (`without_skill`) to compare output quality.
3. **Review results** — Examine the generated benchmark report and qualitative outputs to confirm the skill produces correct, reliable code.

Include the verification results (pass rates, key findings) in your PR description. PRs without verification evidence may be rejected.

### Example PR Description

```markdown
## Skill Verification Results

| Test Case | with_skill | without_skill |
|-----------|-----------|--------------|
| TPS keyboard projectile | 100% (8/8) | 37.5% (3/8) |
| FPS mouse bullet | 100% (9/9) | 67% (6/9) |

Key findings:
- Collision group setup: 0% baseline → 100% with skill
- Direction calculation: correctly uses rigidBody.rotation() for TPS
```

## Pre-commit Hook

`.githooks/pre-commit` delegates all validation to `scripts/validate.ts` — the same script CI
runs on every pull request, so a rule can never hold in the hook but not in CI, or vice versa.

Before running, the hook materializes the git index into a temporary tree
(`git checkout-index`) and validates that tree, not the working directory — so what gets
checked is exactly what is about to be committed, including changes that are staged but not
yet saved to disk, and excluding unstaged edits to already-tracked files.

It covers both `skills/` and `plugins/`: filename and frontmatter rules for every skill
document (see [Filename Rules](#filename-rules) and [Frontmatter](#frontmatter) above), plus
plugin manifest rules, asset constraints, the symlink ban, code-asset syntax checks, and
cross-repo skill-naming collisions (see [plugins/README.md](plugins/README.md)). The one thing
the hook skips is each plugin's own `tests/` — those run under `bun test` in CI instead, since
spawning them on every commit would add seconds to each one.

Bun is required; the hook refuses to run without it (see [Setup](#setup) above).
