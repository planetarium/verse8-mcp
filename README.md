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

> **Timeout**: 서버 측은 기본 120초가 적용되지만, 클라이언트 측 타임아웃이
> 짧으면(기본 60초) 응답을 못 받습니다. Codex/OpenCode 사용자는 반드시
> [수동 설치 가이드](./docs/manual-install.md#기본-타임아웃-120초)를 따라
> 클라이언트 타임아웃을 120초 이상으로 조정하세요.

**2. Use it:**

### New project

Open any empty directory and say:

```
Make a 2D shooter with Verse8
```

The agent handles login, proposes a template, and (after you approve the template once) creates the GitLab project, clones it, and attaches — all automatic.

Installing is free; creating a project and some asset tools require Verse8 credits. A new account gets no credits at sign-up — verify a phone number and claim the one-time welcome credit first (see [Troubleshooting](#insufficient_credits)).

### Existing project (not on this machine yet)

Open the folder you want the game in and say, with the project path or the web editor URL:

```
Open my Verse8 game owner/my-platformer-1abc
Open https://create.verse8.io/creator/editor?chat=owner/my-platformer-1abc
```

`verse8_open_project` grants a project token, clones the game into `<folder>/<game-slug>`, and attaches it. If that folder already exists it is left untouched and the tool says so. The URL must come from the same Verse8 environment the server is configured for ([docs/environment.md](docs/environment.md)).

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
| `verse8_open_project` | Bring an existing Verse8 game that is not cloned here yet (project path or web editor URL) onto this machine: project token → clone → attach. Never overwrites a folder. | Always |
| `verse8_attach` | Install hooks + AGENTS.md + skills into an already-cloned `gitlab.verse8.io` project. Idempotent. | Always |
| `verse8_checkpoint` | `git add -A` → V8-format commit → push. | Logged in |
| `verse8_preview` | Checkpoint → preflight → `bun run dev` spawn. `serverOnly: true`: gameserver build + `@agent8/deploy --preview` only (server.js always re-uploaded). | Logged in |
| `verse8_upload_asset` | Upload a local file (image / audio / video / 3D / font / small text) to the Verse8 CDN via `agent8-backend /api/upload-attachment`. Pass `filePath` + `cdnPath`; the host is expected to mirror the project's `src/assets.json` URL patterns and to register the returned URL back into that manifest. | Logged in |
| `verse8_upload_thumbnail` | Upload a verse cover image (png/jpg/gif/webp ≤4 MB) or preview video (mp4 ≤10 MiB) to `contents.verse8.io` via verse8.io `/api/upload`. | Logged in |
| `verse8_gameserver` | Read-only view of the game server, prod or preview: status (v1/v2, players, rooms), `$collection` data (paged, equality search), user / asset / global state, recent errors and live logs (v2). Uses the gateway's developer API (`/v1/verses/:verse/*`, owner only). | Logged in, verse owner |
| `verse8_deploy_status` | Read-only: the published commit and time (from the live playUrl), title / visibility / review status, latest release note, how local HEAD relates to the published commit, prod / preview game server state. | Logged in |
| `verse8_verse` | Creator-page operations without a rebuild: read the listing / your games / release notes / analytics (DAU, MAU, sessions, charts); edit title, texts, tags, cover, preview video, remix / mobile / orientation, visibility, and existing release notes; list, pin and delete comments. Changes preview first and run only with the preview's `planId`, refused if the arguments or the live values changed since; the current visibility is always kept. | Logged in, verse owner |
| `verse8_vxshop` | VX Shop items: seller status and item list (with purchase limits), sales and revenue; create (hidden by default), edit, archive / restore an item, answer disputes — preview first, then the preview's `planId` to apply (refused if the item changed since); starting a sale or repricing an item on sale also asks you in the host's own prompt ([below](#actions-you-confirm-yourself)); edits keep the current purchase limits. Item images upload to the `vx-shop` category. | Logged in, verse owner, approved seller |
| `verse8_deploy` | Publish: checkpoint → media upload → `bun run build --base ./` (+ gameserver build) → `@agent8/deploy --prod` → `POST /v1/verse/create` (first) or `/v1/verse/update/:id` (update). `dryRun: true` previews the mode + publish body. | Logged in |
| `image_*`, `music_generate`, `sfx_generate`, `spritesheet_*`, `skybox_*`, `claythis_3d_*`, `cinematic_*`, `crossramp_*`, `ui_theme_*` | Upstream asset-generation proxies. | Logged in |

Resources: `verse8://skill/<name>/SKILL.md`.

### Actions you confirm yourself

On the web a person presses the button and reads the warning. Here an agent calls the tool, so what an action needs before it runs depends on what it does:

| Run condition | Actions | What it takes |
|---|---|---|
| Immediate | Reads, and changes to local files only | Nothing |
| Preview | Changes that can be undone and cost nothing | The `planId` of the action's own preview — it does not run without a preview, or if anything changed since |
| User confirmation | Changes that cost money, change what is public, affect other people, or are hard to undo | The `planId`, then your own answer in a prompt the host shows in the terminal |

Today the user-confirmation actions are in `verse8_vxshop`: starting a sale (creating an item on sale, turning an item's on-sale flag on, restoring an archived item whose on-sale flag is set) and changing the price of an item that is on sale.

The prompt is an MCP elicitation. It is one line with the target, the price or the values that change, and whether it can be undone; the choices are `Cancel` (first) and `Run`. Your answer goes from the host straight to the MCP server, not through the agent. Only `Run` runs the action — declining, pressing Esc or anything else returns `user_cancelled` and changes nothing.

- **Hosts without elicitation.** A host that does not declare the elicitation capability when it connects cannot show the prompt: the action returns `confirm_unavailable`, changes nothing, and says where to do the same on the web (the game's creator page). Non-interactive runs (`claude -p`, the Agent SDK) cancel the prompt by themselves and get `user_cancelled`.
- **Hooks that answer for you.** If you configure your host to answer elicitations automatically — for example a Claude Code `Elicitation` hook that returns `accept` — the server receives the same answer as if you had chosen `Run` and cannot tell the two apart. Do not auto-accept prompts from this server unless you mean every such action to run unasked.
- **Timeouts.** The tool call waits for your answer for up to 10 minutes. If the host cancels the tool call first (a tool timeout shorter than the time you take to answer — Codex `tool_timeout_sec` defaults to 60 seconds), the prompt is withdrawn and an answer given afterwards is not used: nothing runs. Raise the host's tool timeout for this server if you need longer. A host that gives up on a call without sending the MCP cancellation cannot be detected.

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

### IP asset pools

The `verse8_ip_assets` tool uses your Verse8 login to request pool-scoped
A2A access and saves inline files locally. Configure the token endpoint with
`VERSE8_TOKEN_EXCHANGE_URL` and the pool base URL with `VERSE8_A2A_BASE_URL`.
See [IP asset integration](docs/ip-assets.md) for configuration and task continuation.
