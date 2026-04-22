# 보안 자세 (Security posture)

- **Trust-boundary redaction** — 모든 MCP 응답 envelope (tool, resource, prompt)이 `util/redact.ts`를 통과합니다. `glpat-*`, `Bearer <token>`, `oauth2:<secret>@…` URL, `access_token / refresh_token / device_code` JSON 필드를 포함한 throw된 에러도 호스트 LLM에 그대로 도달하지 않습니다.

- **Path-traversal rejection** — `projectDir` / `targetDir`은 MCP dispatch 경계에서 zod-refined됩니다. `..`, NUL, symlinked parent는 파일시스템 접근 전에 `invalid_input` / `invalid_parent`로 거부됩니다.

- **Clone-command safety** — `git clone`은 항상 `execFileSync` argv-array 형태로 실행됩니다. GitLab PAT는 `parseCloneCommand`로 파싱되며 절대 셸에 보간되지 않습니다.

- **Host allow-list** — 모든 env-driven base URL은 `*.verse8.io` + loopback에 대해 caller별 정책 predicate로 검증됩니다. 단일 진입점 `parseOverrideHost` (low-level URL parser)만 공유하고, 정책 결정 (auth / proxy / web-editor)은 caller 별로 분리되어 있습니다.

- **Failure atomicity** — `applyAttachmentArtifacts`는 단계별 reverse op를 기록합니다. 중간 단계 실패 시 LIFO 순으로 이전 쓰기를 rollback 해 디스크에 어떤 부분적인 attach 흔적도 남기지 않습니다.

- **Publish guard** — `prepublishOnly`가 `scripts/prepublish-guard.sh`를 실행해 `npm pack` 타볼에서 `glpat-*`, `Bearer <token>`, `"access_token":"…"`, `VITE_AGENT8_ACCOUNT=0x<hex>`, `*.map` 파일명을 스캔. 매치가 있으면 publish 거부.

- **Secret-pattern fuzz tests** — `tests/unit/redact.test.mjs` + `tests/unit/dispatchRedaction.test.mjs`가 8 가지 secret shape에 대해 redactor + dispatch envelope wrapping을 회귀 검증.

자세한 production-hardening 플랜은 [.omc/plans/production-hardening-review.md](../.omc/plans/production-hardening-review.md) 참조.
