# Verse8 for Claude

Build, preview and publish [Verse8](https://verse8.io) web games from Claude. The plugin runs the `@verse8/mcp` server, which detects Verse8 projects (repositories hosted on `gitlab.verse8.io`) and gives Claude the tools to create a project, commit in Verse8's history format, run a local preview, generate game assets, upload files to the Verse8 CDN and publish the game.

## Install

```
/plugin marketplace add planetarium/verse8-mcp
/plugin install verse8@verse8-plugins
```

Then ask Claude to make a game, for example "Make a 3D platformer on Verse8". Claude signs you in with a browser code the first time (`verse8_login_start`).

## What it does

| Tool | What it does |
| --- | --- |
| `verse8_bootstrap`, `verse8_status` | Detect whether the working directory is a Verse8 project and what to do next |
| `verse8_login_start`, `verse8_login_complete` | Sign in with a one-time browser code (OAuth device flow) |
| `verse8_new_project_start`, `verse8_new_project_confirm` | Create a Verse8 project from a template and clone it |
| `verse8_attach` | Set up an existing clone (git hooks, `AGENTS.md`, skills) |
| `verse8_checkpoint` | Commit and push in Verse8's commit-message format |
| `verse8_preview` | Commit, install dependencies and start the local dev server |
| `verse8_upload_asset`, `verse8_upload_thumbnail` | Upload game assets and store-listing images |
| `verse8_deploy` | Build the game and publish it (first release or update) |
| `image_*`, `music_generate`, `sfx_generate`, and other generators | Asset generation through Verse8's hosted services |

## Claude Code mod (2.1.287 or later)

On Claude Code 2.1.287+, the plugin also loads a small in-session module (`hooks/verse8.mjs`) that runs only inside a Verse8 project (a directory with `.verse8/project.json`):

- **Gatekeeper** — a Bash command that would bypass the Verse8 workflow is refused before it runs, and Claude is told which tool to use instead: `git commit` → `verse8_checkpoint`; `--no-verify` → not allowed; `bun run dev` / `npm run dev` / a `vite` that starts a server (not `vite build`) → `verse8_preview`. Text inside quotes or a heredoc is not read as a command. The git hooks stay in place as the hard layer; the mod only catches the mistake earlier. If the mod itself fails, the command goes through as before.
- **Preview reminder** — at the end of every turn the mod asks git what differs from the last preview (or from session start before any): files committed since then plus files the working tree changed. If anything does, a line above the prompt says how many files changed, whatever edited them (Edit, a Bash `sed -i`, a subagent, a checkpoint commit, a rebase). It disappears on the next preview.

Older Claude Code versions ignore the module and keep the MCP server only. The mod keeps its state in Claude Code's plugin state, runs only `git rev-parse`, `git diff --name-only` and `git status --porcelain` in the project, reads nothing but `.verse8/project.json`, and sends nothing anywhere.

## What it runs, sends and stores

Once you are signed in, the server lists its tools at the start of every session — in any directory — and that lookup contacts Verse8's asset services (`mcp-*-svc.verse8.io`) with your token. Everything else below happens only in a Verse8 project, or when you ask Claude to sign in or create one.

**Runs on your machine**

- `npx -y @verse8/mcp@<pinned version>` from the npm registry.
- In a Verse8 project: `git` (commit, push to `gitlab.verse8.io`), the project's package manager (`bun update` by default), `bun run dev` for previews, and `bun run build` for deploys.
- On every deploy, `npx -y @agent8/deploy` uploads the built game; for projects with a game server, `npx -y @agent8/gameserver-node` builds the server code first.

**Changes in your project**

`verse8_attach` and `verse8_new_project_confirm` install `pre-commit` and `commit-msg` git hooks that keep Verse8's commit format — an existing hook of the same name that is not Verse8's is replaced, not backed up — and write `AGENTS.md`, `CLAUDE.md`, `.claude/skills/*`, `.verse8/project.json`, `.verse8/.gitignore` and `.env` (your wallet address as `VITE_AGENT8_ACCOUNT` and the game's `VITE_AGENT8_VERSE` id; Verse8 projects commit `.env`). Files you edited are kept unless you ask to overwrite them.

A new project is cloned with a 30-day GitLab access token embedded in the `origin` URL in `.git/config`, so pushes work without a credential prompt.

Each `verse8_checkpoint` / `verse8_preview` / `verse8_deploy` commit message contains your prompt for that turn, Claude's summary of the work and a truncated record of the tool calls (inputs and outputs), and is pushed to `gitlab.verse8.io` — the same history format the Verse8 web editor writes.

**Sends data to Verse8 services** (all over HTTPS, authenticated with your Verse8 token)

| Destination | Why |
| --- | --- |
| `v8-meme-api.verse8.io` | Sign-in, profile, publishing the game listing |
| `agent8-backend.verse8.io` | Project creation, repository access tokens, asset uploads |
| `verse8.io` | Cover image and video uploads for the listing. Videos are then sent with `PUT` to a short-lived Cloudflare R2 upload URL that `verse8.io` issues (served from `contents.verse8.io`) |
| `gitlab.verse8.io` | Your project's git repository |
| `mcp-*-svc.verse8.io` | Asset generation (image, audio, sprite sheet, skybox, 3D, UI theme, cinematic, vector search, Crossramp) |
| Verse8 game backend (`verse8-game-backend-*.run.app`, via `@agent8/deploy`) | Uploading the built game and game-server code, served from `agent8-games.verse8.io` |

Prompts you give to generation tools and the files you upload are sent to these services. Apart from downloading packages from the npm registry, the plugin sends nothing to other third parties.

**Stores locally**

- Your Verse8 access token in `~/.config/verse8/token` (file mode `0600`; `$XDG_CONFIG_HOME/verse8/token` if set).
- An audit log of tool calls, with secrets redacted, in `~/.local/state/verse8/mcp.log` (`$XDG_STATE_HOME/verse8/mcp.log` or `$VERSE8_AUDIT_LOG_PATH` if set).

## Requirements

- Node.js 18.17 or later (for `npx`), `git`, and [Bun](https://bun.sh) for Verse8 projects.
- A Verse8 account with credits. Installing the plugin is free; creating a project and some asset tools require Verse8 credits. A new account gets no credits at sign-up — verify a phone number and claim the one-time welcome credit. Recharge at <https://verse8.io/settings>; an `insufficient_credits` error means the account has run out (see [Troubleshooting](https://github.com/planetarium/verse8-mcp#insufficient_credits)).

## Support

Report issues at <https://github.com/planetarium/verse8-mcp/issues>. Source code: <https://github.com/planetarium/verse8-mcp>.

## License

MIT. See [LICENSE](./LICENSE).
