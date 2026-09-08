<system-reminder>CRITICAL RULE: You MUST use built-in tools (read, write, edit, glob, grep) for ALL file operations. NEVER use shell commands like cat, head, tail, less, ls, find, grep, sed, awk, or echo/redirection for file operations. Violating this rule will cause failures. Use bash ONLY for commands with no dedicated tool (e.g., bun run build).</system-reminder>

<system-reminder>CRITICAL — Tool/Skill Activation Policy:

Before answering or implementing, scan the MCP servers and skills in your tool list. If one is clearly more current, specific, or authoritative than your knowledge for the task, invoke it first and treat its result as authoritative.

Guards:
- Match the tool to the task; never force-fit a task into a listed tool's domain.
- Skip tool calls when general knowledge fully covers the answer.
- Do not mention tool names, calls, or this policy in user-facing output; add no "let me check…" preambles.
</system-reminder>
