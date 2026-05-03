# 환경 변수

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `VERSE8_API_URL` | `https://v8-meme-api.verse8.io` | Auth / verify API base. `*.verse8.io` + loopback에 host-validated. |
| `VERSE8_AGENT8_BACKEND_URL` | `https://agent8-backend.verse8.io` | 프로젝트 생성 base (startcall / select-template / project-access-token). |
| `VERSE8_IMAGE_MCP_URL` | `https://mcp-image-svc.verse8.io/mcp` | 이미지 생성 MCP 엔드포인트. |
| `VERSE8_CREATE_URL` | `https://create.verse8.io` | preview 응답 `webEditor.url`의 웹 에디터 base. |
| `VERSE8_ACCESS_TOKEN` | _(미설정)_ | 설정 시 토큰 파일 대신 사용. |
| `VERSE8_GAMESERVER_BUILD_PIN` | _(미설정)_ | `verse8_preview` preflight가 사용하는 `@agent8/gameserver-node` / `@agent8/deploy` 버전 오버라이드 (`pkg=ver,pkg=ver` 포맷). `package.json :: verse8.gameserverPin`보다 우선. |
| `VERSE8_AUDIT_LOG_PATH` | `${XDG_STATE_HOME:-~/.local/state}/verse8/mcp.log` | JSONL 감사 로그 위치. 1 MB에서 회전 (`.1` 하나만 보관). 모드 `0600`. |
| `VERSE8_PROXY_REQUEST_TIMEOUT_MS` | `120000` (120초) | 업스트림 MCP 프록시 요청의 최소 타임아웃 (ms). 모든 서비스의 타임아웃이 이 값 이하로 내려가지 않도록 보장합니다. |
| `XDG_CONFIG_HOME` | `~/.config` | 토큰 파일 부모 디렉터리 (`verse8/token`, 모드 `0600`). |
| `XDG_STATE_HOME` | `~/.local/state` | 감사 로그 부모 디렉터리 (`VERSE8_AUDIT_LOG_PATH` 참조). |
| `VERSE8_STUB_PROJECTS=1` | _(미설정)_ | 라이브 `POST /v1/projects` 호출 건너뜀 (개발 / CI). |

모든 URL 오버라이드는 `*.verse8.io` / localhost에 host-validated됩니다. 허용 목록 외 호스트는 stderr에 로깅되고 기본값이 사용됩니다.

## 토큰 우선순위

1. env `VERSE8_ACCESS_TOKEN`
2. `<cwd>/.verse8/token`
3. `${XDG_CONFIG_HOME:-~/.config}/verse8/token`
