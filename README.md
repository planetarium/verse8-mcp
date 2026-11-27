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
| `verse8_logout` | Delete the local login token (also the first step of switching accounts). The token is not revoked on the server. | Always |
| `verse8_status` | Token / token source / project / expiry check + routing. | Always |
| `verse8_new_project_start` → `_confirm` | Create new Verse8 project (2-step: propose → approve → clone + attach). | Always |
| `verse8_open_project` | Bring an existing Verse8 game that is not cloned here yet (project path or web editor URL) onto this machine: project token → clone → attach. Never overwrites a folder. | Always |
| `verse8_attach` | Install hooks + AGENTS.md + skills into an already-cloned `gitlab.verse8.io` project. Idempotent. | Always |
| `verse8_checkpoint` | `git add -A` → V8-format commit → push. | Logged in |
| `verse8_preview` | Checkpoint → preflight → `bun run dev` spawn. `serverOnly: true`: gameserver build + `@agent8/deploy --preview` only (server.js always re-uploaded). | Logged in |
| `verse8_upload_asset` | Upload a local file (image / audio / video / 3D / font / small text) to the Verse8 CDN via `agent8-backend /api/upload-attachment`. Pass `filePath` + `cdnPath`; the host is expected to mirror the project's `src/assets.json` URL patterns and to register the returned URL back into that manifest. | Logged in |
| `verse8_assets` | The web editor's asset panel: `search` the Verse8 asset library (`GET /api/resources`, by category + keyword), `add` found items to `src/assets.json`, `upload` several files to `assets/<categoryPath>`, register them in `src/assets.json` and record the upload activity. Writes the web editor's entry shape and keeps existing entries. | Logged in |
| `verse8_upload_thumbnail` | Upload a verse cover image (png/jpg/gif/webp ≤4 MB) or preview video (mp4 ≤10 MiB) to `contents.verse8.io` via verse8.io `/api/upload`. | Logged in |
| `verse8_gameserver` | Read-only view of the game server, prod or preview: status (v1/v2, players, rooms), `$collection` data (paged, equality search), user / asset / global state, recent errors and live logs (v2). Uses the gateway's developer API (`/v1/verses/:verse/*`, owner only). | Logged in, verse owner |
| `verse8_deploy_status` | Read-only: the published commit and time (from the live playUrl), title / visibility / review status, latest release note, how local HEAD relates to the published commit, prod / preview game server state. | Logged in |
| `verse8_verse` | Creator-page operations without a rebuild: read the listing / your games / release notes / analytics (DAU, MAU, sessions, charts); edit title, texts, tags, cover, preview video, remix / mobile / orientation, visibility, and existing release notes; list, pin and delete comments. Changes preview first and run only with the preview's `planId`, refused if the arguments or the live values changed since; the current visibility is kept unless you change it, and widening it, like deleting a comment, also asks you in the host's own prompt ([below](#actions-you-confirm-yourself)). | Logged in, verse owner |
| `verse8_vxshop` | VX Shop items: seller status and item list (with purchase limits), sales and revenue; create (hidden by default), edit, archive / restore an item, answer disputes — preview first, then the preview's `planId` to apply (refused if the item changed since); starting a sale or repricing an item on sale also asks you in the host's own prompt ([below](#actions-you-confirm-yourself)); edits keep the current purchase limits. Item images upload to the `vx-shop` category. | Logged in, verse owner, approved seller |
| `verse8_deploy` | Publish: checkpoint → media upload → `bun run build --base ./` (+ gameserver build) → `@agent8/deploy --prod` → `POST /v1/verse/create` (first) or `/v1/verse/update/:id` (update). `dryRun: true` previews the mode + publish body. A deploy that widens who can see the game (a first deploy unless Private, an update towards Public) also asks you in the host's own prompt ([below](#actions-you-confirm-yourself)). | Logged in |
| `image_*`, `music_generate`, `sfx_generate`, `spritesheet_*`, `skybox_*`, `claythis_3d_*`, `cinematic_*`, `crossramp_*`, `ui_theme_*` | Upstream asset-generation proxies. | Logged in |

Resources: `verse8://skill/<name>/SKILL.md`.

### Actions you confirm yourself

On the web a person presses the button and reads the warning. Here an agent calls the tool, so what an action needs before it runs depends on what it does:

| Run condition | Actions | What it takes |
|---|---|---|
| Immediate | Reads, and changes to local files only | Nothing |
| Preview | Changes that can be undone and cost nothing | The `planId` of the action's own preview — it does not run without a preview, or if anything changed since |
| User confirmation | Changes that cost money, change what is public, affect other people, or are hard to undo | The `planId`, then your own answer in a prompt the host shows in the terminal |

Today the user-confirmation actions are:

- `verse8_vxshop` — starting a sale: a change that puts the item on sale. Whether an item is on sale is read from what you set — the on-sale flag, the archive flag and the purchase dates — so that is creating an item with the on-sale flag, turning the flag on, restoring it from the archive, removing or passing a future start date, and extending or removing an end date that has passed. A start date still ahead counts too, and the prompt then says `from <date>` instead of `from now on`. Stock is not part of it: the server lowers it on every purchase and brings it back on a refund or an expired reservation, so an item on sale with stock 0 is still on sale and asks like any other — and filling such an item from stock 0 is itself a sale start. Also: changing the price of an item that is on sale or scheduled. Purchase dates are accepted in one form only, `YYYY-MM-DD[THH:MM[:SS[.sss]]][Z or ±HH:MM]` (a space instead of `T` is fine); anything else — `2026-12 20:00`, `+2026-12-01 20:00`, `12/01/2026` — is refused as `invalid_input`, because the server could read it as another moment than this tool does. Written without a time zone (`2026-12-01T20:00:00`) they are UTC, as the server reads them — not your local time; the prompt marks such a date `UTC`, and a date that names its zone (`…+09:00`, `…Z`) is shown as written. An item that already holds a date in another form (set elsewhere) has an unknown sale state: any change that leaves it switched on asks, and the prompt says the date could not be read. A start date after the end date is a window that never opens, so such an item is not on sale and not scheduled. The per-user and per-period count limits are not part of this — changing them stays at preview unless the same edit also does one of the above — but when such an edit changes them, the prompt lists every limit that changes, in full.
- `verse8_verse` — an `update` that widens who can see the game: Private → Unlisted, Private → Public, Unlisted → Public. The prompt shows the game's title and `Visibility: current → new`. Narrowing the visibility stays at preview.
- `verse8_verse` — `comment_delete`: a deleted comment cannot be restored and counts against the commenter. The prompt shows the commenter and the comment's text.
- `verse8_deploy` — a deploy that widens who can see the game, by the same rule as the update above: a first deploy unless you pass `visibility: "Private"` (a first deploy is Public by default), and an update whose `visibility` moves towards Public. It has no `planId`: the `dryRun` says `runCondition: user_confirm` and shows the text, and the real run asks you before it commits, builds or uploads anything. An update that keeps the visibility is not asked.

Left at preview on purpose: answering a buyer's dispute (`verse8_vxshop` `dispute`) sends the buyer a message — it moves no money and changes nothing public — and pinning a comment (`comment_pin`) is undone by unpinning.

The prompt is an MCP elicitation. It is one line with the target, the price or the values that change, and whether it can be undone; the choices are `Cancel` (first) and `Run`. Your answer goes from the host straight to the MCP server, not through the agent. Only `Run` runs the action — declining, pressing Esc or anything else returns `user_cancelled` and changes nothing.

What you saw is what runs. After your `Run` the server reads the target again; if anything the prompt was written from has changed while it was open — a price edited on the web, purchase limits, the game's title or visibility, the comment's text — it stops with `plan_mismatch` and changes nothing. Time passing is judged by one rule: a run is held to the confirmation it actually got. Once you have chosen `Run`, a sale date that passes meanwhile (a start that arrives, an end that goes by) does not stop it — you were asked, and the values you were shown are unchanged. A change that ran without asking because it was preview-level is checked again after its upload: if a sale date passed and the same write would now start a sale, it stops and asks for a new preview. Values the server changes by itself are not held against you: a unit sold between the preview and the run does not stop a stop-selling, an archive or a repricing (the stock is compared only when your request changes the stock). If that second read fails for its own reason — the login was rejected, the API is down — the answer says so, not "preview again". When a request changes more than fits on the line, the target, the main values and the undo note stay and the prompt says how many other changes it leaves out (they are all in the preview). Control and invisible formatting characters in titles, item names and comments are removed from the prompt.

The same holds across the waits inside a run. A deploy builds and uploads for minutes; right before it publishes, an update reads the game again and publishes from that reading, so a title or visibility you changed on the web meanwhile is kept. If publishing would then make the game visible to more people in a way you did not confirm — you set it to Private during the build and the deploy was asked for Public — it stops without publishing and says so: the game files are uploaded by then, the game's record is untouched, and deploying again asks you properly. An edit that uploads a cover, video or item image reads the target once more after the upload for the same reason.

- **Hosts without elicitation.** A host that does not declare form elicitation when it connects cannot show the prompt: the action returns `confirm_unavailable`, changes nothing, and says where to do the same on the web: the game's own creator page, `https://create.verse8.io/creations/<verseId>` — the "VX Shop" tab for shop items, the "Visibility" select on the "General" tab for visibility (for a deploy: deploy without widening it, then widen it there). On the "VX Shop" tab a new item is made with "Add New Item", and an existing one is changed in its edit dialog — not with the on/off switch: the switch sends no purchase limits, and the server then removes the item's limits. An archived item has only Restore there (switch on "Include Archived"); Restore removes the limits the same way, so the restored item sells **without limits** until you set them again in its edit dialog. The edit dialog also saves the stock it read when it was opened, so units sold while it is open come back. If the limits or the stock must hold exactly, do it from a host that can show the confirmation prompt instead of on the web. A comment is deleted on the game's own page (`https://verse8.io/<verseId>`): open the comments and press the trash button next to the comment. Non-interactive runs (`claude -p`, the Agent SDK) cancel the prompt by themselves and get `user_cancelled`.
- **Hooks that answer for you.** If you configure your host to answer elicitations automatically — for example a Claude Code `Elicitation` hook that returns `accept` — the server receives the same answer as if you had chosen `Run` and cannot tell the two apart. Do not auto-accept prompts from this server unless you mean every such action to run unasked.
- **Timeouts.** The tool call waits for your answer for up to 10 minutes. If the host cancels the tool call first (a tool timeout shorter than the time you take to answer — Codex `tool_timeout_sec` defaults to 60 seconds), the prompt is withdrawn and an answer given afterwards is not used: nothing runs. Raise the host's tool timeout for this server if you need longer. A host that gives up on a call without sending the MCP cancellation cannot be detected.

---

## Troubleshooting

### `insufficient_credits`

`verse8_new_project_start` / `_confirm`, `verse8_upload_asset` or `verse8_assets` `upload` returns `insufficient_credits` (usually HTTP 402; for `verse8_assets` per file in `failed` when other files uploaded) when the signed-in account has no Verse8 credits left. Sign-in still works, so this is typically the first thing a new account hits.

- **New account** — credits are not granted at sign-up. Verify a phone number (SMS) on Verse8, then claim the one-time welcome credit.
- **Existing account** — recharge at <https://verse8.io/settings>. `verse8_status` also returns this link as `creditRechargeUrl`.

Then:

- From `verse8_new_project_start` or `verse8_upload_asset` — retry the same tool call. From `verse8_assets` `upload` — retry with only the files listed in `failed` (the others are already uploaded and registered).
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
