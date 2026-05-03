# @verse8/mcp

MCP server that lets any AI agent (Claude Code, Codex, Cursor, opencode, …) build Verse8 games from a single natural-language prompt.

---

## Quick start

**1. Install once:**

```bash
claude mcp add verse8 -- npx -y @verse8/mcp   # Claude Code
codex  mcp add verse8 -- npx -y @verse8/mcp   # Codex
```

> **Timeout 설정**: Verse8 에셋 생성 툴은 최대 120~180초까지 걸릴 수 있습니다.
> 작동이 타임아웃으로 실패한다면 [수동 설치 가이드](./docs/manual-install.md#기본-타임아웃-120초-설정)의
> 타임아웃 설정을 따라 호스트별로 조정하세요.
> 서버 측은 `VERSE8_PROXY_REQUEST_TIMEOUT_MS=120000` 환경변수로 최소 120초를 보장합니다.

**2. Use it:**

### New project

Open any empty directory and say:

```
Make a 2D shooter with Verse8
```

The agent handles login, proposes a template, and (after you approve the template once) creates the GitLab project, clones it, and attaches — all automatic.

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

Deploy from the web editor — **<https://create.verse8.io/>**.

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
| `image_*`, `music_generate`, `sfx_generate`, `spritesheet_*`, `skybox_*`, `claythis_3d_*`, `cinematic_*`, `crossramp_*`, `ui_theme_*` | Upstream asset-generation proxies. | Logged in |

Resources: `verse8://skill/<name>/SKILL.md`.

---

## Troubleshooting

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
- Master plan + invariants → [.omc/ARCHITECTURE.md](./.omc/ARCHITECTURE.md), [.omc/INVARIANTS.md](./.omc/INVARIANTS.md)

---

## License

MIT
