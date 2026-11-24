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

What the hook checks — a commit fails if any of these is missing:

- A non-empty first line (the subject).
- A `<V8AgentMessage>` block whose body is JSON with a `messageId` and a string `status`.
- A `<V8UserMessage>` block with a user prompt after the `[Model: …]` / `[Provider: …]` lines.
- A `<V8AssistantMessage>` block (its children are optional).

A commit that passes but has no `<problemStatement>` / `<workSummary>` inside `<V8AssistantMessage>` lands with a warning.

## Full example

A complete message that the hook accepts with no warnings, as `verse8_checkpoint` builds it (the `*_ext_…` ids are minted per commit):

```text
make the jump higher

<V8AgentMessage>
{"messageId":"msg_ext_49a1a4199214525a7f166a","status":"completed","mcpServers":[],"problemStatement":"Players could not reach the second platform.","workSummary":"Raised JUMP_VELOCITY from 8 to 11 in src/player.ts."}
</V8AgentMessage>
<V8UserMessage>
[Model: claude-opus-4-7]

[Provider: anthropic]

make the jump higher
</V8UserMessage>
<V8AssistantMessage>
<problemStatement id="prs_ext_3800f0d73f77f3fd4e88cc" status="completed">`Players could not reach the second platform.`</problemStatement>

<workSummary id="wsm_ext_45a1188f790464f69f8e53" status="completed">`Raised JUMP_VELOCITY from 8 to 11 in src/player.ts.`</workSummary>

<reasoning id="prt_ext_8f695e4502bc0c897728ba" status="completed">`Raised the jump impulse; gravity is unchanged.`</reasoning>

<toolCall id="prt_ext_141e702385718b3037d4e1" name="edit" status="completed">`{"input":{"filePath":"src/player.ts"}}`</toolCall>
</V8AssistantMessage>
```

## If the commit-msg hook rejects or warns

The `commit-msg` git hook (installed by `verse8_attach`, which `verse8_new_project_confirm` runs after cloning) runs `verse8-mcp hook commit-msg` and acts on the result in two ways:

- **Format drift — rejected.** A message that is not valid V8 format makes the hook exit 1 and the commit does not land. Commit through `verse8_checkpoint` instead of a hand-written `git commit`. Merge / Revert subjects and `VERSE8_ALLOW_NONCOMPLIANT=1` are the only exceptions.
- **Missing narrative — warned.** A valid commit without `<problemStatement>` / `<workSummary>` lands, and the hook prints `⚠` lines to stderr. Read the warnings, pass the missing field next turn, move on.
