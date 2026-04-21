import * as fs from "node:fs";
import { parseV8CommitMessage } from "../format/v8CommitMessage.js";

/**
 * `verse8-mcp hook commit-msg <file>` — git `commit-msg` hook entrypoint.
 *
 * Enforces the Verse8 commit-message format. A commit that drifts from the
 * format is REJECTED (exit 1), with two narrow exceptions:
 *
 *   1. Git auto-generated commits (merge / revert). Subjects starting with
 *      `Merge ` or `Revert ` pass through — the user didn't author them.
 *   2. `VERSE8_ALLOW_NONCOMPLIANT=1` env override. Lets the user commit a
 *      one-off non-V8 message intentionally (e.g., bootstrap / cleanup).
 *
 * Exits 1 on format rejection; exits 0 on pass or allowed exception.
 * Exits 1 on operational error (cannot read message file).
 *
 * `git commit --no-verify` still bypasses the hook entirely — that's git,
 * not us. The AGENTS.md template tells agents not to use --no-verify in
 * verse8 projects.
 */
export function runCommitMsgHook(messageFilePath: string | undefined): number {
  if (!messageFilePath) {
    process.stderr.write("[verse8 commit-msg] missing message-file path argument\n");
    return 1;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(messageFilePath, "utf8");
  } catch (e) {
    process.stderr.write(`[verse8 commit-msg] cannot read ${messageFilePath}: ${(e as Error).message}\n`);
    return 1;
  }

  // Strip git's comment lines before parsing (# … lines the editor leaves in).
  const stripped = raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();

  if (!stripped) {
    process.stderr.write("[verse8 commit-msg] commit message is empty — git will block this anyway\n");
    return 0;
  }

  const firstLine = stripped.split(/\r?\n/, 1)[0] ?? "";

  // Exception 1 — git auto-generated commits.
  if (/^(Merge |Revert ).+/i.test(firstLine)) {
    return 0;
  }

  // Exception 2 — explicit override via env.
  if (process.env.VERSE8_ALLOW_NONCOMPLIANT === "1") {
    process.stderr.write(
      "[verse8 commit-msg] ⚠ VERSE8_ALLOW_NONCOMPLIANT=1 — skipping V8 format enforcement for this commit.\n",
    );
    return 0;
  }

  const result = parseV8CommitMessage(stripped);
  if (result.valid) {
    // Non-blocking warnings (e.g. missing <problemStatement> / <workSummary>
    // inside <V8AssistantMessage>). We surface these to stderr so the agent
    // sees them next turn but the commit still goes through — the narrative
    // nudge should never block a valid V8-format commit from landing.
    if (result.warnings && result.warnings.length > 0) {
      process.stderr.write(
        "[verse8 commit-msg] ⚠ commit accepted but missing narrative context inside <V8AssistantMessage> for future agents:\n",
      );
      for (const w of result.warnings) {
        process.stderr.write(`  • ${w}\n`);
      }
      process.stderr.write(
        "  → Next time, pass `problemStatement` and `workSummary` to verse8_checkpoint so `git log` readers can reconstruct history without replaying every tool payload.\n",
      );
    }
    return 0;
  }

  process.stderr.write("[verse8 commit-msg] ✖ commit rejected — message does not match the Verse8 format:\n");
  for (const issue of result.issues) {
    process.stderr.write(`  • ${issue}\n`);
  }
  process.stderr.write(
    "\n" +
      "[verse8 commit-msg] verse8 projects require the V8 commit format for web/container compatibility.\n" +
      "[verse8 commit-msg] Fix options:\n" +
      "  1. Use the verse8_checkpoint MCP tool — it builds the format deterministically.\n" +
      "     (pass: userPrompt, model, provider, toolCalls)\n" +
      "  2. Build a conformant message via scripts/v8-commit-message.js < input.json > msg.txt\n" +
      "     then: git commit -F msg.txt\n" +
      "  3. Bypass this check for a single commit (not recommended for agent-driven work):\n" +
      "       VERSE8_ALLOW_NONCOMPLIANT=1 git commit -m \"...\"\n",
  );
  return 1;
}
