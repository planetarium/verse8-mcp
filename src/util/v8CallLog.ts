/**
 * In-memory ring buffer of MCP tool calls observed in the current server
 * process. `verse8_checkpoint` uses this as a fallback when the host LLM
 * omits the `toolCalls` field — we can at least record which of OUR tools
 * were invoked this turn. Host-only tools (Read/Write/Bash in Claude Code)
 * are invisible here; the LLM must pass those explicitly if it wants them
 * recorded.
 *
 * Scope is per-projectDir within a single process. A long-lived MCP session
 * that spans multiple verse8 projects (e.g. startOnly mode, multi-project
 * agent) would otherwise bleed project A's tool calls into project B's next
 * checkpoint commit. Callers pass `projectDir` at record + drain time; calls
 * without a projectDir live in a shared "global" bucket for back-compat.
 */

export interface LoggedCall {
  name: string;
  status: "completed" | "error";
  input?: unknown;
  /** Compact output — kept short; full output may be truncated by the V8 builder. */
  output?: unknown;
  timestampMs: number;
}

export interface RecordInput extends LoggedCall {
  /** Project root this call belongs to. Omit for global/no-project context. */
  projectDir?: string;
}

const CAPACITY = 200;
const GLOBAL_KEY = "__global__";

interface Bucket {
  buffer: LoggedCall[];
  lastCheckpointMs: number;
}

const buckets: Map<string, Bucket> = new Map();

function getBucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { buffer: [], lastCheckpointMs: 0 };
    buckets.set(key, b);
  }
  return b;
}

function bucketKey(projectDir?: string): string {
  return projectDir && projectDir.length > 0 ? projectDir : GLOBAL_KEY;
}

export function recordToolCall(entry: RecordInput): void {
  const { projectDir, ...rest } = entry;
  const bucket = getBucket(bucketKey(projectDir));
  bucket.buffer.push(rest);
  if (bucket.buffer.length > CAPACITY) {
    bucket.buffer = bucket.buffer.slice(-CAPACITY);
  }
}

/**
 * Calls recorded since the previous `drainSinceLastCheckpoint()` invocation
 * for the given projectDir. Omit `projectDir` to drain the global bucket.
 */
export function drainSinceLastCheckpoint(projectDir?: string): LoggedCall[] {
  const bucket = getBucket(bucketKey(projectDir));
  const since = bucket.lastCheckpointMs;
  bucket.lastCheckpointMs = Date.now();
  return bucket.buffer.filter((e) => e.timestampMs > since);
}

export function peekAll(projectDir?: string): LoggedCall[] {
  return getBucket(bucketKey(projectDir)).buffer.slice();
}

export function clearLog(): void {
  buckets.clear();
}
