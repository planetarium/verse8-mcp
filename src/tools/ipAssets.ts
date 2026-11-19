import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DuplicateMessageError, invokeA2A } from "../a2a/client.js";
import { IpAssetError } from "../util/ipAssetHttp.js";
import { loadToken } from "../context/token.js";
import { atomicWriteFileSync } from "../util/atomicWrite.js";
import { isSafeAbsPath } from "../util/safePath.js";

export const ipAssetsInputSchema = z.object({
  pool: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
  method: z.enum(["message/send", "message/stream", "tasks/get", "tasks/cancel", "tasks/resubscribe"]),
  text: z.string().min(1).max(64 * 1024).optional(),
  messageId: z.string().min(1).max(256).optional(),
  taskId: z.string().min(1).max(256).optional(),
  contextId: z.string().min(1).max(256).optional(),
  projectDir: z.string().refine(value => path.isAbsolute(value) && isSafeAbsPath(value)).optional(),
}).strict();
type Input = z.infer<typeof ipAssetsInputSchema>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Linear scan: repeated-group regexes can exhaust V8's stack on multi-MiB assets. */
function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let dataEnd = value.length;
  if (value.endsWith("==")) dataEnd -= 2;
  else if (value.endsWith("=")) dataEnd--;
  for (let index = 0; index < dataEnd; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  return dataEnd === value.length || dataEnd >= 2;
}

// Older attached projects may lack the ip-assets/ entry in .verse8/.gitignore.
async function ensureAssetIgnore(directory: string): Promise<void> {
  const ignore = path.join(directory, ".gitignore");
  let stat;
  try {
    stat = await fs.lstat(ignore);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    atomicWriteFileSync(ignore, "*\n", { mode: 0o600 });
    return;
  }
  if (!stat.isFile() || !["*", "*\n", "*\r\n"].includes(await fs.readFile(ignore, "utf8"))) {
    throw new IpAssetError("artifact_invalid");
  }
}

async function privateOutputDirectory(projectDir: string, namespace: string): Promise<string> {
  const root = await fs.realpath(projectDir);
  let current = root;
  for (const segment of [".verse8", "ip-assets", namespace]) {
    current = path.join(current, segment);
    await fs.mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IpAssetError("artifact_invalid");
    if (segment === "ip-assets") await ensureAssetIgnore(current);
  }
  return current;
}

/** Only inline bytes are supported. Provider URLs are never fetched or exposed. */
async function saveResults(results: Record<string, unknown>[], projectDir: string, namespace: string) {
  type ArtifactParts = { parts: unknown[]; complete: boolean; hasBase: boolean };
  const artifacts = new Map<string, ArtifactParts>();
  // Provider IDs are arbitrary strings; synthetic message IDs must never share their map.
  const messageParts: Array<[string, ArtifactParts]> = [];
  const messages: string[] = [];
  let messageBytes = 0;
  let messageIndex = 0;
  const addMessage = (message: Record<string, unknown>) => {
    if (Array.isArray(message.parts)) {
      messageParts.push([`message-${messageIndex++}`, { parts: message.parts, complete: true, hasBase: true }]);
    }
  };
  for (const result of results) {
    if (result.kind === "message") addMessage(result);
    if (result.kind === "task") {
      if (Array.isArray(result.history)) for (const m of result.history) if (object(m) && m.role === "agent") addMessage(m);
      if (Array.isArray(result.artifacts)) for (const artifact of result.artifacts) {
        if (!object(artifact) || typeof artifact.artifactId !== "string" || !Array.isArray(artifact.parts)) throw new IpAssetError("artifact_invalid", true);
        artifacts.set(artifact.artifactId, { parts: artifact.parts, complete: true, hasBase: true });
      }
    }
    if (object(result.status) && object(result.status.message)) addMessage(result.status.message);
    if (result.kind === "artifact-update") {
      const a = result.artifact;
      if (!object(a) || typeof a.artifactId !== "string" || !Array.isArray(a.parts)) throw new IpAssetError("artifact_invalid", true);
      const previous = artifacts.get(a.artifactId);
      artifacts.set(a.artifactId, { parts: result.append === true ? [...(previous?.parts ?? []), ...a.parts] : a.parts,
        complete: result.lastChunk === true && (result.append !== true || previous?.hasBase === true),
        hasBase: result.append !== true || previous?.hasBase === true });
    }
  }
  const pending: Array<{ artifactId: string; name: string; bytes: Buffer; mimeType?: string }> = [];
  for (const [artifactId, artifact] of [...artifacts, ...messageParts]) {
    for (const part of artifact.parts) {
      if (!object(part)) throw new IpAssetError("artifact_invalid", true);
      if (part.kind === "text" && typeof part.text === "string" && messageBytes < 64 * 1024) {
        const text = part.text.slice(0, 64 * 1024 - messageBytes);
        messages.push(text); messageBytes += text.length;
      }
      if (part.kind !== "file") continue;
      const file = part.file;
      if (!object(file) || file.uri !== undefined || typeof file.bytes !== "string" ||
          !isBase64(file.bytes)) throw new IpAssetError("artifact_invalid", true);
      if (!artifact.complete) continue;
      const bytes = Buffer.from(file.bytes, "base64");
      const name = typeof file.name === "string" ? path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) : "asset.bin";
      if (pending.length >= 128) throw new IpAssetError("artifact_invalid", true);
      pending.push({ artifactId, name: name || "asset.bin", bytes, ...(typeof file.mimeType === "string" ? { mimeType: file.mimeType } : {}) });
    }
  }
  const files: Array<{ artifactId: string; path: string; name: string; sizeBytes: number; mimeType?: string }> = [];
  if (pending.length) {
    const directory = await privateOutputDirectory(projectDir, namespace);
    const written: string[] = [];
    try {
      for (const file of pending) {
        const digest = createHash("sha256").update(file.bytes).digest("hex");
        const target = path.join(directory, `${digest}-${file.name}`);
        try {
          await fs.writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
          written.push(target);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          const stat = await fs.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes.length) throw new IpAssetError("artifact_invalid", true);
          const existing = await fs.readFile(target);
          if (!existing.equals(file.bytes)) throw new IpAssetError("artifact_invalid", true);
        }
        files.push({ artifactId: file.artifactId, path: target, name: file.name, sizeBytes: file.bytes.length,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}) });
      }
    } catch (e) { await Promise.all(written.map(target => fs.unlink(target).catch(() => undefined))); throw e; }
  }
  return { files, messages, incompleteArtifacts: [...artifacts].filter(([, value]) => !value.complete).map(([id]) => id) };
}

export async function runIpAssets(input: Input, cwd = process.cwd()) {
  const projectDir = path.resolve(input.projectDir ?? cwd);
  const source = loadToken(projectDir);
  if (!source) return { ok: false, error: "not_logged_in", hint: "Use verse8_login_start and verse8_login_complete." };
  const isMessage = input.method.startsWith("message/");
  if ((isMessage && !input.text) || (!isMessage && (!input.taskId || input.text || input.contextId || input.messageId))) {
    return { ok: false, error: "invalid_input", hint: "Messages require text; task operations require taskId only." };
  }
  const messageId = isMessage ? input.messageId ?? randomUUID() : undefined;
  let taskId = input.taskId;
  let contextId = input.contextId;
  let state: string | undefined;
  const observe = (result: Record<string, unknown>) => {
    if (result.kind === "task" && typeof result.id === "string") taskId = result.id;
    else if (typeof result.taskId === "string") taskId = result.taskId;
    if (typeof result.contextId === "string") contextId = result.contextId;
    if (object(result.status) && typeof result.status.state === "string") state = result.status.state;
  };
  const params: Record<string, unknown> = isMessage ? {
    ...(input.method === "message/send" ? { configuration: { blocking: false } } : {}),
    message: { kind: "message", role: "user", messageId, parts: [{ kind: "text", text: input.text }],
      ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) },
  } : { id: taskId };
  try {
    const reply = await invokeA2A(input.pool, input.method, params, source, observe);
    const namespace = createHash("sha256").update(JSON.stringify([reply.resource, taskId ?? contextId ?? reply.requestId])).digest("hex");
    const assets = await saveResults(reply.results, projectDir, namespace);
    return { ok: true, pool: input.pool, messageId, taskId, contextId, state, ...assets };
  } catch (e) {
    const error = e instanceof IpAssetError ? e.code : "artifact_write_failed";
    if (e instanceof DuplicateMessageError) {
      taskId = e.taskId;
      // The caller may have reused the message ID in a different context.
      contextId = undefined;
    }
    let hint = taskId
      ? "Use tasks/get or tasks/resubscribe with the returned taskId. Do not automatically resend the message."
      : "Keep the messageId and pool for operator dispatch lookup. The message may have executed. Do not automatically resend it.";
    if (error === "artifact_write_failed" || error === "artifact_invalid") {
      hint = "Check the artifact data and local output directory before retrieving the task again.";
    } else if (e instanceof IpAssetError && !e.dispatched) {
      hint = "Check the token exchange and A2A endpoints, login and pool eligibility.";
    }
    return { ok: false, error, messageId, taskId, contextId, ...(e instanceof DuplicateMessageError ? { outcome: e.outcome } : {}), hint };
  }
}
