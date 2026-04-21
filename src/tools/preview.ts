import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createConnection } from "node:net";
import * as path from "node:path";
import { z } from "zod";
import { parseOverrideHost } from "../util/hostAllowlist.js";
import { sanitizeChildEnv } from "../util/childEnv.js";
import { resolveAgent8Pin } from "../util/gameserverPin.js";
import {
  checkpointInputSchema,
  runCheckpoint,
  type CheckpointResult,
} from "./checkpoint.js";
import { isSafeAbsPath } from "../util/safePath.js";

export const previewInputSchema = z
  .object({
    // V8 commit fields — mirrored from checkpointInputSchema so agents can
    // call this tool exactly like verse8_checkpoint.
    files: z.array(z.string().min(1)).optional(),
    projectDir: z
      .string()
      .min(1)
      .refine(isSafeAbsPath, {
        message:
          "projectDir must not contain `..`, NUL byte, or redundant separators (rejected at MCP dispatch boundary)",
      })
      .optional(),
    userPrompt: z.string().min(1).optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    mcpServers: z.array(z.string()).optional(),
    reasoning: z.string().optional(),
    problemStatement: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Mirrored from verse8_checkpoint. 1–3 sentences describing how you interpreted the user's request this turn. Required for history continuity.",
      ),
    workSummary: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Mirrored from verse8_checkpoint. 1–5 sentences describing what you did this turn. Required for history continuity.",
      ),
    toolCalls: z
      .array(
        z
          .object({
            name: z.string().min(1),
            status: z.enum(["completed", "error"]).optional(),
            input: z.unknown().optional(),
            output: z.unknown().optional(),
          })
          .strict(),
      )
      .optional(),
    useAutoToolLog: z.boolean().default(true),
    message: z.string().min(1).optional(),
    skipAttachCheck: z.boolean().default(false),

    // Preview-specific
    previewCommand: z
      .string()
      .default("bun run dev")
      .describe(
        "Shell command to launch the Vite dev server. Verse8 default is `bun run dev`. Override only when the project overrides it in package.json.",
      ),
    previewPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(5173)
      .describe("Vite dev server port. Default 5173."),
    logPath: z
      .string()
      .default(".verse8/preview.log")
      .describe(
        "Relative path (from projectDir) where preview stdout/stderr will be written. Appended to.",
      ),
    startOnly: z
      .boolean()
      .default(false)
      .describe(
        "If true, skip the checkpoint step and just probe / start the preview. Use when the user explicitly asked to 'open the preview again' without code changes.",
      ),
    readinessTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120_000)
      .default(15_000)
      .describe(
        "Max time (ms) to wait for the dev server to bind the preview port after spawn. Default 15000 (Vite cold boot with tsx). If the port never binds (or the child exits), the tool returns dev_server_not_ready with the log tail instead of lying about a running server.",
      ),
    installCommand: z
      .string()
      .min(1)
      .default("bun update")
      .describe(
        "Preflight install/sync command run BEFORE the dev server spawns. Default `bun update`. Override per-project (e.g. `npm install`, `pnpm install`). Runs blocking; failure aborts the preview before the server starts.",
      ),
    skipPreflight: z
      .boolean()
      .default(false)
      .describe(
        "When true, skip the install + (when gameserver project) gameserver build + deploy preflight. Use only when you've just run those steps yourself or are working offline. Default false runs the full preflight.",
      ),
    preflightTimeoutMs: z
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(180_000)
      .describe(
        "Per-step timeout (ms) for each preflight command. Default 180000 (3 min) — `bun install` cold caches and `gameserver-node build` can take a while.",
      ),
  })
  .strict();

export type PreviewInput = z.infer<typeof previewInputSchema>;

export interface WebEditorLink {
  url: string;
  projectPath: string;
}

export interface PreflightStepResult {
  command: string;
  durationMs: number;
  exitCode: number;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface PreflightSummary {
  ran: boolean;
  gameserver: boolean;
  steps: PreflightStepResult[];
  skipReason?: "skipPreflight_flag";
}

export type PreviewResult =
  | {
      ok: true;
      commit: CheckpointResult | null;
      preflight: PreflightSummary;
      preview:
        | {
            status: "started";
            url: string;
            pid: number | undefined;
            command: string;
            logPath: string;
          }
        | {
            status: "already_running";
            url: string;
          };
      webEditor: WebEditorLink | null;
    }
  | {
      ok: false;
      stage: "checkpoint";
      checkpoint: CheckpointResult;
      hint: string;
    }
  | {
      ok: false;
      stage: "preflight_failed";
      hint: string;
      failedStep: PreflightStepResult;
      stepsCompleted: PreflightStepResult[];
      gameserver: boolean;
    }
  | {
      ok: false;
      stage: "preview_spawn_failed";
      error: string;
      hint: string;
      command: string;
    }
  | {
      ok: false;
      stage: "dev_server_not_ready";
      error: "dev_server_not_ready" | "dev_server_exited";
      hint: string;
      command: string;
      pid: number | undefined;
      logPath: string;
      logTail: string;
      exitCode: number | null;
    };

const DEFAULT_CREATE_URL = "https://create.verse8.io";

function isAllowedCreateUrl(url: string): boolean {
  const p = parseOverrideHost(url);
  if (!p) return false;
  if (!p.isHttp) return true;
  if (p.isLoopback) return true;
  return p.host === "verse8.io" || p.host.endsWith(".verse8.io");
}

function getCreateBaseUrl(): string {
  const override = process.env.VERSE8_CREATE_URL;
  if (!override || override.length === 0) return DEFAULT_CREATE_URL;
  // Local policy enumeration so the web-editor link allow-set can drift
  // independently from the proxy / auth allow-sets if requirements
  // diverge. The harm of widening here is only a confusing link; we keep
  // the bar uniform with other tools.
  if (!isAllowedCreateUrl(override)) {
    console.error(
      `[verse8-preview] rejecting VERSE8_CREATE_URL=${override} — host not on .verse8.io allow-list. Using default ${DEFAULT_CREATE_URL}.`,
    );
    return DEFAULT_CREATE_URL;
  }
  return override.replace(/\/+$/, "");
}

/** Extract `<user>/<repo>` from origin; null when not a gitlab.verse8.io repo. */
export function deriveProjectPathFromOrigin(projectDir: string): string | null {
  let originUrl = "";
  try {
    originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (!originUrl) return null;

  // Accept both http(s):// and SSH-style git@host:path shapes.
  // Examples:
  //   https://oauth2:glpat-X@gitlab.verse8.io/user/proj-ts.git
  //   https://gitlab.verse8.io/user/proj-ts.git
  //   git@gitlab.verse8.io:user/proj-ts.git
  let host = "";
  let pathOnHost = "";
  const sshMatch = originUrl.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch) {
    host = sshMatch[1].toLowerCase();
    pathOnHost = sshMatch[2];
  } else {
    try {
      const parsed = new URL(originUrl);
      host = parsed.hostname.toLowerCase();
      pathOnHost = parsed.pathname;
    } catch {
      return null;
    }
  }
  if (host !== "gitlab.verse8.io") return null;

  // Strip leading slash and trailing .git
  const trimmed = pathOnHost.replace(/^\/+/, "").replace(/\.git$/i, "");
  // Must be at least namespace/slug shape.
  if (!trimmed.includes("/")) return null;
  // Basic sanity: no path traversal, no empty segments.
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  if (segments.some((s) => s === "." || s === "..")) return null;
  return segments.join("/");
}

export function buildWebEditorLink(projectPath: string): WebEditorLink {
  const base = getCreateBaseUrl();
  return {
    projectPath,
    url: `${base}/creator/editor?chat=${encodeURIComponent(projectPath)}`,
  };
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDevServer(
  port: number,
  pid: number | undefined,
  timeoutMs: number,
): Promise<
  | { ready: true }
  | { ready: false; reason: "timeout" }
  | { ready: false; reason: "child_exited" }
> {
  const deadline = Date.now() + timeoutMs;
  // Short first sleep — Vite rarely binds in under 150ms.
  const initialSleep = 200;
  const pollInterval = 250;
  await new Promise((r) => setTimeout(r, initialSleep));
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return { ready: true };
    if (!isProcessAlive(pid)) return { ready: false, reason: "child_exited" };
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  return { ready: false, reason: "timeout" };
}

function readLogTail(logAbs: string, maxBytes = 16_384): string {
  try {
    const stat = fs.statSync(logAbs);
    if (!stat.isFile()) return "";
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logAbs, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      return lines.slice(-40).join("\n").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function splitCommand(cmd: string): [string, string[]] {
  const parts = cmd.trim().split(/\s+/);
  return [parts[0] ?? "", parts.slice(1)];
}


export function detectGameserver(projectDir: string): boolean {
  for (const entry of ["server.ts", "server.js"]) {
    try {
      if (fs.statSync(path.join(projectDir, entry)).isFile()) return true;
    } catch {
      /* not present */
    }
  }
  try {
    if (fs.statSync(path.join(projectDir, "server")).isDirectory()) return true;
  } catch {
    /* not present */
  }
  return false;
}

function tail(s: string, lines = 20): string {
  if (!s) return "";
  const all = s.split(/\r?\n/);
  return all.slice(-lines).join("\n").trim();
}

interface PreflightSpec {
  command: string;
  cmd: string;
  args: string[];
}

export function buildPreflightSteps(
  installCommand: string,
  gameserver: boolean,
): PreflightSpec[] {
  const steps: PreflightSpec[] = [];
  const [installBin, ...installArgs] = installCommand.trim().split(/\s+/);
  if (!installBin) {
    // Defensive — schema's min(1) should prevent this, but if a caller
    // passes "   ", emit nothing rather than spawning an empty command.
    return steps;
  }
  steps.push({
    command: installCommand.trim(),
    cmd: installBin,
    args: installArgs,
  });
  if (gameserver) {
    const gsPin = resolveAgent8Pin("gameserver-node");
    const deployPin = resolveAgent8Pin("deploy");
    steps.push({
      command: `npx -y ${gsPin.nameArg} build`,
      cmd: "npx",
      args: ["-y", gsPin.nameArg, "build"],
    });
    steps.push({
      command: `npx -y ${deployPin.nameArg} --preview`,
      cmd: "npx",
      args: ["-y", deployPin.nameArg, "--preview"],
    });
  }
  return steps;
}

function runPreflightSteps(
  cwd: string,
  steps: PreflightSpec[],
  timeoutMs: number,
):
  | { ok: true; results: PreflightStepResult[] }
  | { ok: false; failedStep: PreflightStepResult; completed: PreflightStepResult[] } {
  const completed: PreflightStepResult[] = [];
  for (const step of steps) {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const out = execFileSync(step.cmd, step.args, {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      stdout = String(out);
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        status?: number | null;
        signal?: string | null;
      };
      stdout = String(err.stdout ?? "");
      stderr = String(err.stderr ?? err.message ?? "");
      // execFileSync exit code: status when known, signal when killed,
      // -1 for spawn / timeout errors.
      exitCode =
        typeof err.status === "number"
          ? err.status
          : err.signal
          ? 128
          : -1;
      const result: PreflightStepResult = {
        command: step.command,
        durationMs: Date.now() - start,
        exitCode,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
      };
      return { ok: false, failedStep: result, completed };
    }
    completed.push({
      command: step.command,
      durationMs: Date.now() - start,
      exitCode,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    });
  }
  return { ok: true, results: completed };
}

export async function runPreview(
  input: PreviewInput,
  serverCwd: string = process.cwd(),
): Promise<PreviewResult> {
  const cwd = path.resolve(input.projectDir ?? serverCwd);

  let checkpoint: CheckpointResult | null = null;
  if (!input.startOnly) {
    // Build the checkpoint input by stripping preview-specific fields.
    const ckInput = checkpointInputSchema.parse({
      files: input.files,
      projectDir: input.projectDir,
      userPrompt: input.userPrompt,
      model: input.model,
      provider: input.provider,
      mcpServers: input.mcpServers,
      reasoning: input.reasoning,
      problemStatement: input.problemStatement,
      workSummary: input.workSummary,
      toolCalls: input.toolCalls,
      useAutoToolLog: input.useAutoToolLog,
      message: input.message,
      skipAttachCheck: input.skipAttachCheck,
    });
    checkpoint = await runCheckpoint(ckInput, serverCwd);
    // The preview shows the local working tree. We can safely launch it as
    // long as the change is captured somewhere in git — either already
    // committed (ok:true) OR there's nothing new to commit OR the local
    // commit succeeded but only the push to origin failed (the user can
    // retry push later without losing the preview-matches-local-commit
    // invariant).
    //
    // True blockers: commit couldn't be made at all, tree can't be staged,
    // token/attach missing. Those all mean the user would preview state that
    // never hit git, so we abort.
    const recoverableForPreview = new Set([
      "nothing_to_commit",
      "push_failed", // local commit succeeded; sync can be retried separately
    ]);
    if (
      !checkpoint.ok &&
      !recoverableForPreview.has((checkpoint as { error: string }).error)
    ) {
      return {
        ok: false,
        stage: "checkpoint",
        checkpoint,
        hint: `Preview not started because the checkpoint failed (${(checkpoint as { error: string }).error}). Fix the commit error before re-running verse8_preview. To intentionally show an unpersisted state, pass startOnly: true.`,
      };
    }
  }

  let preflightSummary: PreflightSummary;
  if (input.skipPreflight) {
    preflightSummary = {
      ran: false,
      gameserver: detectGameserver(cwd),
      steps: [],
      skipReason: "skipPreflight_flag",
    };
  } else {
    const gameserver = detectGameserver(cwd);
    const steps = buildPreflightSteps(input.installCommand, gameserver);
    const result = runPreflightSteps(cwd, steps, input.preflightTimeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        stage: "preflight_failed",
        hint:
          `Preflight aborted at: ${result.failedStep.command} (exit ${result.failedStep.exitCode}). ` +
          `Dev server NOT started — fix the failure and re-run, or pass skipPreflight: true if you have already provisioned the environment.` +
          (result.failedStep.stderrTail
            ? `\n--- stderr (last lines) ---\n${result.failedStep.stderrTail}`
            : ""),
        failedStep: result.failedStep,
        stepsCompleted: result.completed,
        gameserver,
      };
    }
    preflightSummary = {
      ran: true,
      gameserver,
      steps: result.results,
    };
  }

  const port = input.previewPort;
  const url = `http://localhost:${port}`;
  // Best-effort: derive from origin. The link is additive — missing/null
  // just means the envelope omits it rather than breaking the preview.
  const projectPath = deriveProjectPathFromOrigin(cwd);
  const webEditor = projectPath ? buildWebEditorLink(projectPath) : null;

  const inUse = await isPortInUse(port);
  if (inUse) {
    return {
      ok: true,
      commit: checkpoint,
      preflight: preflightSummary,
      preview: { status: "already_running", url },
      webEditor,
    };
  }

  const [cmd, args] = splitCommand(input.previewCommand);
  if (!cmd) {
    return {
      ok: false,
      stage: "preview_spawn_failed",
      error: "empty_command",
      hint: "previewCommand resolved to an empty string",
      command: input.previewCommand,
    };
  }
  const logAbs = path.resolve(cwd, input.logPath);
  try {
    fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  } catch {
    /* non-fatal — spawn will surface the real error below */
  }

  let pid: number | undefined;
  let spawnError: Error | null = null;
  let exitCode: number | null = null;
  try {
    const fd = fs.openSync(logAbs, "a");
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: sanitizeChildEnv(),
    });
    pid = child.pid;
    // Capture async spawn failures (ENOENT on missing `bun`, etc.) that
    // surface AFTER spawn() itself returns. waitForDevServer checks
    // isProcessAlive → the error here is retained for the failure hint.
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("exit", (code) => {
      exitCode = code;
    });
    child.unref();
    // The child inherits a dup of fd as stdout+stderr, so close the parent
    // handle immediately. Leaving it open leaks a file descriptor for the
    // lifetime of the MCP server (the parent side never sees close).
    try {
      fs.closeSync(fd);
    } catch {
      /* non-fatal */
    }
  } catch (e) {
    return {
      ok: false,
      stage: "preview_spawn_failed",
      error: (e as Error).name || "spawn_failed",
      hint: (e as Error).message,
      command: input.previewCommand,
    };
  }

  // Verify the dev server actually binds the port before claiming success.
  // Without this the tool would happily return "started" even when the
  // child died at boot (missing script, port conflict, missing deps, etc.).
  const readiness = await waitForDevServer(
    port,
    pid,
    input.readinessTimeoutMs,
  );
  if (!readiness.ready) {
    const tail = readLogTail(logAbs);
    const err = spawnError as Error | null;
    const reasonHint =
      readiness.reason === "child_exited"
        ? `Dev server process (pid=${pid}) exited before binding port ${port}${
            exitCode !== null ? ` (exit code ${exitCode})` : ""
          }.${err ? ` spawn error: ${err.message}.` : ""}`
        : `Dev server did not bind port ${port} within ${input.readinessTimeoutMs}ms after spawn.`;
    const tailHint =
      tail.length > 0
        ? ` Last log lines from ${logAbs}:\n${tail}`
        : ` (No output captured in ${logAbs}.)`;
    return {
      ok: false,
      stage: "dev_server_not_ready",
      error:
        readiness.reason === "child_exited"
          ? "dev_server_exited"
          : "dev_server_not_ready",
      hint: `${reasonHint}${tailHint}`,
      command: input.previewCommand,
      pid,
      logPath: logAbs,
      logTail: tail,
      exitCode,
    };
  }

  return {
    ok: true,
    commit: checkpoint,
    preflight: preflightSummary,
    preview: {
      status: "started",
      url,
      pid,
      command: input.previewCommand,
      logPath: logAbs,
    },
    webEditor,
  };
}
