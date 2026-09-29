# Verse8 for Claude

Build, preview and publish [Verse8](https://verse8.io) web games from Claude. The plugin runs the `@verse8/mcp` server, which detects Verse8 projects (repositories hosted on `gitlab.verse8.io`) and gives Claude the tools to create a project, commit in Verse8's history format, run a local preview, generate game assets, upload files to the Verse8 CDN and publish the game.

## Install

```
/plugin marketplace add planetarium/verse8-mcp
/plugin install verse8@verse8
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

## What it runs, sends and stores

Everything below happens only in a Verse8 project, or when you ask Claude to sign in or create one.

**Runs on your machine**

- `npx -y @verse8/mcp@<pinned version>` from the npm registry.
- In a Verse8 project: `git` (commit, push to `gitlab.verse8.io`), the project's package manager (`bun update` by default), `bun run dev` for previews, and `bun run build` for deploys.
- For projects with a game server, `npx -y @agent8/gameserver-node@<pinned>` and `npx -y @agent8/deploy@<pinned>` build and upload the server code. Versions are pinned in the server package.

**Changes in your project**

`verse8_attach` and `verse8_new_project_confirm` install `pre-commit` and `commit-msg` git hooks that keep Verse8's commit format, and write `AGENTS.md`, `CLAUDE.md`, `.claude/skills/*` and `.verse8/project.json`. Files you edited are kept unless you ask to overwrite them.

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

- Your Verse8 access token in `~/.config/verse8/token` (file mode `0600`).
- An audit log of tool calls, with secrets redacted, in `~/.local/state/verse8/mcp.log`.

## Requirements

- Node.js 18.17 or later (for `npx`), `git`, and [Bun](https://bun.sh) for Verse8 projects.
- A Verse8 account.

## Support

Report issues at <https://github.com/planetarium/verse8-mcp/issues>. Source code: <https://github.com/planetarium/verse8-mcp>.

## License

MIT. See [LICENSE](./LICENSE).
