---
name: verse8-login
description: Log in to Verse8 via RFC 8628 device flow, check identity, and log out. Use when the user asks to "verse8 login", "verse8 logout", "verse8 status", "내 verse8 프로필", or whenever a Verse8 API call returns 401 Unauthorized.
---

# verse8-login

Device Authorization Grant (RFC 8628) login for Verse8. The access token is stored on disk and consumed by every authenticated verse8-mcp tool (`verse8_status`, `verse8_new_project_*`, `verse8_attach`, `verse8_checkpoint`, `verse8_preview`, and every image / audio / skill proxy tool).

## When to invoke

- User says: "verse8 login" / "verse8 로그인" / "verse8로 로그인해줘"
- User says: "verse8 status" / "who am I on verse8" / "내 verse8 프로필"
- User says: "verse8 logout"
- Any Verse8 API call returns **401 Unauthorized** → tell the user to re-login and start the login below

## Tools

| Intent | Tool(s) | Notes |
|--------|---------|-------|
| Log in | `verse8_login_start` → `verse8_login_complete` | Split flow: start returns the URL/code immediately so you can show them to the user, then complete polls for the access token (default 120s, max 1800s). |
| Who am I | `verse8_status` | Profile from `GET /v1/auth/verify`, plus this project's attachment state |
| Log out | (no tool) | Delete the token file (`${XDG_CONFIG_HOME:-~/.config}/verse8/token`) |

## How login works

1. `verse8_login_start` calls `POST {API}/v1/auth/device/authorize` and returns `verification_uri_complete`, `user_code`, `device_code`, `expires_in`, `interval`.
2. Show `verification_uri_complete` (or `verification_uri` when it is absent) and `user_code` to the user and ask them to approve in the browser.
3. `verse8_login_complete` with the same `device_code` polls `POST {API}/v1/auth/device/token`, starting every 5 seconds and waiting 5 seconds longer each time the server answers `slow_down`. It is safe to call again with the same `device_code` if it times out before the user approves.
4. On success it writes the returned `access_token` to `${XDG_CONFIG_HOME:-~/.config}/verse8/token` (mode `600`).
5. Call `verse8_status` to confirm the identity.

## Token lookup order (for downstream consumers)

verse8-mcp tools resolve the token in this order:

1. `VERSE8_ACCESS_TOKEN` env var
2. `<cwd>/.verse8/token` (project-scoped, gitignored)
3. `${XDG_CONFIG_HOME:-~/.config}/verse8/token` (written by `verse8_login_complete`)

## Environment overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `VERSE8_API_URL` | `https://v8-meme-api.verse8.io` | Auth/API base URL |
| `XDG_CONFIG_HOME` | `~/.config` | Parent directory for the token file |
| `VERSE8_ACCESS_TOKEN` | _(unset)_ | If set, tools use it instead of the token files |

## Device-flow error handling

| Server error | HTTP | Client action |
|--------------|------|---------------|
| `authorization_pending` | 400 | Keep polling at the current interval |
| `slow_down` | 400 | Increase interval by 5s, then continue |
| `expired_token` | 400 | Abort and tell user to re-run login |
| `access_denied` | 400 | Abort — user rejected the request in the browser |

## References

- RFC 8628 — OAuth 2.0 Device Authorization Grant: https://datatracker.ietf.org/doc/html/rfc8628
