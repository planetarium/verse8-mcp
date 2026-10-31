# @verse8/mcp

MCP server that lets any AI agent (Claude Code, Codex, Cursor, opencode, …) build Verse8 games from a single natural-language prompt.

---

## Quick start

**1. Install once:**

Claude Code, as a plugin (pins the server version and updates with the plugin):

```
/plugin marketplace add planetarium/verse8-mcp
/plugin install verse8@verse8-plugins
```

Or add the MCP server directly:

```bash
claude mcp add verse8 -- npx -y @verse8/mcp   # Claude Code
codex  mcp add verse8 -- npx -y @verse8/mcp   # Codex
```

Use one of the two in Claude Code, not both — each registers a server named `verse8`. What the plugin runs, sends and stores is listed in [plugins/verse8/README.md](./plugins/verse8/README.md).

> **Timeout**: The server defaults to 120 seconds, but a shorter client-side timeout
> can end a tool call before the response arrives. Codex/OpenCode users should follow
> the [manual installation guide](./docs/manual-install.md#%EA%B8%B0%EB%B3%B8-%ED%83%80%EC%9E%84%EC%95%84%EC%9B%83-120%EC%B4%88)
> to set the client timeout to at least 120 seconds.

**2. Use it:**

### New project

Open any empty directory and say:

```
Make a 2D shooter with Verse8
```

The agent handles login, proposes a template, and (after you approve the template once) creates the GitLab project, clones it, and attaches — all automatic.

Installing is free; creating a project and some asset tools require Verse8 credits. A new account gets no credits at sign-up — verify a phone number and claim the one-time welcome credit first (see [Troubleshooting](#insufficient_credits)).

### Existing project (cloned from gitlab.verse8.io)

```
Attach this to Verse8
```

Then continue normally:

```
Add a background image
Add an enemy that chases the player
Add background music to the main scene
```

### Deploy

```
Deploy this game
```

The agent calls `verse8_deploy`. The same fields as the web publish dialog are required: a first deploy needs a title, tags, a cover image and a release note; every deploy needs a release note (title, types, description). The agent drafts all of them from the project — the release note from the checkpoints since the last deploy, the cover with `image_asset_generate` — and on a **first deploy** shows you the result once before publishing (swap the cover or title there). **Updates** publish right away and report the play URL and release note; say "show me first" if you want to confirm.

---

## Manual install

For hosts without a CLI helper (Claude Desktop, Cursor, opencode, Continue) or direct JSON config → [docs/manual-install.md](./docs/manual-install.md).

---

## Tools

| Tool | Purpose | Exposed |
|---|---|---|
| `verse8_bootstrap` | Always called first — returns `workflow.nextTool`. | Always |
| `verse8_login_start` / `_complete` | RFC 8628 device-flow login. | Always |
| `verse8_status` | Token / project / expiry check + routing. | Always |
| `verse8_new_project_start` → `_confirm` | Create new Verse8 project (2-step: propose → approve → clone + attach). | Always |
| `verse8_attach` | Install hooks + AGENTS.md + skills into an already-cloned `gitlab.verse8.io` project. Idempotent. | Always |
| `verse8_checkpoint` | `git add -A` → V8-format commit → push. | Logged in |
| `verse8_preview` | Checkpoint → preflight → `bun run dev` spawn. | Logged in |
| `verse8_upload_asset` | Upload a local file (image / audio / video / 3D / font / small text) to the Verse8 CDN via `agent8-backend /api/upload-attachment`. Pass `filePath` + `cdnPath`; the host is expected to mirror the project's `src/assets.json` URL patterns and to register the returned URL back into that manifest. | Logged in |
| `verse8_upload_thumbnail` | Upload a verse cover image (png/jpg/gif/webp ≤4 MB) or preview video (mp4 ≤10 MiB) to `contents.verse8.io` via verse8.io `/api/upload`. | Logged in |
| `verse8_deploy` | Publish: checkpoint → media upload → `bun run build --base ./` (+ gameserver build) → `@agent8/deploy --prod` → `POST /v1/verse/create` (first) or `/v1/verse/update/:id` (update). `dryRun: true` previews the mode + publish body. | Logged in |
| `image_*`, `music_generate`, `sfx_generate`, `spritesheet_*`, `skybox_*`, `claythis_3d_*`, `cinematic_*`, `crossramp_*`, `ui_theme_*` | Upstream asset-generation proxies. | Logged in |

Resources: `verse8://skill/<name>/SKILL.md`.

---

## Troubleshooting

### `insufficient_credits`

`verse8_new_project_start` / `_confirm` or `verse8_upload_asset` returns `insufficient_credits` (usually HTTP 402) when the signed-in account has no Verse8 credits left. Sign-in still works, so this is typically the first thing a new account hits.

- **New account** — credits are not granted at sign-up. Verify a phone number (SMS) on Verse8, then claim the one-time welcome credit.
- **Existing account** — recharge at <https://verse8.io/settings>. `verse8_status` also returns this link as `creditRechargeUrl`.

Then:

- From `verse8_new_project_start` or `verse8_upload_asset` — retry the same tool call.
- From `verse8_new_project_confirm` — the GitLab project may already have been created before the error, and the error does not say which one. Any retry (calling `_confirm` again or starting over from `verse8_new_project_start`) creates another project, so an empty project may be left behind.

### MCP server restarted mid-flow

`verse8_new_project_confirm` returns `template_mismatch` when the MCP server restarted between `_start` and `_confirm` (config change, crash, reload). Re-run `verse8_new_project_start` to get a fresh `startCallId`, then call `_confirm` again. Rate-limit windows also reset across restarts.

---

## More

- Environment variables → [docs/environment.md](./docs/environment.md)
- Skills system → [docs/skills.md](./docs/skills.md)
- Agent workflow discovery + architecture → [docs/architecture.md](./docs/architecture.md)
- Observability (audit log) → [docs/observability.md](./docs/observability.md)
- Security → [docs/security.md](./docs/security.md)
- Development / build / test / invariants → [docs/development.md](./docs/development.md)

---

## License

MIT
