# 아키텍처

Invariants are listed in [security.md › Invariants](./security.md#invariants).

## 핵심 개념

- **토큰 우선순위**: env `VERSE8_ACCESS_TOKEN` → `<cwd>/.verse8/token` → `${XDG_CONFIG_HOME:-~/.config}/verse8/token`.
- **프로젝트 감지**: cwd에 `.verse8/project.json` AND `git remote origin` 호스트가 `gitlab.verse8.io`.
- **Hook entrypoint**: `verse8-mcp hook pre-commit` / `verse8-mcp hook commit-msg` (git이 commit 시 호출).
- **동적 툴**: 툴 셋이 매 `tools/list` 요청마다 현재 cwd + 토큰 존재로 재평가됨.
- **Bin**: 단일 `verse8-mcp` executable이 서브커맨드(`serve` / `hook pre-commit` / `hook commit-msg`)를 dispatch. `npx -y @verse8/mcp`는 패키지에 bin이 정확히 하나라 인자 없이 실행됨.

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
