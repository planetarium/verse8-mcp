# Verse8 MCP — Production Hardening Review Plan

> **Status**: Draft v2 (Planner revision after Architect (Codex) + Critic round 1)
> **Scope**: `/Users/planetariumhq/Workspace/verse8-mcp` at `v0.3.0`, prototype → production
> **Hot paths**: `src/tools/attach.ts` (64x), `src/tools/newProject.ts` (36x), `src/server.ts` (36x)
> **Date**: 2026-04-21
>
> **v1 → v2 changes**: inserted **M0** (trust-boundary patch) per Architect synthesis path. Split M1 into **M1a** (deletion-first dedup, pre-M2) and **M1b** (structural extraction, deferred post-M2). Reordered **M0 → M1a → M2 → M1b → M3 → M4**. Added pre-mortem Scenarios 4–5 (MCP protocol envelope leak, multi-process memo loss). Resolved OQ1 / OQ6. Sharpened AC-TYPES-1 and AC-OBSERVABILITY-1. Added invariant→test mapping as an M1a deliverable. Hardened hostAllowlist with caller-specific policy options. Added `applyAttachmentArtifacts` rollback design (M3). Added skills-vendor subtree pinning. Added multi-process semantics section.

## 1. Requirements Summary

The 1st prototype of `@verse8/verse8-mcp` (MCP meta-server for gitlab.verse8.io projects, 9-service proxy, V8 commit format, skill materializer) is functionally complete (76 unit + 26 smoke tests green). The production bar is about **stability, safety, and operability** — not new features. The review must produce an **actionable, priority-ordered work list** across seven axes:

1. **Structure & module boundaries** — `attach.ts` at 700+ LOC, `imageMcp.ts` misnamed, `applyAttachmentArtifacts` at 6 optional fields.
2. **Code duplication & reuse** — atomic-write pattern duplicated, host allow-list near-duplicated 3x with **different policies**, `.env.tmp` scheme duplicated, tolerant-parse isolated.
3. **Security** — Bearer token handling, URL allow-list, child-process env sanitization, `.env` / token file modes, PAT redaction, **dispatch-boundary error envelopes, projectDir path-traversal**.
4. **Error handling & observability** — 29 stderr writes with no structured log, no rotating audit trail, no correlation id, no rate-limit awareness.
5. **Type safety & API contracts** — zod schemas, error union enumerations, MCP tool JSON schema adapter surface.
6. **Test coverage** — gaps in `attachment.ts`, `util/v8CallLog.ts`, `login.ts`; smoke at 1350 LOC (hard to parallelize).
7. **Deployment & operational stability** — 0.3.0 breaking change (skill precedence), no version-pinning for `@agent8/gameserver-node` / `@agent8/deploy`, no pre-publish hooks, **skills-vendor subtree not sha-pinned**.

## 2. Principles (apply across all workstreams)

1. **Invariants are contracts** — the 11 invariants enumerated in `.omc/ARCHITECTURE.md` §5 (token never hits shell, `.verse8/project.json` carries no secrets, URL host allow-list, skill precedence, `.env` immutability, skill no-touch, scoped overwrite flags, V8 format on-wire contract, narrative location, single-shot session retry, token-gated discovery) are production promises. Any refactor preserves them with **at least one regression test per invariant**, tracked via an explicit invariant→test mapping (M1a deliverable).
2. **Deletion-first refactors** — *for code-level steps*, each change removes more lines than it adds (or breaks even). *For module moves* (files splits / renames that relocate without removing duplication), the step is **explicitly labeled "module move"** rather than "deletion-first", and must meet two weaker tests: (a) LOC of the **max-file** after the move is strictly lower than before; (b) the move exposes a seam that is actually used by a subsequent slice (not speculative). Module moves are **deferred** until after all deletion-first dedup and all security steps ship — M1b comes after M2.
3. **Defense in depth at trust boundaries, not everywhere** — token files, subprocess argv, URL overrides, clone command parsing, skill name filesystem writes, **MCP dispatch envelopes, zod-parsed projectDir**. Internal code paths trust zod-parsed inputs. Every new helper is **policy-explicit** — a shared low-level parser is fine; a shared decision function that conflates three different trust policies is not.
4. **Observable by default, silent by opt-in** — every state-changing tool emits a single structured log line (tool name, outcome, duration, projectDir digest) to a rotating audit file under **`$XDG_STATE_HOME/verse8/mcp.log`** (or `~/.local/state/verse8/mcp.log`), with an opt-in project-local symlink pointer `<projectDir>/.verse8/mcp.log.link`. Stderr diagnostics stay for developer view; structured log is for ops. **Resolves OQ1 (v1)**: XDG default prevents `.verse8/mcp.log` from leaking into `git add -A`; project-local pointer is opt-in and is itself sha256-digested, never raw path.
5. **Tests document intent, not implementation** — every fix ships with a failing-test-first commit; every invariant gets one unit or smoke guardrail; every pre-mortem scenario gets one failing-test-turned-green slice.
6. **Process-local state is a known limitation, not a feature** — `startCallMemo`, `inFlightConfirms`, and any proposed rate-limit Maps live in process memory. Any restart (crash, config reload, Claude Code re-attach) drops them. This is documented, tested (smoke asserts "restart → confirm without startCallId still works"), and flagged in README as a known edge — **persistent store is 0.4.x follow-up**, not this plan's scope.

## 3. Decision Drivers

1. **Zero-regression production promotion** — `npm run build` / unit (117) / smoke (26) must stay green after every slice; 0.3.0 users mid-migration cannot break.
2. **Security posture compatible with per-project GitLab PATs and RFC 8628 device-flow tokens** — no PAT leakage in logs, stderr, error envelopes, MCP protocol responses, or persistent state.
3. **Maintainer throughput** — the next feature iteration is blocked behind `attach.ts` at 700+ LOC; structural work compounds after trust-boundary work ships.

## 4. Viable Options (re-evaluated)

### Option A — ~~Staged "structure first, then harden"~~ REJECTED (v1 favored; v2 rejected per Architect + Critic)

**Rejection rationale**: (i) Violates Principle 2 — M1.3/M1.5/M1.6 are module moves the plan originally marked "deletion-first." (ii) Architect observed that the actual live security gaps (`server.ts:278` raw exception leak, absent `projectDir` schema guard, absent symlink-parent guard, incomplete redactor coverage) predate any structural code. Refactoring the structure around unhardened boundaries widens the risk window. (iii) Critic confirmed M2 has near-zero overlap with M1 extraction targets (only M2.6 touches `attach.ts`), so "security first" imposes no rework penalty on structure. The "touch same lines twice" dismissal of Option B in v1 was evidence-free.

### Option B — Trust-boundary-first, then deletion-dedup, then structure (CHOSEN)

**Approach**: Five sequential milestones ordered by risk reduction, each independently shippable and reversible.

- **M0 (Trust-boundary patch → 0.3.1)**: Dispatch-level redaction covering `server.ts:278` generic-catch and resource/prompt error paths; `projectDir` / `targetDir` schema-level path-traversal rejection; symlink-parent rejection in `runNewProjectConfirm`; centralized `util/redact.ts` covering `glpat-*`, `Bearer <token>`, `oauth2:<secret>@` URLs, `access_token` JSON fields; token file mode warning on read. **No structural code movement.** Security-only, defensive-only.
- **M1a (Deletion-first dedup → 0.3.2)**: Genuinely deletion-first utilities only. `util/atomicWrite.ts` (dedupes two near-identical impls), `util/redact.ts` already exists from M0; extract `format/fileChangeSynthesis.ts` from `checkpoint.ts` because it unblocks isolated unit testing (prerequisite for M3 invariant-test coverage). `util/hostAllowlist.ts` extracted as **low-level URL parser only** — per-caller `policy*` predicates stay with each caller (auth/proxy/link have different policies, per Critic). Invariant→test mapping table delivered.
- **M2 (Security hardening → 0.3.3)**: Build on M0 and M1a. Token file permission assertion, child-process env sanitization shared helper, `.verse8/mcp.log` / `.verse8/preview.log` in written `.gitignore` stanza, skills-vendor subtree sha pinning, rate-limit on `verse8_new_project_start` (process-local, **documented as best-effort**).
- **M1b (Structural extraction → 0.4.0)**: Once M0+M1a+M2 have pinned the dangerous edges. Split `attach.ts` (`prompts/agentsMdTemplate.ts` + `context/hooks.ts` + `resources/skillCatalog.ts`), rename `imageMcp.ts` → `proxy/forward.ts`, optionally phase `applyAttachmentArtifacts` into named installers **iff** the atomicity rollback design (M3.8) is in place first. Each extraction is a module move, not a deletion-first refactor; LOC-reduction goal is the only measurable win.
- **M3 (Observability + types + failure atomicity → 0.4.x)**: `util/auditLog.ts` under XDG (not project-local), `util/errors.ts` typed error-code registry with AST-assert test, `util/toolDispatch.ts` wraps handlers, three new unit test files (`attachment.ts`, `v8CallLog.ts`, `login.ts`), **`applyAttachmentArtifacts` rollback design** — track every write, reverse on failure.
- **M4 (Operational → 0.4.x)**: Split `smoke.sh` (sequential runner only — shared token backup prevents parallelism per Architect; documented), pin `@agent8/gameserver-node` / `@agent8/deploy`, `prepublishOnly` guard, `token_expires_soon` in `verse8_status`, remove `verse8_new_project` shim, `npm audit` gate.

**Pros**: (i) Live security gaps close in the first release. (ii) No abstraction step runs until a prior step has earned the dedup — Principle 2 honored. (iii) Structure work lands on a hardened substrate; M1b changes can't re-open a redaction gap. (iv) Each milestone maps to a tight semver bump with explicit changelog lines.

**Cons**: Longer total calendar (5 milestones vs. 4). Mitigated by: each milestone is small; M0 + M1a + M2 can ship in the same 0.3.x sprint if verification suite stays cheap.

### Option C — "Big-bang refactor" (REJECTED, unchanged from v1)

Unchanged rejection rationale: compound regression risk, contradicts "zero-regression production promotion" driver.

## 5. Pre-mortem (deliberate-mode; 5 failure scenarios — Scenarios 4–5 added in v2)

### Scenario 1 — "Refactor extracts a helper, loses an invariant"

**Failure mode**: During M1b, `writeAgentsDoc` is moved to `src/context/agentsDoc.ts`, but the `existsAny` pre-check that short-circuits idempotent re-runs is dropped because the new caller structure hides it. Next `verse8_attach` on a user-edited `AGENTS.md` overwrites it silently.

**Pre-mitigation**:
- Red-line test FIRST: `tests/unit/attach.idempotent.test.mjs` — runs `applyAttachmentArtifacts` twice on a fixture with a handwritten `AGENTS.md`, asserts byte-identical after call #2.
- Lands before any extraction. Appears in the invariant→test mapping table (M1a deliverable) as Invariant §5.6 coverage.

### Scenario 2 — "Audit log leaks a PAT"

**Failure mode**: M3 adds an audit log. A `confirm_failed` error flows through with `err.stderr` from `git clone` that echoes `https://oauth2:glpat-xxx@gitlab.verse8.io/...`. Existing `redactToken` only covers two specific catches; audit-line path does not.

**Pre-mitigation**:
- v2 moves audit log location to `$XDG_STATE_HOME/verse8/mcp.log` so `git add -A` cannot commit it even if redaction fails.
- Redactor is the **sole** write path for both stderr and audit (enforced by a lint rule: `grep "fs.appendFile.*mcp.log"` — must call `redact.ts`).
- Fuzz test in `tests/security/redact-fuzz.mjs` generates 200 synthetic outputs with PAT-shaped strings in varied positions; every output must be scrubbed.

### Scenario 3 — "Host allow-list dedup widens the allow-set"

**Failure mode**: M1a merges three allow-list impls into one. The new helper accepts the union, and `preview.ts`'s web-editor link now accepts SSH `git@localhost:…` where it previously parsed only HTTPS. A crafted origin URL produces a web editor link against an unintended host.

**Pre-mitigation (v2, stricter per Architect)**:
- **Only extract the low-level URL parser** (host extraction + scheme check). Caller-specific policies (`isAllowedAuthBase`, `isAllowedProxyOverride`, `isAllowedWebEditorOrigin`) stay separate and explicit.
- Each caller accepts an **options struct** declaring whitelisted schemes, SSH/loopback policy, and domain suffix.
- Unit-test matrix of 10+ URLs × 3 policy sets; each caller re-runs its pre-refactor baseline.

### Scenario 4 — "MCP protocol envelope leaks a PAT through the generic catch" (NEW, v2)

**Failure mode**: `server.ts:278` catches every tool-level exception and returns `{error: "tool_exception", hint: (e as Error).message}` in the MCP content envelope. If `runNewProjectConfirm` throws mid-clone before its own `redactToken` runs (e.g. from `fs.mkdirSync`, `execFileSync` synchronous throw before the catch branch applies), the exception message can carry the full `oauth2:glpat-*@host/...` URL. The MCP envelope is then serialized to the LLM host, which may log it to a cloud provider, cache it, or surface it to the user.

**Evidence**:
- `server.ts:279–286`: generic catch returns `(e as Error).message` unredacted.
- `newProject.ts:458`: `redactToken` only runs on specific `clone_failed` / `clone_parse_failed` returns, not on thrown exceptions.
- Resource read path (`server.ts:356–381`) and prompt get path (`server.ts:389–424`) have the same raw-exception leak.

**Pre-mitigation (M0 step — must land before any other work)**:
- M0.1: wrap every MCP content envelope with `redact.ts`. Generic catch, resource-read error, prompt-get error all feed through a single `safeErrorHint(e)` helper.
- Regression test: `tests/unit/dispatchRedaction.test.mjs` — injects a thrown error whose message contains every known secret shape, asserts the MCP response body contains no match.

### Scenario 5 — "Multi-process state loss produces a user-facing failure loop" (NEW, v2)

**Failure mode**: Claude Code restarts the MCP server (config change, crash, user `/reload`). `startCallMemo` (`newProject.ts:118`) is empty. User's LLM calls `verse8_new_project_confirm` with the previous-session `startCallId` → returns `template_mismatch` → user loops. Same pattern applies to `inFlightConfirms` and the proposed rate-limit Map.

**Evidence**:
- `tests/smoke.sh:1074` — smoke already documents `startCallId` is unusable across fresh processes and confirms without it.
- No README / docs section flags this to the user; the LLM has no way to know the server restarted.

**Pre-mitigation (M2 addition)**:
- README and AGENTS.md template grow an "MCP server restarted mid-flow" troubleshooting section.
- `verse8_new_project_confirm` treats `template_mismatch` with `startCallId` presence as a known-recoverable path — hint says "call `verse8_new_project_start` again" instead of "invented values".
- **Documented as known limitation**, not solved by persistent store (out of scope; 0.4.x follow-up). Principle 6 captures this.

## 6. Implementation Steps

Ordered by **expected priority × risk reduction × deletion-first-ness**. Each step is sized to be independently reviewable (1 PR, <400 LOC diff).

### M0 — Trust-boundary patch (target: 0.3.1, ~1 week)

| # | Step | File(s) | Risk | Notes |
|---|---|---|---|---|
| M0.1 | Add `util/redact.ts` covering `glpat-*`, `Bearer <t>`, `oauth2:<s>@`, `access_token` JSON fields; export `safeErrorHint(e: Error): string` and `safeHint(s: string): string` | `util/redact.ts` (new) | Low | Defense-in-depth; no callers yet. Self-test: 12-case fixture + 200-case fuzz. |
| M0.2 | Route MCP dispatch generic catch through `safeErrorHint` | `src/server.ts:278–285`, `src/server.ts:367` (resource), `src/server.ts:416` (prompt) | **Critical-security-fix** | Closes the envelope leak Scenario 4. Regression test `tests/unit/dispatchRedaction.test.mjs`. |
| M0.3 | Migrate existing `redactToken` callers (`newProject.ts:507`, `agent8Backend.ts:363`) to `util/redact.ts` — **deletion-first**: two helpers collapse into one | `util/redact.ts`, `tools/newProject.ts`, `api/agent8Backend.ts` | Low | Satisfies Principle 2's 2-callsite rule. |
| M0.4 | Add zod refinement: reject `projectDir` / `targetDir` values containing `..` segments, absolute-path root traversal, or `\0`; applied at MCP dispatch, before any `path.resolve` | `src/tools/attach.ts:36–44`, `src/tools/checkpoint.ts:46–53`, `src/tools/preview.ts:43`, `src/tools/newProject.ts:47` | Medium | Uses shared `zod.string().refine(isSafeAbsPath)`; test matrix in `tests/unit/safePath.test.mjs`. |
| M0.5 | Pre-clone parent symlink rejection | `src/tools/newProject.ts:387` | Medium | `fs.lstatSync` on each segment up to `/`. Protects against clone-time TOCTOU / symlinked parent attack. Test fixture: `tmp/<symlinked-parent>/<slug>` clone rejected. |
| M0.6 | Proxy header redaction for 4xx/5xx passthrough hints | `src/proxy/imageMcp.ts:366` | Low | Current inline regex only covers `Bearer`; move to shared redactor. |
| M0.7 | Token file permission warning on read | `src/context/token.ts:33` | Low | `fs.statSync(p).mode & 0o777 !== 0o600` → stderr warn. Never refuses read (backwards compat). |

**M0 acceptance gate**: all dispatch surfaces (tool, resource, prompt) pass a fuzzer that injects 50 PAT-shaped exceptions; zero leak.

### M1a — Deletion-first dedup (target: 0.3.2)

| # | Step | File(s) | Risk | LOC delta (target) | Notes |
|---|---|---|---|---|---|
| M1a.1 | Extract `util/atomicWrite.ts`; migrate `envFile.ts` and `login.ts` | `util/atomicWrite.ts` (new), `context/envFile.ts:104`, `tools/login.ts:112` | Low | **−15** | True dedup. Preserves mode arg. |
| M1a.2 | Extract `util/hostAllowlist.ts` as **URL parser only** (no policy decisions); callers import `{parseOverrideHost, Host}` and keep their own policy predicates | `util/hostAllowlist.ts` (new, ~30 LOC), `proxy/registry.ts:166`, `api/v8MemeApi.ts:74`, `tools/preview.ts:222`, `api/agent8Backend.ts:21` | Low | **−20** | 8-URL × 4-policy test matrix (`tests/unit/hostAllowlist.test.mjs`). Per Architect Scenario 3 mitigation. |
| M1a.3 | **Deliverable**: invariant→test mapping table at `.omc/INVARIANTS.md` | new doc | n/a | — | Enumerates all 11 invariants from `.omc/ARCHITECTURE.md` §5 with test file : case references; reviewer-checkable via grep. |

### M2 — Security hardening (target: 0.3.3)

| # | Step | File(s) | Risk | Notes |
|---|---|---|---|---|
| M2.1 | Shared `util/childEnv.ts` (env sanitization); migrate preview spawn | `util/childEnv.ts` (new), `tools/preview.ts:379` | Low | Satisfies Principle 2 if used by ≥2 callers; if only preview uses it, keep inline with a regression test. |
| M2.2 | Attach writes `.verse8/.gitignore` stanza covering `preview.log`, project-local audit log pointer, any `.env.tmp-*` leftovers | `src/tools/attach.ts` (new artifact), `context/gitIgnore.ts` (new, ~40 LOC) | Low | Prevents accidental commit of local log files; sha256-of-sha256 hashed audit pointer only. |
| M2.3 | Pin `skills-vendor/agent8-skills` subtree commit sha in `package.json` (new `verse8.skillsVendor.sha` field) and assert at build time | `package.json`, `scripts/check-subtree-sha.sh` (new) | Low | Supply-chain guard per Architect blind spot. Build fails if subtree head diverges from pinned sha. |
| M2.4 | Add best-effort rate-limit on `verse8_new_project_start` — 5 calls per process per 60s rolling window | `tools/newProject.ts:151` | Low | Documented as process-local; cleared on restart. README addendum. |
| M2.5 | Document the multi-process semantics limitation (Scenario 5 mitigation) | `README.md`, `AGENTS.md` template in `tools/attach.ts`, `tools/newProject.ts` hint text | Low | No code change beyond hint text; this is a docs commitment. |
| M2.6 | Make `verse8_new_project_confirm`'s `template_mismatch` error hint explicit about restart recovery | `tools/newProject.ts:229–241` | Low | Mitigates user-facing loop from Scenario 5. |

### M1b — Structural extraction (target: 0.4.0, deferred per Architect)

| # | Step | File(s) | Risk | LOC delta | Notes |
|---|---|---|---|---|---|
| M1b.1 | Extract `prompts/agentsMdTemplate.ts` from `attach.ts` | `prompts/agentsMdTemplate.ts` (new, ~230 LOC), `tools/attach.ts` (shrink ~230 LOC) | **High** | net 0, max-file LOC ↓ | **Module move**, not dedup. Pre-guarded by M1a.3 mapping table + idempotent red-line test (Scenario 1). |
| M1b.2 | Extract `context/hooks.ts` (writeHook, resolveHooksDir) — shared with `attachment.ts` detection | `context/hooks.ts` (new), `tools/attach.ts`, `context/attachment.ts:78` | Medium | **−12** net (dedup resolveHooksDir across attach/detect) | **Deletion-first** because `resolveHooksDir` is currently duplicated in `attach.ts:559` and `attachment.ts:78`. |
| M1b.3 | Extract `resources/skillCatalog.ts` (renderSkillsCatalog, extractSkillDescription) | `resources/skillCatalog.ts` (new), `tools/attach.ts` | Low | net 0 | Module move. |
| M1b.4 | Rename `proxy/imageMcp.ts` → `proxy/forward.ts` with back-compat alias for one release | `proxy/forward.ts`, `server.ts`, `tools/login.ts`, `tools/status.ts` | Low | net +5 (back-compat shim) | Module move. Shim drops in 0.5.0. |
| M1b.5 | Extract `format/fileChangeSynthesis.ts` from `checkpoint.ts:163–275` | `format/fileChangeSynthesis.ts` (new), `tools/checkpoint.ts` | Medium | **+0 net** | **Module move** (honest label). Previously in M1a.3; moved here per Architect round-2 must-fix so the hardening tranche runs zero module moves. Unblocks isolated unit tests tracked in M3. |
| M1b.6 | **DEFERRED to 0.4.x-or-later** — phase `applyAttachmentArtifacts` into named installers | n/a | — | — | **Resolves OQ6**: per Critic + Open Question 6, this step is not worth the risk in this plan's scope. Revisit when atomic rollback design (M3.8) ships. |

### M3 — Observability + types + failure atomicity (target: 0.4.x)

| # | Step | File(s) | Risk | Notes |
|---|---|---|---|---|
| M3.1 | `util/auditLog.ts` — rotating JSONL at `$XDG_STATE_HOME/verse8/mcp.log`, mode 0600, 1 MB rotation; optional `<projectDir>/.verse8/mcp.log.link` pointer | `util/auditLog.ts` (new) | Low | Non-fatal on I/O error. Resolves OQ1. |
| M3.2 | `util/errors.ts` — error-code registry as string-literal union `ErrorCode`; every tool result union narrows `error: ErrorCode` | `util/errors.ts` (new), ~8 tool files | Medium | AST-assert test via `ts-morph` (see sharpened AC-TYPES-1). |
| M3.3 | `util/toolDispatch.ts` — wraps handlers with correlation-id + duration + audit sink | `server.ts` | Medium | Replaces inline try/catch; must keep existing call-log bucket alignment. |
| M3.4 | `tests/unit/attachment.test.mjs` (≥10 cases) | new | Low | — |
| M3.5 | `tests/unit/v8CallLog.test.mjs` (≥8 cases) | new | Low | — |
| M3.6 | `tests/unit/login.test.mjs` (≥6 cases) | new | Low | Uses `v8-meme-api-mock.ts`. |
| M3.7 | Decide `zod-to-json-schema` dep adoption vs pin home-rolled adapter | `util/jsonSchema.ts` | Medium | Decision point. Default recommendation: pin with 30-case round-trip test. |
| M3.8 | **Failure atomicity** for `applyAttachmentArtifacts`: each sub-install records a reverse op; on mid-sequence failure, execute reverse ops in LIFO order before returning `attach_failed` | `tools/attach.ts:403`, `util/rollback.ts` (new) | Medium | Closes Architect blind spot (`tools/attach.ts:430` currently has no rollback; clone-then-attach-fail leaves a half-attached repo). |
| M3.9 | Promote `scripts/verify-audit-log.sh` into `tests/unit/auditLog.test.mjs` so it runs automatically | new | Low | Per Critic §6 — shell scripts rot. |

### M4 — Operational (target: 0.4.x–0.5.0)

| # | Step | File(s) | Risk | Notes |
|---|---|---|---|---|
| M4.1 | Split `tests/smoke.sh` into `tests/smoke/{login,attach,new-project,preview,skills}.sh` + shared `_runner.sh`; **sequential execution only** per Architect — token backup makes parallel unsafe | `tests/smoke/*.sh` (new) | Low | Parallel execution flagged as a future enhancement with a persistent token-vault refactor. |
| M4.2 | Pin `@agent8/gameserver-node` + `@agent8/deploy` via `npx -y @agent8/pkg@<pin>` with env override | `tools/preview.ts:444–454` | Low | — |
| M4.3 | `prepublishOnly` — build + unit + smoke + tarball guard (reject `glpat-*`, `.verse8/token`, `VITE_AGENT8_ACCOUNT=0x`, `Bearer `, `access_token":"`, `.map`) | `package.json`, `scripts/prepublish-guard.sh` (new) | Low | — |
| M4.4 | `verse8_status → token_expires_soon` warning (<7 days) | `tools/status.ts` | Low | Adds `tokenExpiresAt` timestamp (never the token) to `.verse8/project.json`. |
| M4.5 | Remove `verse8_new_project` deprecation shim | `server.ts:86–91, 208–216`, smoke | Low | — |
| M4.6 | CI `npm audit --audit-level=high` gate | CI config | Low | — |

## 7. Acceptance Criteria (testable)

_v2 sharpens AC-TYPES-1 and AC-OBSERVABILITY-1 per Critic §4; adds AC-MCP-REDACTION, AC-INVARIANT-MAP, AC-ATOMICITY, AC-SUPPLY-CHAIN._

1. **AC-MCP-REDACTION** (M0) — `tests/unit/dispatchRedaction.test.mjs` injects 50 synthetic exceptions whose messages contain every known secret shape (`glpat-xxx`, `Bearer eyJ...`, `oauth2:glpat-xxx@host`, `"access_token":"xxx"`) thrown from every tool / resource / prompt handler; MCP JSON-RPC response body matches `/glpat-|Bearer [A-Za-z]|oauth2:[^*]|"access_token":"/` zero times.
2. **AC-PATH-TRAVERSAL** (M0) — `runAttach({projectDir:"../../etc"})`, `runCheckpoint({projectDir:"/tmp/../etc"})`, `runPreview({projectDir:"\0evil"})`, `runNewProjectConfirm({targetDir:"../../.."})` all reject at MCP dispatch with `invalid_input` BEFORE any `path.resolve` / HTTP / fs call.
3. **AC-SYMLINK-PARENT** (M0) — `runNewProjectConfirm` with a `targetDir` whose path contains a symlink segment is rejected with `invalid_parent`.
4. **AC-INVARIANT-MAP** (M1a) — `.omc/INVARIANTS.md` lists all 11 invariants from `ARCHITECTURE.md §5` with `test:file.mjs::case-name` references; a CI script greps every referenced test name and fails if any is missing.
5. **AC-STRUCTURE-1** (M1b, sharpened) — `src/tools/attach.ts` drops below 350 LOC; every invariant from `.omc/INVARIANTS.md` still has at least one test reference AND the referenced test passes.
6. **AC-STRUCTURE-2** (M1a) — The shared URL-host parser is defined and exported in exactly one file (`util/hostAllowlist.ts :: parseOverrideHost`). Caller-specific policy predicates (`isAllowedAuthBase`, `isAllowedProxyOverride`, `isAllowedWebEditorOrigin`) remain per-caller and each imports `parseOverrideHost` rather than re-implementing it. CI check: grep `export .* parseOverrideHost` matches exactly one file; each caller file contains its own `isAllowed*` function that calls `parseOverrideHost(...)`. The test deliberately does NOT grep raw `.endsWith(".verse8.io")` to avoid incentivizing policy re-centralization.
7. **AC-SECURITY-1** (M0+M2) — Every stderr / error-envelope / audit write flows through `util/redact.ts`. `tests/security/redact-fuzz.mjs` uses property-based generation (`fast-check` or similar) seeded with every known secret shape; ≥200 generated cases per CI run, configurable via `VERSE8_REDACT_FUZZ_RUNS`; zero PAT-shaped survivors. Coverage grows automatically as new secret shapes are added to the shape registry.
8. **AC-SECURITY-2** (M4) — `npm pack --dry-run` tarball contains zero files matching `glpat-*`, `.verse8/token`, `VITE_AGENT8_ACCOUNT=0x`, `Bearer `, `"access_token":`, or `.map`; `scripts/prepublish-guard.sh` unit test covers every negative case.
9. **AC-SUPPLY-CHAIN** (M2) — Build fails if `skills-vendor/agent8-skills` HEAD sha differs from `package.json :: verse8.skillsVendor.sha`.
10. **AC-OBSERVABILITY-1** (M3, sharpened) — Every `CallToolRequestSchema` handler path that reaches a tool's `run*` function writes exactly one JSONL audit line to `$XDG_STATE_HOME/verse8/mcp.log`. Paths that fail at schema parse or `unknown_tool` dispatch do NOT write. A smoke test asserts line count equals tool-call count for a 5-tool session, and asserts absence of audit line for a schema-failure request.
11. **AC-OBSERVABILITY-2** (M3) — `.verse8/mcp.log` (XDG path) rotates when size ≥ 1 MB (rename to `mcp.log.1`, drop existing `.1`); tool path never blocks on rotation error.
12. **AC-OBSERVABILITY-3** (M3) — Audit lines have `projectDirDigest = sha256(projectDir).slice(0,12)`; never a raw path. Unit test: fixed `projectDir="/tmp/foo/bar"` → deterministic digest.
13. **AC-TYPES-1** (M3, sharpened) — Every tool result union's `error` field is typed as `ErrorCode` (string-literal union exported from `util/errors.ts`). `tests/unit/errorCodeCoverage.test.mjs` enumerates all `ErrorCode` members via `ts-morph` AST inspection and asserts each appears in at least one tool's result type; rejects codes used but not exported.
14. **AC-TESTS-1** (M3) — `context/attachment.ts` has ≥10 unit cases including custom `core.hooksPath`, signature false-positive reject, missing-hooks-dir.
15. **AC-TESTS-2** (M3) — `util/v8CallLog.ts` has ≥8 unit cases including cross-project isolation, capacity eviction, drain-idempotency.
16. **AC-TESTS-3** (M3) — `tools/login.ts` has ≥6 unit cases using `v8-meme-api-mock.ts` fixture.
17. **AC-ATOMICITY** (M3.8) — A synthetic `attach_failed` during step 4/5 of `applyAttachmentArtifacts` (skill write) produces zero on-disk side effects from steps 1–3 (hooks / AGENTS.md / marker all reversed). Verified by `tests/unit/attachRollback.test.mjs` snapshot diff.
18. **AC-OPERATIONAL-1** (M4) — `bash tests/smoke/login.sh` runs the login subset in isolation in ≤30s.
19. **AC-OPERATIONAL-2** (M4) — `verse8_status` returns `token_expires_soon` when `.verse8/project.json tokenExpiresAt` is within 7 days; 0 HTTP calls added to happy path.
20. **AC-MULTI-PROCESS-DOC** (M2) — README + AGENTS.md template + `verse8_new_project_confirm` hint include a "MCP server restarted mid-flow" paragraph; regression test greps each file for the documented sentence.

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| M0 redaction helper has a regex gap that a novel secret shape slips through | Medium | Critical | 200-case fuzz test; quarterly review of new secret shapes; redactor also strips hex strings ≥20 chars preceded by `token` / `secret` / `authorization` as a fallback. |
| AC-PATH-TRAVERSAL rejects a legitimate user path (false positive) | Low | Medium | Schema refine whitelists POSIX-compliant absolute paths + `~`-expansion; add test fixture for every real-world path used by smoke. |
| Symlink-parent guard breaks on dev machines using `/tmp` as a symlink (common on macOS `/private/tmp`) | **Medium** | Medium | Allow single-level legitimate symlinks resolved via `fs.realpathSync` and then re-validate absence of `..` / traversal in the resolved path. Smoke runs on macOS. |
| Invariant→test mapping rots (someone renames a test) | Medium | Medium | M1a.3 adds a CI check that greps every referenced test name; drift fails build. |
| Host allow-list parser rename breaks a caller whose policy depended on the old helper's strictness | Low | High | Per-caller policy predicates keep original behavior; 8-URL × 4-policy matrix pre-commits the baseline. |
| Audit log at XDG_STATE_HOME pollutes user home | Low | Low | 1 MB rotation cap; single rotated file retained; total on-disk budget ≤2 MB. |
| `ts-morph` dependency for AC-TYPES-1 adds weight | Low | Low | Dev-dependency only; skipped in production tarball. |
| M3.8 rollback misses a write path (new sub-install added later) | Medium | Medium | Contract: every new sub-install returns `{execute, reverse}` pair; type system enforces it via `AttachInstaller` interface. |
| `skills-vendor` sha pin blocks upstream updates | Low | Low | `scripts/check-subtree-sha.sh` emits an actionable error pointing at the subtree-pull command + version bump in `package.json`. |
| `@agent8/gameserver-node` / `@agent8/deploy` pinning freezes a known-good set that upstream abandons | Low | High | `VERSE8_GAMESERVER_BUILD_PIN` env override; pin is opt-in-per-project via `.verse8/project.json`. |

## 9. Expanded Test Plan (deliberate-mode; v2 adds dispatch-boundary + rollback coverage)

### Unit tests (`node:test` via `npm run test:unit`, grows 117 → ~180)

- **M0 new files**:
  - `tests/unit/dispatchRedaction.test.mjs` (8) — exception-through-envelope matrix for tool / resource / prompt.
  - `tests/unit/redact.test.mjs` (10) — PAT / Bearer / oauth2 / access_token / multi-line / double-redaction / idempotency / fuzz sampling.
  - `tests/unit/safePath.test.mjs` (12) — absolute / relative / `..` / `\0` / symlink-parent / NUL byte / unicode path.
  - `tests/unit/atomicWrite.test.mjs` (4).
- **M1a new files**:
  - `tests/unit/hostAllowlist.test.mjs` (10) — caller × URL matrix.
- **M1b new files**:
  - `tests/unit/fileChangeSynthesis.test.mjs` (8) — cap, rename, copy, delete, binary, truncation. (Moved from M1a per Architect round-2.)
- **M3 new files**:
  - `tests/unit/attachment.test.mjs` (≥10), `tests/unit/v8CallLog.test.mjs` (≥8), `tests/unit/login.test.mjs` (≥6).
  - `tests/unit/auditLog.test.mjs` (6) — rotation, mode, non-blocking on I/O fail, digest.
  - `tests/unit/errorCodeCoverage.test.mjs` (3) — AST enumeration, unused-code detection, unknown-code rejection.
  - `tests/unit/attachRollback.test.mjs` (4) — mid-sequence failure snapshot diff.
- **Extended**:
  - `newProjectConfirm.test.mjs` — add symlink-parent (AC-SYMLINK-PARENT) + `..`-traversal (AC-PATH-TRAVERSAL).
  - `skillWriter.test.mjs` — add `core.hooksPath` no-touch invariant.
  - `v8CommitMessage.test.mjs` — redactor interop on error envelope.

### Integration / smoke (`bash tests/smoke.sh` + split `tests/smoke/*.sh`)

- Sequential-only runner per Architect (token backup).
- New cases:
  - `attach.sh` — idempotent-on-user-edit guard (M1b pre-guardrail).
  - `new-project.sh` — `projectDir: "../../tmp"` rejected at dispatch (AC-PATH-TRAVERSAL); `template_mismatch` hint mentions restart recovery (AC-MULTI-PROCESS-DOC).
  - `skills.sh` — `pruneOrphanedSkills:true` + user-edited orphan preserved.
  - `preview.sh` — `.verse8/preview.log` excluded from `git status --porcelain` after attach.
  - `observability.sh` (new suite) — 5-tool session produces 5 audit lines; schema-failure produces 0 lines.

### End-to-end (live prod, manual — `tests/e2e/verify-loop.sh`)

- 9 existing live checks stay green.
- New:
  - `verse8_status` nearly-expired PAT → `token_expires_soon`.
  - `npm pack` artifact against final commit passes `prepublish-guard.sh` offline.
  - Symlinked-parent clone rejected (AC-SYMLINK-PARENT).
  - Restart mid-`new_project` flow surfaces the documented `template_mismatch` hint (AC-MULTI-PROCESS-DOC).

### Observability / operational

- Audit-log schema validator is now a unit test (M3.9), not a shell script (per Critic §6).
- Rotation test: append 1.1 MB synthetic → file rotated exactly once; next write succeeds.
- Performance: checkpoint latency on 10-file diff within ±5 % of pre-refactor baseline.

### Security

- Redactor fuzz (200 cases).
- Dispatch-envelope fuzz (50 cases) — NEW in v2.
- File-permission audit: every file written by M0/M2/M3 tools matches documented mode (0600 token/log, 0644 AGENTS.md/SKILL.md); post-step script `scripts/verify-modes.sh`.
- `npm audit --audit-level=high`.

## 10. Verification Steps (per milestone)

### After every slice

1. `npm run build` — clean.
2. `npm run test:unit` — green (117 → ~180 by M3 end).
3. `bash tests/smoke.sh` — green (26 → ~36 by M4 end).
4. `git diff --stat` — confirm LOC trend (deletion-first steps net-negative; module-move steps flat with max-file-LOC ↓).
5. Grep sweeps (automated in `scripts/verify-grep-sweeps.sh`):
   - `rg 'glpat-' dist/ tests/ .verse8/` — zero hits.
   - `rg 'Bearer [A-Za-z]' dist/` — zero.
   - `rg 'export .* parseOverrideHost' src/` — exactly 1 file (post-M1a.2).
   - `rg '\\.endsWith\\(\"\\.verse8\\.io\"\\)' src/` — **≥1** (each caller keeps its own policy predicate; NOT constrained to single hit per Architect round-2 fix).
   - `rg 'TODO|FIXME|XXX' src/` — no new additions per slice.
6. Supply-chain drift check (after every slice, not just M2 milestone gate): `scripts/check-subtree-sha.sh` confirms `skills-vendor/agent8-skills` HEAD sha matches the `package.json :: verse8.skillsVendor.sha` pin. Cheap; guards against accidental subtree drift during M1b module moves.

### Milestone gates

- **M0 complete** ⇔ AC-MCP-REDACTION + AC-PATH-TRAVERSAL + AC-SYMLINK-PARENT + AC-SECURITY-1 pass.
- **M1a complete** ⇔ AC-STRUCTURE-2 + AC-INVARIANT-MAP pass; LOC trend net-negative; ≥2 callsites collapsed per extraction.
- **M2 complete** ⇔ AC-SUPPLY-CHAIN + AC-MULTI-PROCESS-DOC pass.
- **M1b complete** ⇔ AC-STRUCTURE-1 passes (attach.ts <350 LOC with invariant mapping intact).
- **M3 complete** ⇔ AC-OBSERVABILITY-1/2/3 + AC-TYPES-1 + AC-ATOMICITY + AC-TESTS-1/2/3 pass.
- **M4 complete** ⇔ AC-SECURITY-2 + AC-OPERATIONAL-1/2 pass; live e2e manual green; `0.4.0` / `0.5.0` CHANGELOG breaking-change entries present.

### Pre-release sign-off

- [ ] `npm run build && npm test` green.
- [ ] `bash tests/smoke.sh` green.
- [ ] `bash tests/e2e/verify-loop.sh` green (manual).
- [ ] `npm pack --dry-run` tarball passes `prepublish-guard.sh`.
- [ ] `scripts/verify-grep-sweeps.sh` passes.
- [ ] `CHANGELOG.md` calls out every breaking change.
- [ ] `README.md` env var table updated if new envs added.
- [ ] `.omc/INVARIANTS.md` mapping grep-validates against actual test file/case names.

## 11. Resolved decisions (v2)

- **OQ1 (audit log location)** — **Resolved**: `$XDG_STATE_HOME/verse8/mcp.log` (with `~/.local/state/verse8/mcp.log` fallback on Linux/macOS). Project-local is opt-in symlink/pointer only. Rationale: containment of accidental `git add -A`, clean with XDG norms, audit lines still correlate via `projectDirDigest`.
- **OQ6 (M1.6 — phase applyAttachmentArtifacts into installers)** — **Resolved out of scope**: moved to M1b.5 and **deferred to 0.4.x-or-later**. Prerequisite: M3.8 rollback design must land first. Reason: the 6-optional-field signature is a smell but stable; phase-split before rollback design would multiply half-success failure modes without containment.

## 12. Remaining open questions (non-blocking for execution)

- **OQ2 (zod-to-json-schema adoption)** — decision point during M3.7. Default recommendation: pin home-rolled adapter with 30-case round-trip test.
- **OQ3 (rate-limit scope)** — process-local `Map` for 0.3.x; persistent store is a 0.4.x follow-up gated on multi-process semantics decision.
- **OQ4 (shim removal timing)** — 0.4.0 per TODO; unchanged.
- **OQ5 (`.env` self-heal strictness)** — separate RFC, not this plan's scope.

## 13. Multi-process semantics (documented known limitation)

Three process-local state stores live in the codebase:

- `startCallMemo` (`newProject.ts:118`) — capped 50 entries; FIFO-evicted.
- `inFlightConfirms` (`newProject.ts:143`) — concurrency guard by `projectPath` or `startCallId+templateName`.
- Rate-limit Map (M2.4, proposed) — 5/60s rolling window per `verse8_new_project_start`.

All three are lost on MCP server restart. Per Principle 6:

1. This is **documented** in README (M2.5) and AGENTS.md template (M2.5).
2. `verse8_new_project_confirm` treats `template_mismatch` with a fresh-process `startCallId` as a **known-recoverable path** — hint says "re-run `verse8_new_project_start`" (M2.6, AC-MULTI-PROCESS-DOC).
3. Smoke test asserts the "restart → confirm without startCallId" path works (already present at `smoke.sh:1074`).
4. **Persistent store is out of scope for this plan**; 0.4.x follow-up after multi-process design decision.

## 14. Changelog (reviewer feedback applied)

### v1 → v2

Applied from Architect (Codex) REQUEST REWORK:

- Inserted M0 (trust-boundary patch) before any structure work, merging the critical subset of v1 M2 (M2.1, M2.2, M2.5, M2.7) plus new M0.2 dispatch-envelope redaction.
- Reordered milestones to M0 → M1a → M2 → M1b → M3 → M4.
- Deferred M1b.5 (`applyAttachmentArtifacts` installers) to 0.4.x-or-later.
- Split M1.1 into caller-specific policy predicates with a shared URL parser only.
- Resolved OQ1 (XDG_STATE_HOME) and OQ6 (deferred).

Applied from Critic ITERATE:

- Amended Principle 2 to distinguish deletion-first refactors from module moves, with weaker LOC-per-file test for the latter.
- Added AC-MCP-REDACTION for the `server.ts:278` envelope leak.
- Added pre-mortem Scenario 4 (MCP envelope leak) and Scenario 5 (multi-process memo loss).
- Sharpened AC-TYPES-1 to reference `ts-morph` AST enumeration rather than vague "`tsc` fails."
- Sharpened AC-OBSERVABILITY-1 to scope which dispatch paths count as invocations.
- Added AC-INVARIANT-MAP as M1a deliverable (`.omc/INVARIANTS.md`).
- Added AC-ATOMICITY for `applyAttachmentArtifacts` rollback (M3.8).
- Promoted `verify-audit-log.sh` from shell script to unit test (M3.9).
- Added supply-chain section (skills-vendor sha pin, M2.3).
- Added multi-process semantics section §13.

### v2 → v2.1 (Architect round-2 APPROVE WITH CHANGES; 2 must-fixes applied)

- Moved `fileChangeSynthesis` extraction out of M1a into M1b.5 so the hardening tranche contains **zero module moves**. M1a.3 is now only the invariant→test mapping deliverable.
- Rewrote AC-STRUCTURE-2 to validate "one shared parser, separate caller policies" without the brittle `.endsWith(".verse8.io")` grep; new check greps `export .* parseOverrideHost` for exactly one file. Updated verification-step grep sweeps to match.
- Updated test-plan split so `tests/unit/fileChangeSynthesis.test.mjs` lands with M1b, not M1a.

### v2.1 → v2.2 (Critic round-2 APPROVE with 2 non-blocking recommendations)

- AC-SECURITY-1 reworded to specify **property-based fuzz generation** (seeded by a shape registry that grows with new secret types) instead of a fixed 200-case count.
- Per-slice supply-chain drift check added as step 6 of "After every slice" verification (was previously only M2 milestone gate). Catches accidental `skills-vendor/agent8-skills` subtree drift during M1b module moves.

## 15. Architecture Decision Record (ADR)

**Decision**: Adopt **Option B (Trust-boundary-first, then deletion-dedup, then structure)** for the prototype → production hardening of `@verse8/verse8-mcp`. Execute in five milestones M0 → M1a → M2 → M1b → M3 → M4 across the 0.3.x and 0.4.x release lines.

**Drivers**:
1. **Zero-regression production promotion** — existing 0.3.0 users (117 unit + 26 smoke tests green) must not break across any slice.
2. **Close live security gaps first** — `server.ts:278` generic-catch leaks raw exception text to the MCP protocol envelope; `runAttach` / `runCheckpoint` / `runPreview` accept unvalidated `projectDir`; `runNewProjectConfirm` clones into a parent without symlink validation. These are not hypothetical — they are code paths in `v0.3.0` today.
3. **Maintainer throughput** — `attach.ts` at 700+ LOC blocks future feature iteration; but structural churn before trust-boundary closure widens the risk window, so it is scheduled after security ships.

**Alternatives considered**:
- **Option A — Staged "structure first, then harden"** (v1 favored; v2 REJECTED). Both reviewers flagged that it violates the plan's own deletion-first principle (M1.3/M1.5/M1.6 are module moves, not dedup) and leaves live security gaps unpatched during the highest-risk refactor phase. Architect evidence: `server.ts:278` returns `(e as Error).message` unredacted today; Critic evidence: v1's dismissal of Option B ("touching same lines twice") was contradicted by the M2 step table showing near-zero overlap with M1's `attach.ts` extraction targets.
- **Option C — Big-bang refactor** (REJECTED in both rounds). Compound regression risk; contradicts "zero-regression production promotion" driver. A 0.3.0 → 0.4.0 jump that restructures every smell at once multiplies blast radius beyond what the 117 + 26 test suite can verify.

**Why chosen** (Option B):
- (i) Live security gaps close in the first release (0.3.1 = M0), limiting the exposure window.
- (ii) No abstraction step runs until a prior step has earned the dedup — Principle 2 (deletion-first / module-move distinction) honored across all five milestones. M1a hardening tranche contains zero module moves post-v2.1 fix.
- (iii) Structure work (M1b) lands on a substrate where trust boundaries, redactor coverage, path validation, and supply-chain pins are already in place. M1b extractions cannot re-open a redaction gap because the dispatch envelope is already guarded.
- (iv) Each milestone maps to a tight semver bump with explicit CHANGELOG entries (0.3.1 → 0.3.2 → 0.3.3 → 0.4.0 → 0.4.x → 0.5.0) so external consumers can track risk.
- (v) Process-local state (`startCallMemo`, `inFlightConfirms`, rate-limit) is honestly documented as a known limitation rather than papered over with a half-finished persistent-store refactor (§13, P6).

**Consequences**:
- **Positive**: Live security patches ship within one sprint; every M1b extraction has an invariant→test map (M1a.3) backing it; the `applyAttachmentArtifacts` rollback design (M3.8) makes the hardest deferred refactor (M1b.6) feasible when it finally runs in 0.4.x-or-later.
- **Negative**: Longer total calendar (5 milestones across 0.3.x + 0.4.x). Mitigated by each milestone's small PR footprint (<400 LOC diffs) and independent shipping cadence.
- **Accepted trade-off**: Multi-process state (`startCallMemo` et al.) remains process-local in 0.3.x / 0.4.0. Persistent store is a documented 0.4.x-or-later follow-up, not this plan's scope.
- **Deprecation window**: `verse8_new_project` shim removed in 0.4.0 (M4.5), consistent with the one-release window promised in 0.3.0.

**Follow-ups**:
1. Persistent store for `startCallMemo` / `inFlightConfirms` — blocked on multi-process semantics RFC (0.4.x or later).
2. Parallel smoke-test runner — blocked on persistent token-vault refactor (post-0.4.0).
3. `.env` self-heal strictness (fail-fast vs best-effort) — separate RFC (§12 OQ5).
4. `zod-to-json-schema` dependency decision — revisited during M3.7 (default: pin home-rolled adapter).
5. Phase `applyAttachmentArtifacts` into named installers (M1b.6) — revisit once M3.8 rollback design ships.
6. Rate-limit durability — process-local `Map` for 0.3.x; rolling-window persistent implementation in 0.4.x follow-up.

**Consensus trail**:
- Planner v1 (initial draft, deliberate mode).
- Architect round 1 (Codex): REQUEST REWORK — 3 must-fixes (reorder, remove abstractions failing deletion-first, multi-process + audit-log design).
- Critic round 1: ITERATE — 5 must-fixes (reorder, MCP envelope redaction, pre-mortem expansion, resolve OQ1/OQ6, sharpen AC-TYPES-1/AC-OBSERVABILITY-1).
- Planner v2 (revision): applied all 8 converging items; reordered to M0 → M1a → M2 → M1b → M3 → M4; added Scenarios 4–5; added §13 multi-process section; added M3.8 rollback; added M2.3 skills-vendor pin; resolved OQ1 (XDG_STATE_HOME) and OQ6 (deferred).
- Architect round 2 (Codex): APPROVE WITH CHANGES — 2 must-fixes (move fileChangeSynthesis to M1b, fix AC-STRUCTURE-2 grep).
- Planner v2.1: both must-fixes applied.
- Critic round 2: **APPROVE** (all 5 round-1 items ADDRESSED; principle-option consistency clean; ACs mechanically verifiable; 2 non-blocking recommendations).
- Planner v2.2: applied both recommendations (property-based fuzz, per-slice subtree-sha check).
- **Consensus reached: 2 iterations of the Planner → Architect → Critic loop. Final verdict: APPROVED.**

---

<!-- End of plan. Implementation may begin at M0. -->
