# IP asset access

`verse8_ip_assets` uses the existing Verse8 login to invoke authorized A2A pools.

## Endpoint configuration

Set two HTTPS URLs in the MCP server environment and restart the server.
Allowed hosts are `verse8.io`, its subdomains, loopback, and exactly
`vicoop-router.fly.dev`. Both URLs must pass validation before token exchange.
Both URLs may include a path. Credentials, queries and fragments are rejected.

- `VERSE8_TOKEN_EXCHANGE_URL` is the full RFC 8693 token endpoint. Configure
  a service trusted to receive the original Verse8 token.
- `VERSE8_A2A_BASE_URL` is the base URL for the pools. The client appends
  the pool name and uses that exact URL as the exchange request's `resource`.
  Only the exchanged bearer token is sent to the pool.

The endpoints may use different hosts. The pool must accept tokens from the
configured authorization server. For the vicoop-router deployment, set the
token endpoint to `https://<host>/api/verse8/token` and the pool base to
`https://<host>/api/a2a` (planetarium/vicoop-router#174 and
planetarium/vicoop-bridge#607).

The client requests the scope for the selected operation and requires the
response to confirm it. It accepts bearer tokens with a lifetime of up to
five minutes. The in-memory cache is keyed by token endpoint, resource,
scope and source credential hash. Entries are renewed within five seconds
of expiry. An A2A authentication failure clears the cache.

## Operations

After `verse8_login_start` and `verse8_login_complete`, invoke:

```json
{
  "pool": "maple-assets",
  "method": "message/stream",
  "text": "Prepare the requested character sprite as an inline file artifact.",
  "projectDir": "/absolute/path/to/project"
}
```

`message/send` also accepts `text`. Preserve the returned `messageId`, `taskId`
and `contextId`. To send a follow-up, supply the existing `taskId`/`contextId`
with new text. A new message gets a new message ID unless one was explicitly
supplied. For `tasks/get`, `tasks/cancel` or `tasks/resubscribe`, supply `pool`
and `taskId`; omit message-specific fields.

Streaming is consumed within the MCP call (up to 120 seconds), not relayed as
MCP notifications. On interruption, the result preserves any observed task ID
and the original message ID. Query or resubscribe to that task. **Never resend
an ambiguous message automatically**: it may already have executed. If no task
ID was received, report the ambiguity rather than minting a fresh message ID
and silently duplicating work.

## Files

Only inline A2A file bytes are accepted. Provider file URIs are rejected and are
never fetched or returned. Complete inline files are saved privately under
`<projectDir>/.verse8/ip-assets/<task-digest>/`, with sanitized, content-addressed names and
exclusive writes. Repeated task snapshots reuse identical verified files rather
than writing duplicate copies. The response contains file paths and sizes, task state and
text messages, not base64 file bodies. Incomplete streamed artifacts are listed
but not written; use task retrieval/resubscription to obtain complete output.
Symlinked `.verse8` or `ip-assets` directories are rejected. Before saving files, the client ensures
`.verse8/ip-assets/.gitignore` excludes all downloads from checkpoint staging.
Attach also excludes the directory in `.verse8/.gitignore`.

Exchange responses are limited to 64 KiB; A2A responses/streams to 32 MiB.
Redirects are disabled for both hops. Transport, exchange and JSON-RPC errors
return fixed error codes instead of raw server bodies or credentials. No shared
provider credential fallback exists.

## Validation

`tests/unit/ipAssets.test.mjs` tests independent endpoint configuration, source-token
separation, scopes/resources, cache identity and renewal, actual file bytes,
symlink/URI rejection, malformed responses and interrupted/chunked SSE. These
use mocked HTTP responses; they do not claim live Verse8 acceptance or actual
production deployment validation.
