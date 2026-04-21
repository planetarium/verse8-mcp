import { createHash } from "node:crypto";

/**
 * V8 commit message format — deterministic builder + validator.
 *
 * Each commit captures enough context for a later agent (or human) to
 * reconstruct what the previous turn tried to do WITHOUT rereading every
 * tool payload. The body layout is:
 *
 *     <subject = first line of userPrompt>
 *
 *     <V8AgentMessage>
 *     {"messageId":"msg_…","status":"completed","mcpServers":[…],
 *      "problemStatement":"…","workSummary":"…"}
 *     </V8AgentMessage>
 *     <V8UserMessage>
 *     [Model: …]
 *
 *     [Provider: …]
 *
 *     <userPrompt verbatim>
 *     </V8UserMessage>
 *     <V8AssistantMessage>
 *     <problemStatement id="prs_…" status="completed">`…`</problemStatement>  (optional)
 *     <workSummary id="wsm_…" status="completed">`…`</workSummary>            (optional)
 *     <reasoning id="prt_…" status="completed">`…`</reasoning>                (optional)
 *     <toolCall id="prt_…" name="…" status="…">`{...}`</toolCall>             (repeat)
 *     </V8AssistantMessage>
 *
 * Container commits carry `msg_…` / `prt_…` IDs minted by the V8 backend.
 * External (Claude Code / Codex / …) commits use the `msg_ext_…` /
 * `prt_ext_…` / `prs_ext_…` / `wsm_ext_…` namespaces so history readers
 * can tell them apart.
 *
 * The assistant-message body captures every assistant-side artefact from
 * the turn: how the request was framed (`problemStatement`), what was done
 * at a high level (`workSummary`), the thought process (`reasoning`), and
 * the tool calls that were executed (`toolCall`). Per user direction, the
 * assistant's prose response is NOT included.
 *
 * `problemStatement` + `workSummary` serve as the narrative future agents
 * skim from `git log` without having to parse every payload. They are ALSO
 * duplicated as plain strings inside the `V8AgentMessage` JSON so
 * programmatic parsers can pick them up without XML processing.
 *
 * Compatibility note: earlier iterations emitted `## Problem` / `## Work`
 * markdown sections ABOVE the XML blocks. The parser still recognises that
 * legacy layout so pre-existing commits keep validating and the narrative
 * is recoverable, but the builder now ONLY emits the XML form — narrative
 * lives inside `<V8AssistantMessage>` with the rest of the assistant-side
 * artefacts.
 */

export interface V8ToolCallEntry {
  name: string;
  status?: "completed" | "error";
  input?: unknown;
  output?: unknown;
}

export interface V8CommitInput {
  userPrompt: string;
  model?: string;
  provider?: string;
  mcpServers?: string[];
  reasoning?: string;
  toolCalls?: V8ToolCallEntry[];
  /**
   * How this turn framed the user's request. Short prose. Answers
   * "what did the agent understand the user to be asking for, and what
   * constraints are in play?" Reading just the problemStatements of
   * recent commits should give a future agent the narrative arc of the
   * project without replaying every toolCall payload.
   */
  problemStatement?: string;
  /**
   * What the agent actually did this turn. Short prose, 1–5 sentences.
   * Higher level than `reasoning` (which is about thought process) and
   * `toolCalls` (which are machine-level payloads). Example:
   *   "Replaced the stubbed verse8_new_project with a 2-tool
   *   start/confirm split, added agent8-backend client + mock, and
   *   documented the new flow in AGENTS.md."
   */
  workSummary?: string;
  /** Override the hash seed for stable IDs in tests. */
  idSeed?: string;
}

const EXTERNAL_ID_PREFIX = "ext_";
const MAX_INLINE_PAYLOAD_CHARS = 4000;
const MAX_SUBJECT_CHARS = 200;
// Narrative fields (problemStatement / workSummary) land in git log + are
// read by future agents. They should be short prose, not dumps — cap at
// 8 KB each so a runaway LLM can't balloon the commit body.
const MAX_NARRATIVE_CHARS = 8000;
const ID_HASH_LEN = 22;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function deterministicId(
  kind: "msg" | "prt_r" | "prt_t" | "prs" | "wsm",
  seed: string,
  index: number,
): string {
  const h = sha256Hex(`${kind}:${seed}:${index}`).slice(0, ID_HASH_LEN);
  return `${kind.split("_")[0]}_${EXTERNAL_ID_PREFIX}${h}`;
}

function truncatePayload(s: string): string {
  return s.length > MAX_INLINE_PAYLOAD_CHARS
    ? s.slice(0, MAX_INLINE_PAYLOAD_CHARS) + " ...(truncated)"
    : s;
}

function truncateNarrative(s: string): string {
  return s.length > MAX_NARRATIVE_CHARS
    ? s.slice(0, MAX_NARRATIVE_CHARS) + " ...(truncated)"
    : s;
}

function firstLineSubject(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > MAX_SUBJECT_CHARS ? line.slice(0, MAX_SUBJECT_CHARS - 1) + "…" : line;
}

/**
 * Deterministic given input — same input produces byte-identical output.
 */
export function buildV8CommitMessage(input: V8CommitInput): string {
  if (!input.userPrompt || !input.userPrompt.trim()) {
    throw new Error("buildV8CommitMessage: userPrompt is required");
  }

  const seed = input.idSeed ?? sha256Hex(input.userPrompt);
  const messageId = deterministicId("msg", seed, 0);
  const subject = firstLineSubject(input.userPrompt);

  const problemStatement =
    input.problemStatement && input.problemStatement.trim().length > 0
      ? truncateNarrative(input.problemStatement.trim())
      : undefined;
  const workSummary =
    input.workSummary && input.workSummary.trim().length > 0
      ? truncateNarrative(input.workSummary.trim())
      : undefined;

  const agentMeta: Record<string, unknown> = {
    messageId,
    status: "completed",
    mcpServers: input.mcpServers ?? [],
  };
  if (problemStatement) agentMeta.problemStatement = problemStatement;
  if (workSummary) agentMeta.workSummary = workSummary;
  const agentMessage = JSON.stringify(agentMeta);

  const userMessageParts: string[] = [];
  if (input.model) userMessageParts.push(`[Model: ${input.model}]`);
  if (input.provider) userMessageParts.push(`[Provider: ${input.provider}]`);
  userMessageParts.push(input.userPrompt);
  const userMessageBody = userMessageParts.join("\n\n");

  const assistantLines: string[] = [];
  // Narrative artefacts come FIRST inside V8AssistantMessage so a reader
  // scrolling the commit sees "what I understood / what I did" before
  // diving into reasoning + tool payloads. The narrative is ALSO
  // duplicated inside V8AgentMessage JSON (agentMeta above) for
  // programmatic parsers that don't want XML.
  if (problemStatement) {
    const psid = deterministicId("prs", seed, 0);
    assistantLines.push(
      `<problemStatement id="${psid}" status="completed">\`${problemStatement}\`</problemStatement>`,
    );
  }
  if (workSummary) {
    const wsid = deterministicId("wsm", seed, 0);
    assistantLines.push(
      `<workSummary id="${wsid}" status="completed">\`${workSummary}\`</workSummary>`,
    );
  }
  if (input.reasoning && input.reasoning.trim()) {
    const rid = deterministicId("prt_r", seed, 0);
    const body = truncatePayload(input.reasoning.trim());
    assistantLines.push(`<reasoning id="${rid}" status="completed">\`${body}\`</reasoning>`);
  }
  if (input.toolCalls && input.toolCalls.length > 0) {
    input.toolCalls.forEach((tc, i) => {
      const tid = deterministicId("prt_t", seed, i);
      const status = tc.status ?? "completed";
      let body = "";
      const payload: Record<string, unknown> = {};
      if (tc.input !== undefined) payload.input = tc.input;
      if (tc.output !== undefined) payload.output = tc.output;
      if (Object.keys(payload).length > 0) {
        body = `\`${truncatePayload(JSON.stringify(payload))}\``;
      }
      assistantLines.push(
        `<toolCall id="${tid}" name="${tc.name}" status="${status}">${body}</toolCall>`,
      );
    });
  }

  const assistantInner =
    assistantLines.length > 0 ? `\n${assistantLines.join("\n\n")}\n` : "\n";

  // Narrative lives INSIDE V8AssistantMessage (as <problemStatement> /
  // <workSummary> XML tags above) — the container's assistant-side
  // artefacts all nest in one place so the commit structure stays
  // self-contained. The narrative is ALSO duplicated inside the
  // V8AgentMessage JSON so programmatic parsers don't have to walk XML.
  return [
    subject,
    "",
    "<V8AgentMessage>",
    agentMessage,
    "</V8AgentMessage>",
    "<V8UserMessage>",
    userMessageBody,
    "</V8UserMessage>",
    `<V8AssistantMessage>${assistantInner}</V8AssistantMessage>`,
  ].join("\n");
}

/**
 * Parser / validator for the V8 commit message format.
 *
 * `issues` lists soft warnings — the pre-commit hook surfaces these to the
 * user without blocking the commit (per user direction "알려주면 좋겠습니다").
 */

export interface V8ParseResult {
  valid: boolean;
  issues: string[];
  /**
   * Non-blocking warnings — surfaced to the user but don't affect `valid`.
   * Used for "your commit is structurally fine but missing narrative that
   * future agents will need" signals.
   */
  warnings: string[];
  subject?: string;
  agentMessage?: {
    messageId?: string;
    status?: string;
    mcpServers?: string[];
    problemStatement?: string;
    workSummary?: string;
  };
  userPrompt?: string;
  model?: string;
  provider?: string;
  toolCallNames?: string[];
  hasReasoning?: boolean;
  /** Narrative fields — preferred from V8AgentMessage JSON, else scraped from the markdown body. */
  problemStatement?: string;
  workSummary?: string;
}

const AGENT_RE = /<V8AgentMessage>\s*([\s\S]*?)\s*<\/V8AgentMessage>/;
const USER_RE = /<V8UserMessage>\s*([\s\S]*?)\s*<\/V8UserMessage>/;
const ASSISTANT_RE = /<V8AssistantMessage>([\s\S]*?)<\/V8AssistantMessage>/;
const TOOL_CALL_RE = /<toolCall[^>]*\sname="([^"]+)"[^>]*>/g;
const REASONING_RE = /<reasoning[^>]*>/;
const MODEL_LINE_RE = /\[Model:\s*([^\]]+)\]/;
const PROVIDER_LINE_RE = /\[Provider:\s*([^\]]+)\]/;
// Canonical XML tags — narrative lives inside V8AssistantMessage as
// <problemStatement> / <workSummary> with a backtick-quoted body matching
// the reasoning/toolCall convention.
const PROBLEM_STATEMENT_XML_RE =
  /<problemStatement[^>]*>\s*`([\s\S]*?)`\s*<\/problemStatement>/;
const WORK_SUMMARY_XML_RE =
  /<workSummary[^>]*>\s*`([\s\S]*?)`\s*<\/workSummary>/;
// Legacy fallback — earlier iterations emitted narrative as top-level
// markdown sections above the XML blocks. Keep recognising them so
// pre-existing commits stay parseable without rewrite.
const PROBLEM_SECTION_RE = /^##\s+Problem\s*\n([\s\S]*?)(?=\n##\s|\n<|$)/m;
const WORK_SECTION_RE = /^##\s+Work\s*\n([\s\S]*?)(?=\n##\s|\n<|$)/m;

export function parseV8CommitMessage(msg: string): V8ParseResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  const subject = (msg.split(/\r?\n/)[0] ?? "").trim();
  if (!subject) issues.push("missing subject line (first line of commit is empty)");

  let agentMessage: V8ParseResult["agentMessage"];
  const agentMatch = msg.match(AGENT_RE);
  if (!agentMatch) {
    issues.push("missing <V8AgentMessage> block");
  } else {
    try {
      const parsed = JSON.parse(agentMatch[1].trim());
      agentMessage = parsed;
      if (!parsed?.messageId) issues.push("V8AgentMessage.messageId missing");
      if (typeof parsed?.status !== "string") issues.push("V8AgentMessage.status missing or not a string");
    } catch {
      issues.push("V8AgentMessage body is not valid JSON");
    }
  }

  const userMatch = msg.match(USER_RE);
  let userPrompt: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  if (!userMatch) {
    issues.push("missing <V8UserMessage> block");
  } else {
    const body = userMatch[1];
    const m = body.match(MODEL_LINE_RE);
    if (m) model = m[1].trim();
    const p = body.match(PROVIDER_LINE_RE);
    if (p) provider = p[1].trim();
    const promptBody = body
      .replace(MODEL_LINE_RE, "")
      .replace(PROVIDER_LINE_RE, "")
      .trim();
    userPrompt = promptBody || undefined;
    if (!userPrompt) issues.push("V8UserMessage has no user prompt body");
  }

  let toolCallNames: string[] = [];
  let hasReasoning = false;
  const assistMatch = msg.match(ASSISTANT_RE);
  if (!assistMatch) {
    issues.push("missing <V8AssistantMessage> block");
  } else {
    const body = assistMatch[1];
    toolCallNames = [...body.matchAll(TOOL_CALL_RE)].map((m) => m[1]);
    hasReasoning = REASONING_RE.test(body);
  }

  // Narrative extraction, in order of preference:
  //   1. V8AgentMessage JSON (programmatic duplicate — cheapest to read)
  //   2. <problemStatement> / <workSummary> XML tags inside V8AssistantMessage (canonical shape)
  //   3. `## Problem` / `## Work` markdown sections (legacy layout preserved for back-compat)
  let problemStatement: string | undefined;
  let workSummary: string | undefined;
  if (agentMessage) {
    if (typeof agentMessage.problemStatement === "string" && agentMessage.problemStatement.trim().length > 0) {
      problemStatement = agentMessage.problemStatement.trim();
    }
    if (typeof agentMessage.workSummary === "string" && agentMessage.workSummary.trim().length > 0) {
      workSummary = agentMessage.workSummary.trim();
    }
  }
  if (!problemStatement) {
    const m = msg.match(PROBLEM_STATEMENT_XML_RE);
    if (m && m[1]) {
      const body = m[1].trim();
      if (body.length > 0) problemStatement = body;
    }
  }
  if (!workSummary) {
    const m = msg.match(WORK_SUMMARY_XML_RE);
    if (m && m[1]) {
      const body = m[1].trim();
      if (body.length > 0) workSummary = body;
    }
  }
  if (!problemStatement) {
    const m = msg.match(PROBLEM_SECTION_RE);
    if (m && m[1]) {
      const body = m[1].trim();
      if (body.length > 0) problemStatement = body;
    }
  }
  if (!workSummary) {
    const m = msg.match(WORK_SECTION_RE);
    if (m && m[1]) {
      const body = m[1].trim();
      if (body.length > 0) workSummary = body;
    }
  }

  // Non-blocking warning: V8-format commits (with a userPrompt present)
  // should carry narrative. Don't flag it for non-V8 commits (e.g. merge /
  // revert / bootstrap messages) which legitimately lack a user prompt.
  if (userPrompt) {
    if (!problemStatement) {
      warnings.push(
        "missing <problemStatement> inside <V8AssistantMessage> — a future agent reading git log will not know how this turn framed the user's request. Pass `problemStatement` to verse8_checkpoint.",
      );
    }
    if (!workSummary) {
      warnings.push(
        "missing <workSummary> inside <V8AssistantMessage> — a future agent reading git log will not know what this turn changed at a glance. Pass `workSummary` to verse8_checkpoint.",
      );
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    subject,
    agentMessage,
    userPrompt,
    model,
    provider,
    toolCallNames,
    hasReasoning,
    problemStatement,
    workSummary,
  };
}
