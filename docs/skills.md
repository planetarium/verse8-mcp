# 스킬 시스템

`@verse8/mcp`는 두 소스에서 스킬 문서를 번들로 가져와 attached된 모든 프로젝트에 per-project 스킬로 머터리얼라이즈합니다:

| 소스 | 용도 | 관리 |
|------|------|------|
| `skills/` | 코어 스킬 (`verse8-login`, `verse8-commit`, …) | 이 패키지에 포함 |
| `skills-vendor/agent8-skills/` | 게임 빌딩 스킬 (gameserver SDK, vibe-starter-3d, …) | [planetarium/agent8-skills](https://github.com/planetarium/agent8-skills)의 `public.json`이 허용한 것만 워크플로우가 자동 벤더링 |

`verse8_attach` 시 (그리고 `verse8_new_project_confirm`의 마지막 단계로) **이 프로젝트에 해당하는** 스킬이 `<projectDir>/.claude/skills/<name>/SKILL.md`에 복사되어 Claude Code가 자동 로드합니다. 다른 호스트(Codex, Cursor, opencode, …)는 같은 목록을 `AGENTS.md` / `CLAUDE.md`에 splice된 동적 `## Available Verse8 skills` 카탈로그로 보고, `resources/read verse8://skill/<name>/SKILL.md`로 내용을 가져올 수 있습니다. MCP 리소스 목록 자체는 게이트 없이 번들된 스킬 전부를 노출합니다.

각 파일 끝의 `<!-- verse8-skill-hash: <sha256> -->` 마커가 사용자 편집을 감지합니다. 해시가 어긋나면 "사용자가 소유한 파일"로 간주되어 re-attach 시 byte-identical하게 보존됩니다. `overwriteAllSkills: true`는 re-copy를 강제. `pruneOrphanedSkills: true`는 더 이상 번들되지 않으면서 *우리 해시 마커가 편집되지 않은 채 남은* `.claude/skills/<name>/SKILL.md`를 지우고, 그 폴더는 비었을 때만 지웁니다 — 사용자 작성 디렉터리(마커 없음)와 폴더 안의 다른 파일은 절대 건드리지 않습니다. attach가 중간 단계에서 실패하면 그 실행이 바꾼 파일만 되돌립니다: 덮어쓰거나 지운 `SKILL.md`는 이전 바이트와 파일 모드 그대로 복원하고, 스킬 폴더는 그 실행이 새로 만든 경우에만 지웁니다.

## 플러그인 활성화 (requiresPackage)

벤더링된 플러그인(`skills-vendor/agent8-skills/plugins/<p>/`)은 Agent8 컨테이너와 같은 규칙으로 프로젝트마다 켜고 끕니다(`src/resources/pluginGate.ts`, 상류 `plugins/README.md`의 "Package scoping"):

- `plugin.json`에 `requiresPackage`가 없거나 `[]`이면 항상 활성.
- 있으면 프로젝트 `package.json`의 `dependencies`·`devDependencies`에 그중 하나라도 있으면 활성(OR).
- `requiresPackage` 형식이 잘못됐거나(배열 아님, 16개 초과, npm 패키지 이름이 아닌 항목) `plugin.json`이 없거나 깨졌거나 `tags`가 비어 있지 않으면 비활성 — 읽을 수 없는 스코프가 "모두에게 적용"으로 떨어지지 않게 합니다.
- `package.json`이 없거나 파싱되지 않으면 의존성 집합은 비어 있는 것으로 봅니다(패키지 스코프 플러그인은 모두 비활성).
- 최상위 `skills/<name>.md`와 코어 스킬은 항상 활성.

활성 플러그인의 스킬만 설치·카탈로그에 올리고, 활성 플러그인의 `instructions/AGENTS.md`는 플러그인 이름 순으로 카탈로그 뒤에 합성됩니다(AGENTS.md를 새로 쓰거나 `overwriteAgentsDoc: true`일 때). 비활성 플러그인의 스킬 중 우리 해시 마커가 그대로인 `.claude/skills/<name>/SKILL.md`는 플래그와 관계없이 지워지고(`installed.skills.deactivated`), 사용자가 편집했거나 직접 만든 파일은 남습니다. 판정 결과는 `installed.skillPlugins`(`dependencies` 출처, `active[]`·`inactive[]`와 사유)로 돌려줍니다. 의존성을 추가한 뒤에는 `verse8_attach`를 다시 실행해야 반영됩니다.

## 스킬 병합 우선순위

이름 충돌 시 `core > vendor > cache`. **0.3.0 breaking change** — 이전 릴리스는 사용자 캐시를 마지막에 두어 캐시가 이겼습니다. 0.3.0부터는 문서대로 동작 — 캐시로 번들 스킬을 오버라이드하던 사용자는 패키지를 fork하거나 스킬 이름을 바꿔야 합니다.

## 벤더 스킬 업데이트 (메인테이너)

벤더 트리는 손으로 갱신하지 않습니다. planetarium/agent8-skills의 `main`에 push가 일어나면 그쪽 워크플로우(`notify-verse8-mcp.yml`)가 이 리포로 `repository_dispatch`(`event_type: agent8-skills-updated`, `client_payload: { sha, ref, run_url }`)를 보내고, 이 리포의 `.github/workflows/sync-agent8-skills.yml`이 받아서:

1. 해당 `sha`를 체크아웃하고 그 커밋의 `public.json`(`{ "skills": [...], "plugins": [...] }` allowlist)을 읽습니다. 파일이 없으면 명시적으로 실패합니다(`public_json_missing`).
2. `scripts/sync-agent8-skills.mjs`로 `skills-vendor/agent8-skills/`를 처음부터 다시 만듭니다. 들어가는 것은 아래가 전부입니다:

   ```
   skills-vendor/agent8-skills/
     README.md                      생성 — 출처 안내
     public.json                    상류 매니페스트 그대로
     skills/<name>.md               public.json :: skills[] 하나당 하나
     plugins/<plugin>/              public.json :: plugins[] 하나당 하나
       plugin.json                  상류 매니페스트 그대로 (requiresPackage 게이트)
       instructions/AGENTS.md       상류에 있을 때만
       skills/*.md                  플러그인의 스킬 파일
   ```

   플러그인 `assets/`, 상류의 `prompts/`·최상위 `instructions/`·README는 Agent8 컨테이너용이라 MCP가 읽지 않으므로 가져오지 않습니다. 상류 레이아웃을 그대로 따르므로 MCP의 스킬 탐색(`src/resources/skills.ts`, 부모 디렉터리가 `skills`인 `.md`)이 두 위치를 모두 찾고, `plugins/<p>/skills/` 아래 스킬은 그 플러그인 소속으로 기록되어 위의 활성화 판정을 받습니다.
3. 변경이 있으면 `package.json :: verse8.skillsVendor`를 갱신하고(`sha` = `scripts/compute-subtree-sha.sh` 콘텐츠 해시, `upstream.commit` = 벤더링한 상류 커밋) 브랜치 `sync/agent8-skills`에 force-push해 PR을 열거나 기존 PR을 갱신합니다. 공개 대상에 변경이 없으면 PR 없이 끝나고, 받은 `sha`가 이미 핀된 커밋(main의 핀, 또는 열려 있는 `sync/agent8-skills` 브랜치의 핀)이거나 그 조상이면 건너뜁니다(`scripts/sync-skip-check.mjs`). 늦게 도착했거나 재실행된 오래된 dispatch가 더 새로운 sync PR을 되돌리지 못하게 하기 위해서입니다.

수신 측에서도 플러그인 적격성을 확인합니다: `tags`가 있는(태그 스코프) 플러그인과 `preview`/`publish` 에셋을 싣는 플러그인은 MCP에 태그 게이트·에셋 주입 경로가 없으므로 allowlist에 있어도 실패시킵니다. `requiresPackage` 형식이 잘못된 플러그인도 실패시킵니다(`plugin_invalid`) — 런타임은 이를 비활성으로 처리하므로 그대로 실으면 플러그인 스킬이 조용히 사라집니다. 같은 이름의 스킬이 두 곳에서 오면(`skill_name_collision`) 역시 실패합니다. `skills/`·`plugins/`·`plugins/<p>/`·`plugins/<p>/skills/`가 symlink이거나 스킬 파일이 symlink이면 따라가지 않고 실패합니다(`symlink_rejected`) — allowlist 밖의 파일이 링크를 타고 들어오는 길을 막기 위해서입니다.

수동으로 돌리려면 상류를 체크아웃해 두고:

```bash
node scripts/sync-agent8-skills.mjs --upstream ../agent8-skills \
  --commit "$(git -C ../agent8-skills rev-parse HEAD)"   # --dry-run 으로 미리보기
bash scripts/check-subtree-sha.sh
```

콘텐츠 해시는 LF 체크아웃 기준입니다. Windows의 `core.autocrlf=true` 작업 트리에서는 값이 달라지므로 핀 계산과 `check:subtree-sha`는 Linux(CI/WSL)에서 돌립니다. `bash scripts/check-subtree-sha.sh`는 CI(`ci.yml`)에서 매 push마다 실행되어 핀 없이 트리가 drift하면 실패합니다.

사용자는 `npx -y @verse8/mcp@latest` (또는 의존성 매니페스트)로 업그레이드하고 `verse8_attach`를 재실행해 새 스킬을 프로젝트에 전파합니다.
