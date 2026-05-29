#!/usr/bin/env node
/**
 * tests/mocks/agent8-backend-mock.ts
 *
 * Local HTTP mock for https://agent8-backend.verse8.io — the project-creation
 * service consumed by verse8_new_project_{start,confirm}.
 *
 * Endpoints:
 *   POST /api/startcall
 *   GET  /api/select-template
 *   GET  /api/gitlab/project-access-token
 *   POST /api/gitlab/project-access-token
 *   POST /api/upload-attachment
 *
 * Flags:
 *   --fail=<stage>[,<stage>...]   Return 500 on the named stage(s).
 *                                 stages: startcall, select-template,
 *                                         token-check, token-grant, upload
 *   --clone-fixture=<abs-path>    Use this local bare repo path as the
 *                                 cloneCommand URL (file://...). Default
 *                                 is /tmp/verse8-smoke-bundle.git.
 *   --oauth-url                   Instead of file://, emit an oauth-embedded
 *                                 https:// URL that matches the real backend
 *                                 shape. (git clone will fail unless the URL
 *                                 is reachable — use only for URL-shape tests.)
 *   --fixed-project-path=<str>    Fixed project.path to return from
 *                                 select-template (default uses a timestamp).
 *
 * Writes:
 *   /tmp/agent8-mock-port.txt   — listening port
 *   /tmp/agent8-mock-calls.jsonl — per-request call log for test assertions
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as url from "node:url";

const args = process.argv.slice(2);
const VALID_TOKEN = "test-token-xyz";
const PORT_FILE = "/tmp/agent8-mock-port.txt";
const CALLS_FILE = "/tmp/agent8-mock-calls.jsonl";

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const failStages = new Set(
  (flagValue("fail") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const cloneFixture = flagValue("clone-fixture") ?? "/tmp/verse8-smoke-bundle.git";
const useOauthUrl = hasFlag("oauth-url");
const fixedProjectPath = flagValue("fixed-project-path");
// Drops cloneCommand from the POST /api/gitlab/project-access-token response
// to simulate the real backend's "PAT already granted" retry path. Confirm
// should then synthesize the command from gitUrl + projectPath.
const omitCloneCommand = hasFlag("omit-clone-command");
// Drops gitUrl too — with both missing, confirm should fail loud with a
// structured token_grant_failed instead of crashing on undefined.trim().
const omitGitUrl = hasFlag("omit-git-url");
// Emits the token-grant response with snake_case keys (clone_command,
// git_url, expires_at) — reproduces a real-world agent8-backend
// environment where the field naming drifted from the documented
// camelCase shape. Confirm must still succeed.
const snakeCaseKeys = hasFlag("snake-case");

// Reset call log on startup so each test run gets a clean slate.
fs.writeFileSync(CALLS_FILE, "", "utf8");

function logCall(entry: Record<string, unknown>): void {
  fs.appendFileSync(CALLS_FILE, JSON.stringify(entry) + "\n", "utf8");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function requireBearer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const auth = req.headers["authorization"] ?? "";
  if (auth !== `Bearer ${VALID_TOKEN}`) {
    send(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function buildGitUrl(projectPath: string, tokenValue: string): string {
  return useOauthUrl
    ? `https://oauth2:${tokenValue}@gitlab.verse8.io/${projectPath}.git`
    : `file://${cloneFixture}`;
}

function buildCloneCommand(projectPath: string, tokenValue: string): string {
  const slug = projectPath.split("/").pop() ?? "repo";
  return `git clone -b develop ${buildGitUrl(projectPath, tokenValue)} ${slug}`;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url ?? "/", true);
  const pathname = parsed.pathname ?? "/";
  const method = req.method ?? "GET";

  logCall({
    ts: Date.now(),
    method,
    pathname,
    query: parsed.query,
    authorization: req.headers["authorization"] ?? null,
  });

  // POST /api/startcall
  if (method === "POST" && pathname === "/api/startcall") {
    if (!requireBearer(req, res)) return;
    if (failStages.has("startcall")) {
      send(res, 500, { error: "startcall_injected_failure" });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* ignore */
    }
    const message = String(body.message ?? "");
    send(res, 200, {
      templateName: "basic-vite-react",
      title: inferTitle(message),
      projectRepo: inferSlug(message),
      nextActionSuggestion: "Print 'Hello, World!' on screen.",
      template: {
        name: "basic-vite-react",
        label: "Basic Vite + React",
        description: "Minimal 2D/UI scaffolding for web games.",
        githubRepo: "planetarium/agent8-templates",
        path: "basic-vite-react",
        tags: ["2d", "starter"],
      },
    });
    return;
  }

  // GET /api/select-template
  if (method === "GET" && pathname === "/api/select-template") {
    if (!requireBearer(req, res)) return;
    if (failStages.has("select-template")) {
      send(res, 500, { error: "select_template_injected_failure" });
      return;
    }
    const projectRepo = String(parsed.query.projectRepo ?? "demo");
    const projectPath = fixedProjectPath ?? `smoke-user/${projectRepo}-${Date.now()}`;
    const projectId = 1001;
    send(res, 200, {
      project: {
        id: projectId,
        name: projectRepo,
        path: projectPath,
        description: "Created by smoke test.",
      },
      commit: { id: "deadbeef" },
    });
    return;
  }

  // GET /api/gitlab/project-access-token
  if (method === "GET" && pathname === "/api/gitlab/project-access-token") {
    if (!requireBearer(req, res)) return;
    if (failStages.has("token-check")) {
      send(res, 500, { error: "token_check_injected_failure" });
      return;
    }
    send(res, 200, { hasToken: false, tokens: [] });
    return;
  }

  // POST /api/gitlab/project-access-token
  if (method === "POST" && pathname === "/api/gitlab/project-access-token") {
    if (!requireBearer(req, res)) return;
    if (failStages.has("token-grant")) {
      send(res, 500, { error: "token_grant_injected_failure" });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* ignore */
    }
    const projectPath = String(body.projectPath ?? "smoke-user/demo");
    const tokenValue = "glpat-smokeXXXXXXXXXXXXXX";
    const gitUrl = buildGitUrl(projectPath, tokenValue);
    const expiresAtIso = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const payload: Record<string, unknown> = {
      token: tokenValue,
      scopes: ["api", "read_repository", "write_repository"],
      accessLevel: "maintainer",
    };
    if (snakeCaseKeys) {
      payload.expires_at = expiresAtIso;
      payload.expires_in_days = 30;
      if (!omitGitUrl) payload.git_url = gitUrl;
      if (!omitCloneCommand) {
        payload.clone_command = buildCloneCommand(projectPath, tokenValue);
      }
    } else {
      payload.expiresAt = expiresAtIso;
      payload.expiresInDays = 30;
      if (!omitGitUrl) payload.gitUrl = gitUrl;
      if (!omitCloneCommand) {
        payload.cloneCommand = buildCloneCommand(projectPath, tokenValue);
      }
    }
    send(res, 200, payload);
    return;
  }

  // POST /api/upload-attachment — multipart file upload.
  // We don't parse the multipart body (boundary splitting is not needed for
  // the smoke contract); we just drain it so the client sees its request
  // complete and we can log the body length for assertions.
  if (method === "POST" && pathname === "/api/upload-attachment") {
    if (!requireBearer(req, res)) return;
    if (failStages.has("upload")) {
      send(res, 500, { success: false, error: "upload_injected_failure" });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    await new Promise<void>((resolve) => req.on("end", () => resolve()));
    const bodyLen = Buffer.concat(chunks).length;
    logCall({
      ts: Date.now(),
      method,
      pathname,
      bodyLen,
      authorization: req.headers["authorization"] ?? null,
    });
    const verse = "smoke-verse";
    const pathField = "assets/images";
    const fname = `${Math.random().toString(36).slice(2, 18)}.png`;
    send(res, 200, {
      success: true,
      url: `https://agent8-games.verse8.io/${verse}/${pathField}/${fname}`,
    });
    return;
  }

  send(res, 404, { error: "not_found" });
});

function inferTitle(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return "My Verse8 Game";
  const normalized = trimmed.replace(/\s+/g, " ");
  return normalized.length > 40 ? normalized.slice(0, 40) : normalized;
}

function inferSlug(message: string): string {
  const base = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "my-verse8-game";
}

server.listen(0, "127.0.0.1", () => {
  const addr = server.address() as { port: number };
  const port = addr.port;
  fs.writeFileSync(PORT_FILE, String(port), "utf8");
  process.stderr.write(
    `[agent8-mock] listening on 127.0.0.1:${port}` +
      (failStages.size ? ` (fail=${[...failStages].join(",")})` : "") +
      `\n`,
  );
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
