# 환경 변수

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `VERSE8_API_URL` | `https://v8-meme-api.verse8.io` | Auth / verify API base. `*.verse8.io` + loopback에 host-validated. |
| `VERSE8_AGENT8_BACKEND_URL` | `https://agent8-backend.verse8.io` | 프로젝트 생성 base (startcall / select-template / project-access-token). |
| `VERSE8_IMAGE_MCP_URL` | `https://mcp-image-svc.verse8.io/mcp` | 이미지 생성 MCP 엔드포인트. |
| `VERSE8_CREATE_URL` | `https://create.verse8.io` | preview 응답 `webEditor.url`의 웹 에디터 base. `verse8_open_project` also accepts editor URLs only on this host (another host → `environment_mismatch`). |
| `VERSE8_TOKEN_EXCHANGE_URL` | — | Full HTTPS endpoint that receives the Verse8 token for IP asset access. |
| `VERSE8_A2A_BASE_URL` | — | HTTPS base for IP asset pools. Receives the exchanged bearer token. |
| `VERSE8_ACCESS_TOKEN` | _(미설정)_ | 설정 시 토큰 파일 대신 사용. It wins over both token files, so `verse8_login_complete` and `verse8_logout` cannot replace or clear it — remove it from the MCP server's env settings and restart the server. |
| `VERSE8_WEB_URL` | `https://verse8.io` | `verse8_upload_thumbnail` / `verse8_deploy`가 커버 이미지·영상을 올리는 verse8.io 웹 앱 base (`/api/upload`). `.verse8.io`·loopback만 허용. |
| `VERSE8_GAMESERVER_URL` | `https://gs-gateway.verse8.io` | `verse8_gameserver`가 읽는 게임 서버 게이트웨이 base (`/v1/verses/:verse/*`). 토큰이 가므로 https `*.verse8.io`·loopback만 허용. |
| `VERSE8_GAMESERVER_BUILD_PIN` | _(미설정)_ | `verse8_preview` preflight와 `verse8_deploy`가 사용하는 `@agent8/gameserver-node` / `@agent8/deploy` 버전 오버라이드 (`pkg=ver,pkg=ver` 포맷). `package.json :: verse8.gameserverPin`보다 우선. |
| `VERSE8_CHECKPOINT_REQUIRE_FILES` | _(미설정)_ | `1`이면 `verse8_checkpoint` / `verse8_preview` / `verse8_deploy`가 `files` 없이 불렸을 때 `git add -A`를 하지 않고 `files_required`와 바뀐 파일 목록(`changedFiles`)을 돌려줍니다. 여러 세션이 한 폴더에서 일할 때 다른 세션의 작업이 섞여 커밋되지 않게 합니다. 호출의 `stageAll`이 이 값보다 우선합니다. |
| `VERSE8_AUDIT_LOG_PATH` | `${XDG_STATE_HOME:-~/.local/state}/verse8/mcp.log` | JSONL 감사 로그 위치. 1 MB에서 회전 (`.1` 하나만 보관). 모드 `0600`. |
| `VERSE8_PROXY_REQUEST_TIMEOUT_MS` | `120000` (120초) | 업스트림 MCP 프록시 요청의 최소 타임아웃 (ms). 모든 서비스의 타임아웃이 이 값 이하로 내려가지 않도록 보장합니다. |
| `XDG_CONFIG_HOME` | `~/.config` | 토큰 파일 부모 디렉터리 (`verse8/token`, 모드 `0600`). |
| `XDG_STATE_HOME` | `~/.local/state` | 감사 로그 부모 디렉터리 (`VERSE8_AUDIT_LOG_PATH` 참조). |

Each URL override is checked against its service’s host allowlist. The IP asset endpoints accept HTTPS on `verse8.io`, its subdomains, loopback, or exactly `vicoop-router.fly.dev`. Both must be configured. An invalid or missing value stops the request before token exchange.

## 토큰 우선순위

1. env `VERSE8_ACCESS_TOKEN`
2. `<cwd>/.verse8/token` — read only when it is a regular file that git does not track. A link (the file or the `.verse8` folder) or a tracked file is skipped ([INV-16](./security.md#invariants)).
3. `${XDG_CONFIG_HOME:-~/.config}/verse8/token` — written by `verse8_login_complete`.

`verse8_status` reports which one is in use as `tokenSource` (`env` / `project` / `config`, plus the file path), and a skipped project file as `projectTokenRefused`. When the server rejects the token (HTTP 401), the hint names the source: logging in again only rewrites the third one, so a stale `VERSE8_ACCESS_TOKEN` or project token has to be cleared first.

`verse8_logout` deletes the two token files (never a skipped project file) and answers `logout_incomplete` while `VERSE8_ACCESS_TOKEN` still supplies a token. Verse8 has no token revocation API: a deleted token stays valid on the server until it expires.
