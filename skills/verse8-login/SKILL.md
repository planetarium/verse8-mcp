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
- Any Verse8 API call returns **401 Unauthorized** → tell the user to re-login and suggest running `bash scripts/verse8-login.sh`

## Scripts

All three live in `scripts/` at the repo root — they depend only on `bash`, `curl`, and `python3`.

| Script | What it does |
|--------|--------------|
| `scripts/verse8-login.sh` | Starts device flow, opens the browser, polls for the token, writes it to disk, then prints the profile |
| `scripts/verse8-status.sh` | Calls `/v1/auth/verify` with the stored token and prints the current identity |
| `scripts/verse8-logout.sh` | Deletes the token file |

Invoke via `bash scripts/<name>.sh` (or mark them `chmod +x` and run directly).

## How `verse8-login.sh` works

1. `POST {API}/v1/auth/device/authorize` → receives `device_code`, `user_code`, `verification_uri_complete`, `expires_in`, `interval`.
2. Prints the verification URL + user code, opens the browser (`open` on macOS, `xdg-open` on Linux).
3. Polls `POST {API}/v1/auth/device/token` with `{device_code}` every `interval` seconds.
4. On success, writes the returned `access_token` to `~/.config/verse8/token` (mode `600`, parent dir `700`).
5. Chains into `verse8-status.sh` to confirm identity.

## Token lookup order (for downstream consumers)

verse8-mcp tools resolve the token in this order (see `src/context/token.ts`):

1. `VERSE8_ACCESS_TOKEN` env var
2. `<cwd>/.verse8/token` (project-scoped, gitignored)
3. `~/.config/verse8/token` (written by this script)

## Environment overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `VERSE8_API_URL` | `https://v8-meme-api.verse8.io` | Auth/API base URL |
| `XDG_CONFIG_HOME` | `~/.config` | Parent directory for the token file |
| `VERSE8_ACCESS_TOKEN` | _(unset)_ | If set, `verse8-status.sh` uses it instead of the file |

## Device-flow error handling

| Server error | HTTP | Client action |
|--------------|------|---------------|
| `authorization_pending` | 400 | Keep polling at the current interval |
| `slow_down` | 400 | Increase interval by 5s, then continue |
| `expired_token` | 400 | Abort and tell user to re-run login |
| `access_denied` | 400 | Abort — user rejected the request in the browser |

## Typical output

```text
🔐 Verse8 device login
   API: https://v8-meme-api.verse8.io

   1. Open: https://verse8.io/device-auth?user_code=FMBN-SZNX
   2. Code: FMBN-SZNX

⏳ Waiting for authorization (up to 1800s)...
✅ Token saved → /Users/you/.config/verse8/token
👤 Snack Games
   userUid:  100000
   handle:   tester
   email:    you@example.com
   wallet:   0xffff...4cdc
   tier:     PLATINUM
   points:   4030
   role:     user
   active:   True
```

## MCP Tool Equivalents (v1 package)

If the host LLM has `@verse8/mcp` installed, it can call these tools directly instead of the shell scripts:

| Script | MCP Tool(s) | Notes |
|--------|-------------|-------|
| `verse8-login.sh` | `verse8_login_start` → `verse8_login_complete` | Split flow: start returns the URL/code immediately so the host LLM can show them to the user, then complete polls for the access token (default 120s, max 1800s). Token saved to the same location. |
| `verse8-status.sh` | `verse8_status` | Same profile output |
| `verse8-logout.sh` | (not exposed) | Delete `~/.config/verse8/token` manually |

## References

- RFC 8628 — OAuth 2.0 Device Authorization Grant: https://datatracker.ietf.org/doc/html/rfc8628
- Backend: `g2-sync/src/service/deviceAuth.service.ts`, `g2-sync/src/controller/deviceAuth.controller.ts`
- Frontend: `verse8-vibe/src/app/device-auth/page.tsx`
- Verify endpoint: `g2-sync/src/controller/auth.controller.ts` (`GET /v1/auth/verify`)