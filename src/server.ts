import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./util/jsonSchema.js";
import { recordToolCall } from "./util/v8CallLog.js";
import { redactHead, safeErrorHint, safeHint } from "./util/redact.js";
import { dispatchTool } from "./util/toolDispatch.js";
import { LOGIN_HINT } from "./util/hints.js";
import { loadToken } from "./context/token.js";
import { ipAssetsInputSchema, runIpAssets } from "./tools/ipAssets.js";
import { attachInputSchema, runAttach } from "./tools/attach.js";
import { bootstrapInputSchema, runBootstrap } from "./tools/bootstrap.js";
import {
  checkpointInputSchema,
  runCheckpoint,
} from "./tools/checkpoint.js";
import { previewInputSchema, runPreview } from "./tools/preview.js";
import { deployInputSchema, runDeploy } from "./tools/deploy.js";
import { gameserverInputSchema, runGameserver } from "./tools/gameserver.js";
import { deployStatusInputSchema, runDeployStatus } from "./tools/deployStatus.js";
import { runVerseOps, verseOpsInputSchema } from "./tools/verseOps.js";
import { runVxShop, vxShopInputSchema } from "./tools/vxShop.js";
import type { ConfirmHost } from "./tools/creatorOps.js";
import {
  runUploadAsset,
  uploadAssetInputSchema,
} from "./tools/uploadAsset.js";
import {
  runUploadThumbnail,
  uploadThumbnailInputSchema,
} from "./tools/uploadThumbnail.js";
import {
  loginCompleteInputSchema,
  loginStartInputSchema,
  logoutInputSchema,
  runLoginComplete,
  runLoginStart,
  runLogout,
} from "./tools/login.js";
import {
  newProjectConfirmInputSchema,
  newProjectStartInputSchema,
  runNewProjectConfirm,
  runNewProjectStart,
} from "./tools/newProject.js";
import { openProjectInputSchema, runOpenProject } from "./tools/openProject.js";
import { runStatus, statusInputSchema } from "./tools/status.js";
import {
  callImageTool,
  discoverImageTools,
  type UpstreamTool,
} from "./proxy/forward.js";
import {
  listSkillResources,
  readSkillResource,
} from "./resources/skills.js";
import {
  getNewProjectBootstrapPrompt,
  newProjectBootstrapPrompt,
} from "./prompts/newProjectBootstrap.js";
import {
  attachPrompt,
  bootstrapPrompt,
  getAttachPrompt,
  getBootstrapPrompt,
  getStatusPrompt,
  statusPrompt,
} from "./prompts/manualCommands.js";

const SERVER_INFO = {
  name: "@verse8/mcp",
  version: "0.10.0",
};

/**
 * MCP `InitializeResult.instructions` — broadcast to the host at session
 * start. Claude Code / Cursor / opencode include this in the LLM's system
 * context, which is a stronger signal than individual tool descriptions.
 * Use this to enforce "bootstrap first + never use raw git / bun run dev
 * in a verse8 project" at a level the LLM cannot overlook.
 */
const SERVER_INSTRUCTIONS = `@verse8/mcp is attached. MANDATORY for this session:

1) **Call \`verse8_bootstrap\` at the START of EVERY turn** that might touch files / run commands / generate code — BEFORE any Edit, Write, Bash, or other file-modifying action. It is a cheap (~10ms, no network) classifier.
   - If it returns \`workflow.nextAction === "not_verse_project"\` → safe to ignore the rest of Verse8 MCP; proceed with usual tools.
   - If it returns \`ready\` → the project is an attached Verse8 project; follow rules 2–5 below.
   - Any other nextAction → call the named \`nextTool\` and honor \`workflow.instructions\`.

2) **In a Verse8 project (nextAction === "ready"), NEVER use raw \`git commit\` via Bash.** ALWAYS use \`verse8_checkpoint\`. The installed commit-msg hook rejects non-V8 commits with exit 1.

3) **NEVER run \`bun run dev\` / \`vite\` / any dev server via Bash.** ALWAYS use \`verse8_preview\` — it bundles a V8 commit with the spawn so "what the user sees == what is in git".

4) **NEVER pass \`--no-verify\`** (or any hook-skip flag) to git.

5) **Preview-delta rule**: any change the user will see in the next preview (UI tweak, gameplay, asset swap, bug fix) ends the turn with \`verse8_preview\`.

6) **Image / music / sfx / 3D asset generation** → use the image_asset_generate / music_generate / sfx_generate / spritesheet_generate / skybox_generate / claythis_3d_generate / etc. tools. Do NOT call external APIs directly.

7) **Deploy / publish** → \`verse8_deploy\` (\`dryRun: true\` first, then confirm — it is public). NEVER deploy via Bash. A push deploys nothing, whatever a skill says: \`verse8_preview\` deploys the server for testing.

8) **3D engine: Incanto by default.** On \`vibe-starter-3d\`, \`vibe-starter-3d-environment\`, \`@react-three/fiber\` or \`incanto\`? Keep it; never add a second 3D engine. A 3D game with none of those (nor \`three\`) uses Incanto — steps in AGENTS.md.

Violating any of 2–5 will either corrupt git state (rejected commit), desynchronize preview from repo (2 and 3), or silently lose the V8 metadata that Verse8 tooling depends on.`;

const BASE_TOOLS: Tool[] = [
  {
    name: "verse8_bootstrap",
    description:
      "CALL THIS FIRST at the start of ANY file-modifying or code-generating task — bug fix, feature add, performance tuning, refactor, build, deploy — BEFORE any Edit/Write/Bash/etc. It is a cheap (~10ms, no network) workspace classifier. Returns {workflow:{nextAction, nextTool, reason, instructions}, diagnostics, workspaceMode}. When the cwd is NOT a Verse8 project (no gitlab.verse8.io origin, no .verse8/project.json marker), `nextTool` is `null` and `instructions` tell you to proceed with your usual tools — safe to ignore the rest of the Verse8 MCP surface. When the cwd IS a Verse8 project, `nextTool` names the exact next tool (verse8_attach / verse8_login_start / etc.) — follow it verbatim. Also call this when the user mentions verse8 / gitlab.verse8.io / 버스8 or asks to create / preview a game in any workspace. Args: `userRequest` (user's verbatim message, echoed into instructions) and `projectDir` (override cwd).",
    inputSchema: zodToJsonSchema(bootstrapInputSchema),
  },
  {
    name: "verse8_login_start",
    description:
      "Call this when `workflow.nextTool` from verse8_bootstrap / verse8_status is 'verse8_login_start'. Begins Verse8 device-flow login (RFC 8628). Returns {verification_uri_complete, user_code, device_code, expires_in} IMMEDIATELY without polling. You MUST (1) show verification_uri_complete (or verification_uri when it is absent) and user_code to the user, (2) wait for browser approval, (3) call verse8_login_complete with the same device_code. Do NOT re-call verse8_login_start before completing — each call issues a fresh device_code.",
    inputSchema: zodToJsonSchema(loginStartInputSchema),
  },
  {
    name: "verse8_login_complete",
    description:
      "Finish Verse8 device-flow login. Polls the token endpoint for up to max_wait_seconds (default 120) and, on success, writes the access token to ${XDG_CONFIG_HOME:-~/.config}/verse8/token (mode 0600). Pass the device_code returned by verse8_login_start. Safe to call multiple times with the same device_code if the user is still authorizing — device_code is valid for ~30 minutes.",
    inputSchema: zodToJsonSchema(loginCompleteInputSchema),
  },
  {
    name: "verse8_logout",
    description:
      "Log out of Verse8 on this machine, or the first step of switching accounts (then verse8_login_start). Deletes the local token files: ${XDG_CONFIG_HOME:-~/.config}/verse8/token and `projectDir`/.verse8/token (default: the MCP server's cwd — pass `projectDir` when the project token file is in another folder, as the rejected-token hint says). Returns {projectDir, removed, left, serverSide}. Verse8 has no token revocation API, so the token stays valid on the server until it expires — tell the user. Returns {error:'logout_incomplete'} when a token is still in use afterwards (e.g. the VERSE8_ACCESS_TOKEN environment variable, which only the user can remove from the MCP server's env settings) or a token file could not be deleted or checked — `hint` says what the user has to remove.",
    inputSchema: zodToJsonSchema(logoutInputSchema),
  },
  {
    name: "verse8_status",
    description:
      "Return the current Verse8 profile via GET /v1/auth/verify plus the attachment state of `projectDir` (default: the MCP server's cwd) and `workflow.nextTool` routing. Returns {error:'not_logged_in'} when no token is available (and still provides a workflow pointing at verse8_login_start), {error:'token_invalid'} when the server rejected the token (the hint says which source to clear), and {error:'auth_check_unavailable'} when the check itself failed (not a rejection: retry, do not log out). Safe alternative to verse8_bootstrap when you also want profile + stale-preview + proxy info. Pass `projectDir` when the project is a subdirectory of the MCP server's cwd (otherwise the cwd is checked and reported as not a verse8 project).",
    inputSchema: zodToJsonSchema(statusInputSchema),
  },
  {
    name: "verse8_new_project_start",
    description:
      "Call this when `workflow.nextTool` from verse8_bootstrap / verse8_status is 'verse8_new_project_start'. Phase 1 of the Verse8 new-project flow — calls /api/startcall with the user's verbatim request and returns {templateName, repo, path, suggestedTitle, suggestedProjectRepo, nextActionSuggestion, startCallId}. Show the template to the user, wait for confirmation (or override title/projectRepo), THEN call verse8_new_project_confirm with the returned values verbatim. NEVER fabricate templateName/repo/path. DO NOT start generating game code directly — the Verse8 backend mints the project repo.",
    inputSchema: zodToJsonSchema(newProjectStartInputSchema),
  },
  {
    name: "verse8_new_project_confirm",
    description:
      "Phase 2 of the Verse8 new-project flow. Pass templateName/repo/path verbatim from verse8_new_project_start; plus title, projectRepo, and the returned startCallId. Creates the GitLab project, grants a 30-day token, clones the repo on branch `develop`, and installs the verse8 git hooks + AGENTS.md. Returns {projectDir, nextCallRequires:{projectDir}} — you MUST pass `projectDir` on every subsequent verse8_checkpoint / verse8_preview / image-proxy call in this session. On transient failures (token_grant_failed / clone_failed) the error envelope includes `projectPath`; retry by re-calling this tool with that `projectPath` to skip duplicate project creation.",
    inputSchema: zodToJsonSchema(newProjectConfirmInputSchema),
  },
  {
    name: "verse8_open_project",
    description:
      "Bring an EXISTING Verse8 game that is not cloned on this machine yet onto it to keep working locally — wherever it was made (the web editor, verse8_new_project_confirm on another machine, a local clone that was deleted). Pass `project` exactly as the user gave it: a project path like `owner/game-slug`, the web editor URL (`.../creator/editor?chat=owner/game-slug`), or a gitlab.verse8.io URL. Optional `targetDir` = parent folder (default: cwd). Grants a 30-day project token, clones branch `develop` into `<targetDir>/<slug>`, and installs the verse8 hooks + AGENTS.md (same as verse8_attach). Does NOT create a project — use verse8_new_project_start for a new game. Returns {projectDir, webEditor, nextCallRequires:{projectDir}} — pass `projectDir` on every later verse8_checkpoint / verse8_preview call. `clone_target_exists`: the folder is already there and was NOT overwritten — follow the hint (verse8_attach if it is the same project, else another targetDir). `token_check_failed` / `token_grant_failed` carry the backend's `status` and message: on a 4xx (e.g. the project belongs to someone else, or the token limit is reached) show the message to the user and do not retry — follow the hint; on a 5xx or a network error (`status` 0) you may retry once. `environment_mismatch`: the editor URL is from another Verse8 environment than this server.",
    inputSchema: zodToJsonSchema(openProjectInputSchema),
  },
  {
    name: "verse8_attach",
    description:
      "Call this when `workflow.nextTool` from verse8_bootstrap / verse8_status is 'verse8_attach' (typically: user cd'd into a freshly cloned gitlab.verse8.io repo that lacks hooks). Idempotent — safe to re-run. Installs pre-commit + commit-msg hooks, writes AGENTS.md / CLAUDE.md with the dynamic skills catalog, copies each bundled skill to `<projectDir>/.claude/skills/<name>/SKILL.md` (hash-fingerprinted so user edits survive re-attach), and ensures .verse8/project.json exists. Optional flags: `overwriteAgentsDoc`, `overwriteAllSkills`, `pruneOrphanedSkills` (deletes only our unedited SKILL.md of skills no longer bundled; other files in the folder stay), `overwriteEnv`. After attach, re-call verse8_bootstrap to confirm `nextAction === 'ready'` before implementing anything.",
    inputSchema: zodToJsonSchema(attachInputSchema),
  },
];

const CHECKPOINT_TOOL: Tool = {
  name: "verse8_checkpoint",
  description:
    "MANDATORY commit tool for Verse8 projects — NEVER use `git commit` via Bash (the installed commit-msg hook rejects non-V8 commits with exit 1). Stages `files` if provided else `git add -A` (with `stageAll: false` or VERSE8_CHECKPOINT_REQUIRE_FILES=1 it stages nothing and returns `files_required` + `changedFiles` — pass `files` when other sessions share the folder), builds a V8-format commit from your `userPrompt` + `model` + `provider` (+ optional `toolCalls`), and pushes to gitlab.verse8.io. **Always pass `problemStatement` (how you framed the user's ask) and `workSummary` (what you did)** — these are the narrative future agents read from `git log` to understand project history without re-parsing every tool payload. Call this whenever `verse8_bootstrap` returned `workflow.nextAction === \"ready\"` and the user's change is complete (or before launching verse8_preview).",
  inputSchema: zodToJsonSchema(checkpointInputSchema),
};

const PREVIEW_TOOL: Tool = {
  name: "verse8_preview",
  description:
    "MANDATORY dev-server launcher for Verse8 projects — NEVER use `bun run dev` / `vite` / any dev server via Bash. This tool bundles a verse8_checkpoint commit with the spawn so 'what the user sees == what is in git'. Sequence: (1) internal verse8_checkpoint with the V8 commit fields you pass (`userPrompt` / `model` / `provider` / `problemStatement` / `workSummary`); (2) preflight — `installCommand` (default `bun update`), and for Agent8 GameServer projects (detected via `server.ts` / `server.js` / `server/`) runs pinned `@agent8/gameserver-node build` + `@agent8/deploy --preview`; (3) spawn `bun run dev` detached on port 5173. Use this whenever the user should visually verify a change. Pass `startOnly: true` to skip the commit only (only when user asked to re-open preview without changes). Pass `skipPreflight: true` only if you already provisioned install/build/deploy. Response includes `webEditor.url` (https://create.verse8.io/creator/editor?chat=<projectPath>) on gitlab.verse8.io origins — show BOTH local preview URL AND web editor URL to the user. Errors: `preflight_failed` (dev server NOT started) / `dev_server_not_ready` (port never bound, log tail included).",
  inputSchema: zodToJsonSchema(previewInputSchema),
};

const UPLOAD_ASSET_TOOL: Tool = {
  name: "verse8_upload_asset",
  description:
    "Upload a local file (image / audio / video / 3D / font / small text) to the Verse8 CDN via agent8-backend /api/upload-attachment. Pass `filePath` (absolute or relative to projectDir) + `cdnPath` (relative subpath under the verse, e.g. 'assets/images' / 'assets/3d/characters' / 'assets/audio'). Returns `{ url, filename, cdnPath, verse, sizeBytes, contentType }` where `url` is the public https://agent8-games.verse8.io/<verse>/<cdnPath>/<server-assigned-filename>. IMPORTANT: the V8 asset convention is driven by `src/assets.json` — before calling this tool, read the project's manifest to match existing URL-path patterns (each template uses its own scheme such as `assets/3d/animations/mixamorig/`); and AFTER upload, register the returned url into `src/assets.json` so it is actually consumed by the runtime. Allowed extensions: png/jpg/jpeg/gif/svg/webp/glb/gltf/vrm/mp3/wav/ogg/m4a/mp4/webm/mov/ttf/otf/woff/woff2/txt/md/json/csv/xml. Requires a logged-in Verse8 project run through `verse8_attach` (uses VITE_AGENT8_VERSE from .env).",
  inputSchema: zodToJsonSchema(uploadAssetInputSchema),
};

export const DEPLOY_TOOL: Tool = {
  name: "verse8_deploy",
  description:
    "Publish the Verse8 project to production — use whenever the user asks to deploy / publish / launch / ship / 배포 / 출시 / 게시. NEVER run a deploy command via Bash. Auto-detects first deploy vs update. Sequence: (1) verse8_checkpoint (same V8 commit fields); (2) uploads `thumbnailPath` / `videoPath`; (3) rm -rf dist → `installCommand` (default `bun update`) → `bun run build --base ./` → gameserver build; (4) `@agent8/deploy --prod`; (5) POST the verse record (create / update). Required as in the web publish dialog: first deploy needs `title` (4–50), `tags` (1–5), a cover (`thumbnailPath` or `imageUrl`) and a release note; EVERY deploy needs `releaseNoteTitle` + `releaseNoteTypes` + `releaseNoteDescription`; on update omitted fields keep their values. ALWAYS call with `dryRun: true` first. If it returns `invalid_input` with `missing`, do not quiz the user — draft every value from the project (release note from `suggestedReleaseNote`, cover via image_asset_generate) and re-run dryRun. If the dryRun returns `warnings`, show them to the user and confirm before deploying. First deploy: show the user that one result (`mode` + `publishBody`) and deploy only after they approve. Update: with no warnings, deploy right away (title/cover/tags stay, only the release note is new) and report playUrl + release note. If dryRun says `runCondition: user_confirm` (visibility widens: first deploy unless Private, update towards Public), the host asks the user and it runs only on their Run; `user_cancelled` / `confirm_unavailable` = nothing deployed, relay the hint. MSU projects get `__MSU` + `__review_required` tags, Nine Chronicles `__9C` + `__review_required`. The verse id never changes (VX Shop products / gameserver state are keyed by it); `verse_owned_by_other` / `verse_id_unavailable` stop with a hint. `plugin_shim_missing`: the build references `DebugPanel` without the web editor's publish shim; game files are not uploaded; the checkpoint push and cover upload are already done (remove the reference, or publish from the web editor).",
  inputSchema: zodToJsonSchema(deployInputSchema),
};

export const GAMESERVER_TOOL: Tool = {
  name: "verse8_gameserver",
  description:
    "Read this project's game server — READ-ONLY (no writes, no deploys). Pick `target`: prod (the published game) or preview (what verse8_preview deployed). Actions: status (v1/v2, state, players, rooms); collections / items (Firestore collections of `$collection`, paged with cursor, optional equality search by `field`+`value`); users / user / global (user, asset and global state); errors and logs (v2 servers only: recent error lines, or recent + live console output for a few seconds). Use it to check what the server stored or why a server function failed, instead of adding an admin-only server function. Results can include other players' wallet addresses and state — show the user only what they asked for. Requires the Verse8 login of the verse owner.",
  inputSchema: zodToJsonSchema(gameserverInputSchema),
};

export const DEPLOY_STATUS_TOOL: Tool = {
  name: "verse8_deploy_status",
  description:
    "READ-ONLY: what is live for this project's verse. Returns the published commit (`publishedSha`, `publishedAt` from the live playUrl), title / visibility / review status, the latest release note (buildVersion, types, date, review status), how the local checkout relates to the published commit (HEAD, whether HEAD contains it, commits since, uncommitted paths), and the prod / preview game server version and state. Use it to answer \"is this commit live?\" or \"when was it published?\" before or after verse8_deploy. The game server's own upload time is not available from any API (said in the answer).",
  inputSchema: zodToJsonSchema(deployStatusInputSchema),
};

export const VERSE_OPS_TOOL: Tool = {
  name: "verse8_verse",
  description:
    "Creator-page operations on a published Verse8 game, without a rebuild. Read: get (listing, visibility, review status, latest release note), mine (your games, with review status), release_notes (history), analytics (DAU / MAU / sessions summary and charts). Change: update (title, short description, description, tags, cover image, preview video, remix / mobile / orientation flags, visibility; local files are uploaded) and release_note_update (title, types, body, image of an existing note — only its author may). Comments: comments (list), comment_pin (pin / unpin), comment_delete (irreversible; asks the user like a widening update, below). Changing actions PREVIEW by default: they return `changes` and a `planId` and change nothing. Show the preview to the user; after they approve, call again with the same arguments plus that planId. It runs only if nothing changed since the preview — otherwise `plan_mismatch` (says what changed): preview again. An update that widens visibility (Private → Unlisted / Public, Unlisted → Public; preview says `runCondition: user_confirm`) also opens the host's own confirmation prompt when called with the planId and runs only if the user chooses Run there and nothing changed meanwhile; `user_cancelled` / `confirm_unavailable` mean nothing changed — relay the hint, do not retry. update keeps the current visibility unless `visibility` is given (making a Private game visible can start a review that keeps it hidden) and never creates a release note or notifies followers. To ship new game code use verse8_deploy instead.",
  inputSchema: zodToJsonSchema(verseOpsInputSchema),
};

export const VXSHOP_TOOL: Tool = {
  name: "verse8_vxshop",
  description:
    "VX Shop items of this project's verse (the creator page's VX Shop tab). list: seller approval + items with their purchase limits. sales: purchases and disputes. revenue: VX totals / refunds for a period. archive: archive / restore an item. dispute: answer a buyer dispute (the buyer is notified; no refund). upsert: create an item (productId, name, price in VX, stock required; created hidden unless isActive) or edit one by itemId (name, price, stock, image, description, metadata object, purchase limits, on-sale flag). upsert, archive and dispute PREVIEW by default (`changes` / `body` and a `planId`) and change nothing — price and on-sale changes affect real purchases, so show the preview to the user; after they approve, call again with the same arguments plus that planId. It runs only if nothing changed since the preview — otherwise `plan_mismatch` (says what changed): preview again. Starting a sale (an edit that puts the item on sale: on-sale flag, restore, sale dates, or stock from 0 on an item on sale; stock 0 does not take an item off sale) and repricing an item on sale or scheduled (preview says `runCondition: user_confirm`) also open the host's own confirmation prompt when called with the planId, and run only if the user chooses Run there and nothing changed meanwhile; `user_cancelled` / `confirm_unavailable` mean nothing changed — relay the hint, do not retry. Editing keeps the current purchase limits unless you change or clear them. Refused when the account is not an approved VX seller. The game's code sells an item by its productId.",
  inputSchema: zodToJsonSchema(vxShopInputSchema),
};

const UPLOAD_THUMBNAIL_TOOL: Tool = {
  name: "verse8_upload_thumbnail",
  description:
    "Upload a verse cover image (png/jpg/jpeg/gif/webp, ≤4 MB) or preview video (mp4, ≤10 MiB) to contents.verse8.io via verse8.io /api/upload — the same storage the web publish dialog uses. Returns {url, kind}. Pass the url to verse8_deploy as `imageUrl` / `videoUrl` (or give verse8_deploy `thumbnailPath` / `videoPath` directly). This is for the verse's store listing, NOT in-game assets — use verse8_upload_asset for those.",
  inputSchema: zodToJsonSchema(uploadThumbnailInputSchema),
};

function imageToolToMcpTool(t: UpstreamTool): Tool {
  return {
    name: t.name,
    description: t.description || `Verse8 image MCP: ${t.name}`,
    inputSchema:
      (t.inputSchema as Tool["inputSchema"]) ?? {
        type: "object",
        additionalProperties: true,
      },
  };
}

function jsonContent(value: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/**
 * How long a confirmation prompt may stay open. The SDK's default request
 * timeout (60 s) is shorter than a person reading a price; past this the
 * request fails and nothing runs.
 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

export function createServer(): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      // listChanged:true tells clients to re-request tools/list when the
      // server emits `notifications/tools/list_changed`. The set of
      // verse8 tools surfaced depends on (a) cwd being a verse project
      // and (b) a valid token — both of which can flip mid-session
      // after verse8_attach / verse8_login_complete / verse8_new_project_confirm /
      // verse8_open_project.
      tools: { listChanged: true },
      resources: {},
      prompts: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  });

  // Fire a tools/list_changed notification when the dynamic tool set
  // may have changed. Best-effort — a failed notify must never break
  // the tool call. Guarded by a try/catch because sendToolListChanged
  // throws on transports that aren't connected yet.
  const notifyToolListChanged = (): void => {
    Promise.resolve(server.sendToolListChanged()).catch(() => {
      /* best-effort; client will refresh on next tools/list anyway */
    });
  };

  // The user confirmation of the plan gate (creatorOps RUN_RULES): the
  // prompt is an MCP elicitation the host shows in its own UI, and the
  // answer comes back on this connection, not through the agent. A host
  // that did not declare elicitation at initialize cannot be asked.
  // `signal` is the tool call's own: the SDK aborts it when the host cancels
  // the call. The prompt is withdrawn with it, and an answer that still
  // arrives afterwards is not used.
  // The form capability is what the prompt needs (a host that declares only
  // url elicitation cannot show it; the SDK reads an empty declaration as
  // form). The request is sent as it is, not through the SDK's
  // elicitInput: that helper throws when an accepted answer does not fit
  // the form (a third choice, no choice), which would be reported as "the
  // prompt could not be shown" although the user did answer. The gate reads
  // the raw answer and runs only on the Run choice.
  const confirmHostFor = (signal: AbortSignal): ConfirmHost => ({
    get canAsk() {
      return server.getClientCapabilities()?.elicitation?.form !== undefined;
    },
    ask: (message, requestedSchema) =>
      server.request(
        { method: "elicitation/create", params: { mode: "form", message, requestedSchema } },
        ElicitResultSchema,
        { timeout: CONFIRM_TIMEOUT_MS, signal },
      ),
    isCancelled: () => signal.aborted,
  });

  // tools/list — re-evaluate token every call so project-scoped tools
  // appear as soon as the user logs in (no server restart needed).
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cwd = process.cwd();
    const token = loadToken(cwd);

    const tools: Tool[] = [...BASE_TOOLS];

    if (token) {
      // INV-11: Tool discovery is token-gated, not cwd-gated
      tools.push({
        name: "verse8_ip_assets",
        description: "Invoke an authorized native A2A IP asset pool using your Verse8 login. Requires operator-configured VERSE8_TOKEN_EXCHANGE_URL and VERSE8_A2A_BASE_URL. Methods: message/send or message/stream with text; tasks/get, tasks/cancel or tasks/resubscribe with taskId. Preserve returned taskId/contextId for continuation and messageId for correlation. Inline files are saved under projectDir/.verse8/ip-assets; provider URLs are never fetched. message/send requests early acknowledgement. Use tasks/get for pending assets. On interruption without a taskId, keep the messageId for operator lookup. Never automatically resend a message.",
        inputSchema: zodToJsonSchema(ipAssetsInputSchema),
      });
      tools.push(CHECKPOINT_TOOL);
      tools.push(PREVIEW_TOOL);
      tools.push(UPLOAD_ASSET_TOOL);
      tools.push(UPLOAD_THUMBNAIL_TOOL);
      tools.push(DEPLOY_TOOL);
      tools.push(GAMESERVER_TOOL);
      tools.push(DEPLOY_STATUS_TOOL);
      tools.push(VERSE_OPS_TOOL);
      tools.push(VXSHOP_TOOL);
      const imageTools = await discoverImageTools(token);
      for (const t of imageTools) {
        tools.push(imageToolToMcpTool(t));
      }
    }

    return { tools };
  });

  // tools/call — re-validate on invocation and record to the V8 call log
  // (consumed by verse8_checkpoint when the LLM omits explicit toolCalls).
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    const cwd = process.cwd();
    // verse8_checkpoint is the consumer of the log; don't record itself.
    const shouldLog = name !== "verse8_checkpoint";

    const result = await (async () => {
    try {
      if (name === "verse8_bootstrap") {
        const parsed = bootstrapInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(
          name,
          () => runBootstrap(parsed, cwd),
          { projectDir: pd },
        );
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_login_start") {
        loginStartInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () => runLoginStart());
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_login_complete") {
        const parsed = loginCompleteInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () => runLoginComplete(parsed, cwd));
        // Token state likely changed → re-enumerate tools so
        // verse8_checkpoint / verse8_preview / image_* surface.
        if (result.ok) notifyToolListChanged();
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_logout") {
        const parsed = logoutInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () => runLogout(parsed, cwd), {
          projectDir: parsed.projectDir ?? cwd,
        });
        // Token state changed → the logged-in tools must drop out of the list.
        if (result.removed.length > 0) notifyToolListChanged();
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_status") {
        const parsed = statusInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runStatus(pd), {
          projectDir: pd,
        });
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_new_project_start") {
        const parsed = newProjectStartInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () =>
          runNewProjectStart(parsed, cwd),
        );
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_new_project_confirm") {
        const parsed = newProjectConfirmInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () =>
          runNewProjectConfirm(parsed, cwd),
        );
        // Project was just created + cloned + attached; tool surface
        // may have expanded (preview/checkpoint/image_* if token was
        // minted during confirm).
        if (result.ok) notifyToolListChanged();
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_open_project") {
        const parsed = openProjectInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () =>
          runOpenProject(parsed, cwd),
        );
        // Cloned + attached, same as new_project_confirm.
        if (result.ok) notifyToolListChanged();
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_attach") {
        const parsed = attachInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runAttach(parsed, cwd), {
          projectDir: pd,
        });
        // Attachment state flipped → bootstrap routing changes and
        // verse8_checkpoint/preview become callable. Nudge the client.
        if (result.ok) notifyToolListChanged();
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_checkpoint") {
        const parsed = checkpointInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(
          name,
          () => runCheckpoint(parsed, cwd),
          { projectDir: pd },
        );
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_preview") {
        const parsed = previewInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runPreview(parsed, cwd), {
          projectDir: pd,
        });
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_upload_asset") {
        const parsed = uploadAssetInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(
          name,
          () => runUploadAsset(parsed, cwd),
          { projectDir: pd },
        );
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_upload_thumbnail") {
        const parsed = uploadThumbnailInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(
          name,
          () => runUploadThumbnail(parsed, cwd),
          { projectDir: pd },
        );
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_deploy") {
        const parsed = deployInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runDeploy(parsed, cwd, confirmHostFor(extra.signal)), {
          projectDir: pd,
        });
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_gameserver") {
        const parsed = gameserverInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runGameserver(parsed, cwd), { projectDir: pd });
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_deploy_status") {
        const parsed = deployStatusInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runDeployStatus(parsed, cwd), { projectDir: pd });
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_verse") {
        const parsed = verseOpsInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runVerseOps(parsed, cwd, confirmHostFor(extra.signal)), { projectDir: pd });
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_vxshop") {
        const parsed = vxShopInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runVxShop(parsed, cwd, confirmHostFor(extra.signal)), { projectDir: pd });
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_ip_assets") {
        const parsed = ipAssetsInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () => runIpAssets(parsed, cwd), { projectDir: parsed.projectDir ?? cwd });
        return { content: jsonContent(result), isError: !result.ok };
      }

      // Image proxy fallthrough — gated on token only.
      const token = loadToken(cwd);
      if (!token) {
        return {
          content: jsonContent({
            error: "not_logged_in",
            hint: LOGIN_HINT,
          }),
          isError: true,
        };
      }

      const imageTools = await discoverImageTools(token);
      const match = imageTools.find((t) => t.name === name);
      if (!match) {
        // Tool name is attacker-controllable; redact via safeHint (US-M0-2).
        return {
          content: jsonContent({
            error: "unknown_tool",
            hint: safeHint(`tool '${name}' is not registered`),
          }),
          isError: true,
        };
      }

      const resp = await dispatchTool(name, () =>
        callImageTool(name, args ?? {}, token),
      );
      if (!resp.ok) {
        return { content: jsonContent(resp), isError: true };
      }
      const upstream = resp.result as
        | { content?: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean }
        | null
        | undefined;
      if (upstream && Array.isArray(upstream.content)) {
        return {
          content: upstream.content as any,
          isError: upstream.isError === true,
        };
      }
      return { content: jsonContent(resp.result) };
    } catch (e) {
      // Redact thrown errors before they reach the LLM host (US-M0-2).
      return {
        content: jsonContent({
          error: "tool_exception",
          hint: safeErrorHint(e),
        }),
        isError: true,
      };
    }
    })();

    if (shouldLog) {
      try {
        let compactOutput: unknown;
        if (result && Array.isArray((result as any).content)) {
          const first = (result as any).content[0];
          if (first && typeof first.text === "string") {
            const text = first.text;
            // Attempt structured output first; fall back to trimmed text.
            try {
              compactOutput = JSON.parse(text);
            } catch {
              // INV-13: redact before the cut (the call log redacts again,
              // but a shape already cut there no longer matches).
              compactOutput = text.length > 500 ? redactHead(text, 500) + "…" : text;
            }
          }
        }
        // Skip schema/dispatch failures to avoid polluting the call-log bucket.
        const outErr =
          compactOutput && typeof compactOutput === "object"
            ? (compactOutput as { error?: unknown }).error
            : undefined;
        const skipTypes = new Set(["tool_exception", "unknown_tool"]);
        if (typeof outErr === "string" && skipTypes.has(outErr)) {
          return result;
        }
        // Bucket by args.projectDir (else cwd) to match checkpoint drain key.
        const argProjectDir =
          args && typeof (args as Record<string, unknown>).projectDir === "string"
            ? ((args as Record<string, unknown>).projectDir as string)
            : undefined;
        recordToolCall({
          projectDir: argProjectDir ?? cwd,
          name,
          status: (result as any)?.isError ? "error" : "completed",
          input: args,
          output: compactOutput,
          timestampMs: Date.now(),
        });
      } catch {
        /* recording is best-effort; never break the tool call */
      }
    }

    return result;
  });

  // resources/list
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = listSkillResources().map((r) => ({
      uri: r.uri,
      name: r.name,
      title: r.title,
      description: r.description,
      mimeType: r.mimeType,
    }));
    return { resources };
  });

  // resources/read
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const read = readSkillResource(uri);
    if (!read.ok) {
      // Redact hint before returning in contents[] envelope (US-M0-2).
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ error: read.error, hint: safeHint(read.hint) }),
          },
        ],
      };
    }
    return {
      contents: [
        {
          uri: read.uri,
          mimeType: read.mimeType,
          text: read.text,
        },
      ],
    };
  });

  // prompts/list — surfaces as `/verse8:<name>` slash commands in Claude Code.
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        bootstrapPrompt,
        attachPrompt,
        statusPrompt,
        newProjectBootstrapPrompt,
      ],
    };
  });

  // prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    try {
      const name = req.params.name;
      if (name === bootstrapPrompt.name) return getBootstrapPrompt();
      if (name === attachPrompt.name) return getAttachPrompt();
      if (name === statusPrompt.name) return getStatusPrompt();
      if (name === newProjectBootstrapPrompt.name) {
        return getNewProjectBootstrapPrompt();
      }
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: JSON.stringify({
                error: "unknown_prompt",
                hint: safeHint(`prompt '${name}' is not registered`),
              }),
            },
          },
        ],
      };
    } catch (e) {
      // Redact prompt builder errors (US-M0-2).
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: JSON.stringify({
                error: "prompt_exception",
                hint: safeErrorHint(e),
              }),
            },
          },
        ],
      };
    }
  });

  return server;
}
