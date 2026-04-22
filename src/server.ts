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

const SERVER_INFO = {
  name: "@verse8/mcp",
  version: "0.5.1",
};

const BASE_TOOLS: Tool[] = [
  {
    name: "verse8_bootstrap",
    description:
      "CALL THIS FIRST whenever the user mentions verse8, asks to create / modify / preview a Verse8 game, or you see a gitlab.verse8.io repo. Returns {workflow:{nextAction, nextTool, reason, instructions}, diagnostics, workspaceMode}. The `nextTool` field names the exact Verse8 tool you MUST call next — follow it verbatim and honor `workflow.instructions`. Do NOT generate game code, edit files, or guess a workflow before calling this tool. Optional args: `userRequest` (user's verbatim message, echoed back into instructions) and `projectDir` (override cwd).",
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
    "Commit + push the current working tree to origin (gitlab.verse8.io). Stages `files` if provided, otherwise `git add -A` (verse8 projects commit .env by convention). Pass `userPrompt` + `model` + `provider` (+ optional `toolCalls`) to produce a V8-format commit message; file changes are captured automatically from the staged diff. **Always pass `problemStatement` (how you framed the user's ask) and `workSummary` (what you did at a high level)** — these are the narrative future agents read from `git log` to understand project history without re-parsing every tool payload.",
  inputSchema: zodToJsonSchema(checkpointInputSchema),
};

const PREVIEW_TOOL: Tool = {
  name: "verse8_preview",
  description:
    "Atomic commit + preflight + Vite dev-server launch for verse8 (Vite + Bun) projects. Sequence: (1) verse8_checkpoint with the V8 commit fields you pass (same `userPrompt` / `model` / `provider` / `problemStatement` / `workSummary` semantics as verse8_checkpoint); (2) preflight — runs `installCommand` (default `bun update`) and, when this is an Agent8 GameServer project (presence of `server.ts`, `server.js`, or a `server/` directory triggers detection), runs `npx -y @agent8/gameserver-node build` followed by `npx -y @agent8/deploy --preview` so the locally-running client has a freshly-deployed server to talk to; (3) spawn `bun run dev` detached on port 5173 (configurable). Use this — NOT a separate Bash `bun run dev` — whenever the user should visually verify the change. Pass `startOnly: true` to skip the commit AND preflight (only if the user asked to re-open the preview without changes). Pass `skipPreflight: true` only if you've already provisioned the install/build/deploy yourself. Response envelope includes `webEditor.url` (https://create.verse8.io/creator/editor?chat=<projectPath>) when the origin is a gitlab.verse8.io repo — show BOTH the local preview URL AND the web editor URL to the user. If a preflight step fails the tool returns `preflight_failed` with the failed step + stderr tail (dev server not started). If the dev server fails to bind within `readinessTimeoutMs` (default 15s) the tool returns `dev_server_not_ready` with the log tail.",
  inputSchema: zodToJsonSchema(previewInputSchema),
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
      tools: {},
      resources: {},
      prompts: {},
    },
  });

  // tools/list — re-evaluate token every call so project-scoped tools
  // appear as soon as the user logs in (no server restart needed).
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cwd = process.cwd();
    const token = loadToken(cwd);

    const tools: Tool[] = [...BASE_TOOLS];

    if (token) {
      tools.push(CHECKPOINT_TOOL);
      tools.push(PREVIEW_TOOL);
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
        return { content: jsonContent(result), isError: !result.ok };
      }

      if (name === "verse8_attach") {
        const parsed = attachInputSchema.parse(args ?? {});
        const pd = parsed.projectDir ?? cwd;
        const result = await dispatchTool(name, () => runAttach(parsed, cwd), {
          projectDir: pd,
        });
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

  // prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: [newProjectBootstrapPrompt] };
  });

  // prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    try {
      if (req.params.name !== newProjectBootstrapPrompt.name) {
        return {
          messages: [
            {
              role: "assistant",
              content: {
                type: "text",
                text: JSON.stringify({
                  error: "unknown_prompt",
                  hint: safeHint(`prompt '${req.params.name}' is not registered`),
                }),
              },
            },
          ],
        };
      }
      return getNewProjectBootstrapPrompt();
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
