---
name: verse8-commit
description: How to commit in Verse8 projects. Use when the host LLM is about to call `verse8_checkpoint`, or whenever the user asks to "save", "commit", or "push" changes in a gitlab.verse8.io-origin project.
---

# verse8-commit

Rules for producing commits that remain parseable by the Verse8 web / container / opencode stack. `verse8_checkpoint` **is** the entry point — this skill teaches you how to drive it.

## Core principle — "preview-delta, commit immediately"

If the user would see a visible change when they next preview the project (game screen, UI, generated asset, tweaked logic path, new file), call `verse8_checkpoint` before moving on. Do not batch preview-worthy deltas.

Skip checkpoint only when:
- The working tree is clean, or
- All changes are scratch files, local configs, or partial edits you still need to revise.

## When to call checkpoint

Call once per **user turn** that produced a preview-worthy change. One turn → one checkpoint → one commit → one push.

If you did not produce any change this turn (pure reading, debugging, explanation), do not call checkpoint.

## Required inputs

`verse8_checkpoint` builds the V8 commit-message format from these fields. Pass them every time:

| Field | Required | Content |
|-------|----------|---------|
| `userPrompt` | **yes** | The user's actual message this turn, verbatim. First non-empty line becomes the commit subject. |
| `model` | recommended | Your model id, e.g. `claude-opus-4-7`. |
| `provider` | recommended | `anthropic`, `openai`, `google-vertex`, etc. |
| `mcpServers` | recommended | Names of MCP servers whose tools you invoked, e.g. `["image"]`. Omit if you used none. |
| `reasoning` | optional | One short paragraph summarizing your reasoning. Skip if you didn't reason. |
| `toolCalls` | optional | List of `{ name, status, input?, output? }`. Tool names only is fine; `input`/`output` are optional (truncated past 4 KB). Omit entirely to let verse8-mcp auto-fill from its own log — but that log only covers verse8-mcp tools, so host Read/Write/Bash calls will be missing unless you pass them. |
| `files` | optional | Explicit staging list. Omit to stage everything (`git add -A`). |
| `projectDir` | optional | Absolute path to the project when the MCP server's cwd is the parent. |

The checkpoint tool assembles the message deterministically and commits + pushes in one step.

## What NOT to put in the commit

- **Your assistant response prose.** The message body captures reasoning + which tools were used; it does not quote your final explanation.
- **Secrets beyond `.env`.** The `.env` file is part of the verse8 convention; everything else secret belongs in `.gitignore`.
- **Manually synthesized `msg_…` / `prt_…` IDs.** verse8-mcp mints `msg_ext_…` / `prt_ext_…` itself so external and container commits stay distinguishable.

## Format at a glance

```
<subject = first line of userPrompt>

<V8AgentMessage>
{"messageId":"msg_ext_…","status":"completed","mcpServers":[…]}
</V8AgentMessage>
<V8UserMessage>
[Model: …]

[Provider: …]

<userPrompt verbatim>
</V8UserMessage>
<V8AssistantMessage>
<reasoning id="prt_ext_r…" status="completed">`…`</reasoning>    (optional)
<toolCall id="prt_ext_t…" name="…" status="…">`{…}`</toolCall>
…
</V8AssistantMessage>
```

See `sample/match-three-game` in the repo for real container-generated commits, and `src/format/v8CommitMessage.ts` for the exact grammar.

## If the commit-msg hook warns

The `commit-msg` git hook (installed by `verse8_new_project`) runs `parseV8CommitMessage` and prints `⚠` lines to stderr for any drift. It does **not** block the commit; the checkpoint still lands. Read the warnings, fix the missing field next turn, move on.

## Reference

- Builder/parser: `src/format/v8CommitMessage.ts`
- Hook: `src/cli/commitMsgHook.ts` + `hooks/commit-msg`
- Standalone CLI: `scripts/v8-commit-message.js` (takes JSON stdin, prints message)
- Example commits: `sample/match-three-game/` git history
