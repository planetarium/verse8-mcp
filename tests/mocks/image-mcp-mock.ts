#!/usr/bin/env node
/**
 * tests/mocks/image-mcp-mock.ts
 *
 * Local HTTP mock for https://mcp-image-svc.verse8.io/mcp
 *
 * Handles JSON-RPC 2.0 over HTTP POST:
 *   initialize              -> session id via mcp-session-id header
 *   notifications/initialized -> 202
 *   tools/list              -> image_asset_generate tool schema
 *   tools/call              -> synthesized image result (or 500 if --force-500)
 *
 * Every request must carry Authorization: Bearer <something> — returns 401
 * otherwise.
 *
 * Records received Authorization headers to /tmp/v8-image-mock-calls.jsonl
 * (append one JSON line per request).
 *
 * Flags:
 *   --force-500   Return HTTP 500 on tools/call requests
 *   --port-file <path>  Override port file (default /tmp/v8-image-mock-port.txt)
 *
 * Writes port to /tmp/v8-image-mock-port.txt on startup.
 */

import * as http from "node:http";
import * as fs from "node:fs";

const args = process.argv.slice(2);
const FORCE_500 = args.includes("--force-500");
const SESSION_EXPIRE_ONCE = args.includes("--session-expire-once");
const portFileIdx = args.indexOf("--port-file");
const PORT_FILE = portFileIdx >= 0 ? args[portFileIdx + 1] : "/tmp/v8-image-mock-port.txt";
const CALLS_FILE = "/tmp/v8-image-mock-calls.jsonl";
// Session-id rotation so reinit yields a DIFFERENT id — mimics real server GC.
let sessionCounter = 0;
let currentSessionId = `mock-session-${++sessionCounter}`;
// When --session-expire-once is on, the very first tools/call with the
// current session returns "No valid session ID provided". Re-initialize
// then mints a fresh id and subsequent calls succeed.
let expiredSent = 0;

// Clear calls file on startup
try { fs.writeFileSync(CALLS_FILE, "", "utf8"); } catch { /* ignore */ }

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function recordCall(authHeader: string, method: string): void {
  const entry = JSON.stringify({ ts: Date.now(), authorization: authHeader, method }) + "\n";
  try { fs.appendFileSync(CALLS_FILE, entry, "utf8"); } catch { /* ignore */ }
}

function send(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
    ...(extraHeaders ?? {}),
  };
  res.writeHead(status, headers);
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];

  // Only handle POST /mcp
  if (req.method !== "POST" || (pathname !== "/mcp" && pathname !== "/")) {
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    send(res, 404, { error: "not_found" });
    return;
  }

  // Auth check
  const auth = (req.headers["authorization"] as string) ?? "";
  recordCall(auth, "unknown");

  if (!auth || !auth.startsWith("Bearer ")) {
    send(res, 401, { error: "unauthorized", message: "Authorization: Bearer <token> required" });
    return;
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const rpcId = body.id ?? null;
  const method = (body.method as string) ?? "";

  // Update the last recorded call with actual method
  recordCall(auth, method);

  // notifications/initialized — no response needed
  if (method === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return;
  }

  // initialize — rotate the session id so the reinit path's retry is
  // observably using a different id from the expired one.
  if (method === "initialize") {
    currentSessionId = `mock-session-${++sessionCounter}`;
    send(
      res,
      200,
      {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "image-mcp-mock", version: "0.0.1" },
        },
      },
      { "mcp-session-id": currentSessionId },
    );
    return;
  }

  // tools/list
  if (method === "tools/list") {
    send(res, 200, {
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        tools: [
          {
            name: "image_asset_generate",
            description: "Generate a game asset image from a text description",
            inputSchema: {
              type: "object",
              properties: {
                description: { type: "string", description: "Text description of the image to generate" },
                gameType: { type: "string", description: "Game type context" },
                assetType: { type: "string", description: "Type of asset (item, background, character, etc.)" },
              },
              required: ["description"],
            },
          },
        ],
      },
    });
    return;
  }

  // tools/call
  if (method === "tools/call") {
    if (FORCE_500) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_server_error", message: "Forced 500 for testing" }));
      return;
    }

    if (SESSION_EXPIRE_ONCE && expiredSent === 0) {
      expiredSent++;
      send(res, 400, {
        jsonrpc: "2.0",
        id: rpcId,
        error: { code: -32000, message: "No valid session ID provided" },
      });
      return;
    }

    const params = body.params as Record<string, unknown> | undefined;
    const toolName = params?.name as string | undefined;
    const toolArgs = params?.arguments as Record<string, unknown> | undefined;

    if (toolName !== "image_asset_generate") {
      send(res, 200, {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool" }) }],
          isError: true,
        },
      });
      return;
    }

    send(res, 200, {
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: "file:///tmp/fake-image.png",
              assetType: toolArgs?.assetType ?? "item",
              description: toolArgs?.description ?? "",
            }),
          },
        ],
        isError: false,
      },
    });
    return;
  }

  // Unknown method
  send(res, 200, {
    jsonrpc: "2.0",
    id: rpcId,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address() as { port: number };
  const port = addr.port;
  fs.writeFileSync(PORT_FILE!, String(port), "utf8");
  process.stderr.write(`[image-mock] listening on 127.0.0.1:${port}${FORCE_500 ? " (force-500)" : ""}\n`);
});

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
