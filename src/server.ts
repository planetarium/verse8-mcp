import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./util/jsonSchema.js";
import { recordToolCall } from "./util/v8CallLog.js";
import { safeErrorHint, safeHint } from "./util/redact.js";
import { dispatchTool } from "./util/toolDispatch.js";
import { loadToken } from "./context/token.js";
import { attachInputSchema, runAttach } from "./tools/attach.js";
import { bootstrapInputSchema, runBootstrap } from "./tools/bootstrap.js";
import {
  checkpointInputSchema,
  runCheckpoint,
} from "./tools/checkpoint.js";
import { previewInputSchema, runPreview } from "./tools/preview.js";
import {
  runUploadAsset,
  uploadAssetInputSchema,
} from "./tools/uploadAsset.js";
import {
  loginCompleteInputSchema,
  loginStartInputSchema,
  runLoginComplete,
  runLoginStart,
} from "./tools/login.js";
import {
  newProjectConfirmInputSchema,
  newProjectStartInputSchema,
  runNewProjectConfirm,
  runNewProjectStart,
} from "./tools/newProject.js";
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
  version: "0.5.6",
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
      "Call this when `workflow.nextTool` from verse8_bootstrap / verse8_status is 'verse8_login_start'. Begins Verse8 device-flow login (RFC 8628). Returns {verification_uri_complete, user_code, device_code, expires_in} IMMEDIATELY without polling. You MUST (1) show verification_uri_complete and user_code to the user, (2) wait for browser approval, (3) call verse8_login_complete with the same device_code. Do NOT re-call verse8_login_start before completing — each call issues a fresh device_code.",
    inputSchema: zodToJsonSchema(loginStartInputSchema),
  },
  {
    name: "verse8_login_complete",
    description:
      "Finish Verse8 device-flow login. Polls the token endpoint for up to max_wait_seconds (default 120) and, on success, writes the access token to ${XDG_CONFIG_HOME:-~/.config}/verse8/token (mode 0600). Pass the device_code returned by verse8_login_start. Safe to call multiple times with the same device_code if the user is still authorizing — device_code is valid for ~30 minutes.",
    inputSchema: zodToJsonSchema(loginCompleteInputSchema),
  },
  {
    name: "verse8_status",
    description:
      "Return the current Verse8 profile via GET /v1/auth/verify plus cwd attachment state and `workflow.nextTool` routing. Returns {error:'not_logged_in'} when no token is available (and still provides a workflow pointing at verse8_login_start). Safe alternative to verse8_bootstrap when you also want profile + stale-preview + proxy info.",
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
    name: "verse8_attach",
    description:
      "Call this when `workflow.nextTool` from verse8_bootstrap / verse8_status is 'verse8_attach' (typically: user cd'd into a freshly cloned gitlab.verse8.io repo that lacks hooks). Idempotent — safe to re-run. Installs pre-commit + commit-msg hooks, writes AGENTS.md / CLAUDE.md with the dynamic skills catalog, copies each bundled skill to `<projectDir>/.claude/skills/<name>/SKILL.md` (hash-fingerprinted so user edits survive re-attach), and ensures .verse8/project.json exists. Optional flags: `overwriteAgentsDoc`, `overwriteAllSkills`, `pruneOrphanedSkills` (removes only files bearing our hash marker), `overwriteEnv`. After attach, re-call verse8_bootstrap to confirm `nextAction === 'ready'` before implementing anything.",
    inputSchema: zodToJsonSchema(attachInputSchema),
  },
];

const CHECKPOINT_TOOL: Tool = {
  name: "verse8_checkpoint",
  description:
    "MANDATORY commit tool for Verse8 projects — NEVER use `git commit` via Bash (the installed commit-msg hook rejects non-V8 commits with exit 1). Stages `files` if provided else `git add -A`, builds a V8-format commit from your `userPrompt` + `model` + `provider` (+ optional `toolCalls`), and pushes to gitlab.verse8.io. **Always pass `problemStatement` (how you framed the user's ask) and `workSummary` (what you did)** — these are the narrative future agents read from `git log` to understand project history without re-parsing every tool payload. Call this whenever `verse8_bootstrap` returned `workflow.nextAction === \"ready\"` and the user's change is complete (or before launching verse8_preview).",
  inputSchema: zodToJsonSchema(checkpointInputSchema),
};

const PREVIEW_TOOL: Tool = {
  name: "verse8_preview",
  description:
    "MANDATORY dev-server launcher for Verse8 projects — NEVER use `bun run dev` / `vite` / any dev server via Bash. This tool bundles a verse8_checkpoint commit with the spawn so 'what the user sees == what is in git'. Sequence: (1) internal verse8_checkpoint with the V8 commit fields you pass (`userPrompt` / `model` / `provider` / `problemStatement` / `workSummary`); (2) preflight — `installCommand` (default `bun update`), and for Agent8 GameServer projects (detected via `server.ts` / `server.js` / `server/`) runs pinned `@agent8/gameserver-node build` + `@agent8/deploy --preview`; (3) spawn `bun run dev` detached on port 5173. Use this whenever the user should visually verify a change. Pass `startOnly: true` to skip commit AND preflight (only when user asked to re-open preview without changes). Pass `skipPreflight: true` only if you already provisioned install/build/deploy. Response includes `webEditor.url` (https://create.verse8.io/creator/editor?chat=<projectPath>) on gitlab.verse8.io origins — show BOTH local preview URL AND web editor URL to the user. Errors: `preflight_failed` (dev server NOT started) / `dev_server_not_ready` (port never bound, log tail included).",
  inputSchema: zodToJsonSchema(previewInputSchema),
};

const UPLOAD_ASSET_TOOL: Tool = {
  name: "verse8_upload_asset",
  description:
    "Upload a local file (image / audio / video / 3D / font / small text) to the Verse8 CDN via agent8-backend /api/upload-attachment. Pass `filePath` (absolute or relative to projectDir) plus EITHER `category` (`bgm` / `sfx` / `image` / `effect` — maps to assets/audio/bgm, assets/audio/sfx, assets/images, assets/effects) OR `cdnPath` (relative subpath, e.g. 'assets/custom'). Returns `{ url, filename, cdnPath, verse, sizeBytes, contentType }` where `url` is the public https://agent8-games.verse8.io/<verse>/<cdnPath>/<server-assigned-filename>. Allowed extensions: png/jpg/jpeg/gif/svg/webp/glb/gltf/vrm/mp3/wav/ogg/m4a/mp4/webm/mov/ttf/otf/woff/woff2/txt/md/json/csv/xml. Requires a logged-in Verse8 project that has already been run through `verse8_attach` (uses VITE_AGENT8_VERSE from .env).",
  inputSchema: zodToJsonSchema(uploadAssetInputSchema),
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

export function createServer(): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      // listChanged:true tells clients to re-request tools/list when the
      // server emits `notifications/tools/list_changed`. The set of
      // verse8 tools surfaced depends on (a) cwd being a verse project
      // and (b) a valid token — both of which can flip mid-session
      // after verse8_attach / verse8_login_complete / verse8_new_project_confirm.
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

  // tools/list — re-evaluate token every call so project-scoped tools
  // appear as soon as the user logs in (no server restart needed).
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cwd = process.cwd();
    const token = loadToken(cwd);

    const tools: Tool[] = [...BASE_TOOLS];

    if (token) {
      tools.push(CHECKPOINT_TOOL);
      tools.push(PREVIEW_TOOL);
      tools.push(UPLOAD_ASSET_TOOL);
      const imageTools = await discoverImageTools(token);
      for (const t of imageTools) {
        tools.push(imageToolToMcpTool(t));
      }
    }

    return { tools };
  });

  // tools/call — re-validate on invocation and record to the V8 call log
  // (consumed by verse8_checkpoint when the LLM omits explicit toolCalls).
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
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
        const result = await dispatchTool(name, () => runLoginComplete(parsed));
        // Token state likely changed → re-enumerate tools so
        // verse8_checkpoint / verse8_preview / image_* surface.
        if (result.ok) notifyToolListChanged();
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_status") {
        statusInputSchema.parse(args ?? {});
        const result = await dispatchTool(name, () => runStatus(cwd), {
          projectDir: cwd,
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

      // Image proxy fallthrough — gated on token only.
      const token = loadToken(cwd);
      if (!token) {
        return {
          content: jsonContent({
            error: "not_logged_in",
            hint: "call verse8_login_start (then verse8_login_complete) or run: bash scripts/verse8-login.sh",
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
              compactOutput = text.length > 500 ? text.slice(0, 500) + "…" : text;
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
