# verse8-mcp — Architecture & Refactor Briefing

> **Audience:** the next-session agent picking this up for a project-wide
> structure review and refactor. This document describes the code **as it
> exists today** (2026-04-21, `package.json` version `0.3.0`).

## 1. What verse8-mcp is

A Node 18.17+ TypeScript **MCP (Model Context Protocol) meta-server** that
the host LLM (Claude Code, Codex, Cursor, opencode) registers via `npx -y
@verse8/verse8-mcp serve`. Once registered, the server:

1. **Gates a Verse8 developer workflow** for any LLM session that runs
   inside a `gitlab.verse8.io` project — auto-commits via V8 commit format,
   launches local previews with server-deploy preflight, surfaces web-editor
   links, and installs git hooks that enforce the format.
2. **Proxies 9 upstream Verse8 MCP services** (image / spritesheet /
   cinematic / audio / skybox / ui / claythis / crossramp / vectorsearch)
   so the host LLM sees one MCP endpoint instead of nine.
3. **Materializes skill documentation** into `<projectDir>/.claude/skills/`
   so Claude Code's native skill loader picks up both core verse8-mcp
   skills and the vendored `agent8-skills` library.
4. **Owns the `.env` contract** (`VITE_AGENT8_ACCOUNT` +
   `VITE_AGENT8_VERSE`) that the verse8 runtime depends on at boot.

The surface is a single `@verse8/verse8-mcp` npm package; there is no
separate CLI package. The `bin.verse8-mcp` in `package.json` maps to
`dist/index.js` which dispatches `serve` / `hook pre-commit` /
`hook commit-msg`.

## 2. Top-level layout

```
verse8-mcp/
├─ src/                        ← TypeScript source (strict, ES2022, Node16 modules)
│  ├─ index.ts                 ← binary entry: dispatches subcommands
│  ├─ server.ts                ← MCP server wiring: tool / resource / prompt handlers
│  ├─ api/
│  │   ├─ v8MemeApi.ts         ← auth base (https://v8-meme-api.verse8.io)
│  │   └─ agent8Backend.ts     ← project-creation base (https://agent8-backend.verse8.io)
│  ├─ cli/
│  │   ├─ preCommitHook.ts     ← git pre-commit: rejects non-gitlab-verse8 origins
│  │   └─ commitMsgHook.ts     ← git commit-msg: validates V8 format + emits narrative warnings
│  ├─ context/
│  │   ├─ token.ts             ← token file priority: env > <cwd>/.verse8/token > $XDG_CONFIG_HOME/verse8/token
│  │   ├─ verseProject.ts      ← "is this a verse8 project?" (origin + marker detection)
│  │   ├─ attachment.ts        ← "is this project attached to verse8-mcp?" (hooks + AGENTS.md signature)
│  │   └─ envFile.ts           ← .env (VITE_AGENT8_ACCOUNT/VERSE) materialization & drift policy
│  ├─ format/
│  │   └─ v8CommitMessage.ts   ← V8 commit format builder + parser (problemStatement / workSummary XML + JSON duplicate)
│  ├─ prompts/
│  │   └─ newProjectBootstrap.ts  ← single MCP prompt that teaches the 2-step new-project flow
│  ├─ proxy/
│  │   ├─ registry.ts          ← 9 upstream services + URL override allow-list + enable/disable config
│  │   └─ imageMcp.ts          ← stateful JSON-RPC proxy, session-expiry retry, per-service cache
│  ├─ resources/
│  │   └─ skills.ts            ← listSkillResources / readSkillResource (merges core + vendor + cache)
│  ├─ tools/
│  │   ├─ login.ts             ← verse8_login_start, verse8_login_complete (RFC 8628 device flow)
│  │   ├─ status.ts            ← verse8_status
│  │   ├─ newProject.ts        ← verse8_new_project_start, verse8_new_project_confirm (+ deprecation shim)
│  │   ├─ attach.ts            ← verse8_attach, applyAttachmentArtifacts (shared by attach + confirm)
│  │   ├─ checkpoint.ts        ← verse8_checkpoint (V8 commit + push + auto file-change narration)
│  │   ├─ preview.ts           ← verse8_preview (checkpoint → preflight → bun run dev + readiness probe)
│  │   └─ skillWriter.ts       ← hash-fingerprinted SKILL.md materializer (no-touch invariant, prune opt-in)
│  └─ util/
│      ├─ jsonSchema.ts        ← thin zod → JSON schema adapter used by tool registration
│      └─ v8CallLog.ts         ← per-project in-process log of tool invocations (checkpoint backstop)
├─ skills/                     ← verse8-mcp core skills (2: verse8-login, verse8-commit)
├─ skills-vendor/agent8-skills/← git-subtree-vendored upstream skill library (23 flat .md files)
├─ hooks/                      ← pre-commit / commit-msg template scripts (shelled out by installed hooks)
├─ tests/
│  ├─ smoke.sh                 ← 26 MCP-stdio integration tests
│  ├─ lib/jsonrpc.sh           ← minimal MCP-stdio helper used by smoke
│  ├─ mocks/                   ← v8-meme-api-mock.ts, agent8-backend-mock.ts, image-mcp-mock.ts, fixture-bundle.sh
│  ├─ unit/*.test.mjs          ← 9 node:test files, 117 cases, all run against dist/
│  └─ e2e/verify-loop.sh       ← live-prod checks (manual, not in CI)
├─ dist/                       ← tsc output (gitignored; shipped in npm tarball)
├─ sample/                     ← match-three-game + simple-omok-game fixtures (not shipped)
├─ .omc/                       ← OMC session state + this file + TODO
├─ README.md                   ← user-facing (install, Case 1/2, env vars, skills)
├─ CHANGELOG.md                ← release notes (0.1.0 → 0.3.0)
└─ package.json                ← bin: verse8-mcp → dist/index.js
```

## 3. Public tool surface (via MCP)

Always exposed (no login required):

| Tool | Responsibility | Main state touched |
|---|---|---|
| `verse8_login_start` | RFC 8628 device-code request | none |
| `verse8_login_complete` | poll token endpoint, write `~/.config/verse8/token` | token file (atomic) |
| `verse8_status` | verify token, report project attachment + proxy config | read-only |
| `verse8_new_project_start` | agent8-backend `/api/startcall`, mint `scid_…` | in-process memo (capped 50) |
| `verse8_new_project_confirm` | select-template → token grant → clone → attach | disk: new project dir + .env + git + skills |
| `verse8_new_project` | deprecation shim → `{error:"tool_renamed"}` | none |
| `verse8_attach` | install hooks + AGENTS.md + project marker + skills + .env | disk: 5 categories of files |

Exposed when token present (`tools/list` re-evaluates each call):

| Tool | Responsibility |
|---|---|
| `verse8_checkpoint` | stage + V8-format commit + push; .env self-heal before staging |
| `verse8_preview` | checkpoint → preflight (install + gameserver build/deploy) → `bun run dev` + readiness probe |
| (9 services × N tools, e.g. `image_asset_generate`, `music_generate`, `spritesheet_generate`…) | proxied from upstream MCP services |

Resources (always exposed): `verse8://skill/<name>/SKILL.md` for every
bundled skill (core + vendored + cache; core wins on name collision).

Prompts (always exposed): `verse8-new-project-bootstrap` — teaches the
2-step `start → confirm` flow.

## 4. Data flow — the four core journeys

### 4.1 Login
```
verse8_login_start → POST /v1/auth/device/authorize (v8-meme-api)
                   ← device_code + verification_uri_complete + user_code
verse8_login_complete(device_code)
  → POST /v1/auth/device/token (polling)
  ← access_token (200) or authorization_pending (400)
  → write ~/.config/verse8/token (atomic: tmp + rename, mode 0600)
```

### 4.2 New project (Case 2)
```
verse8_new_project_start({userRequest})
  → POST /api/startcall (agent8-backend)
  ← {templateName, repo, path, suggestedTitle, suggestedProjectRepo, nextActionSuggestion, template}
  → mint scid_… + memoize sha256(templateName,repo,path) in process-local Map

<user approves, maybe overrides title/repo>

verse8_new_project_confirm({templateName, repo, path, title, projectRepo, startCallId?, projectPath?, targetDir?})
  → [guard] recompute sha256 vs memo    → template_mismatch (0 HTTP)
  → [guard] in-flight Set keyed by projectPath or startCallId+templateName  → confirm_in_flight
  → GET /api/select-template              → project.path, project.id
  → GET /api/gitlab/project-access-token  (informational check)
  → POST /api/gitlab/project-access-token → {token, gitUrl, cloneCommand, expiresAt}  (tolerant parser: camelCase / snake_case / nested / SSE)
  → parseCloneCommand (flag-scan, no shell)
  → pre-clone fs.existsSync check         → clone_target_exists
  → execFileSync("git", ["clone", ...flags, "-b", branch, url, slug], {cwd: parentDir})
  → applyAttachmentArtifacts (hooks + AGENTS.md + .verse8/project.json + skills + .env)
  ← {projectDir, projectId, projectPath, gitUrl, branch, tokenExpiresAt, nextCallRequires:{projectDir}}
```

Error codes (8 distinct, no catch-all): `startcall_failed`,
`select_template_failed`, `token_check_failed`, `token_grant_failed`,
`clone_target_exists`, `clone_parse_failed`, `clone_failed`,
`attach_failed`, plus `template_mismatch`, `confirm_in_flight`,
`not_logged_in`.

### 4.3 Attach
```
verse8_attach({projectDir?, overwriteAgentsDoc?, overwriteAllSkills?, pruneOrphanedSkills?, overwriteEnv?})
  → detectVerseProject (origin = gitlab.verse8.io OR .verse8/project.json present)
  → detectAttachment (hook signatures + AGENTS.md signature — gates `attached`)
  → resolveWalletAddress (.env ACCOUNT first, verifyToken() fallback)
  → applyAttachmentArtifacts(projectDir, {overwrite, projectId, overwriteAllSkills, pruneOrphanedSkills, walletAddress, overwriteEnv})
       ├─ writeHook(hooksDir, "pre-commit",  "#!/bin/sh\nexec verse8-mcp hook pre-commit \"$@\"\n")
       ├─ writeHook(hooksDir, "commit-msg",  "#!/bin/sh\nexec verse8-mcp hook commit-msg \"$@\"\n")
       ├─ writeAgentsDoc(projectDir, overwrite, skills) — splices {{SKILLS_CATALOG}} token
       ├─ ensureProjectMarker(projectDir, projectId)    — .verse8/project.json (version, projectId, attachedAt)
       ├─ writeSkillFiles(projectDir, skills, {overwriteAll, pruneOrphaned}) — .claude/skills/<name>/SKILL.md + hash marker
       └─ ensureVerse8EnvFile(projectDir, walletAddress, {overwrite: overwriteEnv})
  → detectAttachment (again, to populate the state field)
```

`applyAttachmentArtifacts` is shared between `verse8_attach` and
`verse8_new_project_confirm`. It's the single source of truth for "what
does an attached verse8 project look like on disk".

### 4.4 Preview
```
verse8_preview({userPrompt, model, provider, problemStatement, workSummary, ...})
  1. verse8_checkpoint (internal) — V8 commit + push
       · self-heal .env (readEnvAccount → verifyToken fallback → ensureVerse8EnvFile)
       · synthesizeFileChangesFromDiff (git diff --cached per-file)
       · mergeToolCalls (llm-passed ∪ auto-logged ∪ file-changes, dedupe by filePath)
       · buildV8CommitMessage (deterministic, backtick-quoted XML bodies)
       · git commit -m <message> → commit-msg hook validates
       · git push origin HEAD
  2. preflight (new in 0.3.0)
       · installCommand (default "bun update")
       · if detectGameserver(cwd): npx -y @agent8/gameserver-node build
       · if detectGameserver(cwd): npx -y @agent8/deploy --preview
       · each step blocking, execFileSync with per-step timeout
  3. spawn bun run dev (detached, stdio → .verse8/preview.log)
  4. waitForDevServer (poll port, bail on child exit)
  5. derive webEditor.url from `git remote origin` (gitlab.verse8.io → https://create.verse8.io/creator/editor?chat=<path>)
  6. return {ok, commit, preflight, preview: {status, url, pid, command, logPath}, webEditor}
```

## 5. Cross-cutting invariants (do NOT break these in a refactor)

1. **Token never hits a shell.** Every `git clone` uses
   `execFileSync("git", ["clone", ...])` argv-array form. Never `exec` or
   `execSync` with a command string. The GitLab PAT comes embedded in
   `cloneCommand` which is parsed via `parseCloneCommand` before the argv
   is constructed.
2. **`.verse8/project.json` carries no secrets.** Only `{version, projectId,
   attachedAt}` (and nothing else). The PAT lives only inside
   `.git/config` via the clone URL. AC-4 and AC-11 in the Case-2 spec
   enforce this.
3. **URL overrides are host-validated.** Every env that lets a user
   redirect a backend base URL (`VERSE8_API_URL`,
   `VERSE8_AGENT8_BACKEND_URL`, `VERSE8_<SERVICE>_MCP_URL`, `VERSE8_CREATE_URL`)
   goes through `isAllowedOverrideHost` in `src/proxy/registry.ts`:
   `.verse8.io` / localhost only for http(s); non-http schemes accepted
   (fetch will reject them at transport time).
4. **Skill merge precedence is `core > vendor > cache`.** `listSkillsUnder`
   inserts into a `Map<uri, SkillResource>` in REVERSE order (cache first,
   core last) so `Map.set`'s last-write-wins gives the right precedence.
   This was a **breaking change in 0.3.0** — callers who relied on cache
   overrides must move overrides into `skills/`.
5. **`.env` ACCOUNT/VERSE is immutable once set.** `ensureVerse8EnvFile`
   NEVER auto-overwrites an existing ACCOUNT. Mismatch emits a stderr
   hint that points at `verse8_attach({overwriteEnv: true})` as the
   explicit override.
6. **Skill no-touch invariant.** `writeSkillFiles` only writes to
   `.claude/skills/<name>/` where `<name>` is in the bundled skill set.
   Pre-existing user-authored skill directories are untouched even under
   `overwriteAllSkills: true` (AC-15 in the plan).
7. **`overwriteAllSkills: true` does not cascade to .env.** And vice-versa.
   Each overwrite flag scopes to its artifact class.
8. **V8 commit format is the on-wire contract.** The commit-msg hook
   rejects non-V8 messages (exit 1). Two carve-outs:
   `^(Merge |Revert )` and `VERSE8_ALLOW_NONCOMPLIANT=1`. The builder is
   **deterministic** — same input produces byte-identical output; the
   parser handles JSON + XML + markdown narrative fallbacks for forward
   compat.
9. **Narrative location = inside `<V8AssistantMessage>`.** The canonical
   shape is `<problemStatement>` / `<workSummary>` XML tags (with backtick
   body + id + status="completed"), duplicated into the V8AgentMessage JSON
   for programmatic parsers. The legacy `## Problem` / `## Work` markdown
   layout is still parsed for backward compat but NOT emitted.
10. **MCP proxy session retry is single-shot.** On an "expired session"
    JSON-RPC error, evict cache, reinitialize once, retry. No infinite
    retry loops.
11. **Tool discovery is token-gated, not cwd-gated.**
    `tools/list` exposes `verse8_checkpoint` + `verse8_preview` + proxy
    tools whenever a token exists — they re-validate the verse project at
    INVOCATION via `projectDir` / cwd. This supports the "just-cloned into
    a subdir, don't restart MCP" flow.

## 6. Side-effect map (what touches what)

| Surface | Written by | Read by |
|---|---|---|
| `~/.config/verse8/token` (or `$XDG_CONFIG_HOME/verse8/token`) | `verse8_login_complete` | `context/token.ts`, every authenticated tool |
| `<projectDir>/.verse8/project.json` | `ensureProjectMarker` (attach + confirm) | `context/verseProject.ts`, `context/attachment.ts`, `proxy/registry.ts` (disabledMcpProxies) |
| `<projectDir>/.git/hooks/{pre-commit,commit-msg}` | `writeHook` (attach + confirm) | git |
| `<projectDir>/AGENTS.md` and `CLAUDE.md` | `writeAgentsDoc` (attach + confirm) | host LLM |
| `<projectDir>/.claude/skills/<name>/SKILL.md` | `writeSkillFiles` (attach + confirm) | Claude Code skill loader |
| `<projectDir>/.env` | `ensureVerse8EnvFile` (attach + confirm + checkpoint self-heal) | Vite runtime |
| `<projectDir>/.verse8/preview.log` | `runPreview` spawn stdout/stderr | operator |
| git working copy | `runCheckpoint` (stage + commit + push) | git remote |
| spawned `bun run dev` child | `runPreview` | user |
| MCP proxy service caches (in-memory) | `discoverServiceTools` in `imageMcp.ts` | proxy tool calls |
| V8 call log (in-memory, per-projectDir) | every tool dispatch (except checkpoint) | `runCheckpoint` for toolCalls backstop |
| in-flight / startCallMemo Maps (in-memory) | `runNewProject{Start,Confirm}` | same-process retries |

Nothing outside those entries should be written. Anything in the repo
currently doing a sneaky write should be on the refactor review list.

## 7. Testing strategy

- **Unit (`node:test` via `npm run test:unit`, 117 cases):** runs against
  `dist/`. Each file targets one module. Mocks are process-spawned (never
  monkeypatching fetch) so tests exercise the same wire protocol as prod.
  Temp dirs go into `os.tmpdir()` with `fs.mkdtempSync` and are cleaned
  in `finally`.
- **Smoke (`bash tests/smoke.sh`, 26 cases):** drives the MCP server over
  stdio using `tests/lib/jsonrpc.sh`. Each test starts the relevant mock
  server (v8-meme-api-mock, agent8-backend-mock, image-mcp-mock), runs an
  end-to-end flow, asserts output shape. Token is backed up + restored at
  the suite level so running smoke doesn't clobber the developer's real
  login.
- **E2E (`tests/e2e/verify-loop.sh`, manual only):** hits production
  backends. Not in CI. Used for pre-release smoke against the actual
  verse8.io services. Expects `~/.config/verse8/token` to exist.
- **Build precondition:** unit tests import from `dist/`, so every test
  run via `npm test` triggers `tsc` first. If a refactor breaks a unit
  test, always rerun `npm run build` first to rule out a stale `dist/`.

`npm test` = `npm run build` (implicitly, via test:unit's dependency)
followed by `smoke` and `unit`. Confirm both green before every commit
per the project's own policy.

## 8. Dependency shape (intra-package)

```
index.ts
  └─ server.ts
       ├─ tools/{login,status,newProject,attach,checkpoint,preview}  ← all tool entries
       ├─ resources/skills                                            ← MCP resources
       ├─ prompts/newProjectBootstrap                                 ← MCP prompts
       ├─ proxy/{registry,imageMcp}                                   ← 9-service proxy
       └─ util/{jsonSchema, v8CallLog}

tools/attach.ts   →  context/{verseProject,attachment,envFile,token}, api/v8MemeApi, resources/skills, tools/skillWriter
tools/newProject  →  api/{agent8Backend,v8MemeApi}, context/token, tools/attach
tools/checkpoint  →  context/{attachment,token,verseProject,envFile}, api/v8MemeApi, format/v8CommitMessage, util/v8CallLog
tools/preview     →  tools/checkpoint, proxy/registry (host allow-list for VERSE8_CREATE_URL)
tools/login       →  api/v8MemeApi, context/token
tools/status      →  api/v8MemeApi, context/{attachment,token,verseProject}, proxy/{imageMcp,registry}

cli/preCommitHook →  context/verseProject
cli/commitMsgHook →  format/v8CommitMessage

proxy/imageMcp    →  proxy/registry
resources/skills  →  (leaf — fs only)
context/envFile   →  (leaf — fs + crypto)
api/*             →  proxy/registry (for isAllowedOverrideHost)
```

No circular deps. No `node:http` / `node:net` outside `proxy/*`,
`tools/status.ts` (port probe), and `tools/preview.ts` (port probe). All
remote I/O goes through the two `api/` modules.

## 9. Known smells & refactor candidates

> These are observations, not a prescription. A refactor pass should
> consider whether to collapse, split, or leave as-is.

1. **`src/tools/attach.ts` has grown to ~700 lines.** It hosts the MCP
   tool handler, `applyAttachmentArtifacts`, the `AGENTS_MD_TEMPLATE`
   string (200+ lines), the hook-writer helpers, the catalog renderer,
   and the frontmatter description extractor. Good candidates to split:
   (a) template → `src/prompts/agentsMdTemplate.ts`; (b) hook writing →
   `src/context/hooks.ts`; (c) skill-catalog rendering →
   `src/resources/skillCatalog.ts`. The `verse8_attach` handler itself
   stays in `tools/`.
2. **`src/tools/checkpoint.ts` mixes 3 concerns:** message assembly
   (`resolveMessage`), file-change backstop (`synthesizeFileChangesFromDiff`),
   and git operations. The backstop could live in its own module
   (`src/format/fileChangeSynthesis.ts`) and be unit-tested in isolation
   — currently only exercised via integration paths.
3. **`proxy/imageMcp.ts` filename is historic.** It's the multi-service
   proxy now; rename to `proxy/forward.ts` or `proxy/upstream.ts` for
   honesty.
4. **The `applyAttachmentArtifacts` signature has grown to 6 optional
   fields** (`overwrite`, `projectId`, `overwriteAllSkills`,
   `pruneOrphanedSkills`, `walletAddress`, `overwriteEnv`). Each addition
   is sound in isolation but together they're a hint that the function is
   doing too much. Consider splitting into phases:
   `installHooks()`, `installAgentsDoc()`, `installMarker()`,
   `installSkills()`, `installEnv()` — each with its own opts struct.
5. **Schema defaults leak.** `previewInputSchema` has defaults that zod
   populates when `.parse()` runs at the MCP dispatch layer
   (`src/server.ts` in `CallToolRequestSchema`). But direct test callers
   (e.g. `previewReadiness.test.mjs`) must pass every field manually
   because `runPreview` does not re-parse. Consider either: (a) have the
   runner re-parse its own input (cheap runtime cost); (b) make all
   schema-default fields mandatory in the TypeScript type and apply
   defaults at the server dispatch exclusively.
6. **`src/resources/skills.ts::resolveRepoRoot` walks up looking for
   `skills/` or `skills-vendor/`.** It's OK but brittle; consider using
   `fileURLToPath(import.meta.url)` + a declarative `__REPO_ROOT__`
   constant populated at build time by `tsc`'s `rootDir`.
7. **No persistent audit log.** Every state change (attach, checkpoint,
   preview) is logged to stderr but nothing durable. A `.verse8/mcp.log`
   (mode 0644, rotating) could dramatically speed up "what happened in
   the last session" debugging.
8. **`V8CommitInput` now carries 8 fields** (`userPrompt`, `model`,
   `provider`, `mcpServers`, `reasoning`, `toolCalls`, `problemStatement`,
   `workSummary`, `idSeed`). Consider a nested shape: `{user: {prompt,
   model, provider}, narrative: {problemStatement, workSummary,
   reasoning}, tools: {called, mcpServers}}`. Low priority — the flat
   shape matches the historical V8 spec.
9. **`tests/smoke.sh` is 1200+ lines.** Consider splitting into
   `smoke/login.sh`, `smoke/attach.sh`, `smoke/new-project.sh`,
   `smoke/preview.sh`, `smoke/skills.sh` with a shared runner. Would
   improve parallelism if someone wants to run only one suite.
10. **The `.env.tmp-<pid>-<ts>` atomic-write pattern in `envFile.ts`
    could be factored up.** Same pattern appears in login's token write
    (`src/tools/login.ts`). Shared helper in `src/util/atomicWrite.ts`.
11. **No `error` typing abstraction.** Every tool's result union enumerates
    its own error codes; there's no central error-code registry. For
    refactor, a `src/errors.ts` with typed error constructors would make
    adding a new error code less accident-prone.

## 10. Subsystems worth understanding before touching anything

- **RFC 8628 device flow (login.ts)** — two-tool split (`start`, `complete`)
  because users need to see the verification URL immediately without
  blocking polling.
- **verse8 project detection (verseProject.ts)** — `.verse8/project.json` +
  `git remote origin` == `gitlab.verse8.io`. Both checked; marker is
  enough if origin is missing (e.g., fresh clone with rewritten origin).
- **Attachment detection (attachment.ts)** — distinct from project detection.
  Checks hook signatures + AGENTS.md "verse8-mcp" / "verse8_checkpoint"
  substring AND `core.hooksPath` resolution for husky-style setups.
- **V8 commit format (format/v8CommitMessage.ts)** — opaque-looking XML
  container the verse8 backend parses. The builder must stay deterministic
  because downstream systems hash the commit body. Narrative lives
  INSIDE `<V8AssistantMessage>` (canonical) + duplicated inside
  `<V8AgentMessage>` JSON (programmatic). The parser reads both + legacy
  markdown.
- **MCP proxy (proxy/imageMcp.ts + registry.ts)** — stateful. Each upstream
  service has a cached session-id + tool schema set. Token change →
  cache drop (called from `status.ts` on `token_invalid`). First-discovery
  wins on tool-name collision (e.g. `asset_wait` is in 3 services).
- **Skill materialization (skillWriter.ts)** — hash fingerprint
  (`<!-- verse8-skill-hash: <sha256> -->`) on the LAST line of every
  copied file. Last line chosen over first line because Claude Code's
  skill loader is known to be happy with trailing HTML comments but
  Step 0's verification of leading-comment tolerance was never done
  empirically in prod. Safe fallback location.
- **Env file (context/envFile.ts)** — once-set immutable contract. Reused
  ACCOUNT from `.env` short-circuits `verifyToken()` calls in
  checkpoint's self-heal, which is the hot path.

## 11. Current test coverage map

| File under test | Unit tests | Smoke tests |
|---|---|---|
| `src/api/agent8Backend.ts` | 17 (URL allow-list, parseCloneCommand 8 shapes, tolerantJsonParse, pickString) | — |
| `src/context/envFile.ts` | 12 | — |
| `src/format/v8CommitMessage.ts` | 12 (build, parse, narrative XML/markdown, sample acceptance) | — |
| `src/proxy/registry.ts` | 7 (precedence matrix, env allow/block-list, project override) | — |
| `src/proxy/imageMcp.ts` | — (integration via smoke) | 4 (bearer, error passthrough, session expiry retry, 500 passthrough) |
| `src/resources/skills.ts` | indirectly via smoke + skillWriter tests | 3 (materialize, no-touch, no-cascade-delete) |
| `src/tools/attach.ts` | — (integration via smoke) | agents_md_literals + skills_materialized |
| `src/tools/checkpoint.ts` | commit message tests exercise the builder | 1 (no_token_errors) |
| `src/tools/login.ts` | — | device-flow via v8-meme-api-mock |
| `src/tools/newProject.ts` | 8 (template_mismatch, retry, concurrency, traversal slug, omit shapes) | 3 (tool_renamed, start_shape, confirm_happy_path, template_mismatch) |
| `src/tools/preview.ts` | 15 (webEditor URL 7, readiness 4, preflight 4) | — |
| `src/tools/skillWriter.ts` | 11 | (covered via smoke) |

Gaps worth flagging:
- No unit test for `context/attachment.ts` detectAttachment logic; only
  integration-exercised.
- No unit test for the V8 call log (`util/v8CallLog.ts`) — it's tiny but
  the cross-project bleed fix in iteration 4 was test-driven and those
  tests should probably be lifted into a dedicated unit file.
- `src/tools/login.ts` has no dedicated unit test — device flow is
  exercised only via smoke against the mock.

## 12. If the next session only reads ONE file before diving in

Read `src/tools/attach.ts`. It's the longest file, carries the most
invariants, and sits at the crossroads of every other subsystem. If a
refactor is going to break something, it'll break something here first.

## 13. Getting started checklist for the refactor session

- [ ] `npm run build` clean
- [ ] `npm run test:unit` green (117 cases)
- [ ] `bash tests/smoke.sh` green (26 cases)
- [ ] read this file top to bottom
- [ ] read `src/tools/attach.ts`
- [ ] read `.omc/TODO.md` for the "what's still open" session handoff
- [ ] skim `CHANGELOG.md` to understand the 0.1 → 0.3 evolution
- [ ] decide scope with the user before starting any structural move
