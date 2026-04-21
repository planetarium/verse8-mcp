# verse8-mcp TODO — Next Session Handoff

Last updated: 2026-04-20
Current branch/worktree: `/Users/planetariumhq/Workspace/verse8-mcp` (main)

## Status

### ✅ Shipped & verified
- **Login**: RFC 8628 device flow split (`verse8_login_start` + `verse8_login_complete`)
- **Status**: `verse8_status` with attachment state + stale-preview + mcpProxies fields
- **Attach**: `verse8_attach` — hooks + AGENTS.md/CLAUDE.md dual-write + signature check + `core.hooksPath` support (AGENTS.md now teaches the 2-step new-project flow)
- **Checkpoint**: V8 commit format + git-diff backstop + strict commit-msg hook (merge/revert passthrough + `VERSE8_ALLOW_NONCOMPLIANT=1`) + file-count cap
- **Preview**: atomic `verse8_preview` (commit + spawn `bun run dev` detached) with env sanitization
- **MCP proxy**: 9 services (image/spritesheet/cinematic/audio/skybox/ui/claythis/crossramp/vectorsearch) with 3-tier enable/disable config + cache self-heal + token-change invalidation
- **Call log**: scoped by projectDir, schema-failure exclusion
- **Security**: URL host allow-list (`*.verse8.io` / localhost) for all env overrides — now including `VERSE8_AGENT8_BACKEND_URL`
- **New-project (Case 2)**: 2-tool split shipped — `verse8_new_project_start` + `verse8_new_project_confirm`. `verse8_new_project` kept one release as a `tool_renamed` deprecation shim. 8 distinct failure codes, startCallId + sha256 digest guardrail (template_mismatch), in-flight concurrency guard (confirm_in_flight), retry-safe `projectPath` echo-back, flag-scanning cloneCommand parser with argv-array git invocation (PAT never hits a shell), `nextCallRequires.projectDir` envelope.
- **Preview hardening**: webEditor URL (`https://create.verse8.io/creator/editor?chat=<projectPath>`) derived from origin. Dev-server readiness probe (`readinessTimeoutMs` default 15s) — no more lying about running servers.
- **Proxy session auto-recovery**: MCP image/audio/etc upstream now reinits + retries once on "No valid session ID" responses.
- **V8 commit narrative**: `problemStatement` + `workSummary` fields on `verse8_checkpoint` / `verse8_preview`. Render as `## Problem` / `## Work` markdown sections at top of commit body AND inside `V8AgentMessage` JSON. commit-msg hook surfaces warnings (non-blocking) when missing.
- **Skills v2 (0.3.0)**: agent8-skills vendored under `skills-vendor/agent8-skills/` (23 game-building skills, flat upstream layout preserved). `verse8_attach` now materializes every bundled skill to `<projectDir>/.claude/skills/<name>/SKILL.md` with trailing hash-marker `<!-- verse8-skill-hash: <sha256> -->` for drift detection. `overwriteAllSkills` forces, `pruneOrphanedSkills` opt-in delete. Dynamic `## Available Verse8 skills` catalog in AGENTS.md / CLAUDE.md. **BREAKING**: merge precedence `core > vendor > cache` (was `cache > core`). Package version `0.3.0`.
- **Tests**: smoke **26/26** · unit **76/76** · `npm run build` clean (verify-loop is manual, hits production).

---

## 🎯 Next-session work (priority order)

### Priority 0 — Project-wide structure review & refactor

**Start here**: read [`.omc/ARCHITECTURE.md`](./ARCHITECTURE.md) in full. It
describes the code as it exists today (Section 2: layout; Section 4: core
data flows; Section 5: **11 invariants that must NOT break**; Section 8:
intra-package dependency shape; Section 9: **11 identified refactor
candidates** with prioritized suggestions).

Guardrails before any structural move:
- `npm run build` clean
- `npm run test:unit` green (117 cases)
- `bash tests/smoke.sh` green (26 cases)

Recommended first refactor scope (from ARCHITECTURE.md §9):
1. Split `src/tools/attach.ts` (~700 lines) into template / hook-writer /
   skill-catalog modules.
2. Extract `synthesizeFileChangesFromDiff` from `checkpoint.ts` into
   `src/format/fileChangeSynthesis.ts` and unit-test in isolation.
3. Rename `proxy/imageMcp.ts` → `proxy/forward.ts` (it's the multi-service
   proxy now, the filename is historic).
4. Share the atomic-write helper between `context/envFile.ts` and
   `tools/login.ts` via a new `src/util/atomicWrite.ts`.

Low-risk, high-payoff. Bigger splits (collapsing `applyAttachmentArtifacts`
into phased install functions, nesting `V8CommitInput`) should be a
separate scope after 1–4 settle.

### Priority 1 — Live e2e verification against prod

All shipped flows are scripted-tested end to end. Two checks must be done
against the real `agent8-backend.verse8.io` before any 0.4.0 tag:

- [ ] `verse8_new_project_start` → `verse8_new_project_confirm` against
      prod; assert the produced projectDir is a working clone and a
      subsequent `verse8_checkpoint` (with `projectDir` argument) commits
      + pushes successfully.
- [ ] In the newly-cloned dir, verify the pre-commit hook still blocks a
      non-gitlab.verse8.io push (Case 1 continuity).
- [ ] Run `bash tests/e2e/verify-loop.sh` with a fresh token to re-confirm
      the 9 existing live checks still pass.

### Priority 2 — Post-ship follow-ups

- [ ] Token-expiry warning: `verse8_status` surfaces `token_expires_soon`
      when the gitlab PAT has <7 days remaining. Requires storing
      `tokenExpiresAt` in `.verse8/project.json` (timestamp only, never
      the token).
- [ ] Remove the `verse8_new_project` deprecation shim in 0.4.0 (tool
      description + handler in `src/server.ts`, smoke test
      `test_new_project_tool_renamed`).
- [ ] Template catalog caching: remember first-seen templates to suggest
      alternatives if user rejects the initial proposal.
- [ ] `verse8_new_project_cancel`: helper to delete a just-created gitlab
      repo (pending backend API).

---

## Quick reference

| What | Where |
|------|-------|
| **Current architecture + refactor candidates** | [`.omc/ARCHITECTURE.md`](./ARCHITECTURE.md) |
| User-facing docs (install / Case 1 / Case 2 / env vars) | [`../README.md`](../README.md) |
| Release history & breaking changes | [`../CHANGELOG.md`](../CHANGELOG.md) |
| Attach template source (AGENTS.md body) | `src/tools/attach.ts` (`AGENTS_MD_TEMPLATE`) |
| V8 commit builder / parser | `src/format/v8CommitMessage.ts` |
| Proxy registry (9 services + host allow-list) | `src/proxy/registry.ts` |
| Verify-loop harness (live prod) | `tests/e2e/verify-loop.sh` |
| Sample V8 commits to study | `sample/match-three-game/` git log |

## Environment reminders

- Backend bases:
  - Auth: `https://v8-meme-api.verse8.io`
  - Project creation: `https://agent8-backend.verse8.io`
  - Image MCP: `https://mcp-image-svc.verse8.io/mcp` (and 8 sibling services)
  - Web editor: `https://create.verse8.io/creator/editor?chat=<projectPath>`
- Token file: `~/.config/verse8/token` (mode 0600)
- Host allow-listed URL overrides: `VERSE8_API_URL`,
  `VERSE8_AGENT8_BACKEND_URL`, `VERSE8_CREATE_URL`, `VERSE8_<SERVICE>_MCP_URL` ×9
- Sample projects for hands-on testing: `sample/match-three-game/`,
  `sample/simple-omok-game/`
3. First code change should be `src/api/agent8Backend.ts` (new file, no dependencies — easy warm-up).
4. Confirm green after each major step: `npm run build && bash tests/smoke.sh && npm run test:unit`.
5. When all 14 ACs pass, update docs (P2) and ship.
