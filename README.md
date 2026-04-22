# @verse8/mcp

Verse8 MCP 메타-서버 — `gitlab.verse8.io` 프로젝트를 자동 감지하고 verse8 스킬, 이미지/에셋 생성 툴, 프리뷰 오케스트레이션, git 체크포인트 기능을 모든 Model Context Protocol 호스트(Claude Code, Claude Desktop, Codex, Cursor, opencode, Continue, …)에 노출합니다.

- **패키지**: `@verse8/mcp`
- **바이너리**: `verse8-mcp` (stdio MCP 서버)
- **호출**: `npx -y @verse8/mcp` (단일 bin 패키지 — npx가 자동으로 `verse8-mcp` 선택)

---

## 빠른 시작

### 1. 설치 (CLI 한 줄)

MCP 호스트가 CLI 헬퍼를 제공한다면 한 명령이면 충분합니다:

```bash
# Claude Code
claude mcp add verse8 -- npx -y @verse8/mcp

# Codex
codex mcp add verse8 -- npx -y @verse8/mcp
```

호스트를 재시작(또는 새 세션을 열면) `verse8_login_start` / `verse8_status` / 등의 툴이 목록에 나타납니다.

> **프로덕션에서는 버전 핀을 권장합니다.** npm 페이지에서 최신 버전을 확인 후 `@verse8/mcp@<version>` 형태로 고정하세요. CI에서 갑작스러운 메이저 변경이 깨뜨리는 일을 막아줍니다.

**팀과 공유 (`.mcp.json` 프로젝트 스코프):**

```bash
claude mcp add verse8 --scope project -- npx -y @verse8/mcp
```

**제거:**

```bash
claude mcp remove verse8
codex  mcp remove verse8
```

### 2. 설치 확인

```bash
claude mcp list     # Claude Code
codex  mcp list     # Codex
```

`verse8: npx -y @verse8/mcp - ✓ Connected` (또는 동등한 표시)가 보이면 성공입니다. 첫 호출 시 `npx`가 패키지를 로컬 캐시로 받아오느라 몇 초 걸릴 수 있습니다.

### 3. 로그인 (1회)

verse8 툴을 쓰기 전에 RFC 8628 device flow로 인증합니다:

```
You: verse8에 로그인해줘.
# 에이전트가 verse8_login_start 호출 → 검증 URL + 사용자 코드 표시
# 브라우저에서 승인
# 에이전트가 verse8_login_complete 호출 → 토큰 저장
```

액세스 토큰은 `${XDG_CONFIG_HOME:-~/.config}/verse8/token` (모드 `0600`)에 저장됩니다. 이후 모든 툴 호출이 자동으로 이 토큰을 사용합니다. MCP 호스트가 없는 환경에서는 이 레포의 `bash scripts/verse8-login.sh`로 헤드리스 로그인 가능.

---

## 사용 시나리오

### Case 1 — 기존 verse8 프로젝트에 attach

이미 클론한 verse8 프로젝트가 있다면:

```bash
git clone https://gitlab.verse8.io/<user>/<project>.git
cd <project>
# MCP 호스트 시작 (예: claude, codex, cursor)
```

에이전트가 프로젝트 안에서 시작되면 `gitlab.verse8.io` origin을 감지해 `verse8_checkpoint` / `verse8_preview` / 이미지 생성 프록시를 노출하고, 첫 `verse8_attach` 호출 시 git hooks + `AGENTS.md` / `CLAUDE.md`를 설치합니다. 이후:

1. 코드/에셋/프롬프트 작업
2. 에이전트에게 "커밋해줘"라고 하거나 `verse8_checkpoint` 호출 — `git add -A` 스테이지 → V8 포맷 커밋 → `gitlab.verse8.io`에 푸시

### Case 2 — 새 verse8 프로젝트 생성

아무 디렉터리에서 MCP 호스트를 시작하고 게임을 설명하세요:

```
You: 2D 슈팅 게임을 만들어줘.
```

MCP는 사용자 승인 게이트가 들어간 **2단계 플로우**를 노출합니다:

1. `verse8_new_project_start({userRequest})` — `agent8-backend.verse8.io`의 `/api/startcall`을 호출하고 제안된 템플릿(name, label, description, tags), 추천 title + repo slug, `startCallId`를 반환합니다. 에이전트가 제안을 보여줍니다.
2. 승인 (또는 title/slug 오버라이드).
3. `verse8_new_project_confirm({templateName, repo, path, title, projectRepo, startCallId, targetDir?})` — GitLab 프로젝트 생성, 30일 액세스 토큰 발급, `develop` 브랜치를 `<targetDir>/<slug>`에 클론, verse8 git hooks + `AGENTS.md` 설치.

응답에는 `nextCallRequires.projectDir`이 포함됩니다 — 세션 내 모든 후속 `verse8_checkpoint` / `verse8_preview` / 이미지 프록시 호출에 `projectDir: <그 경로>`를 넘겨야 합니다 (MCP 서버 자신의 cwd는 부모 디렉터리에 그대로 있음).

일시적 실패(`token_grant_failed`, `clone_failed`, …) 시 에러 envelope에 `projectPath`가 포함됩니다 — 그 `projectPath`를 echo해서 `verse8_new_project_confirm`을 다시 호출하면 중복 프로젝트 생성을 건너뜁니다.

### 프로덕션 배포

배포는 **Verse8 웹 에디터**에서 수행하며, MCP 툴이 아닙니다.

- 열기: **https://create.verse8.io/**
- 동일 계정으로 로그인
- 프로젝트 열고 **Deploy** 클릭

`verse8_checkpoint` / `verse8_preview`는 `gitlab.verse8.io`에 커밋 + 푸시할 뿐, 프로덕션 배포를 트리거하지 않습니다. 에이전트는 "배포 / publish / ship" 요청 시 위 URL로 안내해야 하며 Bash 명령을 임의로 만들어내면 안 됩니다.

### MCP 서버가 도중에 재시작된 경우 (MCP server restarted mid-flow)

`verse8_new_project_*` 내부의 일부 상태(`startCallId → digest` 메모, in-flight-confirm 가드, `verse8_new_project_start`의 프로세스-로컬 rate-limit 윈도우)는 실행 중인 MCP 서버 메모리에만 존재합니다. **재시작하면 모두 사라집니다.**

MCP 호스트가 verse8 서버를 도중에 재시작하면(설정 변경, 크래시, 수동 `/reload`, 호스트 업그레이드) 이전 세션의 `startCallId`로 다음 `verse8_new_project_confirm`을 호출하면 `template_mismatch`가 반환됩니다. 이는 **예상되고 복구 가능한 상황**입니다: re-run `verse8_new_project_start({userRequest})`를 다시 실행하고, 새로 받은 식별자로 `verse8_new_project_confirm`을 호출하세요.

rate-limit 윈도우도 마찬가지로 프로세스 로컬이라 매 재시작마다 리셋됩니다. 영속 저장소는 후속 릴리스 과제입니다.

---

## 수동 설치 (범용 MCP JSON)

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

이게 최소입니다. 환경 변수가 필요할 때만 추가:

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

### 호스트별 설정 파일 위치

| 호스트 | CLI 헬퍼 | 설정 파일 |
|--------|---------|----------|
| Claude Code | `claude mcp add verse8 -- npx -y @verse8/mcp` | `~/.claude.json` (사용자) 또는 `.mcp.json` (프로젝트) |
| Claude Desktop | — (수동 JSON만) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows); 편집 후 앱 재시작 |
| Codex | `codex mcp add verse8 -- npx -y @verse8/mcp` | `~/.config/codex/config.toml` (`[mcp_servers.verse8]` 섹션) |
| Cursor | — (수동 JSON만) | `<프로젝트>/.cursor/mcp.json` 또는 `~/.cursor/mcp.json` |
| opencode | — (수동 JSON만) | `~/.config/opencode/mcp.json` |
| Continue (VS Code) | — (수동 JSON만) | `~/.continue/config.json` → `mcpServers`; 편집 후 윈도우 새로고침 |

stdio로 MCP를 말하는 모든 호스트가 동작합니다 — `command` / `args` MCP 서버 설정을 받는다면 위 스니펫을 그대로 쓰세요.

---

## 툴 레퍼런스

| 툴 | 용도 | 노출 조건 |
|------|------|-----------|
| `verse8_bootstrap` | **항상 첫 번째로 호출.** 상태 머신 `workflow.nextTool` (+ `instructions`) 반환 — 에이전트가 파일시스템 검사로 워크플로 상태를 추측하지 않고 결정론적으로 라우팅. 상세는 [에이전트 워크플로 디스커버리](#에이전트-워크플로-디스커버리) 참조. | 항상 |
| `verse8_login_start` | RFC 8628 device code 요청. `verification_uri_complete` + `user_code` + `device_code`를 즉시 반환 (폴링 없음). URL/코드를 사용자에게 보여주고 브라우저 승인을 기다린 뒤 complete 호출. | 항상 |
| `verse8_login_complete` | `max_wait_seconds` (기본 120, 최대 1800) 동안 토큰 엔드포인트 폴링. 성공 시 토큰 저장. 같은 `device_code`로 재시도 안전. | 항상 |
| `verse8_status` | 토큰 유효성, 프로필, 프로젝트 attachment, MCP 프록시 상태 확인. 토큰 `exp`가 7일 이내면 `warnings: ["token_expires_soon"]` + `tokenExpiresAt` (ISO) 포함. | 항상 |
| `verse8_new_project_start` | new-project 플로우 1단계. 사용자 검토용 `{templateName, repo, path, suggestedTitle, suggestedProjectRepo, startCallId}` 반환. | 항상 |
| `verse8_new_project_confirm` | 2단계: GitLab 프로젝트 생성, 30일 토큰 발급, `git clone -b develop`, hooks + AGENTS.md 설치. 세션 전체에서 재사용할 `projectDir` 반환. | 항상 |
| `verse8_attach` | 이미 클론된 `gitlab.verse8.io` 프로젝트에 hooks + AGENTS.md / CLAUDE.md + 스킬 카탈로그 설치. 멱등. 플래그: `overwriteAgentsDoc`, `overwriteAllSkills`, `pruneOrphanedSkills`, `overwriteEnv`. | 항상 |
| `verse8_checkpoint` | 모든 변경 스테이지(`git add -A`), V8 포맷 커밋 빌드, origin에 푸시. 첫 호출 시 `.env` self-heal. | 유효 토큰 |
| `verse8_preview` | `verse8_checkpoint` → preflight (`bun update`, GameServer 프로젝트면 `gameserver-node build` + `deploy --preview`) → `bun run dev` 백그라운드 spawn. origin이 `gitlab.verse8.io`이면 `webEditor.url` 반환. | 유효 토큰 |
| `image_asset_generate`, `image_variation_generate`, `asset_wait`, `music_generate`, `sfx_generate`, `spritesheet_generate`, `skybox_generate`, `claythis_3d_generate`, `cinematic_asset_generate`, `crossramp_*`, `ui_theme_*` | 업스트림 생성 서비스를 MCP 서버를 통해 프록시. 툴 surface는 `tools/list` 시점에 발견 (업스트림 가용성에 따라). | 유효 토큰 |

> **0.4.0 breaking** — 옛 단일 툴 shim `verse8_new_project`는 제거되었습니다. `verse8_new_project_start` → `verse8_new_project_confirm`을 사용하세요. [CHANGELOG.md](./CHANGELOG.md) 참조.

### 리소스 (읽기 전용)

| 리소스 | 용도 |
|--------|------|
| `verse8://skill/<name>/SKILL.md` | 스킬 문서 (예: `verse8://skill/gameserver-sdk/SKILL.md`) |

### 프롬프트

| 프롬프트 | 용도 |
|---------|------|
| `verse8-new-project-bootstrap` | 새 프로젝트 셋업 인터랙티브 워크스루 |

---

## 환경 변수

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `VERSE8_API_URL` | `https://v8-meme-api.verse8.io` | Auth / verify API base. `*.verse8.io` + loopback에 host-validated. |
| `VERSE8_AGENT8_BACKEND_URL` | `https://agent8-backend.verse8.io` | 프로젝트 생성 base (startcall / select-template / project-access-token). |
| `VERSE8_IMAGE_MCP_URL` | `https://mcp-image-svc.verse8.io/mcp` | 이미지 생성 MCP 엔드포인트. |
| `VERSE8_CREATE_URL` | `https://create.verse8.io` | preview 응답 `webEditor.url`의 웹 에디터 base. |
| `VERSE8_ACCESS_TOKEN` | _(미설정)_ | 설정 시 토큰 파일 대신 사용. |
| `VERSE8_GAMESERVER_BUILD_PIN` | _(미설정)_ | `verse8_preview` preflight가 사용하는 `@agent8/gameserver-node` / `@agent8/deploy` 버전 오버라이드 (`pkg=ver,pkg=ver` 포맷). `package.json :: verse8.gameserverPin`보다 우선. |
| `VERSE8_AUDIT_LOG_PATH` | `${XDG_STATE_HOME:-~/.local/state}/verse8/mcp.log` | JSONL 감사 로그 위치. 1 MB에서 회전 (`.1` 하나만 보관). 모드 `0600`. |
| `XDG_CONFIG_HOME` | `~/.config` | 토큰 파일 부모 디렉터리 (`verse8/token`, 모드 `0600`). |
| `XDG_STATE_HOME` | `~/.local/state` | 감사 로그 부모 디렉터리 (`VERSE8_AUDIT_LOG_PATH` 참조). |
| `VERSE8_STUB_PROJECTS=1` | _(미설정)_ | 라이브 `POST /v1/projects` 호출 건너뜀 (개발 / CI). |

모든 URL 오버라이드는 `*.verse8.io` / localhost에 host-validated됩니다. 허용 목록 외 호스트는 stderr에 로깅되고 기본값이 사용됩니다.

---

## 스킬

`@verse8/mcp`는 두 소스에서 스킬 문서를 번들로 가져와 attached된 모든 프로젝트에 per-project 스킬로 머터리얼라이즈합니다:

| 소스 | 용도 | 관리 |
|------|------|------|
| `skills/` | 코어 스킬 (`verse8-login`, `verse8-commit`, …) | 이 패키지에 포함 |
| `skills-vendor/agent8-skills/` | 게임 빌딩 스킬 (gameserver SDK, vibe-starter-3d, …) | [planetarium/agent8-skills](https://github.com/planetarium/agent8-skills) git subtree |

`verse8_attach` 시 (그리고 `verse8_new_project_confirm`의 마지막 단계로) 모든 발견된 스킬이 `<projectDir>/.claude/skills/<name>/SKILL.md`에 복사되어 Claude Code가 자동 로드합니다. 다른 호스트(Codex, Cursor, opencode, …)는 동일 인벤토리를 `AGENTS.md` / `CLAUDE.md`에 splice된 동적 `## Available Verse8 skills` 카탈로그로 보고, `resources/read verse8://skill/<name>/SKILL.md`로 내용을 가져올 수 있습니다.

각 파일 끝의 `<!-- verse8-skill-hash: <sha256> -->` 마커가 사용자 편집을 감지합니다. 해시가 어긋나면 "사용자가 소유한 파일"로 간주되어 re-attach 시 byte-identical하게 보존됩니다. `overwriteAllSkills: true`는 re-copy를 강제. `pruneOrphanedSkills: true`는 더 이상 번들되지 않으면서 *우리 해시 마커가 있는* `.claude/skills/<name>/` 디렉터리를 제거합니다 — 사용자 작성 디렉터리(마커 없음)는 절대 건드리지 않습니다.

### 스킬 병합 우선순위

이름 충돌 시 `core > vendor > cache`. **0.3.0 breaking change** — 이전 릴리스는 사용자 캐시를 마지막에 두어 캐시가 이겼습니다. 0.3.0부터는 문서대로 동작 — 캐시로 번들 스킬을 오버라이드하던 사용자는 패키지를 fork하거나 스킬 이름을 바꿔야 합니다.

---

## 에이전트 워크플로 디스커버리

모든 Verse8 관련 사용자 요청 ("verse8으로 게임 만들어줘", "이거 커밋해줘", "이 버그 고쳐줘")은 **단일 always-first entry point**인 `verse8_bootstrap`을 통과합니다. 결정론적 상태 머신을 반환합니다:

```jsonc
{
  "ok": true,
  "workspaceMode": "empty" | "unattached_clone" | "attached" | "non_verse_dir",
  "workflow": {
    "nextAction": "login" | "new_project" | "attach" | "ready",
    "nextTool":  "verse8_login_start" | "verse8_new_project_start" | "verse8_attach" | null,
    "reason":    "...",
    "instructions": "..."  // LLM에게 명령형 가이드
  },
  "diagnostics": { "hasGit": bool, "originHost": str|null, "hasProjectMarker": bool,
                   "hasToken": bool, "attached": bool }
}
```

에이전트는 `workflow.nextTool`을 다음으로 호출하고 `workflow.instructions`를 그대로 따릅니다. 이게 중요한 이유: **Codex** 같은 호스트는 `AGENTS.md` / `CLAUDE.md`를 시스템 프롬프트에 자동 로드하지 않습니다 — 툴 계약 기반의 상태 머신이 없으면 BASE_TOOLS 리스트와 서술형 description만 보고 임의로 게임 코드를 생성합니다 (Verse8의 new-project 플로우를 거치지 않고).

`verse8_status`도 같은 `workflow` 구조를 반환합니다 — 이미 status를 호출한 에이전트는 bootstrap 호출을 반복할 필요가 없습니다.

---

## 관측성 (Observability)

모든 툴 dispatch (`verse8_attach`, `verse8_checkpoint`, `verse8_preview`, 이미지 프록시 …)는 정확히 하나의 JSONL 라인을 `${VERSE8_AUDIT_LOG_PATH:-$XDG_STATE_HOME/verse8/mcp.log}`에 쓴다:

```json
{"ts":"2026-04-21T06:18:55.778Z","tool":"verse8_attach","outcome":"ok","durationMs":72,"correlationId":"2d10ee15-…","projectDirDigest":"7fa322a86f4d"}
```

`projectDirDigest`는 `sha256(projectDir).slice(0,12)` — 원본 경로는 절대 기록하지 않습니다. 스키마-파스 실패와 unknown-tool dispatch는 감사 라인을 남기지 **않습니다**. `hint` 필드의 secret-shape 문자열은 dispatch envelope과 동일한 redact 레지스트리로 마스킹됩니다.

## 보안 자세 (Security posture)

- **Trust-boundary redaction** — 모든 MCP 응답 envelope (tool, resource, prompt)이 `util/redact.ts`를 통과합니다. `glpat-*`, `Bearer <token>`, `oauth2:<secret>@…` URL, `access_token / refresh_token / device_code` JSON 필드를 포함한 throw된 에러도 호스트 LLM에 그대로 도달하지 않습니다.
- **Path-traversal rejection** — `projectDir` / `targetDir`은 MCP dispatch 경계에서 zod-refined됩니다. `..`, NUL, symlinked parent는 파일시스템 접근 전에 `invalid_input` / `invalid_parent`로 거부됩니다.
- **Clone-command safety** — `git clone`은 항상 `execFileSync` argv-array 형태로 실행됩니다. GitLab PAT는 `parseCloneCommand`로 파싱되며 절대 셸에 보간되지 않습니다.
- **Host allow-list** — 모든 env-driven base URL은 `*.verse8.io` + loopback에 대해 caller별 정책 predicate로 검증됩니다.
- **Failure atomicity** — `applyAttachmentArtifacts`는 단계별 reverse op를 기록합니다. 중간 단계 실패 시 LIFO 순으로 이전 쓰기를 rollback 해 디스크에 어떤 부분적인 attach 흔적도 남기지 않습니다.
- **Publish guard** — `prepublishOnly`가 `scripts/prepublish-guard.sh`를 실행해 `npm pack` 타볼에서 `glpat-*`, `Bearer <token>`, `"access_token":"…"`, `VITE_AGENT8_ACCOUNT=0x<hex>`, `*.map` 파일명을 스캔. 매치가 있으면 publish 거부.

---

## 개발

### 빌드

```bash
npm run build
```

TypeScript를 `dist/`로 컴파일.

### Dev

```bash
npm run dev
```

`tsx src/index.ts` 실행.

### 테스트

```bash
npm test
```

전체 스위트: `npm run build && bash tests/smoke.sh && npm run test:unit`. 유닛만:

```bash
npm run test:unit
```

분할 smoke 스위트 (M4.1) — 라이브 mock에 대해 단일 서브셋 실행:

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

`npm audit --audit-level=high` — 의존성 트리에 high/critical advisory가 있으면 실패.

### Invariants

```bash
bash scripts/verify-invariants.sh
bash scripts/check-subtree-sha.sh
```

`.omc/INVARIANTS.md`는 11개 프로덕션 invariant (token shell safety, marker secret-freedom, host allow-list, skill precedence, .env immutability, skill no-touch, overwrite-flag scoping, V8 on-wire contract, narrative location, single-shot session retry, token-gated discovery)를 회귀 테스트에 매핑합니다. 검증기가 참조된 모든 테스트 이름을 grep해 누락 시 빌드 실패시킵니다.

### Pre-publish guard

```bash
bash scripts/prepublish-guard.sh
```

`npm publish` 시 `prepublishOnly` 스크립트로 자동 실행됩니다. AC-SECURITY-2 강제 — 타볼이 secret-shape 문자열이나 sourcemap을 운반하지 않음.

### 클린

```bash
npm run clean
```

`dist/` 제거.

### 벤더 스킬 업데이트

벤더 트리는 `git subtree`로 관리됩니다. 업스트림이 새 스킬을 ship하면 메인테이너가:

```bash
git subtree pull \
  --prefix=skills-vendor/agent8-skills \
  https://github.com/planetarium/agent8-skills.git main --squash
npm version patch
npm publish
```

`package.json :: verse8.skillsVendor.sha`가 subtree 콘텐츠 해시를 핀합니다. `bash scripts/check-subtree-sha.sh`는 버전 bump 없이 트리가 drift하면 빌드를 실패시킵니다.

사용자는 `npx -y @verse8/mcp@latest` (또는 의존성 매니페스트)로 업그레이드하고 `verse8_attach`를 재실행해 새 스킬을 프로젝트에 전파합니다.

---

## 아키텍처

현재 아키텍처(모듈 레이아웃, 데이터 플로우, invariant, 알려진 리팩터링 후보)는 [.omc/ARCHITECTURE.md](./.omc/ARCHITECTURE.md) 참조.

핵심 개념:

- **토큰 우선순위**: env `VERSE8_ACCESS_TOKEN` → `<cwd>/.verse8/token` → `${XDG_CONFIG_HOME:-~/.config}/verse8/token`.
- **프로젝트 감지**: cwd에 `.verse8/project.json` AND `git remote origin` 호스트가 `gitlab.verse8.io`.
- **Hook entrypoint**: `verse8-mcp hook pre-commit` / `verse8-mcp hook commit-msg` (git이 commit 시 호출).
- **동적 툴**: 툴 셋이 매 `tools/list` 요청마다 현재 cwd + 토큰 존재로 재평가됨.
- **Bin**: 단일 `verse8-mcp` executable이 서브커맨드(`serve` / `hook pre-commit` / `hook commit-msg`)를 dispatch. `npx -y @verse8/mcp`는 패키지에 bin이 정확히 하나라 인자 없이 실행됨.

---

## License

MIT
