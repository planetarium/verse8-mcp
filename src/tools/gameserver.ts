import { z } from "zod";
import {
  GATEWAY_ID,
  gatewayGet,
  gatewayReadLogStream,
  type GameLogEntry,
  type GatewayResult,
} from "../api/gameserverGateway.js";
import { safeErrorHint } from "../util/redact.js";
import { rejectedTokenHintForLastLoad } from "../context/token.js";
import { projectDirField, resolveVerseContext, verseIdField } from "./verseContext.js";

/**
 * `verse8_gameserver` — read the game server of this project's verse:
 * status, database (collections / items / user + global state) and logs.
 * Read-only: it calls only the gateway's GET routes.
 */

const ACTIONS = ["status", "collections", "items", "users", "user", "global", "errors", "logs"] as const;
const LOG_LEVELS = ["debug", "log", "info", "warn", "error", "profile"] as const;

const gatewayIdField = z.string().regex(GATEWAY_ID, "letters, digits, `.`, `_` or `-` only");

export const gameserverInputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        "status: server version (v1/v2), state, players, rooms. collections: collection names + doc counts. items: documents of `collectionId` (paged; optional equality search). users: account ids that have user state (`kind`: users | assets). user: one account's state. global: global state. errors: recent error log lines (v2 only). logs: recent + live log lines for `followSeconds` (v2 only).",
      ),
    target: z
      .enum(["prod", "preview"])
      .describe("prod: the published game's server (`<verseId>`). preview: the test server verse8_preview deploys (`<verseId>-preview`)."),
    projectDir: projectDirField,
    verseId: verseIdField,
    collectionId: gatewayIdField.optional().describe("items: the collection to read."),
    field: z.string().min(1).max(200).optional().describe("items: document field to match by equality with `value`. Omit to treat `value` as a document-id prefix."),
    value: z.string().max(500).optional().describe("items: search value (field equality, or id prefix when `field` is omitted)."),
    valueType: z.enum(["string", "number", "boolean"]).optional().describe("items: type of `value` for a field search. Default string."),
    account: gatewayIdField.optional().describe("user: the account (wallet address as the game sees it in $sender.account)."),
    kind: z.enum(["users", "assets"]).optional().describe("users / user: user state (default) or asset balances."),
    limit: z.number().int().min(1).max(200).optional().describe("items / users: page size (default 20, max 200). errors: max 50. logs: max lines (default 100)."),
    cursor: z.string().min(1).max(500).optional().describe("items / users: `nextCursor` from the previous page."),
    level: z.enum(LOG_LEVELS).optional().describe("logs: lowest level to include (default log)."),
    followSeconds: z.number().int().min(1).max(30).optional().describe("logs: how long to listen after the replay of recent lines (default 3)."),
  })
  .strict();

export type GameserverInput = z.infer<typeof gameserverInputSchema>;

export type GameserverResult =
  | { ok: true; action: GameserverInput["action"]; target: "prod" | "preview"; verse: string; [k: string]: unknown }
  | { ok: false; error: string; hint: string; status?: number; [k: string]: unknown };

function fromGateway<T>(
  r: GatewayResult<T>,
  verse: string,
): { ok: false; error: string; hint: string; status: number } | null {
  if (r.ok) return null;
  const error =
    r.status === 401 ? "unauthorized" : r.status === 403 ? "forbidden" : r.status === 404 ? "not_found" : r.status === 429 ? "rate_limited" : "upstream_error";
  const hint =
    r.status === 401
      ? `The game server gateway rejected the Verse8 login (${r.error}). ${rejectedTokenHintForLastLoad()}.`
      : r.status === 403
        ? `${r.error}. Only the owner of ${verse} can read it — check that the login matches VITE_AGENT8_ACCOUNT.`
        : `Gateway answered HTTP ${r.status}: ${r.error}`;
  return { ok: false, error, hint, status: r.status };
}

export async function runGameserver(
  input: GameserverInput,
  serverCwd: string = process.cwd(),
): Promise<GameserverResult> {
  const ctx = resolveVerseContext(input, serverCwd);
  if (!ctx.ok) return ctx;
  const verse = input.target === "preview" ? `${ctx.verseId}-preview` : ctx.verseId;
  const base = { ok: true as const, action: input.action, target: input.target, verse };

  try {
    switch (input.action) {
      case "status": {
        const view = await gatewayGet<{ version?: string | null }>(verse, "/server-view", ctx.token);
        const bad = fromGateway(view, verse);
        if (bad) return bad;
        const overview = await gatewayGet<Record<string, unknown>>(verse, "/overview", ctx.token);
        return {
          ...base,
          version: view.ok ? view.data.version ?? null : null,
          overview: overview.ok ? overview.data : null,
          ...(overview.ok ? {} : { overviewError: `HTTP ${overview.status}: ${overview.error}` }),
        };
      }
      case "collections": {
        const r = await gatewayGet<{ collections: Array<{ name: string; docCount: number }> }>(verse, "/db/collections", ctx.token);
        return fromGateway(r, verse) ?? { ...base, collections: r.ok ? r.data.collections : [] };
      }
      case "items": {
        if (!input.collectionId) {
          return { ok: false, error: "invalid_input", hint: "action items needs collectionId (see action collections)." };
        }
        const r = await gatewayGet<Record<string, unknown>>(
          verse,
          `/db/collections/${encodeURIComponent(input.collectionId)}/items`,
          ctx.token,
          {
            limit: input.limit ?? 20,
            cursor: input.cursor,
            field: input.field,
            value: input.value,
            type: input.field ? input.valueType : undefined,
          },
        );
        return fromGateway(r, verse) ?? { ...base, collectionId: input.collectionId, ...(r.ok ? r.data : {}) };
      }
      case "users": {
        const r = await gatewayGet<Record<string, unknown>>(verse, "/db/users", ctx.token, {
          kind: input.kind,
          limit: input.limit ?? 20,
          cursor: input.cursor,
        });
        return fromGateway(r, verse) ?? { ...base, kind: input.kind ?? "users", ...(r.ok ? r.data : {}) };
      }
      case "user": {
        if (!input.account) return { ok: false, error: "invalid_input", hint: "action user needs account (see action users)." };
        const kind = input.kind ?? "users";
        const r = await gatewayGet<Record<string, unknown>>(verse, `/db/${kind}/${encodeURIComponent(input.account)}`, ctx.token);
        return fromGateway(r, verse) ?? { ...base, kind, account: input.account, state: r.ok ? r.data : null };
      }
      case "global": {
        const r = await gatewayGet<Record<string, unknown>>(verse, "/db/global", ctx.token);
        return fromGateway(r, verse) ?? { ...base, state: r.ok ? r.data : null };
      }
      case "errors":
      case "logs": {
        // Logs live in the v2 runtime's stream; a v1 verse answers with an
        // empty list that would read as "no errors".
        const view = await gatewayGet<{ version?: string | null }>(verse, "/server-view", ctx.token);
        const bad = fromGateway(view, verse);
        if (bad) return bad;
        const version = view.ok ? view.data.version ?? null : null;
        if (version !== "v2") {
          return {
            ok: false,
            error: "logs_unavailable",
            hint: `${verse} runs on game server ${version ?? "(not deployed)"}; server logs are only readable for v2 verses. ${version === "v1" ? "v1 logs go to Cloud Run and are not exposed to developers." : "Deploy the server first (verse8_preview for preview, verse8_deploy for prod)."}`,
            version,
          };
        }
        if (input.action === "errors") {
          const r = await gatewayGet<{ entries: GameLogEntry[] }>(verse, "/recent-errors", ctx.token, {
            limit: Math.min(input.limit ?? 20, 50),
          });
          return fromGateway(r, verse) ?? { ...base, version, entries: r.ok ? r.data.entries : [] };
        }
        const seconds = input.followSeconds ?? 3;
        const r = await gatewayReadLogStream(verse, ctx.token, {
          level: input.level,
          seconds,
          maxEntries: input.limit ?? 100,
        });
        if (!r.ok && r.status === 429) {
          return {
            ok: false,
            error: "rate_limited",
            status: 429,
            hint: `The gateway refused another log stream (${r.error}). It allows a few open log streams per wallet (5) — streams just closed, or a web Server tab left open, can count for a short while. Retry in a minute, or use action errors.`,
          };
        }
        return (
          fromGateway(r, verse) ?? {
            ...base,
            version,
            level: input.level ?? "log",
            listenedSeconds: seconds,
            entries: r.ok ? r.data.entries : [],
            truncated: r.ok ? r.data.truncated : false,
          }
        );
      }
    }
  } catch (e) {
    return { ok: false, error: "upstream_unreachable", hint: safeErrorHint(e) };
  }
}
