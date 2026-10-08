# Security Policy

## Supported versions

Security fixes land on the latest minor release of [`@verse8/mcp`](https://www.npmjs.com/package/@verse8/mcp) and the `verse8` Claude Code plugin that pins it. Upgrade to the latest version before reporting.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub: open the [Security tab](https://github.com/planetarium/verse8-mcp/security) and choose **Report a vulnerability**. Only the maintainers can see the report.

Please include:

- the `@verse8/mcp` version you run (the version in your MCP config, or the plugin version shown by `/plugin`)
- the host you run it in (Claude Code, Codex, Cursor, …) and your OS
- steps to reproduce, and what an attacker gains

We will acknowledge the report, keep you updated in the advisory thread, and credit you in the advisory unless you ask us not to.

## Scope

In scope: the code in this repository — the MCP server, its git hooks, the bundled skills and the Claude Code plugin. Typical examples:

- a Verse8 access token or GitLab token leaking into a shell, a log, a commit, a tool response or the published package
- a URL override or backend response that sends credentials to a host outside the allow-list
- path traversal that reads or writes outside the project directory

Out of scope: vulnerabilities in the Verse8 web services themselves, and in third-party MCP hosts. Report Verse8 service issues the same way and we will route them to the right team.

The project's security posture is described in [docs/security.md](./docs/security.md). What the plugin runs, sends and stores is listed in [plugins/verse8/README.md](./plugins/verse8/README.md).
