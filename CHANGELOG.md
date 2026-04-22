# Changelog

All notable changes to `@verse8/mcp` are documented here. Format is
loosely based on [Keep a Changelog](https://keepachangelog.com/), versioning
follows [SemVer](https://semver.org/) — pre-1.0 minor bumps may include
breaking changes when clearly documented.

## [0.5.3] — 2026-04-21

### Fixed — enforce verse8 flow at MCP session level, not just per-tool

0.5.2 strengthened the `verse8_bootstrap` tool description but a user
report confirmed agents (Claude Code) STILL skipped bootstrap and used
raw Bash `git` + edited files directly in an attached verse8 project.
Tool descriptions are one of many hints the LLM sees; **`InitializeResult.instructions`**
is a stronger signal — MCP hosts include it in the LLM's system prompt
at session start.

### Changed
- `src/server.ts` — Server is constructed with an `instructions` field
  containing the full "call bootstrap at the start of every turn + never
  use raw git commit / bun run dev / --no-verify + use verse8 asset
  tools" policy. Claude Code / Cursor / opencode surface this at session
  start, above tool-description level.
- `src/tools/bootstrap.ts` — the `ready` state's `workflow.instructions`
  now inlines the mandatory rules (checkpoint / preview / --no-verify /
  preview-delta / image tool) so even agents that read only the
  bootstrap response (without auto-loaded AGENTS.md) see the rules.
- `src/server.ts` — `verse8_checkpoint` and `verse8_preview` tool
  descriptions rewritten to lead with "MANDATORY … NEVER use raw git /
  bun run dev via Bash".

### Why 0.5.2 was not enough
- Tool descriptions are advisory. Claude Code's routing heuristic can
  and does deprioritize them when the user's prompt does not mention
  the tool by name.
- When `workspaceMode === "attached"` bootstrap returned only a brief
  "proceed directly, use verse8_checkpoint…" instruction — the agent's
  context did not carry the full mandatory rules unless the project
  had a committed `AGENTS.md` / `CLAUDE.md` (which web-editor-created
  projects may lack).
- `InitializeResult.instructions` moves the enforcement from per-tool
  to per-session, so a fresh clone with no AGENTS.md still sees the
  rules on MCP connect.

### Added — manual slash-command prompts
- `/verse8:bootstrap` — manually run `verse8_bootstrap` to classify the
  workspace and see the recommended `nextTool`.
- `/verse8:attach` — manually run `verse8_attach` and (per the prompt
  body) commit the resulting `AGENTS.md` / `CLAUDE.md` /
  `.claude/skills/` to git so future clones inherit the guidance.
- `/verse8:status` — manually run `verse8_status` and get a concise
  report (login state, attachment, workflow.nextTool, expiry warnings).
- `/verse8:verse8-new-project-bootstrap` — unchanged from earlier
  releases; still surfaces the 2-step new-project flow walkthrough.

These prompts let the user **escape the auto-routing layer** when the
agent has not called bootstrap on its own — common during the early
turns of a freshly cloned project that does not yet have committed
AGENTS.md / CLAUDE.md.

### Compatibility
- No API / output shape change. 352/352 unit tests pass (was 347 → +5
  from new `serverInstructions.test.mjs`).
- Hosts that ignore `InitializeResult.instructions` (none known among
  Claude Code / Cursor / opencode / Continue) still benefit from the
  stronger per-tool descriptions and the inlined bootstrap-ready
  instructions.

## [0.5.2] — 2026-04-21

### Fixed — bootstrap must be called for any task, not just verse8-keyword requests

User report: Cloned a verse8 project from the web to local, asked the
agent "콤보 효과가 너무 쎕니다" (please tune the combo effect). The agent
skipped `verse8_bootstrap` entirely and edited 5 files + ran build
directly via native tools — never recognizing the workspace as a verse8
project. Root cause was two-fold:

1. **Tool description was too narrow.** The old description said
   "CALL THIS FIRST whenever the user mentions verse8 / ... / gitlab.verse8.io"
   so the agent skipped it for ordinary bug-fix language. Now the
   description says to call bootstrap at the start of **ANY**
   file-modifying / code-generating task (bug fix, feature add,
   performance tuning, …) **BEFORE any Edit/Write/Bash command** — it's
   a cheap (~10ms, no network) classifier that returns `nextTool: null`
   when the cwd is NOT a Verse8 project, so it's safe to always call.

2. **`non_verse_dir` + `empty` cases incorrectly forced
   `verse8_new_project_start`.** This meant a user asking for a ppt in
   an empty folder, or editing a GitHub repo unrelated to verse8, would
   get routed into the new-project flow. Now those cases return
   `nextAction: "not_verse_project"` with `nextTool: null` and
   instructions telling the agent to proceed with its usual tools.
   Verse8 new-project is OPT-IN — only engaged when the user explicitly
   mentions verse8 / Verse8 / 버스8.

### User-facing decision table

| Cwd state | Token? | `nextAction` | `nextTool` |
|-----------|--------|--------------|------------|
| Empty / non-verse git repo | — | `not_verse_project` | `null` (agent proceeds normally) |
| `gitlab.verse8.io` clone, not attached | missing | `login` | `verse8_login_start` |
| `gitlab.verse8.io` clone, not attached | present | `attach` | `verse8_attach` |
| Attached verse8 project | missing | `login` | `verse8_login_start` |
| Attached verse8 project | present | `ready` | `null` (proceed with verse8_checkpoint / preview) |

### Changed
- `src/tools/bootstrap.ts` — new `BootstrapNextAction` value
  `"not_verse_project"` and reshaped decision table per above.
- `src/server.ts` — `verse8_bootstrap` description rewritten to be
  imperative, aggressive-first-call, but with explicit "safe to call
  in non-verse workspaces" reassurance so agents don't hesitate.
- `src/prompts/agentsMdTemplate.ts` — "First action rule" rewritten
  around the four nextAction outcomes (ready / attach / login /
  not_verse_project).
- Tests updated: `tests/unit/bootstrap.test.mjs`,
  `tests/unit/statusWorkflow.test.mjs`, `tests/unit/bootstrapRouting.test.mjs`.
  346 → 347 unit tests (one new case).

### Compatibility
- `BootstrapResult` / `StatusResult` types gain a new union member on
  `workflow.nextAction`. JSON consumers that enumerate actions must
  handle `"not_verse_project"`.
- `workflow.nextTool === null` is now meaningful for two distinct
  actions (`"ready"` and `"not_verse_project"`) — agents must read
  `nextAction` to disambiguate.

## [0.5.1] — 2026-04-21

### Docs / template
- AGENTS.md template: new "🚨 Deploy is web-only" section. When the user
  asks to deploy / publish / ship / 배포 / 출시, the agent directs them
  to **https://create.verse8.io/** (web UI) instead of inventing a Bash
  command or invoking a non-existent MCP tool. The intent table also
  gains a Deploy row pointing at the same URL.
- README: new "Deploy to production" section above "MCP server
  restarted mid-flow", explaining web-only deployment and the role
  separation (`verse8_checkpoint` / `verse8_preview` push to
  gitlab.verse8.io but do NOT trigger production deploy).
- Newly attached / re-attached projects pick up the new AGENTS.md
  guidance via `verse8_attach({overwriteAgentsDoc: true})`. Existing
  projects continue to work — no breaking change.

## [0.5.0] — 2026-04-21

### Added — bootstrap state machine (Codex UX gap closure)

- **New tool `verse8_bootstrap`** — the single always-first entry-point
  for any Verse8 user request. Returns
  `{workspaceMode, workflow:{nextAction, nextTool, reason, instructions},
  diagnostics}` so MCP hosts (Claude Code, **Codex**, Cursor, …) can
  deterministically route "verse8으로 게임 만들어줘" to the right tool
  without inferring workflow state from prose. Decision table covers
  `empty`, `unattached_clone`, `attached`, `non_verse_dir` modes crossed
  with token presence.
- `src/context/workspace.ts` — new `detectWorkspace()` returning
  `{hasGit, originHost, hasProjectMarker, projectId, attached,
  workspaceMode}`. Replaces the fragile "needs BOTH marker AND matching
  origin" predicate that mis-classified fresh `gitlab.verse8.io` clones.
- **`verse8_status` response gains `workflow`** — same shape as
  `verse8_bootstrap.workflow`. An agent that called `status` first still
  gets `nextAction` / `nextTool` routing on every branch
  (`ok:true` / `not_logged_in` / `token_invalid`). Zero additional HTTP
  calls — routing runs against the existing `verifyToken` response.
- **Tool descriptions rewritten to imperative** in `src/server.ts`:
  - `verse8_bootstrap` starts with "CALL THIS FIRST".
  - `verse8_login_start` / `verse8_new_project_start` / `verse8_attach`
    lead with "Call this when `workflow.nextTool` from verse8_bootstrap
    is …" so LLMs follow the state machine by tool contract.
- **AGENTS.md template** (`src/prompts/agentsMdTemplate.ts`) prepends a
  new "First action rule" section so even after attach, agents default
  back to `verse8_bootstrap` when the workflow state is ambiguous.

### Root cause addressed

Codex (unlike Claude Code) does **not** auto-load project-root
`AGENTS.md` / `CLAUDE.md` into its system prompt, and the MCP prompt
`verse8-new-project-bootstrap` is opt-in only. Previously this meant a
fresh Codex session with an empty directory had **zero** verse-specific
guidance: the agent would see the BASE_TOOLS list with declarative
descriptions and generate a game arbitrarily instead of routing to
`verse8_new_project_start`. The 0.5.0 bootstrap tool makes routing a
tool contract rather than prose.

### Tests

- `tests/unit/workspaceDetect.test.mjs` — 9 cases covering all
  `(hasGit × originHost × hasProjectMarker × attached)` combinations.
- `tests/unit/bootstrap.test.mjs` — 10 cases for `computeBootstrapWorkflow`
  + `runBootstrap` (empty, non-verse, unattached clone, attached, userRequest
  redaction).
- `tests/unit/statusWorkflow.test.mjs` — 4 cases asserting `verse8_status`
  carries the same `workflow` object across all modes.
- `tests/unit/bootstrapRouting.test.mjs` — grep-level guards on tool
  descriptions so a future weakening of the imperative phrasing fails the
  build.
- `tests/unit/dispatchAudit.test.mjs` — `verse8_bootstrap` emits exactly
  one audit line (AC-OBSERVABILITY-1 parity with other tools).

Total: 318 → 346 unit tests.

### Non-breaking

- All existing `verse8_*` tool signatures unchanged.
- `StatusResult` gains a required `workflow` field. This is a type-level
  addition — JSON consumers that ignore unknown fields keep working.
  Existing tests (statusExpiresSoon, dispatch, …) are unaffected.
- `detectVerseProject` + `verseProject.ts` kept as-is for back-compat.

## [0.4.1] — 2026-04-21

### Docs
- README: add a dedicated **Quick install** section at the top with one-liners
  for Claude Code (`claude mcp add verse8 -- npx -y @verse8/mcp`) and Codex
  (`codex mcp add verse8 -- npx -y @verse8/mcp`), plus version-pin, project
  scope, and remove variants.
- The per-host config table now surfaces CLI-helper availability and adds a
  **Verify the install** section (`claude mcp list` / `codex mcp list`).
- No code change — only the published README on the npm page is updated.

## [0.4.0] — 2026-04-21

### Changed — BREAKING
- **Package renamed** `@verse8/verse8-mcp` → `@verse8/mcp`. Update your MCP
  host config: `"args": ["-y", "@verse8/mcp"]` (or `@verse8/mcp@0.4.0` for
  a pinned setup). The bin stays `verse8-mcp` so installed git hooks keep
  working; only the npm package name changed.
- **`verse8_new_project` shim removed.** The one-release deprecation shim
  introduced in 0.2.0 is gone. Agents must call
  `verse8_new_project_start` + `verse8_new_project_confirm`. A call to the
  old name now falls through to the dispatch-level `unknown_tool` /
  `not_logged_in` path, not the `tool_renamed` error.

### Added — hardening milestones M0 → M4
- **M0 (trust-boundary)** — `util/redact.ts` central redactor covering
  `glpat-*`, `Bearer <t>`, `oauth2:<s>@…`, `access_token / refresh_token /
  id_token / device_code` JSON fields. Every MCP response envelope (tool,
  resource, prompt) routes through `safeErrorHint` / `safeHint`. Zod
  refinements reject `..` / NUL / symlink-parent `projectDir` /
  `targetDir` at the dispatch boundary.
- **M1a (deletion-first dedup)** — `util/atomicWrite.ts` collapses two
  near-identical write-tmp-then-rename impls. `util/hostAllowlist.ts` is a
  low-level URL parser only — each caller keeps its own explicit policy
  predicate. `.omc/INVARIANTS.md` maps 11 production invariants to
  regression tests; `scripts/verify-invariants.sh` greps every referenced
  test name and fails the build on drift.
- **M2 (security hardening)** — `util/childEnv.ts` preview spawn env
  sanitizer. `.verse8/.gitignore` stanza for audit log / preview log /
  atomic-write tmp leftovers. `skills-vendor/agent8-skills` subtree SHA
  pinned in `package.json :: verse8.skillsVendor.sha` + verified by
  `scripts/check-subtree-sha.sh`. Best-effort rate-limit on
  `verse8_new_project_start` (documented as process-local).
- **M1b (structural extraction)** — `attach.ts` split 720 → 331 LOC.
  `prompts/agentsMdTemplate.ts`, `context/hooks.ts` (dedup with
  `context/attachment.ts`), `resources/skillCatalog.ts`,
  `format/fileChangeSynthesis.ts`. `proxy/imageMcp.ts` renamed to
  `proxy/forward.ts` with a back-compat shim (removed in 0.5.0).
- **M3 (observability + types + atomicity)**
  - `util/auditLog.ts` — rotating JSONL audit log at
    `${XDG_STATE_HOME:-~/.local/state}/verse8/mcp.log` (or the
    `VERSE8_AUDIT_LOG_PATH` override). 1 MB rotation, mode 0600, writer
    never throws.
  - `util/errors.ts` — `ErrorCode` string-literal union + `ERROR_CODES`
    single source of truth. TypeScript Compiler API AST test
    (`tests/unit/errorCodeCoverage.test.mjs`) asserts every `error: "…"`
    literal in `src/` is a union member.
  - `util/toolDispatch.ts` — correlation-id + duration + audit sink
    wrapper around the `CallToolRequestSchema` handler. Exactly one
    JSONL line per reached tool runner; zero for schema-parse failures
    and `unknown_tool` fallthroughs.
  - `util/rollback.ts` — `RollbackJournal` for multi-step installers.
    `applyAttachmentArtifacts` records a reverse per successful step and
    replays them LIFO on any mid-sequence failure. Pre-existing
    user-authored `AGENTS.md` is preserved.
  - New unit test coverage: `attachment.test.mjs` (11 cases),
    `v8CallLog.test.mjs` (9 cases), `login.test.mjs` (7 cases via local
    HTTP mock), `auditLog.test.mjs` (7), `dispatchAudit.test.mjs` (5),
    `jsonSchema.test.mjs` (31-case round-trip; decision: pin the
    hand-rolled adapter rather than adopting `zod-to-json-schema`),
    `attachRollback.test.mjs` (6), `errorCodeCoverage.test.mjs` (3).
- **M4 (operational)**
  - `tests/smoke/` split — `login.sh`, `attach.sh`, `new-project.sh`,
    `preview.sh`, `skills.sh`, plus a shared `_runner.sh`. `tests/smoke.sh`
    stays a working entrypoint via the new `VERSE8_SMOKE_ONLY` filter.
  - `util/gameserverPin.ts` — preview preflight now resolves
    `@agent8/gameserver-node` + `@agent8/deploy` versions from
    `package.json :: verse8.gameserverPin` with
    `VERSE8_GAMESERVER_BUILD_PIN` env override.
  - `scripts/prepublish-guard.sh` + `prepublishOnly` script — every
    `npm publish` scans the tarball for `glpat-*`, `Bearer <t>`,
    `"access_token":"…"`, `VITE_AGENT8_ACCOUNT=0x<hex>`, `*.map`.
    Publish fails on any hit (AC-SECURITY-2). `package.json :: files`
    narrowed to `dist/**/*.js` + `dist/**/*.d.ts` to exclude sourcemaps
    from the public tarball.
  - `verse8_status` — emits `warnings: ["token_expires_soon"]` and
    `tokenExpiresAt` when the token's `exp` claim is within 7 days.
    Zero additional HTTP calls (reuses the existing `verifyToken`
    response).
  - `npm run audit` — `npm audit --audit-level=high` gate.
- Test suite grew 117 → **318** unit tests across the five milestones.
  `tsc` clean. `scripts/verify-invariants.sh` resolves 31 references;
  `scripts/check-subtree-sha.sh` OK; `scripts/prepublish-guard.sh` OK.

## [0.3.0] — 2026-04-20

### Added
- Vendored [agent8-skills](https://github.com/planetarium/agent8-skills) as
  a git subtree under `skills-vendor/agent8-skills/`. Currently ships 23
  game-building skills (gameserver SDK, vibe-starter-3d family, crossramp,
  leaderboard, etc.) alongside the two existing core skills.
- `src/resources/skills.ts` now discovers skills from three sources —
  `skills/` (core), `skills-vendor/agent8-skills/skills/` (vendored, flat
  upstream layout), and `~/.cache/verse8/skills/` (user cache) — and
  supports both the directory-per-skill (`<name>/SKILL.md`) and flat
  (`skills/<name>.md`) layouts so the upstream layout isn't forced to
  reshape.
- `verse8_attach` now materializes every bundled skill to
  `<projectDir>/.claude/skills/<name>/SKILL.md` so Claude Code auto-loads
  them. A trailing `<!-- verse8-skill-hash: <sha256> -->` marker
  distinguishes "verse8-mcp wrote this" from user edits; re-attach
  preserves user-edited copies verbatim.
- New `attachInputSchema` flags: `overwriteAllSkills` (force-overwrite even
  user-edited skills) and `pruneOrphanedSkills` (remove `.claude/skills/`
  dirs whose skill is no longer bundled AND still carry our marker —
  user-authored skill directories without a marker are never pruned).
- AGENTS.md / CLAUDE.md templates now carry a dynamic `## Available Verse8
  skills` catalog populated from the discovered skill set at attach time.
  Replaces the previous hard-coded "Reference skills" block.
- Attach result envelope gains `installed.skills: { created, updated,
  skippedUserEdited, existingUnchanged, pruned }` so callers can surface
  exactly what happened per skill.
- 10 new unit tests in `tests/unit/skillWriter.test.mjs` covering hash
  determinism, CRLF normalization, idempotent re-run, user-edit
  preservation, overwriteAll bypass, no-touch invariant, and orphan prune.
- 3 new smoke tests covering post-attach skill materialization, the
  no-touch invariant, and no-cascade-delete on upstream removal.

### Changed — BREAKING
- **Skill merge precedence reversed.** Prior releases inserted
  `~/.cache/verse8/skills/` AFTER `skills/` in the merge map, so cache
  entries won on collision. Starting with 0.3.0 the order is
  `core > vendor > cache`, matching the spec. If you relied on a cache
  override of a bundled skill, fork the package or rename the skill.
- `applyAttachmentArtifacts` opts now accepts optional `overwriteAllSkills`
  and `pruneOrphanedSkills`. The existing `{overwrite, projectId}` call
  sites (verse8_new_project_confirm) continue to work — the new fields are
  all optional and default to false.
- `AttachResult.installed` grew a mandatory `skills: SkillWriteResult`
  sub-object. Any external consumer destructuring `installed` will need to
  handle the new field.

### Fixed
- `resolveRepoRoot()` now recognizes the repo when either `skills/` OR
  `skills-vendor/` exists — a consumer with an older install that shipped
  only `skills/` still resolves correctly.

## [0.2.1] — 2026-04-20 (unreleased in this tree)

- Internal bugfix iteration on the Case-2 flow (not published as a
  discrete npm version). Folded into 0.3.0.

## [0.2.0] — 2026-04-20

### Added
- `verse8_new_project_start` + `verse8_new_project_confirm` — 2-tool
  split of the Case-2 flow (agent8-backend startcall + select-template +
  project-access-token + clone + attach). Replaces the stubbed
  `verse8_new_project` which is kept one release as a `tool_renamed`
  deprecation shim.
- Flag-scanning `parseCloneCommand` + argv-array `git clone` keeps the
  GitLab PAT off any shell.
- `VERSE8_AGENT8_BACKEND_URL` env override, host-validated against
  `.verse8/localhost` allow-list.
- Preview `webEditor.url` hint — `https://create.verse8.io/creator/editor`
  — so the host LLM surfaces both local preview and web editor.
- `readinessTimeoutMs` on `verse8_preview` + dev-server port probe so the
  tool no longer lies about a running preview when `bun run dev` exits.
- V8 commit format now carries `## Problem` / `## Work` narrative (and
  the same values inside V8AgentMessage JSON) so future agents reading
  `git log` can reconstruct context without replaying tool payloads.
- MCP proxy now auto-recovers from upstream session expiry (reinit + retry
  once on "No valid session ID" responses).

## [0.1.0]

Initial verse8-mcp release — device-flow login, attach, checkpoint,
preview, status, stub new-project, image/audio/… MCP proxies.
