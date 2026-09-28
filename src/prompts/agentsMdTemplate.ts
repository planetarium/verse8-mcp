/**
 * AGENTS.md template installed by verse8_attach into every verse8 project.
 * (M1b-1 — extracted from src/tools/attach.ts.)
 */

export const AGENTS_MD_TEMPLATE = `# Verse8 Project — Agent Instructions

> Read this file in full at session start. It is installed by verse8-mcp
> (\`verse8_attach\`) and also serves as the attachment marker. Do not delete.

## 🚨 First action rule (before anything else)

At the **START of every turn** — even bug fixes, UI tweaks, performance
tuning, "just change this number" — call
\`verse8_bootstrap({userRequest: "<user's verbatim message>"})\` BEFORE
any Edit / Write / Bash / build command. It is a cheap (~10ms, no
network) classifier that returns:

- \`workflow.nextAction === "ready"\` → this is an attached Verse8
  project; proceed with the user's request and follow the TOP RULES
  below (use \`verse8_checkpoint\` / \`verse8_preview\` for commits &
  previews, NEVER raw \`git commit\` or \`bun run dev\`).
- \`workflow.nextAction === "attach"\` → call \`verse8_attach\` first,
  then re-call bootstrap.
- \`workflow.nextAction === "login"\` → call \`verse8_login_start\` first,
  then re-call bootstrap.
- \`workflow.nextAction === "not_verse_project"\` → this cwd is NOT a
  Verse8 workspace; proceed with your usual tools.

Never infer workflow state from filesystem inspection. The bootstrap
tool is the single source of truth.

## 🚨 TOP RULES (violating these will break the project)

1. **Never run \`bun run dev\` / \`vite\` via Bash.** The \`verse8_preview\` MCP
   tool exists exactly to launch the dev server. It bundles a V8-format
   commit with the spawn so "what the user sees" matches "what is in git".
   If you call \`bun run dev\` via Bash you will produce an uncommitted
   preview — the user will approve state that was never saved.
2. **Never run \`git commit\` via Bash.** Use \`verse8_checkpoint\` (or
   \`verse8_preview\`, which calls it internally). The installed
   \`commit-msg\` git hook rejects non-V8 messages with exit code 1.
3. **Never pass \`--no-verify\` to git.** It bypasses the commit-msg hook
   and produces commits the web/container stack cannot parse.
4. **Preview-delta rule**: any change the user would see in the next
   preview (asset swap, UI tweak, gameplay change, bug fix) ends the turn
   with \`verse8_preview\`. One user turn → one \`verse8_preview\` call →
   one commit → optional running dev server.

If you think you need Bash for \`git commit\` or \`bun run dev\`, stop and
use the MCP tool instead. The only exception is \`VERSE8_ALLOW_NONCOMPLIANT=1 git commit -m "..."\` for a deliberate, user-approved one-off fix.

## 🚨 Deploy only through \`verse8_deploy\`

When the user asks to deploy / publish / ship / 배포 / 출시 / 게시:

1. Call \`verse8_deploy\` with \`dryRun: true\`. It resolves whether this is
   the **first deploy** or an **update** of the project's verse and returns
   the publish body it would send.
2. First deploy needs a \`title\` and a cover image (\`thumbnailPath\` — a
   local png/jpg/gif/webp ≤4 MB, e.g. made with \`image_asset_generate\` —
   or \`imageUrl\`). Ask the user; never invent them. Updates keep the
   current title / image / visibility / tags unless you pass new ones;
   offer \`releaseNoteTitle\` + \`releaseNoteTypes\` for updates.
3. Show the user the mode and metadata, and run \`verse8_deploy\` without
   \`dryRun\` only after they confirm — publishing is public.
4. If it returns \`captcha_required\`, the game files are uploaded but the
   first publish must be finished in the web editor (URL in the hint).
   Later updates work from \`verse8_deploy\`.
5. Do NOT run \`@agent8/deploy --prod\`, a build + upload, or any deploy
   command via Bash. \`verse8_checkpoint\` / \`verse8_preview\` only commit
   + push to gitlab.verse8.io; they do not publish.
6. The verse id (\`VITE_AGENT8_VERSE\`) is the game's identity — VX Shop
   products and gameserver state are keyed by it. Never edit it to "fix" a
   deploy error.

## You are operating inside a Verse8 project

Origin: \`gitlab.verse8.io\`. Project marker: \`.verse8/project.json\`.
Runtime: **Vite + Bun**. The dev server is \`bun run dev\` (default port 5173).

The \`@verse8/mcp\` MCP server is attached and provides the tools you
MUST use for state-changing operations:

| Intent | Use | Do NOT use |
|--------|-----|------------|
| Log in to Verse8 | \`verse8_login_start\` → \`verse8_login_complete\` | \`bash scripts/verse8-login.sh\` unless MCP is unavailable |
| Check current profile / token | \`verse8_status\` | — |
| Commit + push changes | **\`verse8_checkpoint\`** | Native \`git commit\` via Bash |
| **Commit + launch preview for the user** | **\`verse8_preview\`** | Separate \`bun run dev\` via Bash without committing first |
| Generate game images | \`image_asset_generate\` / \`image_variation_generate\` | External image APIs |
| **Deploy / publish to production** | **\`verse8_deploy\`** (\`dryRun: true\` first, then confirm) | Any deploy / build+upload command via Bash |
| Upload a verse cover image / preview video | \`verse8_upload_thumbnail\` (or \`thumbnailPath\` on \`verse8_deploy\`) | \`verse8_upload_asset\` (that is for in-game assets) |

## Preview policy — the "see it = commit it" rule

verse8 is a **Vite + Bun** project. After any change the user should visually
verify (new feature, asset swap, UI tweak, gameplay logic, bug fix), run
\`verse8_preview\` — **not** a bare \`bun run dev\`. \`verse8_preview\`:

1. Runs \`verse8_checkpoint\` first (V8 commit + push)
2. **Preflight** — sync deps via \`installCommand\` (default \`bun update\`).
   If this is a GameServer project (\`server.ts\`, \`server.js\`, or a
   \`server/\` directory present), additionally runs
   \`npx -y @agent8/gameserver-node build\` and
   \`npx -y @agent8/deploy --preview\` so the local client has a freshly
   deployed server to call. Each step is blocking; failure aborts before
   the dev server starts and returns \`preflight_failed\` with the
   failing step + stderr tail.
3. Launches \`bun run dev\` detached on port 5173
4. Returns the preview URL (\`http://localhost:5173\`) for you to relay

This bundling is deliberate: the state the user previews is guaranteed to be
the state that was just committed. Never start the dev server without first
committing — if you do, the user might approve a preview that no longer
exists on disk.

Situations that warrant calling \`verse8_preview\`:

- Added / replaced a game asset (sprites, backgrounds, UI icons)
- Changed gameplay logic that affects rendered behavior
- Modified any screen the user described in this session's prompt
- User explicitly asked to "run", "preview", "show me", "확인해보자"

If \`verse8_preview\` reports \`preview.status = "already_running"\`, the server
is already up — just tell the user the URL. If it reports \`"started"\`,
relay the URL + PID.

**Always surface BOTH links** when the response includes \`webEditor.url\`:

- Preview     : \`http://localhost:5173\`  (local)
- Web Editor  : \`<webEditor.url>\`         (continue editing from the browser)

The web editor link is \`https://create.verse8.io/creator/editor?chat=<projectPath>\`
when \`git remote origin\` is a gitlab.verse8.io repo. If \`webEditor\` is \`null\`,
omit that line (the project isn't hosted on gitlab.verse8.io).

Use \`startOnly: true\` only when the user specifically asks to reopen the
preview with no new changes.

## Commit policy (critical)

Principle: **preview-delta commits**. If the user would see a visible change
in the next preview, call \`verse8_checkpoint\` before moving on. One user
turn → one checkpoint → one commit.

When calling \`verse8_checkpoint\`, always pass:

- \`userPrompt\` — the user's message this turn, verbatim
- \`model\` — your model identifier (e.g. \`claude-opus-4-7\`)
- \`provider\` — e.g. \`anthropic\`
- \`mcpServers\` — names of MCP servers used (optional)
- \`problemStatement\` — **REQUIRED for history continuity**. 1–3 sentences
  describing how you interpreted the user's request this turn: what they
  want + the constraints you're working under. A future agent reading
  \`git log\` depends on this to reconstruct why you made the changes.
- \`workSummary\` — **REQUIRED for history continuity**. 1–5 sentences
  describing what you actually did at a higher level than \`reasoning\`
  (which is about thought process) or \`toolCalls\` (which are raw
  payloads). Good example: "Replaced the stubbed verse8_new_project with
  a 2-tool start/confirm split, added agent8-backend client + mock,
  documented the flow in AGENTS.md."
- \`toolCalls\` — brief list of host tools you used (name + status minimum).
  Omit to let the MCP auto-fill from its observation log — but that log only
  covers verse8-mcp tools; your host tools (Read/Write/Bash) will be missing
  unless you pass them.

The MCP server assembles the V8 format commit message deterministically.
A \`commit-msg\` git hook validates the result — **you will see warnings on
stderr if your commit drifts from the format or is missing narrative**.
Fix them next turn: if the hook warns about missing \`<problemStatement>\` or
\`<workSummary>\` inside \`<V8AssistantMessage>\`, that means you didn't pass
\`problemStatement\` / \`workSummary\` and the next agent loses the reasoning
for this change.

Where narrative lands in the commit: the MCP writes \`<problemStatement>\`
and \`<workSummary>\` tags **inside \`<V8AssistantMessage>\`** (alongside
\`<reasoning>\` and \`<toolCall>\`), and also duplicates both as plain strings
in the \`V8AgentMessage\` JSON for programmatic parsers. Do NOT try to format
the narrative as markdown headings yourself — just pass the prose through
the tool fields and the MCP builds the correct XML.

**Do not use \`git commit\` via Bash in this project.** The installed
\`commit-msg\` hook **rejects non-V8 commits with exit code 1** — any
Bash-driven commit that skips \`verse8_checkpoint\` will fail unless the
subject is a git-auto message (Merge / Revert) or the user explicitly
exports \`VERSE8_ALLOW_NONCOMPLIANT=1\`. Also, do NOT pass \`--no-verify\` to
\`git commit\` — that bypasses the hook and produces commits the web /
container stack cannot parse.

## MCP proxy services (9 total)

verse8-mcp proxies 9 upstream Verse8 services. They appear in \`tools/list\`
whenever the user is logged in. Call \`verse8_status\` to see which are
currently enabled and why.

| Service | Tools | When to use |
|---------|-------|-------------|
| \`image\` | \`image_asset_generate\`, \`image_variation_generate\`, \`asset_wait\` | 2D game assets (characters, items, backgrounds, UI icons) |
| \`spritesheet\` | \`spritesheet_generate\`, \`spritesheet_variation_generate\` | Animated sprite sheets |
| \`cinematic\` | \`cinematic_asset_generate\`, \`cinematic_asset_result\`, \`cinematic_status\` | Text-to-cutscene video |
| \`audio\` | \`music_generate\`, \`sfx_generate\`, \`audio_status\`, \`audio_result\` | BGM / SFX |
| \`skybox\` | \`skybox_generate\`, \`skybox_status\`, \`skybox_styles\` | 360° environments |
| \`ui\` | \`ui_theme_list\`, \`ui_theme_style\` | CSS UI themes |
| \`claythis\` | \`claythis_3d_generate\`, \`claythis_3d_status\` | 2D → 3D conversion |
| \`crossramp\` | \`crossramp_deploy\`, \`crossramp_deploy_status\`, \`crossramp_active_project\` | Testnet deploy, ERC20 |
| \`vectorsearch\` | \`search_codebase_vectordb_items\`, \`read_codebase_vectordb_items\`, \`search_resources_vectordb_items\` | Codebase vector search |

### Enabling / disabling proxies

Users may disable unused proxies — check \`verse8_status → project.mcpProxies\`
first to see current enabled set. If a tool is missing because the user has
disabled that service, do not invent a workaround; suggest the user re-enable:

- \`VERSE8_MCP_PROXIES=image,audio,spritesheet\` — opt-in allow-list
- \`VERSE8_MCP_PROXIES_DISABLED=crossramp,vectorsearch\` — block-list
- \`.verse8/project.json\`: \`{ "disabledMcpProxies": ["claythis"] }\` — persistent per-project

Per-service URL overrides (\`VERSE8_<NAME>_MCP_URL\`) exist for staging /
local dev; rarely relevant during normal feature work.

## Creating a new Verse8 project

Use the two-step flow — NEVER just one tool. The split exists so the user
can approve the proposed template before any GitLab repo is created.

### Step 1 — propose

Call \`verse8_new_project_start({userRequest})\` with the user's verbatim
message. The MCP calls \`/api/startcall\` on agent8-backend and returns:

- \`template\`: full template metadata (name, label, description, tags)
- \`templateName\`, \`repo\`, \`path\`: exact identifiers used by the backend
- \`suggestedTitle\`, \`suggestedProjectRepo\`: backend-inferred defaults
- \`nextActionSuggestion\`: short "first thing you should do" prompt
- \`startCallId\`: opaque correlation id — hold onto it for step 2

Show the user the template label + description + nextActionSuggestion.
Ask whether to proceed, and whether to override \`title\` or \`projectRepo\`.

### Step 2 — confirm

On user confirmation, call \`verse8_new_project_confirm\` with:

- \`templateName\`, \`repo\`, \`path\`: verbatim from step 1 — NEVER invent these
- \`title\`, \`projectRepo\`: from step 1 unless the user explicitly overrode
- \`startCallId\`: verbatim from step 1 — this is a guardrail that catches
  \`templateName\` drift (mismatch → \`template_mismatch\`, zero HTTP calls)
- \`targetDir\`: optional parent directory for the clone (default: cwd)

The MCP will:
1. POST /api/select-template (creates the GitLab project)
2. GET /api/gitlab/project-access-token (check existing PAT)
3. POST /api/gitlab/project-access-token (grant a 30-day PAT if needed)
4. \`git clone -b develop <oauth2-embedded URL>\` into \`<targetDir>/<slug>\`
5. Install git hooks + AGENTS.md + \`.verse8/project.json\` (attach)

On success the response includes \`nextCallRequires.projectDir\`. **From that
point on, you MUST pass \`projectDir\` on every subsequent tool call** —
specifically every \`verse8_checkpoint\`, \`verse8_preview\`, and image-proxy
tool call in this session. The MCP server's own cwd is still the parent
directory, so without \`projectDir\` those tools will target the wrong path.

### Retry after a transient failure

If \`confirm\` returns \`token_grant_failed\`, \`clone_failed\`,
\`clone_parse_failed\`, or \`attach_failed\`, the error envelope includes
\`projectPath\`. Re-call \`confirm\` with that \`projectPath\` to skip
\`selectTemplate\` and resume from token-grant — this avoids orphaning a
duplicate timestamped GitLab repo.

### MCP server restarted mid-flow

If the MCP host restarted between Step 1 and Step 2, the in-process
\`startCallId\` memo is lost. Calling \`verse8_new_project_confirm\` with a
stale \`startCallId\` returns \`template_mismatch\`. Recovery: re-run
\`verse8_new_project_start\` and pass the freshly-issued identifiers verbatim
to \`verse8_new_project_confirm\`. A persistent store is a 0.4.x follow-up.

### Rules

- NEVER call \`verse8_new_project_confirm\` without first running
  \`verse8_new_project_start\`.
- NEVER fabricate \`templateName\` / \`repo\` / \`path\` — always echo the
  values from the start response.
- NEVER embed the GitLab PAT in \`.verse8/project.json\` (it's stored safely
  inside \`.git/config\` via the clone URL only).
- After confirm returns, pass \`projectDir\` on every subsequent tool call
  until the user restarts the MCP host from inside the new directory.

{{SKILLS_CATALOG}}

## If you are not sure this project is attached

Call \`verse8_status\`. If \`project.attached\` is false, call
\`verse8_attach\` — it is idempotent.
`;

/**
 * Belt-and-suspenders guard: the {{SKILLS_CATALOG}} marker must remain in
 * the template, otherwise the catalog silently vanishes. Exported so unit
 * tests can assert it.
 */
export const AGENTS_MD_TEMPLATE_HAS_CATALOG_MARKER =
  AGENTS_MD_TEMPLATE.includes("{{SKILLS_CATALOG}}");
