# 보안 자세 (Security posture)

- **Trust-boundary redaction** — 모든 MCP 응답 envelope (tool, resource, prompt)이 `util/redact.ts`를 통과합니다. `glpat-*`, `Bearer <token>`, `oauth2:<secret>@…` URL, `access_token / refresh_token / device_code` JSON 필드를 포함한 throw된 에러도 호스트 LLM에 그대로 도달하지 않습니다.

- **Path-traversal rejection** — `projectDir` / `targetDir`은 MCP dispatch 경계에서 zod-refined됩니다. `..`, NUL, symlinked parent는 파일시스템 접근 전에 `invalid_input` / `invalid_parent`로 거부됩니다.

- **Clone-command safety** — `git clone`은 항상 `execFileSync` argv-array 형태로 실행됩니다. GitLab PAT는 `parseCloneCommand`로 파싱되며 절대 셸에 보간되지 않습니다.

- **Host allow-list** — 모든 env-driven base URL은 `*.verse8.io` + loopback에 대해 caller별 정책 predicate로 검증됩니다. 단일 진입점 `parseOverrideHost` (low-level URL parser)만 공유하고, 정책 결정 (auth / proxy / web-editor)은 caller 별로 분리되어 있습니다.

- **Failure atomicity** — `applyAttachmentArtifacts`는 단계별 reverse op를 기록합니다. 중간 단계 실패 시 LIFO 순으로 이전 쓰기를 rollback 해 디스크에 어떤 부분적인 attach 흔적도 남기지 않습니다.

- **Publish guard** — `prepublishOnly`가 `scripts/prepublish-guard.sh`를 실행해 `npm pack` 타볼에서 `glpat-*`, `Bearer <token>`, `"access_token":"…"`, `VITE_AGENT8_ACCOUNT=0x<hex>`, `*.map` 파일명을 스캔. 매치가 있으면 publish 거부.

- **Secret-pattern fuzz tests** — `tests/unit/redact.test.mjs` + `tests/unit/dispatchRedaction.test.mjs`가 8 가지 secret shape에 대해 redactor + dispatch envelope wrapping을 회귀 검증.

## Invariants

Promises that must survive any refactor. Each test case or source line that enforces one carries a tag comment `<ID>: <title>` (`//` in TS/JS, `#` in `tests/smoke.sh`), e.g. `// INV-3: URL overrides are host-validated`. To find them:

```bash
git grep -nE '(INV|MCP-UP)-[0-9]+:'   # every tag
git grep -n 'INV-3:'                  # one invariant
```

When you change or move a tagged test, move its tag with it. A new invariant takes the next free number.

| ID | Invariant |
|---|---|
| INV-1 | **The token never hits a shell.** The GitLab PAT is parsed by `parseCloneCommand` and passed only as `execFileSync` argv. A backend-supplied slug containing `..`, `/`, `\`, or NUL is rejected |
| INV-2 | **`.verse8/project.json` carries no secrets.** The payload is `{version, projectId, attachedAt}` only |
| INV-3 | **URL overrides are host-validated.** Every env-driven base URL goes through `parseOverrideHost` plus a per-caller `isAllowed*` predicate (`*.verse8.io` + loopback); a rejected value falls back to the default URL |
| INV-4 | **Skill merge precedence is `core > vendor > cache`.** `listSkillResources` calls `Map.set` in cache → vendor → core order, so the last write wins |
| INV-5 | **`.env` ACCOUNT/VERSE is immutable once set.** A mismatch returns `mismatch-preserved` with a hint pointing at `verse8_attach({overwriteEnv: true})` |
| INV-6 | **Skills outside the bundle are never touched.** `writeSkillFiles` writes only to directories named after bundled skills. `pruneOrphanedSkills` removes a non-bundled directory only when its `SKILL.md` carries an unedited verse8-mcp hash marker. Retiring an inactive plugin's skill follows the same rule and deletes only that `SKILL.md`, never other files in the directory. `overwriteAllSkills` is the one escape hatch: it overwrites bundled-name directories even when the user edited them |
| INV-7 | **Overwrite flags stay in their lane.** `overwriteAllSkills` affects skills only, `overwriteEnv` affects `.env` only |
| INV-8 | **The V8 commit format is an on-wire contract.** `buildV8CommitMessage` is deterministic, the parser accepts everything the builder emits, and structurally drifted messages are rejected |
| INV-9 | **Narrative lives inside `<V8AssistantMessage>`.** `<problemStatement>` / `<workSummary>` are emitted there and duplicated into the `<V8AgentMessage>` JSON. The legacy `## Problem` / `## Work` layout is parsed but never emitted |
| INV-10 | **Proxy session retry is single-shot.** On session expiry the cache is evicted and the call reinitialized and retried once; two consecutive failures surface as-is |
| INV-11 | **Tool discovery is token-gated, not cwd-gated.** With a token, `verse8_checkpoint`, `verse8_preview` and proxy tools are listed; the project is re-validated at call time |
| INV-12 | **The plugin package gate fails closed.** A vendored plugin with a malformed `requiresPackage`, a missing or unparseable `plugin.json`, or non-empty `tags` is inactive, and a missing `package.json` is an empty dependency set. A scope nobody can read never degrades into "every project" |
| MCP-UP-1 | **`verse8_upload_asset` talks only to the allow-listed backend.** The URL comes from `getAgent8BackendBaseUrl()` gated by `isAllowedAgent8BackendBase` |
| MCP-UP-2 | **`cdnPath` traversal is rejected before the network.** `..`, a leading `/`, empty segments, NUL, and a `filename` containing path separators |
| MCP-UP-3 | **`ATTACHMENT_EXTS` is the pre-network extension gate.** Kept in sync by hand with `planetarium/agent8-backend/src/config/constants.ts` |
