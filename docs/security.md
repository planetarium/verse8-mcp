# 보안 자세 (Security posture)

- **Trust-boundary redaction** — 모든 MCP 응답 envelope (tool, resource, prompt)이 `util/redact.ts`를 통과합니다. `glpat-*`, `Bearer <token>`, `oauth2:<secret>@…` URL, `access_token / refresh_token / device_code` JSON 필드를 포함한 throw된 에러도 호스트 LLM에 그대로 도달하지 않습니다.

- **Path-traversal rejection** — `projectDir` / `targetDir`은 MCP dispatch 경계에서 zod-refined됩니다. `..`, NUL, symlinked parent는 파일시스템 접근 전에 `invalid_input` / `invalid_parent`로 거부됩니다.

- **Clone-command safety** — `git clone`은 항상 `execFileSync` argv-array 형태로 실행됩니다. GitLab PAT는 `parseCloneCommand`로 파싱되며 절대 셸에 보간되지 않습니다.

- **Host allow-list** — 모든 env-driven base URL은 `*.verse8.io` + loopback에 대해 caller별 정책 predicate로 검증됩니다. 단일 진입점 `parseOverrideHost` (low-level URL parser)만 공유하고, 정책 결정 (auth / proxy / web-editor)은 caller 별로 분리되어 있습니다.

- **Failure atomicity** — `applyAttachmentArtifacts`는 단계별 reverse op를 기록합니다. 중간 단계 실패 시 LIFO 순으로 이전 쓰기를 rollback 해 디스크에 어떤 부분적인 attach 흔적도 남기지 않습니다.

- **Publish guard** — `prepublishOnly`가 `scripts/prepublish-guard.sh`를 실행해 `npm pack` 타볼에서 `glpat-*`, `Bearer <token>`, `"access_token":"…"`, `VITE_AGENT8_ACCOUNT=0x<hex>`, `*.map` 파일명을 스캔. 매치가 있으면 publish 거부.

- **Secret-pattern fuzz tests** — `tests/unit/redact.test.mjs` + `tests/unit/dispatchRedaction.test.mjs`가 8 가지 secret shape에 대해 redactor + dispatch envelope wrapping을 회귀 검증.

## 불변 조건 (Invariants)

리팩터링해도 깨지면 안 되는 약속입니다. 각 조건을 지키는 테스트·소스 위치에는 `// INV-3: …` 형태의 태그 주석이 달려 있습니다. 위치를 찾으려면:

```bash
git grep -n 'INV-3:'
```

태그가 붙은 테스트를 고치거나 옮길 때 태그도 함께 옮기고, 새 조건을 추가하면 다음 번호로 태그를 답니다.

| ID | 조건 |
|---|---|
| INV-1 | **토큰은 셸에 들어가지 않는다.** GitLab PAT는 `parseCloneCommand`로 파싱해 `execFileSync` argv로만 넘긴다. 백엔드가 준 slug에 `..`, `/`, `\`, NUL이 있으면 거부 |
| INV-2 | **`.verse8/project.json`에 비밀값이 없다.** 페이로드는 `{version, projectId, attachedAt}`뿐 |
| INV-3 | **URL override는 호스트를 검증한다.** env로 받는 base URL은 모두 `parseOverrideHost` + caller별 `isAllowed*` predicate(`*.verse8.io` + loopback)를 거치고, 거부되면 기본 URL 사용 |
| INV-4 | **스킬 병합 우선순위는 `core > vendor > cache`.** `listSkillResources`가 cache → vendor → core 순으로 `Map.set` 해 마지막 쓰기가 이김 |
| INV-5 | **`.env`의 ACCOUNT/VERSE는 한 번 정해지면 바꾸지 않는다.** 불일치는 `mismatch-preserved` + `verse8_attach({overwriteEnv: true})` 안내 |
| INV-6 | **사용자 스킬은 건드리지 않는다.** `writeSkillFiles`는 번들 스킬 이름의 디렉터리에만 쓰고, verse8-mcp 해시 마커가 없는 디렉터리는 `overwriteAllSkills`·`pruneOrphanedSkills`에서도 그대로 둠 |
| INV-7 | **overwrite 플래그는 자기 대상에만 적용된다.** `overwriteAllSkills`는 스킬에만, `overwriteEnv`는 `.env`에만 |
| INV-8 | **V8 커밋 포맷은 외부 계약이다.** `buildV8CommitMessage`는 결정적이고, 파서는 빌더 출력을 모두 받아들이며 구조가 어긋난 메시지는 거부 |
| INV-9 | **서술은 `<V8AssistantMessage>` 안에 둔다.** `<problemStatement>`·`<workSummary>`는 그 안에 쓰고 `<V8AgentMessage>` JSON에도 복제. 구 `## Problem`/`## Work` 형식은 읽기만 함 |
| INV-10 | **프록시 세션 재시도는 한 번뿐.** 세션 만료 시 캐시를 비우고 한 번 재초기화·재시도, 두 번 연속 실패는 그대로 반환 |
| INV-11 | **도구 노출은 토큰 기준, cwd 기준이 아니다.** 토큰이 있으면 `verse8_checkpoint`·`verse8_preview`·프록시 도구를 노출하고, 호출 시점에 프로젝트를 다시 검증 |
| MCP-UP-1 | **`verse8_upload_asset`은 허용된 백엔드에만 보낸다.** URL은 `getAgent8BackendBaseUrl()` + `isAllowedAgent8BackendBase` |
| MCP-UP-2 | **`cdnPath` 경로 조작은 네트워크 전에 거부한다.** `..`, 앞 `/`, 빈 세그먼트, NUL, 경로 구분자가 든 `filename` |
| MCP-UP-3 | **`ATTACHMENT_EXTS`가 네트워크 전 확장자 관문이다.** `planetarium/agent8-backend/src/config/constants.ts` 목록을 손으로 동기화 |
