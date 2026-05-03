# 수동 설치 (Manual Install)

CLI 헬퍼가 없거나 직접 설정 파일을 편집하고 싶을 때. 모든 MCP 호환 호스트는 동일한 JSON 서버 설정 스키마를 공유합니다:

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

환경 변수가 필요할 때만 추가:

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

## 기본 타임아웃 (120초)

@verse8/mcp는 프록시 요청 타임아웃을 **기본 120초(120,000ms)**로 적용합니다.
`VERSE8_PROXY_REQUEST_TIMEOUT_MS` 환경변수로 덮어쓸 수 있습니다.
별도 설정 없이도 2분까지 응답을 기다리므로 대부분의 경우 추가 구성이 필요 없습니다.

다만 MCP 클라이언트 자체의 per-tool 호출 타임아웃도 120초 이상으로
조정해야 합니다. 클라이언트별 방법은 아래와 같습니다.

### Claude Code

```bash
claude mcp add verse8 -- npx -y @verse8/mcp
```

Claude Code는 MCP 프로토콜 사양에 따라 per-tool-call 타임아웃이
기본 **60초**입니다. 이 값을 늘리려면 `.mcp.json` 또는 `~/.claude.json`에
다음과 같이 설정하세요:

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

> 서버 측 타임아웃은 `VERSE8_PROXY_REQUEST_TIMEOUT_MS` 환경변수로
> 덮어쓸 수 있습니다 (기본값 120000). 기본값으로 충분하면 생략하세요.
> ```json
> { "mcpServers": { "verse8": { "env": { "VERSE8_PROXY_REQUEST_TIMEOUT_MS": "180000" } } } }
> ```

### Codex

`~/.codex/config.toml` (또는 프로젝트 `.codex/config.toml`) 에서
`tool_timeout_sec` 를 120초로 설정:

```toml
[mcp_servers.verse8]
command = "npx"
args = ["-y", "@verse8/mcp"]
tool_timeout_sec = 120
```

> Codex의 기본 per-tool 타임아웃은 60초입니다. `tool_timeout_sec = 120` 으로
> 오버라이드하면 2분까지 안전하게 실행됩니다.
> 서버 측 타임아웃 덮어쓰기는 `[mcp_servers.verse8.env]`에
> `VERSE8_PROXY_REQUEST_TIMEOUT_MS = "180000"` 형태로 추가할 수 있습니다 (기본값 120000).

### OpenCode

`opencode.json` 에서 `timeout` 필드를 120000(ms)으로 설정:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "verse8": {
      "type": "local",
      "command": ["npx", "-y", "@verse8/mcp"],
      "timeout": 120000
    }
  }
}
```

> OpenCode의 기본 `timeout` 은 5000ms(5초)입니다. 120000(120초)으로 설정하세요.
> 서버 측 타임아웃 덮어쓰기는 `"environment": { "VERSE8_PROXY_REQUEST_TIMEOUT_MS": "180000" }`
> 으로 추가할 수 있습니다 (기본값 120000).

### Cursor

`<프로젝트>/.cursor/mcp.json` 또는 `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "verse8": {
      "command": "npx",
      "args": ["-y", "@verse8/mcp"],
      "env": {
        "VERSE8_PROXY_REQUEST_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

## 호스트별 설정 파일 위치

| 호스트 | CLI 헬퍼 | 설정 파일 |
|--------|---------|----------|
| Claude Code | `claude mcp add verse8 -- npx -y @verse8/mcp` | `~/.claude.json` (사용자) 또는 `.mcp.json` (프로젝트) |
| Claude Desktop | — | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows); 편집 후 앱 재시작 |
| Codex | `codex mcp add verse8 -- npx -y @verse8/mcp` | `~/.config/codex/config.toml` (`[mcp_servers.verse8]` 섹션) |
| Cursor | — | `<프로젝트>/.cursor/mcp.json` 또는 `~/.cursor/mcp.json` |
| opencode | — | `~/.config/opencode/mcp.json` |
| Continue (VS Code) | — | `~/.continue/config.json` → `mcpServers`; 편집 후 윈도우 새로고침 |

stdio로 MCP를 말하는 모든 호스트가 동작합니다 — `command` / `args` MCP 서버 설정을 받는 어떤 호스트든 위 스니펫이 그대로 통합니다.

## 버전 핀

프로덕션에서는 npm 페이지에서 최신 버전을 확인 후 `@verse8/mcp@<version>` 형태로 핀하세요. CI에서 갑작스러운 메이저 변경이 깨뜨리는 일을 막아줍니다.

## 프로젝트 스코프

팀과 공유 (`.mcp.json` 프로젝트 스코프):

```bash
claude mcp add verse8 --scope project -- npx -y @verse8/mcp
```

## 제거

```bash
claude mcp remove verse8
codex  mcp remove verse8
```
