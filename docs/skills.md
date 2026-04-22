# 스킬 시스템

`@verse8/mcp`는 두 소스에서 스킬 문서를 번들로 가져와 attached된 모든 프로젝트에 per-project 스킬로 머터리얼라이즈합니다:

| 소스 | 용도 | 관리 |
|------|------|------|
| `skills/` | 코어 스킬 (`verse8-login`, `verse8-commit`, …) | 이 패키지에 포함 |
| `skills-vendor/agent8-skills/` | 게임 빌딩 스킬 (gameserver SDK, vibe-starter-3d, …) | [planetarium/agent8-skills](https://github.com/planetarium/agent8-skills) git subtree |

`verse8_attach` 시 (그리고 `verse8_new_project_confirm`의 마지막 단계로) 모든 발견된 스킬이 `<projectDir>/.claude/skills/<name>/SKILL.md`에 복사되어 Claude Code가 자동 로드합니다. 다른 호스트(Codex, Cursor, opencode, …)는 동일 인벤토리를 `AGENTS.md` / `CLAUDE.md`에 splice된 동적 `## Available Verse8 skills` 카탈로그로 보고, `resources/read verse8://skill/<name>/SKILL.md`로 내용을 가져올 수 있습니다.

각 파일 끝의 `<!-- verse8-skill-hash: <sha256> -->` 마커가 사용자 편집을 감지합니다. 해시가 어긋나면 "사용자가 소유한 파일"로 간주되어 re-attach 시 byte-identical하게 보존됩니다. `overwriteAllSkills: true`는 re-copy를 강제. `pruneOrphanedSkills: true`는 더 이상 번들되지 않으면서 *우리 해시 마커가 있는* `.claude/skills/<name>/` 디렉터리를 제거합니다 — 사용자 작성 디렉터리(마커 없음)는 절대 건드리지 않습니다.

## 스킬 병합 우선순위

이름 충돌 시 `core > vendor > cache`. **0.3.0 breaking change** — 이전 릴리스는 사용자 캐시를 마지막에 두어 캐시가 이겼습니다. 0.3.0부터는 문서대로 동작 — 캐시로 번들 스킬을 오버라이드하던 사용자는 패키지를 fork하거나 스킬 이름을 바꿔야 합니다.

## 벤더 스킬 업데이트 (메인테이너)

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
