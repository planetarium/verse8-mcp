# @verse8/mcp

MCP에 연결하면 AI 에이전트에게 한마디로 Verse8 게임 제작을 시작할 수 있는 서버입니다.

---

## 1분 시작

**1단계 — MCP 서버 추가 (1회):**

```bash
claude mcp add verse8 -- npx -y @verse8/mcp   # Claude Code
codex  mcp add verse8 -- npx -y @verse8/mcp   # Codex
```

**2단계 — 게임 만들기:**

```
You: verse8으로 2D 슈팅 게임 만들어줘
```

끝입니다.

에이전트가 자동으로 로그인 필요 여부를 판단해 안내하고, 템플릿을 제안합니다. **사용자가 직접 하는 일은 템플릿 승인 한 번**. 승인 후 GitLab 프로젝트 생성, 클론, attach까지 자동.

```
설치 → 한 문장 요청 → 템플릿 승인 1번
```

배포는 웹 에디터에서 — **<https://create.verse8.io/>** 에서 Deploy 버튼.

---

## 다른 호스트 / 수동 설치

CLI 헬퍼가 없거나 (Claude Desktop, Cursor, opencode, Continue) 직접 JSON을 편집하고 싶다면 → [docs/manual-install.md](./docs/manual-install.md).

---

## Tool Reference

| 툴 | 한 줄 요약 | 노출 |
|------|----------|------|
| `verse8_bootstrap` | **에이전트가 항상 첫 번째로 호출.** 다음 행동/툴을 결정해주는 상태 머신. | 항상 |
| `verse8_login_start` / `verse8_login_complete` | RFC 8628 device flow 로그인 (자동 호출됨). | 항상 |
| `verse8_status` | 토큰/프로젝트/만료 임박 점검 + `workflow.nextTool` 라우팅. | 항상 |
| `verse8_new_project_start` → `verse8_new_project_confirm` | 새 verse8 프로젝트 생성 2단계 (템플릿 제안 → 승인 → 클론 + attach). | 항상 |
| `verse8_attach` | 이미 클론된 `gitlab.verse8.io` 프로젝트에 hooks + AGENTS.md + 스킬 설치. 멱등. | 항상 |
| `verse8_checkpoint` | `git add -A` → V8 포맷 커밋 → push. | 유효 토큰 |
| `verse8_preview` | checkpoint → preflight → `bun run dev` 백그라운드 spawn. | 유효 토큰 |
| `image_*`, `music_generate`, `sfx_generate`, `spritesheet_*`, `skybox_*`, `claythis_3d_*`, `cinematic_*`, `crossramp_*`, `ui_theme_*` | 업스트림 생성 서비스 프록시. | 유효 토큰 |

> **0.4.0 breaking** — 옛 단일 툴 shim `verse8_new_project`는 제거됨. `_start` → `_confirm`을 사용하세요. 자세한 내용은 [CHANGELOG.md](./CHANGELOG.md).

리소스: `verse8://skill/<name>/SKILL.md`. 프롬프트: `verse8-new-project-bootstrap`.

---

## 문제 복구

### MCP server restarted mid-flow

MCP 호스트가 verse8 서버를 도중에 재시작하면 (설정 변경, 크래시, 수동 `/reload`) 이전 세션의 `startCallId`로 `verse8_new_project_confirm`을 호출했을 때 `template_mismatch`가 반환됩니다. 이는 **예상되고 복구 가능한 상황**입니다 — re-run `verse8_new_project_start({userRequest})`로 새 식별자를 받아 다시 `verse8_new_project_confirm`을 호출하세요. rate-limit 윈도우도 마찬가지로 프로세스 로컬이라 매 재시작마다 리셋됩니다.

---

## 더 알아보기

- 환경 변수: [docs/environment.md](./docs/environment.md)
- 수동 설치 / 호스트별 config: [docs/manual-install.md](./docs/manual-install.md)
- 스킬 시스템: [docs/skills.md](./docs/skills.md)
- 에이전트 워크플로 디스커버리 (`verse8_bootstrap` 상태 머신) + 아키텍처: [docs/architecture.md](./docs/architecture.md)
- 관측성 (감사 로그): [docs/observability.md](./docs/observability.md)
- 보안 자세: [docs/security.md](./docs/security.md)
- 개발 / 빌드 / 테스트 / invariants: [docs/development.md](./docs/development.md)
- 마스터 플랜 + invariants 매핑: [.omc/ARCHITECTURE.md](./.omc/ARCHITECTURE.md), [.omc/INVARIANTS.md](./.omc/INVARIANTS.md)

---

## License

MIT
