#!/usr/bin/env node
/**
 * tests/mocks/v8-meme-api-mock.ts
 *
 * Local HTTP mock for https://v8-meme-api.verse8.io
 *
 * Endpoints:
 *   POST /v1/auth/device/authorize  -> device flow init
 *   POST /v1/auth/device/token      -> pending on first call, success on second
 *   GET  /v1/auth/verify            -> profile if valid Bearer, 401 otherwise
 *   POST /v1/projects               -> create project (or 404 if --stub-project-404)
 *
 * Flags:
 *   --stub-project-404   Make POST /v1/projects return 404
 *
 * Writes port to /tmp/v8-mock-port.txt on startup.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as url from "node:url";

const args = process.argv.slice(2);
const STUB_PROJECT_404 = args.includes("--stub-project-404");
const VALID_TOKEN = "test-token-xyz";
const PORT_FILE = "/tmp/v8-mock-port.txt";

// Per-device_code call counter for simulating authorization_pending -> success
const tokenCallCounts = new Map<string, number>();

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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url ?? "/");
  const pathname = parsed.pathname ?? "/";
  const method = req.method ?? "GET";

  // POST /v1/auth/device/authorize
  if (method === "POST" && pathname === "/v1/auth/device/authorize") {
    send(res, 200, {
      device_code: "mock-device-code-abc",
      user_code: "MOCK-CODE",
      verification_uri: "https://verse8.io/activate",
      verification_uri_complete: "https://verse8.io/activate?user_code=MOCK-CODE",
      expires_in: 1800,
      interval: 1,
    });
    return;
  }

  // POST /v1/auth/device/token
  if (method === "POST" && pathname === "/v1/auth/device/token") {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* ignore */
    }
    const deviceCode = (body.device_code as string) || "mock-device-code-abc";
    const count = (tokenCallCounts.get(deviceCode) ?? 0) + 1;
    tokenCallCounts.set(deviceCode, count);

    if (count === 1) {
      // First call: authorization_pending
      send(res, 400, { error: "authorization_pending", error_description: "User has not yet approved" });
    } else {
      // Subsequent calls: success
      send(res, 200, { access_token: VALID_TOKEN, token_type: "Bearer", expires_in: 604800 });
    }
    return;
  }

  // GET /v1/auth/verify
  if (method === "GET" && pathname === "/v1/auth/verify") {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${VALID_TOKEN}`) {
      send(res, 401, { error: "unauthorized", message: "Invalid or missing token" });
      return;
    }
    send(res, 200, {
      userUid: 42,
      handle: "smoke-test-user",
      email: "smoke@verse8.io",
      tier: "GOLD",
      totalPoints: 9999,
      isActivated: true,
      exp: Math.floor(Date.now() / 1000) + 604800,
    });
    return;
  }

  // POST /v1/projects
  if (method === "POST" && pathname === "/v1/projects") {
    if (STUB_PROJECT_404) {
      send(res, 404, { error: "not_found", message: "Project creation endpoint not yet available" });
      return;
    }

    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${VALID_TOKEN}`) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* ignore */
    }

    if (!body.gameType || !body.title || !body.preset) {
      send(res, 400, { error: "bad_request", message: "gameType, title, and preset are required" });
      return;
    }

    send(res, 201, {
      cloneUrl: "file:///tmp/verse8-smoke-bundle.git",
      projectId: "proj-abc123",
    });
    return;
  }

  // Fallthrough 404
  send(res, 404, { error: "not_found" });
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address() as { port: number };
  const port = addr.port;
  fs.writeFileSync(PORT_FILE, String(port), "utf8");
  process.stderr.write(`[v8-mock] listening on 127.0.0.1:${port}${STUB_PROJECT_404 ? " (stub-project-404)" : ""}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
