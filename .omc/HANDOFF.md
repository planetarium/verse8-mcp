# Verse8 MCP — 프로덕션 하드닝 세션 핸드오프

> **이 문서의 목적**: 새로운 Claude 세션이 Verse8 MCP 프로덕션 하드닝 작업을 이어받을 때 1분 안에 컨텍스트를 복구하도록.
>
> **Last updated**: 2026-04-21
> **Cumulative ralph iterations**: 6 (M0 → M1a → M2 → M1b → M3 → M4 완료)
> **Next milestone**: 하드닝 플랜 완료 — 사용자 릴리스 세레모니 대기

---

## 1. 한 눈에 보는 위치

```
완료: M0 ✅  M1a ✅  M2 ✅  M1b ✅  M3 ✅  M4 ✅
남은: 없음 (플랜 전체 완료; 사용자 릴리스 ceremony만 남음)
```

**릴리스 타깃 매핑**
- 0.3.1 = M0 (trust-boundary patch) ✅
- 0.3.2 = M1a (deletion-first dedup) ✅
- 0.3.3 = M2 (security hardening) ✅
- 0.4.0 = M1b (structural extraction) + M4.5 (verse8_new_project shim 제거, breaking) ✅ — 릴리스 대기
- 0.4.x = M3 (observability + types + atomicity) ✅
- 0.4.x–0.5.0 = M4 (operational) ✅
- 0.5.0 = M1b.6 (applyAttachmentArtifacts phasing; M3.8 롤백 이후 재개 가능) + imageMcp shim 제거

**현재 베이스라인**
- `npm run build` → tsc clean
- `node --test tests/unit/*.test.mjs` → **318/318 pass** (M3 +79, M4 +26 cumulative over 213 baseline)
- `bash scripts/verify-invariants.sh` → 31/31 refs resolve
- `bash scripts/check-subtree-sha.sh` → OK (pinned `68cc8969...`)
- `bash scripts/prepublish-guard.sh` → OK (114 files, 0 secret matches)
- `npm run audit` → 0 high/critical vulnerabilities
- `src/tools/attach.ts` → 331 LOC (was 720; AC-STRUCTURE-1 met)

---

## 2. 반드시 읽을 문서 (순서대로)

1. **`.omc/plans/production-hardening-review.md`** (430 줄) — 합의된 마스터 플랜 (v2.2). §6의 M3/M4 섹션이 남은 작업의 정의서.
2. **`.omc/progress.txt`** — 이터레이션 1~4 전체 작업 로그. 각 마일스톤의 실제 LOC delta, 리뷰 피드백, 트레이드오프 기록.
3. **`.omc/ARCHITECTURE.md`** — 코드베이스의 구조/데이터흐름/**11 invariants §5**.
4. **`.omc/INVARIANTS.md`** — 11 invariants → 테스트 매핑 (31 refs). 새 파일이나 리팩토링 시 함께 업데이트해야 `verify-invariants.sh`가 통과.

선택적으로 읽을 문서:
- `.omc/prd.json.m0.done`, `prd.json.m1a.done`, `prd.json.m2.done` — 완료된 마일스톤들의 acceptance criteria 및 completion notes
- `.omc/prd.json` — 현재 PRD (M1b 완료 상태)

---

## 3. 작업 환경 제약 (중요)

**`verse8-mcp`는 이 workspace에서 독립 git repo가 아니다.**
- 부모 `/Users/planetariumhq/Workspace/.git`에 untracked content로 존재.
- 따라서 ralph는 git 커밋 / smoke 테스트(git origin 필요) / 릴리스를 수행하지 않음.
- **검증 범위 = 단위 테스트 + tsc + LSP + invariant/subtree-sha 스크립트.**
- Smoke 테스트, e2e, git 커밋, CHANGELOG/README 릴리스 노트, npm publish는 **사용자가 담당**.

**코드베이스 컨벤션** (핸드오프 필수):
- Node.js 18.17+, TypeScript strict, **Node16 모듈 해석** — TS imports는 `.js` 접미사 필수 (`.ts` 소스라도).
- `console.error` for stderr; **never** `console.log` (stdio MCP protocol 손상).
- 모든 tool 결과는 discriminated union `{ok:true,...} | {ok:false, error, hint, ...}`.
- zod 스키마는 `.strict()`로 미지 필드 거부.
- 테스트는 `.mjs`로 작성, `dist/`에서 import (빌드 후 실행).
- `node:fs`/`node:path`/`node:crypto`/`node:child_process`는 `node:` 접두사 사용.
- MCP SDK Server 인스턴스의 핸들러는 private `_requestHandlers` Map에 저장됨 (dispatchRedaction.test에서 사용).

---

## 4. 남은 작업 상세

### M3 — 관측성 + 타입 + 실패 원자성 (9 stories, target 0.4.x)

플랜 §6 M3 섹션 참조. 각 스토리는 독립 PR 단위.

| # | Story | Risk | Files | Notes |
|---|---|---|---|---|
| M3.1 | `util/auditLog.ts` — rotating JSONL at `$XDG_STATE_HOME/verse8/mcp.log`, mode 0600, 1MB rotation | Low | new | Non-fatal on I/O error (mirror `recordToolCall` pattern). `projectDirDigest = sha256(path).slice(0,12)`, never raw path. |
| M3.2 | `util/errors.ts` — `ErrorCode` string-literal union + `ts-morph` AST 검증 테스트 | Medium | new + 8+ tool files | AC-TYPES-1: `tests/unit/errorCodeCoverage.test.mjs`가 모든 tool result type의 error 필드가 ErrorCode를 좁히는지 AST로 확인. |
| M3.3 | `util/toolDispatch.ts` — correlation-id + duration + audit sink 래퍼 | Medium | new, `server.ts` | 기존 inline try/catch + `recordToolCall` 블록 대체. 기존 call-log bucket alignment 유지 필수. |
| M3.4 | `tests/unit/attachment.test.mjs` (≥10 cases) | Low | new | Custom `core.hooksPath`, 서명 false-positive reject, missing-hooks-dir 케이스 포함. |
| M3.5 | `tests/unit/v8CallLog.test.mjs` (≥8 cases) | Low | new | Cross-project isolation, capacity eviction, drain-idempotency. |
| M3.6 | `tests/unit/login.test.mjs` (≥6 cases) | Low | new | `v8-meme-api-mock.ts` fixture 사용. Device flow happy path + 4 error codes. |
| M3.7 | `zod-to-json-schema` 채택 vs 수제 어댑터 핀 유지 | Medium | `util/jsonSchema.ts` | 기본 권장: 현 어댑터 유지 + 30-case round-trip 테스트. |
| M3.8 | **`applyAttachmentArtifacts` 롤백 설계** — LIFO 역순 실패 복구 | Medium | `tools/attach.ts`, `util/rollback.ts` new | Architect blind spot. 각 sub-install이 `{execute, reverse}` pair 반환. AC-ATOMICITY로 검증. |
| M3.9 | `verify-audit-log.sh` → 단위 테스트 승격 | Low | `tests/unit/auditLog.test.mjs` new | Critic §6 피드백 — shell 스크립트는 썩는다. |

**M3 Acceptance Gates** (플랜 §7):
- AC-OBSERVABILITY-1: 모든 `CallToolRequestSchema` dispatch path가 정확히 1개의 JSONL 감사 라인 생성. 스키마 실패 / `unknown_tool`은 기록하지 않음.
- AC-OBSERVABILITY-2: `.verse8/mcp.log`는 1MB에서 회전 (`mcp.log.1`로 rename, 기존 `.1` drop).
- AC-OBSERVABILITY-3: 감사 라인은 `projectDirDigest = sha256(projectDir).slice(0,12)`; 절대 raw path 기록 금지.
- AC-TYPES-1: ts-morph AST 검사로 모든 tool result union의 error 필드가 `ErrorCode` 좁힘.
- AC-ATOMICITY: M3.8 mid-sequence 실패 시 이전 단계 변경사항 0개 on-disk (snapshot diff).
- AC-TESTS-1/2/3: attachment/v8CallLog/login 단위 테스트 각각 ≥10/≥8/≥6 cases.

### M4 — 운영 (6 stories, target 0.4.x–0.5.0)

| # | Story | Risk | Notes |
|---|---|---|---|
| M4.1 | `tests/smoke.sh` 분할 → `tests/smoke/{login,attach,new-project,preview,skills}.sh` + 공유 `_runner.sh` | Low | Architect 지적: 순차 전용 (토큰 백업 공유). 병렬은 persistent token-vault 리팩토 후. |
| M4.2 | `@agent8/gameserver-node` + `@agent8/deploy` 버전 핀 | Low | `npx -y @agent8/pkg@<pin>`. 옵션 env: `VERSE8_GAMESERVER_BUILD_PIN`. |
| M4.3 | `prepublishOnly` 훅 | Low | 빌드 + 단위 + smoke + 타볼 시크릿 가드 (`glpat-*`, `.verse8/token`, `VITE_AGENT8_ACCOUNT=0x`, `Bearer `, `"access_token":`, `.map` 스캔). `scripts/prepublish-guard.sh` new. |
| M4.4 | `verse8_status → token_expires_soon` | Low | `.verse8/project.json`에 `tokenExpiresAt` timestamp만 기록 (토큰 자체는 절대 안됨). <7일일 때 경고. |
| M4.5 | `verse8_new_project` deprecation shim 제거 | Low | `server.ts:86-91, 208-216` + smoke 업데이트. 0.4.0 CHANGELOG breaking 항목. |
| M4.6 | CI `npm audit --audit-level=high` 게이트 | Low | — |

**M4 Acceptance Gates**:
- AC-SECURITY-2: `npm pack --dry-run` 타볼이 redactor 패턴 0히트.
- AC-OPERATIONAL-1: `bash tests/smoke/login.sh` 단독 실행이 30초 이내.
- AC-OPERATIONAL-2: `verse8_status`가 <7일 만료 토큰에 대해 `token_expires_soon`; happy path HTTP 호출 +0.

---

## 5. 이미 연기된 항목 (plan에 따라 당분간 건드리지 말 것)

- **M1b.6** — `applyAttachmentArtifacts` phasing — **M3.8 롤백 설계 이후** 재개 (0.4.x–0.5.0)
- **`proxy/imageMcp.ts` 백-호환 shim 제거** — 0.5.0 (한 릴리스 유예)
- **Persistent rate-limit 저장소** — 0.4.x follow-up (multi-process 결정 이후)
- **`.env` self-heal 엄격화** — 별도 RFC (현 하드닝 플랜 범위 밖)

---

## 6. Ralph 워크플로우 복습

각 마일스톤 실행 패턴 (이터레이션당 한 번):

1. **PRD 아카이브 + 새 PRD 스코프**: `mv .omc/prd.json .omc/prd.json.mX.done`, 새 PRD 작성
2. **ralph state 활성화**: `state_write(mode='ralph', active=true, ...)`
3. **progress.txt 헤더 append**: 이터레이션 번호, 베이스라인, 대상 파일 패트스
4. **스토리별 구현** → 빌드 + 테스트 → PRD `passes:true`로 업데이트
5. **모든 스토리 완료 후 Architect 검증** (`oh-my-claudecode:architect`) — ACs 실증 증거로 확인
6. **Architect must-fix 반영** (있을 경우)
7. **Mandatory deslop pass** (`oh-my-claudecode:code-simplifier` — ai-slop-cleaner 등가)
8. **Post-deslop regression 재검증**: 빌드 + 테스트 + invariants + subtree-sha
9. **progress.txt finalize** + `state_clear(mode='ralph')`

**중요**: 매 마일스톤마다 `scripts/verify-invariants.sh`와 `scripts/check-subtree-sha.sh`를 게이트로 사용. `.omc/INVARIANTS.md`는 테스트 rename/move 시 같은 커밋에서 업데이트 (파일 헤더에 명시된 규칙).

---

## 7. 다음 세션 시작 프롬프트

**간단 버전** (M3부터 이어 진행):

```
/oh-my-claudecode:ralph .omc/HANDOFF.md 를 먼저 읽고 M3 (관측성 + 타입 + 실패 원자성)을 진행해주세요. 완료 후 자동으로 M4까지 이어가세요.
```

**상세 버전** (세션 복구 + 다음 마일스톤 명시):

```
새로운 세션입니다. Verse8 MCP 프로덕션 하드닝 4번째 이터레이션까지 완료된 상태에서 이어갑니다.

1. 먼저 /Users/planetariumhq/Workspace/verse8-mcp/.omc/HANDOFF.md 를 읽어 현재 상태와 남은 작업, 작업 환경 제약을 파악하세요.
2. /oh-my-claudecode:ralph continue 로 M3 (관측성 + 타입 + 실패 원자성) 마일스톤을 진행합니다.
   - 9개 스토리 (M3.1 auditLog, M3.2 errors, M3.3 toolDispatch, M3.4-6 누락 단위 테스트, M3.7 zodJsonSchema 결정, M3.8 롤백, M3.9 verify-audit 승격)
   - 베이스라인: 213 단위 테스트, attach.ts 331 LOC, verify-invariants 31/31 resolve
3. M3 완료 후 자동으로 M4 (운영, 6개 스토리)로 이어가세요.

제약 (HANDOFF.md §3 참조):
- verse8-mcp은 이 workspace에서 독립 git repo 아님. 검증 = 단위 테스트 + tsc + invariant/subtree-sha 스크립트.
- Smoke 테스트, e2e, 커밋, 릴리스는 사용자가 담당.
- Node16 module resolution → TS imports는 .js 접미사 필수.
- 테스트 .mjs는 dist/에서 import.
```

**마일스톤 하나만 실행하고 멈추고 싶을 때**:

```
/oh-my-claudecode:ralph .omc/HANDOFF.md 를 읽고 M3 마일스톤만 진행해주세요. M4는 이 세션에서 건드리지 마세요.
```

---

## 8. 위기 시 체크리스트 (뭔가 깨졌을 때)

- **Build fails**: `npm run build` 출력 확인. 최근 extraction이 import를 놓쳤을 가능성. `.js` 접미사 누락 흔함.
- **Test fails**: 깨진 테스트 이름이 `verify-invariants` 참조에 있다면 → `.omc/INVARIANTS.md`를 같은 커밋에서 업데이트.
- **verify-invariants.sh fails**: 소스 패턴 참조가 extract된 파일을 따라가지 않은 경우. 같은 커밋에서 INVARIANTS.md 업데이트.
- **check-subtree-sha.sh fails**: `skills-vendor/` 내용이 변경됨. 의도적이면 `sha=$(bash scripts/compute-subtree-sha.sh)`로 다시 계산해서 `package.json :: verse8.skillsVendor.sha` 갱신.
- **Architect REJECT**: PRD AC가 실제로 충족 안 됐을 수 있음. 증거 수집 후 수정, 재검증.

---

## 9. 주요 파일 지도

| 경로 | 역할 |
|---|---|
| `.omc/plans/production-hardening-review.md` | 마스터 플랜 (v2.2) |
| `.omc/HANDOFF.md` | **이 문서** |
| `.omc/progress.txt` | 이터레이션 로그 (누적) |
| `.omc/INVARIANTS.md` | 11 invariants → 테스트 매핑 |
| `.omc/ARCHITECTURE.md` | 코드베이스 구조 & §5 invariants |
| `.omc/TODO.md` | 구 버전 TODO (참조용) |
| `.omc/prd.json` | 현재 PRD (M1b 완료 상태) |
| `.omc/prd.json.m{0,1a,2}.done` | 완료 PRD 아카이브 |
| `scripts/verify-invariants.sh` | invariant 게이트 |
| `scripts/check-subtree-sha.sh` | subtree SHA 게이트 |
| `scripts/compute-subtree-sha.sh` | skills-vendor 해시 계산 |
| `src/util/{redact,safePath,atomicWrite,hostAllowlist,childEnv}.ts` | M0+M1a+M2 공유 유틸 |
| `src/prompts/agentsMdTemplate.ts` | M1b-1 분리 |
| `src/context/{hooks,gitIgnore}.ts` | M1b-2, M2-2 |
| `src/resources/skillCatalog.ts` | M1b-3 |
| `src/proxy/forward.ts` | M1b-4 (canonical) |
| `src/proxy/imageMcp.ts` | M1b-4 shim (0.5.0 제거 예정) |
| `src/format/fileChangeSynthesis.ts` | M1b-5 |
| `tests/unit/*.test.mjs` | 213 케이스 (이 중 ~82개는 하드닝에서 추가됨) |
