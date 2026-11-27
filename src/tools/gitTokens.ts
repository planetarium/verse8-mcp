import * as path from "node:path";
import { z } from "zod";
import { resolveToken, type TokenResolution } from "../context/token.js";
import {
  getProjectAccessToken,
  revokeAllProjectAccessTokens,
  revokeProjectAccessToken,
  type ApiResult,
} from "../api/agent8Backend.js";
import { safeErrorHint } from "../util/redact.js";
import { LOGIN_HINT } from "../util/hints.js";
import {
  apiFail,
  checkPlan,
  isApproved,
  opFail,
  planGate,
  planIdField,
  PROBED,
  rereadWith,
  withRejectedTokenHint,
  type ConfirmHost,
  type OpFail,
  type Plan,
  type PlanProbe,
} from "./creatorOps.js";
import { resolveProjectRef } from "./openProject.js";
import { buildWebEditorLink, deriveProjectPathFromOrigin } from "./preview.js";
import { projectDirField } from "./verseContext.js";

/**
 * `verse8_git_tokens` — the project Git access tokens that verse8_open_project
 * and verse8_new_project_confirm grant (one per call), as the web editor's
 * Git Clone menu shows them: list them, revoke one, or revoke them all.
 * The same agent8-backend routes as that menu:
 *   GET    /api/gitlab/project-access-token?projectPath=…
 *   DELETE /api/gitlab/project-access-token {projectPath, tokenId}  one
 *   DELETE /api/gitlab/project-access-token {projectPath}           ALL
 *
 * The backend allows a few active tokens per project and keeps each for 30
 * days; this tool frees a slot when that limit stops a clone.
 *
 * The list never carries a token value: each entry is rebuilt from the
 * fields named below, whatever else the backend sends.
 *
 * Revoking one token is a preview action (creatorOps plan gate). Revoking
 * all of them cuts every other machine's clone off at once and the backend
 * does it when the request has no tokenId, so it is a separate action that
 * also needs the user's own confirmation (RUN_RULES), and the one-token
 * path can never send a request without an id (agent8Backend).
 */

const ACTIONS = ["list", "revoke", "revoke_all"] as const;

export const gitTokensInputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        "list: the project's active Git access tokens (id, name, created, expires; never the token value). revoke: revoke ONE token by tokenId (preview unless planId). revoke_all: revoke EVERY token of the project (preview unless planId; then the user confirms in the host's prompt).",
      ),
    project: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "The project: a path like `owner/game-slug`, the web editor URL, or a gitlab.verse8.io URL. Omitted = the gitlab.verse8.io origin of projectDir.",
      ),
    projectDir: projectDirField,
    tokenId: z.number().int().min(1).optional().describe("revoke: the token's id (from list)."),
    planId: planIdField,
  })
  .strict();

export type GitTokensInput = z.infer<typeof gitTokensInputSchema>;
export type GitTokensResult = { ok: true; action: GitTokensInput["action"]; [k: string]: unknown } | OpFail;

/** One active token as this tool shows it. No other field of the backend's entry is passed on. */
export interface GitTokenInfo {
  tokenId: number;
  name: string;
  createdAt: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/**
 * The token list of a GET answer (`{success, data: {tokens}}`, or `tokens`
 * at the top), each entry rebuilt from id / name / created_at / expires_at /
 * daysLeft only. Null when the answer holds no list. Entries without a
 * usable id are dropped and counted: they could not be revoked by id.
 */
export function presentTokens(body: unknown): { tokens: GitTokenInfo[]; dropped: number } | null {
  const top = rec(body);
  const list = Array.isArray(top.tokens) ? top.tokens : Array.isArray(rec(top.data).tokens) ? (rec(top.data).tokens as unknown[]) : null;
  if (list === null) return null;
  const tokens: GitTokenInfo[] = [];
  let dropped = 0;
  for (const raw of list) {
    const e = rec(raw);
    const id = e.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      dropped++;
      continue;
    }
    tokens.push({
      tokenId: id,
      name: text(e.name, 100) ?? `token ${id}`,
      createdAt: text(e.created_at ?? e.createdAt, 40),
      expiresAt: text(e.expires_at ?? e.expiresAt, 40),
      daysLeft: typeof e.daysLeft === "number" && Number.isFinite(e.daysLeft) ? e.daysLeft : null,
    });
  }
  return { tokens, dropped };
}

/** A failed backend answer as an error envelope; a network failure (status 0) is upstream_unreachable. */
function backendFail(what: string, r: Extract<ApiResult<unknown>, { ok: false }>): OpFail {
  if (r.status === 0) return opFail("upstream_unreachable", `${what}: ${r.body}`);
  return apiFail(what, r);
}

const LIST_ROUTE = "GET /api/gitlab/project-access-token";

async function readTokens(projectPath: string, token: string): Promise<{ ok: true; tokens: GitTokenInfo[]; dropped: number } | OpFail> {
  const r = await getProjectAccessToken(projectPath, token);
  if (!r.ok) return backendFail(LIST_ROUTE, r);
  const p = presentTokens(r.data);
  if (p === null) {
    return opFail("upstream_error", `${LIST_ROUTE}: the answer carries no token list (top-level keys: ${Object.keys(rec(r.data)).sort().join(", ") || "none"}).`);
  }
  return { ok: true, ...p };
}

/** What a revoked token breaks — said with every revoke preview. */
const CUTS_OFF =
  "Every folder cloned with a revoked token — on this machine or another — can no longer push or pull until it is set up with a new token; a revoked token cannot be restored.";

/** The project path from `project`, or from projectDir's gitlab.verse8.io origin. */
function resolveProject(input: GitTokensInput, projectDir: string): { ok: true; projectPath: string } | OpFail {
  if (input.project !== undefined) {
    const r = resolveProjectRef(input.project);
    return r.ok ? { ok: true, projectPath: r.projectPath } : opFail(r.error, r.hint);
  }
  const p = deriveProjectPathFromOrigin(projectDir);
  if (p) return { ok: true, projectPath: p };
  return opFail(
    "invalid_input",
    `Pass \`project\` (a path like \`owner/game-slug\`, the web editor URL, or the gitlab.verse8.io URL): ${projectDir} has no gitlab.verse8.io origin to read it from.`,
  );
}

export async function runGitTokens(input: GitTokensInput, serverCwd: string = process.cwd(), host?: ConfirmHost): Promise<GitTokensResult> {
  const projectDir = path.resolve(input.projectDir ?? serverCwd);
  // One token lookup for the whole call; its source goes into any 401 hint.
  const auth = resolveToken(projectDir);
  return withRejectedTokenHint(await runWith(input, projectDir, auth, host), auth);
}

async function runWith(input: GitTokensInput, projectDir: string, auth: TokenResolution, host: ConfirmHost | undefined): Promise<GitTokensResult> {
  const token = auth.token;
  if (!token) return opFail("not_logged_in", LOGIN_HINT);
  const proj = resolveProject(input, projectDir);
  if (!proj.ok) return proj;
  const { projectPath } = proj;
  try {
    switch (input.action) {
      case "list": {
        const listed = await readTokens(projectPath, token);
        if (!listed.ok) return listed;
        return {
          ok: true,
          action: "list",
          projectPath,
          tokens: listed.tokens,
          ...(listed.dropped > 0 ? { warnings: [`${listed.dropped} token(s) came without an id and are not shown; see the web editor's Git Clone menu.`] } : {}),
          webEditor: buildWebEditorLink(projectPath),
          note:
            "Active tokens only, newest first; each lasts 30 days and the backend caps how many a project may hold at once (verse8_open_project / verse8_new_project_confirm take one per call). To free a slot, let the user pick a token they no longer use and call action revoke with its tokenId. " +
            CUTS_OFF,
        };
      }
      case "revoke":
        return await runRevoke(input, projectPath, token);
      case "revoke_all":
        return await runRevokeAll(input, projectPath, token, host);
    }
  } catch (e) {
    return opFail("upstream_unreachable", safeErrorHint(e));
  }
}

async function runRevoke(input: GitTokensInput, projectPath: string, token: string): Promise<GitTokensResult> {
  if (input.tokenId === undefined) {
    return opFail("invalid_input", "revoke needs tokenId (from action list). Revoking every token is the separate action revoke_all.");
  }
  const listed = await readTokens(projectPath, token);
  if (!listed.ok) return listed;
  const t = listed.tokens.find((x) => x.tokenId === input.tokenId);
  if (!t) {
    return opFail("not_found", `Token ${input.tokenId} is not an active token of ${projectPath} (already revoked, expired, or another project's). Call action list.`, { status: 404 });
  }
  const plan: Plan = {
    op: "verse8_git_tokens.revoke",
    target: { projectPath, tokenId: t.tokenId },
    body: { projectPath, tokenId: t.tokenId },
    // daysLeft is left out: it changes at midnight, which is no reason to refuse.
    state: { name: t.name, createdAt: t.createdAt, expiresAt: t.expiresAt },
  };
  const gate = await planGate(plan, input.planId, {
    action: "revoke" as const,
    projectPath,
    revokes: t,
    activeAfter: listed.tokens.length - 1,
    warnings: [CUTS_OFF],
  });
  if (!isApproved(gate)) return gate;
  const r = await revokeProjectAccessToken(projectPath, t.tokenId, token);
  if (!r.ok) return backendFail(`DELETE /api/gitlab/project-access-token (token ${t.tokenId})`, r);
  return { ok: true, action: "revoke", dryRun: false, projectPath, revoked: t };
}

async function runRevokeAll(input: GitTokensInput, projectPath: string, token: string, host: ConfirmHost | undefined, probe?: PlanProbe): Promise<GitTokensResult> {
  const listed = await readTokens(projectPath, token);
  if (!listed.ok) return listed;
  const plan: Plan = {
    op: "verse8_git_tokens.revoke_all",
    target: { projectPath },
    body: { projectPath },
    // Every token the prompt names; one granted or revoked meanwhile changes the plan.
    state: { tokens: listed.tokens.map(({ tokenId, name, createdAt, expiresAt }) => ({ tokenId, name, createdAt, expiresAt })) },
  };
  if (probe) {
    probe.plan = plan;
    return PROBED;
  }
  if (listed.tokens.length === 0) {
    // A preview never hands out a planId for an empty list, so a given one is stale.
    const stale = input.planId === undefined ? null : checkPlan(plan, input.planId);
    if (stale && !isApproved(stale)) return stale;
    return { ok: true, action: "revoke_all", dryRun: input.planId === undefined, projectPath, revoked: [], unchanged: true };
  }
  const again = rereadWith((pr) => runRevokeAll(input, projectPath, token, undefined, pr));
  const gate = await planGate(
    plan,
    input.planId,
    { action: "revoke_all" as const, projectPath, revokes: listed.tokens, warnings: [CUTS_OFF] },
    host,
    again,
  );
  if (!isApproved(gate)) return gate;
  const r = await revokeAllProjectAccessTokens(projectPath, token);
  if (!r.ok) return backendFail("DELETE /api/gitlab/project-access-token (all tokens)", r);
  return { ok: true, action: "revoke_all", dryRun: false, projectPath, revoked: listed.tokens };
}
