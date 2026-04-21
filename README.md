# @verse8/mcp

Verse8 MCP meta-server — auto-detects `gitlab.verse8.io` projects and exposes verse8 skills, image / asset generation tools, preview orchestration, and git checkpoint capabilities to any Model Context Protocol host (Claude Code, Claude Desktop, Codex, Cursor, opencode, Continue, …).

- **Package**: `@verse8/mcp`
- **Binary**: `verse8-mcp` (stdio MCP server)
- **Invocation**: `npx -y @verse8/mcp` (single-bin package — npx picks `verse8-mcp` automatically)

## How agents discover the workflow

Every Verse8-related user request ("verse8으로 게임 만들어줘", "commit this", "fix this bug") routes through a **single always-first entry point**: `verse8_bootstrap`. It returns a deterministic state machine:

```jsonc
{
  "ok": true,
  "workspaceMode": "empty" | "unattached_clone" | "attached" | "non_verse_dir",
  "workflow": {
    "nextAction": "login" | "new_project" | "attach" | "ready",
    "nextTool":  "verse8_login_start" | "verse8_new_project_start" | "verse8_attach" | null,
    "reason":    "...",
    "instructions": "..."  // imperative guidance for the LLM
  },
  "diagnostics": { "hasGit": bool, "originHost": str|null, "hasProjectMarker": bool,
                   "hasToken": bool, "attached": bool }
}
```

The agent calls `workflow.nextTool` next and follows `workflow.instructions` verbatim. This matters because hosts like **Codex** do not auto-load `AGENTS.md` / `CLAUDE.md` into their system prompt — without a tool-contract state machine, they would see only the BASE_TOOLS list with declarative descriptions and generate game code arbitrarily instead of routing through Verse8's new-project flow.

`verse8_status` returns the same `workflow` shape, so an agent that already called status does not need to repeat the bootstrap call.

## Install

### Quick install (CLI one-liners)

If your MCP host ships a CLI helper, one command is enough:

```bash
# Claude Code
claude mcp add verse8 -- npx -y @verse8/mcp

# Codex
codex mcp add verse8 -- npx -y @verse8/mcp
```

Both helpers write the same underlying JSON config for you. Restart the host (or open a new session) and `verse8_login_start` / `verse8_status` / etc. show up in the tool list.

**Pinned version (recommended for production):**

```bash
claude mcp add verse8 -- npx -y @verse8/mcp@0.4.0
codex  mcp add verse8 -- npx -y @verse8/mcp@0.4.0
```

**Project-scoped instead of user-global** (shared via `.mcp.json` with teammates):

```bash
claude mcp add verse8 --scope project -- npx -y @verse8/mcp
```

**Remove:**

```bash
claude mcp remove verse8
codex  mcp remove verse8
```

### Manual install (generic MCP JSON)

Every MCP-compatible host shares the same JSON server config schema. Add this entry to your host's MCP config file:

```json
{
  "mcpServers": {
    "verse8": {
      "command": "npx",
      "args": ["-y", "@verse8/mcp"]
    }
  }
}
```

That's the minimum. Add env vars only when you need to override defaults:

```json
{
  "mcpServers": {
    "verse8": {
      "command": "npx",
      "args": ["-y", "@verse8/mcp"],
      "env": {
        "VERSE8_API_URL": "https://v8-meme-api.verse8.io"
      }
    }
  }
}
```

Pin a version for reproducibility:

```json
"args": ["-y", "@verse8/mcp@0.4.0"]
```

### Where each MCP host reads this config

| Host | CLI helper | Config file |
|------|-----------|-------------|
| Claude Code | `claude mcp add verse8 -- npx -y @verse8/mcp` | `~/.claude.json` (user) or `.mcp.json` (project) |
| Claude Desktop | — (manual JSON only) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows); restart app after editing |
| Codex | `codex mcp add verse8 -- npx -y @verse8/mcp` | `~/.config/codex/config.toml` (`[mcp_servers.verse8]` section) |
| Cursor | — (manual JSON only) | `<project>/.cursor/mcp.json` or `~/.cursor/mcp.json` |
| opencode | — (manual JSON only) | `~/.config/opencode/mcp.json` |
| Continue (VS Code) | — (manual JSON only) | `~/.continue/config.json` → `mcpServers`; reload the window after editing |

Any host that speaks MCP over stdio works — if it accepts a `command` / `args` config for MCP servers, drop in the snippet above.

### Verify the install

```bash
claude mcp list     # Claude Code
codex  mcp list     # Codex
```

You should see `verse8: npx -y @verse8/mcp - ✓ Connected` (or equivalent). The first time the server starts, it will `npx`-fetch the package into the local npm cache (one-time, a few seconds).

## One-time login

Authenticate via RFC 8628 device flow before using verse8 tools. Any MCP host:

```
You: verse8에 로그인해줘.
# Agent calls verse8_login_start → shows verification URL + user code
# You approve in the browser
# Agent calls verse8_login_complete → token saved
```

The access token is written to `${XDG_CONFIG_HOME:-~/.config}/verse8/token` (mode `0600`). Every subsequent tool call picks it up automatically. For a headless login (no MCP host), run `bash scripts/verse8-login.sh` from this repo.

## Case 1 — attach an existing verse8 project

```bash
git clone https://gitlab.verse8.io/<user>/<project>.git
cd <project>
# start your MCP host; e.g. `claude`, `codex`, `cursor`
```

Once the agent is running inside the project, it detects the `gitlab.verse8.io` origin, exposes `verse8_checkpoint` / `verse8_preview` / image-generation proxies, and installs the git hooks + `AGENTS.md` / `CLAUDE.md` on first `verse8_attach`. After that:

1. Work on code / assets / prompts.
2. Ask the agent to "commit" or call `verse8_checkpoint` — stages `git add -A`, writes a V8-format commit, pushes to `gitlab.verse8.io`.

## Case 2 — create a new verse8 project

Start your MCP host from any directory and describe the game:

```
You: 2D 슈팅 게임을 만들어줘.
```

The MCP exposes a **two-step flow** with a user-approval gate between the tools:

1. `verse8_new_project_start({userRequest})` — calls `/api/startcall` on `agent8-backend.verse8.io`; returns the proposed template (name, label, description, tags), a suggested title + repo slug, and a `startCallId`. The agent shows the proposal to you.
2. You confirm (or override title / slug).
3. `verse8_new_project_confirm({templateName, repo, path, title, projectRepo, startCallId, targetDir?})` — creates the GitLab project, grants a 30-day access token, clones on branch `develop` into `<targetDir>/<slug>`, and installs the verse8 git hooks + `AGENTS.md`.

The confirm response includes `nextCallRequires.projectDir` — every subsequent `verse8_checkpoint` / `verse8_preview` / image-proxy call in the session must pass `projectDir: <that path>` so the tools target the right directory (the MCP server's own cwd stays at the parent).

On transient failures (`token_grant_failed`, `clone_failed`, …) the error envelope includes `projectPath`; re-call `verse8_new_project_confirm` with that `projectPath` echoed back to skip duplicate project creation.

## Tool reference

| Tool | Purpose | When exposed |
|------|---------|--------------|
| `verse8_bootstrap` | **Always call first.** Returns the state-machine `workflow.nextTool` (+ `instructions`) so the agent routes deterministically without inferring workflow state from filesystem inspection. See [How agents discover the workflow](#how-agents-discover-the-workflow). | Always |
| `verse8_login_start` | Request RFC 8628 device code. Returns `verification_uri_complete` + `user_code` + `device_code` immediately (no polling). Display URL/code to the user, wait for browser approval, then call complete. | Always |
| `verse8_login_complete` | Poll the token endpoint for up to `max_wait_seconds` (default 120, max 1800). Writes token on success. Safe to retry with the same `device_code`. | Always |
| `verse8_status` | Check token validity, profile, project attachment, MCP proxy state. When the token's `exp` claim is within 7 days, the result carries `warnings: ["token_expires_soon"]` and `tokenExpiresAt` (ISO). | Always |
| `verse8_new_project_start` | Phase 1 of new-project flow. Returns `{templateName, repo, path, suggestedTitle, suggestedProjectRepo, startCallId}` for user review. | Always |
| `verse8_new_project_confirm` | Phase 2: create GitLab project, grant 30-day token, `git clone -b develop`, install hooks + AGENTS.md. Returns `projectDir` for session-wide reuse. | Always |
| `verse8_attach` | Install hooks + AGENTS.md / CLAUDE.md + skill catalog in an already-cloned `gitlab.verse8.io` project. Idempotent. Flags: `overwriteAgentsDoc`, `overwriteAllSkills`, `pruneOrphanedSkills`, `overwriteEnv`. | Always |
| `verse8_checkpoint` | Stage all changes (`git add -A`), build V8-format commit, push to origin. `.env` self-heal on first call. | Valid token |
| `verse8_preview` | `verse8_checkpoint` → preflight (`bun update`, optional `gameserver-node build` + `deploy --preview`) → spawn `bun run dev` detached. Returns `webEditor.url` when origin is `gitlab.verse8.io`. | Valid token |
| `image_asset_generate`, `image_variation_generate`, `asset_wait`, `music_generate`, `sfx_generate`, `spritesheet_generate`, `skybox_generate`, `claythis_3d_generate`, `cinematic_asset_generate`, `crossramp_*`, `ui_theme_*` | Upstream generation services proxied through the MCP server. Tool surface is discovered at `tools/list` time (depends on upstream availability). | Valid token |

> **0.4.0 breaking** — `verse8_new_project` (the old single-tool shim) is removed. Call `verse8_new_project_start` followed by `verse8_new_project_confirm` instead. See [CHANGELOG.md](./CHANGELOG.md).

### Resources (read-only)

| Resource | Purpose |
|----------|---------|
| `verse8://skill/<name>/SKILL.md` | Skill documentation (e.g., `verse8://skill/gameserver-sdk/SKILL.md`) |

### Prompts

| Prompt | Purpose |
|--------|---------|
| `verse8-new-project-bootstrap` | Interactive walkthrough for new project setup |

## Skills

`@verse8/mcp` bundles skill documents from two sources and materializes them as per-project skills inside every attached project:

| Source | Purpose | Maintained by |
|--------|---------|---------------|
| `skills/` | Core skills (`verse8-login`, `verse8-commit`, …) | Shipped with this package |
| `skills-vendor/agent8-skills/` | Game-building skills (gameserver SDK, vibe-starter-3d, …) | [planetarium/agent8-skills](https://github.com/planetarium/agent8-skills) git subtree |

On `verse8_attach` (and as the final step of `verse8_new_project_confirm`), every discovered skill is copied to `<projectDir>/.claude/skills/<name>/SKILL.md` so Claude Code auto-loads them. Other hosts (Codex, Cursor, opencode, …) see the same inventory via the dynamic `## Available Verse8 skills` catalog spliced into `AGENTS.md` / `CLAUDE.md`, and can fetch content via `resources/read verse8://skill/<name>/SKILL.md`.

A trailing `<!-- verse8-skill-hash: <sha256> -->` marker detects user edits; a drifted hash means "user owns this file" and re-attach preserves it verbatim. `overwriteAllSkills: true` forces re-copy. `pruneOrphanedSkills: true` removes `.claude/skills/<name>/` directories whose skill is no longer bundled *and* that still carry our hash marker — user-authored skill directories (no marker) are never touched.

### Skill merge precedence

`core > vendor > cache` on name collision. **Breaking change in 0.3.0** — prior releases placed the user cache last in the merge chain, making it win. Starting 0.3.0 the order is as documented; if you relied on a cache override of a bundled skill, fork the package or rename the skill.

### Updating vendored skills

The vendor tree is managed with `git subtree`. When upstream ships new skills, a maintainer runs:

```bash
git subtree pull \
  --prefix=skills-vendor/agent8-skills \
  https://github.com/planetarium/agent8-skills.git main --squash
npm version patch
npm publish
```

`package.json :: verse8.skillsVendor.sha` pins the subtree content hash; `bash scripts/check-subtree-sha.sh` fails the build if the tree drifts from the pin without an accompanying version bump.

Users upgrade via `npx -y @verse8/mcp@latest` (or their dependency manifest) and re-run `verse8_attach` to propagate the new skills into their projects.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VERSE8_API_URL` | `https://v8-meme-api.verse8.io` | Auth / verify API base. Host-validated against `*.verse8.io` + loopback. |
| `VERSE8_AGENT8_BACKEND_URL` | `https://agent8-backend.verse8.io` | Project-creation base (startcall / select-template / project-access-token). |
| `VERSE8_IMAGE_MCP_URL` | `https://mcp-image-svc.verse8.io/mcp` | Image generation MCP endpoint. |
| `VERSE8_CREATE_URL` | `https://create.verse8.io` | Web editor base for `webEditor.url` in preview responses. |
| `VERSE8_ACCESS_TOKEN` | _(unset)_ | If set, used instead of token file. |
| `VERSE8_GAMESERVER_BUILD_PIN` | _(unset)_ | `pkg=ver,pkg=ver` overrides for `@agent8/gameserver-node` and `@agent8/deploy` used by `verse8_preview` preflight. Takes precedence over `package.json :: verse8.gameserverPin`. |
| `VERSE8_AUDIT_LOG_PATH` | `${XDG_STATE_HOME:-~/.local/state}/verse8/mcp.log` | JSONL audit log location. Rotates at 1 MB (single `.1` retained). Mode `0600`. |
| `XDG_CONFIG_HOME` | `~/.config` | Parent directory for the token file (`verse8/token`, mode `0600`). |
| `XDG_STATE_HOME` | `~/.local/state` | Parent directory for the audit log (see `VERSE8_AUDIT_LOG_PATH`). |
| `VERSE8_STUB_PROJECTS=1` | _(unset)_ | Skip the live `POST /v1/projects` call (dev / CI). |

All URL overrides are host-validated against `*.verse8.io` / localhost. A host outside that allow-list is logged to stderr and the default is used instead.

## Observability

Every tool dispatch (`verse8_attach`, `verse8_checkpoint`, `verse8_preview`, image proxies, …) emits exactly one JSONL line to `${VERSE8_AUDIT_LOG_PATH:-$XDG_STATE_HOME/verse8/mcp.log}`:

```json
{"ts":"2026-04-21T06:18:55.778Z","tool":"verse8_attach","outcome":"ok","durationMs":72,"correlationId":"2d10ee15-…","projectDirDigest":"7fa322a86f4d"}
```

`projectDirDigest` is `sha256(projectDir).slice(0,12)` — the raw path is never written. Schema-parse failures and unknown-tool dispatches do **not** emit audit lines. Secret-shaped strings in `hint` fields are redacted via the same registry the dispatch envelopes use.

## Security posture

- **Trust-boundary redaction** — every MCP response envelope (tool, resource, prompt) flows through `util/redact.ts` so thrown errors containing `glpat-*`, `Bearer <token>`, `oauth2:<secret>@…` URLs, or `access_token / refresh_token / device_code` JSON fields never reach the host LLM verbatim.
- **Path-traversal rejection** — `projectDir` / `targetDir` are zod-refined at the MCP dispatch boundary; `..`, NUL, and symlinked parents are rejected with `invalid_input` / `invalid_parent` before any filesystem access.
- **Clone-command safety** — `git clone` always runs via `execFileSync` argv-array form; the GitLab PAT is parsed via `parseCloneCommand` and never interpolated into a shell.
- **Host allow-list** — every env-driven base URL is validated against `*.verse8.io` + loopback with per-caller policy predicates.
- **Failure atomicity** — `applyAttachmentArtifacts` records reverse operations per step; any mid-sequence failure rolls back prior writes in LIFO order so a failed attach leaves zero on-disk side effects.
- **Publish guard** — `prepublishOnly` runs `scripts/prepublish-guard.sh`, which scans the `npm pack` tarball for `glpat-*`, `Bearer <token>`, `"access_token":"…"`, `VITE_AGENT8_ACCOUNT=0x<hex>`, and `*.map` filenames and refuses to publish on any hit.

## Development

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/`.

### Dev

```bash
npm run dev
```

Runs `tsx src/index.ts`.

### Test

```bash
npm test
```

Runs the full suite: `npm run build && bash tests/smoke.sh && npm run test:unit`. Unit-only:

```bash
npm run test:unit
```

Split smoke suites (M4.1) — run a single subset against live mocks:

```bash
bash tests/smoke/login.sh
bash tests/smoke/attach.sh
bash tests/smoke/new-project.sh
bash tests/smoke/preview.sh
bash tests/smoke/skills.sh
```

### Audit

```bash
npm run audit
```

`npm audit --audit-level=high` — fails on any high/critical advisory in the dependency tree.

### Invariants

```bash
bash scripts/verify-invariants.sh
bash scripts/check-subtree-sha.sh
```

`.omc/INVARIANTS.md` maps 11 production invariants (token shell safety, marker secret-freedom, host allow-list, skill precedence, .env immutability, skill no-touch, overwrite-flag scoping, V8 on-wire contract, narrative location, single-shot session retry, token-gated discovery) to regression tests. The verifier greps every referenced test name and fails the build if any is missing.

### Pre-publish guard

```bash
bash scripts/prepublish-guard.sh
```

Runs automatically on `npm publish` via the `prepublishOnly` script. Enforces AC-SECURITY-2 — tarball carries no secret-shaped strings, no sourcemaps.

### Clean

```bash
npm run clean
```

Removes `dist/`.

## Architecture

For current architecture (module layout, data flows, invariants, known refactor candidates), see [.omc/ARCHITECTURE.md](./.omc/ARCHITECTURE.md).

Key concepts:

- **Token priority**: env `VERSE8_ACCESS_TOKEN` → `<cwd>/.verse8/token` → `${XDG_CONFIG_HOME:-~/.config}/verse8/token`.
- **Project detection**: cwd contains `.verse8/project.json` AND `git remote origin` host is `gitlab.verse8.io`.
- **Hook entrypoint**: `verse8-mcp hook pre-commit` / `verse8-mcp hook commit-msg` (invoked by git during commit).
- **Dynamic tools**: tool set re-evaluated on every `tools/list` request based on current cwd + token presence.
- **Bin**: single `verse8-mcp` executable that dispatches subcommands (`serve` / `hook pre-commit` / `hook commit-msg`). `npx -y @verse8/mcp` runs it with no arguments because the package has exactly one bin.

## MCP server restarted mid-flow

Several pieces of state inside `verse8_new_project_*` live only in the running MCP server's memory: the `startCallId → digest` memo, the in-flight-confirm guard, and the per-process rate-limit window for `verse8_new_project_start`. **A restart wipes them.**

If the MCP host (Claude Code, Codex, Cursor, opencode, …) restarts the verse8 server mid-flow — config reload, crash, manual `/reload`, or a host upgrade — the next `verse8_new_project_confirm` call with a previously issued `startCallId` will return `template_mismatch`. This is **expected and recoverable**: re-run `verse8_new_project_start({userRequest})`, hand the returned identifiers to `verse8_new_project_confirm` verbatim, and the new session will succeed.

The same applies to the rate-limit window — it resets on every server restart because it is process-local. A persistent store is a 0.4.x+ follow-up.

## License

MIT
