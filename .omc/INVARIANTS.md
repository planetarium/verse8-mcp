# Verse8 MCP — Invariant → Test Mapping

> **Authoritative mapping read by reviewers and CI.**
> If a test referenced here is renamed, removed, or moved to another file,
> update this document **in the same commit**. `scripts/verify-invariants.sh`
> parses every reference below and fails the build when any is missing.
>
> Each invariant from `.omc/ARCHITECTURE.md §5` (the production-promise list
> the v0.3.0 hardening plan must preserve) appears here exactly once. Entries
> point at one of:
>
> - **`unit:`** a `tests/unit/<file>.test.mjs::<case name>` — the strongest evidence.
> - **`smoke:`** a `tests/smoke.sh` test name — for invariants integration-tested over MCP stdio.
> - **`source:`** a `src/<file>.ts` regex pattern — when the invariant is enforced by structural guarantees that no behavioral test would catch directly (e.g. a JSON payload schema).

## INV-1 — Token never hits a shell

The GitLab PAT is parsed out of the backend's clone command and passed
to `git clone` via `execFileSync` argv array — never interpolated into
a shell string. Backend-supplied slug is rejected if it contains `..`,
`/`, `\`, or NUL.

- source: `src/api/agent8Backend.ts` :: `export function parseCloneCommand`
- source: `src/tools/newProject.ts` :: `parsed\.passthroughFlags,`
- unit: `tests/unit/agent8Backend.test.mjs` :: `parseCloneCommand: short -b flag with oauth URL`
- unit: `tests/unit/newProjectConfirm.test.mjs` :: `confirm rejects traversal slug: hostile backend slug '..' → clone_parse_failed`

## INV-2 — `.verse8/project.json` carries no secrets

The marker file payload is `{version, projectId, attachedAt}` — never any
token, refresh_token, access_token, glpat-*, or Bearer header. Verified by
a source-level regex on the writer.

- source: `src/tools/attach.ts` :: `function ensureProjectMarker`

## INV-3 — URL overrides are host-validated

Every env-driven base URL (VERSE8_API_URL, VERSE8_AGENT8_BACKEND_URL,
VERSE8_<SERVICE>_MCP_URL ×9, VERSE8_CREATE_URL) is parsed via the shared
`parseOverrideHost` helper and gated by a per-caller `isAllowed*` predicate
that explicitly enumerates the verse8.io / loopback allow-set. A malicious
env value is rejected with stderr diagnostic and the default URL is used.

- source: `src/util/hostAllowlist.ts` :: `export function parseOverrideHost`
- unit: `tests/unit/hostAllowlist.test.mjs` :: `isAllowedOverrideHost: rejects foreign hosts and malformed URLs`
- unit: `tests/unit/hostAllowlist.test.mjs` :: `AC-STRUCTURE-2: each per-caller predicate sources the parser, not raw new URL`
- unit: `tests/unit/agent8Backend.test.mjs` :: `getAgent8BackendBaseUrl: evil.example.com override REJECTED → default`

## INV-4 — Skill merge precedence is `core > vendor > cache`

`listSkillResources` inserts in REVERSE precedence (cache → vendor → core)
into a `Map<uri, SkillResource>` so `Map.set`'s last-write-wins gives the
documented `core > vendor > cache` collision behavior.

- source: `src/resources/skills.ts` :: `for \(const s of listSkillsUnder\(coreSkills`

## INV-5 — `.env` ACCOUNT/VERSE is immutable once set

`ensureVerse8EnvFile` never auto-overwrites an existing
`VITE_AGENT8_ACCOUNT`. A mismatch returns `mismatch-preserved` with a
stderr hint pointing at `verse8_attach({overwriteEnv: true})` as the
explicit override.

- unit: `tests/unit/envFile.test.mjs` :: `ensureVerse8EnvFile: account mismatch → preserve + hint (no overwrite)`
- unit: `tests/unit/envFile.test.mjs` :: `ensureVerse8EnvFile: VERSE reused verbatim when present`
- unit: `tests/unit/envFile.test.mjs` :: `ensureVerse8EnvFile: overwrite: true replaces account AND verse`

## INV-6 — Skill no-touch invariant

`writeSkillFiles` only writes to `.claude/skills/<name>/` where `<name>` is
in the bundled skill set. User-authored skill directories without a
verse8-mcp hash marker are untouched even under `overwriteAllSkills: true`
or `pruneOrphanedSkills: true`.

- unit: `tests/unit/skillWriter.test.mjs` :: `writeSkillFiles: unrelated user skill not touched (AC-15)`
- unit: `tests/unit/skillWriter.test.mjs` :: `writeSkillFiles: pruneOrphaned removes only marker-bearing orphans (AC-16)`
- unit: `tests/unit/skillWriter.test.mjs` :: `writeSkillFiles: overwriteAll bypasses user-edit protection (AC-9)`

## INV-7 — `overwriteAllSkills: true` does not cascade to .env (and vice-versa)

Each overwrite flag scopes to its artifact class. `applyAttachmentArtifacts`
threads `overwriteAllSkills` into `writeSkillFiles` only and `overwriteEnv`
into `ensureVerse8EnvFile` only — neither flag touches the other call.

- source: `src/tools/attach.ts` :: `applyAttachmentArtifacts`
- unit: `tests/unit/skillWriter.test.mjs` :: `writeSkillFiles: overwriteAll bypasses user-edit protection (AC-9)`
- unit: `tests/unit/envFile.test.mjs` :: `ensureVerse8EnvFile: overwrite: true replaces account AND verse`

## INV-8 — V8 commit format is the on-wire contract

`buildV8CommitMessage` is deterministic — identical input produces byte-
identical output. The parser accepts every commit the builder produces and
rejects messages that drift from the structural envelope.

- unit: `tests/unit/v8CommitMessage.test.mjs` :: `deterministic build: same input produces identical output`
- unit: `tests/unit/v8CommitMessage.test.mjs` :: `round-trip: build then parse yields valid message`
- unit: `tests/unit/v8CommitMessage.test.mjs` :: `parser accepts existing sample commit from sample/match-three-game`
- unit: `tests/unit/v8CommitMessage.test.mjs` :: `parser rejects message missing V8AgentMessage`
- unit: `tests/unit/v8CommitMessage.test.mjs` :: `parser rejects message missing V8UserMessage`
- unit: `tests/unit/v8CommitMessage.test.mjs` :: `parser rejects message missing V8AssistantMessage`

## INV-9 — Narrative location = inside `<V8AssistantMessage>`

`<problemStatement>` and `<workSummary>` are emitted inside
`<V8AssistantMessage>` (canonical) AND duplicated into the
`<V8AgentMessage>` JSON for programmatic parsers. The legacy
`## Problem` / `## Work` markdown layout is still parsed for back-compat
but never emitted by the builder.

- unit: `tests/unit/v8CommitMessage.test.mjs` :: `narrative: problemStatement + workSummary nest inside V8AssistantMessage AND duplicate into V8AgentMessage JSON`
- unit: `tests/unit/v8CommitMessage.test.mjs` :: `narrative: XML order inside V8AssistantMessage — problemStatement, workSummary, reasoning, toolCall`
- unit: `tests/unit/v8CommitMessage.test.mjs` :: `narrative: parser falls back to markdown section scrape when JSON lacks fields`

## INV-10 — MCP proxy session retry is single-shot

On an "expired session" JSON-RPC error, the proxy evicts the cache,
reinitializes once, and retries the failing tools/call exactly once. Two
consecutive session failures surface verbatim — no infinite retry loop.

- source: `src/proxy/forward.ts` :: `if \(isSessionExpiredResponse\(resp\)\)`
- smoke: `tests/smoke.sh` :: `test_session_expire_retry`

## INV-11 — Tool discovery is token-gated, not cwd-gated

`tools/list` exposes `verse8_checkpoint`, `verse8_preview`, and proxy
tools whenever a token exists; they re-validate the verse project at
invocation via `projectDir` / cwd. This supports the "just-cloned into a
subdir, don't restart MCP" flow.

- source: `src/server.ts` :: `tools\.push\(CHECKPOINT_TOOL\)`

## MCP-UP-1 — `verse8_upload_asset` hits only the allow-listed backend

The upload tool calls `uploadAttachment()` whose URL is built from
`getAgent8BackendBaseUrl()`. The allow-list predicate is the shared
`isAllowedAgent8BackendBase` which enumerates the `*.verse8.io` /
loopback allow-set. A malicious env override is rejected.

- source: `src/api/agent8Backend.ts` :: `export async function uploadAttachment`
- source: `src/api/agent8Backend.ts` :: `isAllowedAgent8BackendBase`
- unit: `tests/unit/uploadAsset.test.mjs` :: `runUploadAsset: happy path returns url and resolved cdnPath`

## MCP-UP-2 — `cdnPath` traversal rejected before the network

`resolveCdnPath()` rejects `..` segments, leading `/`, and NUL before any
fetch. The tool also rejects `filename` overrides that contain path
separators.

- source: `src/format/assetShortcuts.ts` :: `function sanitizeCdnPath`
- unit: `tests/unit/assetShortcuts.test.mjs` :: `resolveCdnPath: parent traversal rejected`
- unit: `tests/unit/assetShortcuts.test.mjs` :: `resolveCdnPath: leading slash rejected`

## MCP-UP-3 — `ATTACHMENT_EXTS` is the pre-network extension gate

Extensions not in the local `ATTACHMENT_EXTS` allowlist are rejected before
any network call. The local list mirrors
`planetarium/agent8-backend/src/config/constants.ts` — if the upstream
list grows, the local copy must be updated (manual sync, documented here).

- source: `src/format/attachmentExts.ts` :: `export const ATTACHMENT_EXTS`
- unit: `tests/unit/attachmentExts.test.mjs` :: `ATTACHMENT_EXTS includes core image/audio/3d/font/text`
- unit: `tests/unit/uploadAsset.test.mjs` :: `runUploadAsset: invalid_extension`
