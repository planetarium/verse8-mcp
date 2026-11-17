# Native Router IP assets

`verse8_ip_assets` uses the existing Verse8 login to invoke native A2A pools
that explicitly authorize the user's verified agreements. It needs the Router
integration in planetarium/vicoop-router#174 and delegated federation from
planetarium/vicoop-bridge#607. This client does not create Router accounts,
provision Bridge grants, or bypass pool policy.

## Trust configuration

Set `VERSE8_ROUTER_URL` in the MCP server's process environment to an explicitly
trusted HTTPS origin, for example `https://router.example`. A path, credentials,
query or fragment is rejected. Tool arguments and provider discovery cannot
change this trust anchor. Restart the MCP server after configuration changes.
Do not configure an origin unless it is authorized to receive your Verse8 token.

The source token is loaded by the existing login mechanism and sent only to
`POST <origin>/api/verse8/token`. The client requests RFC 8693 access-token
exchange for the exact `<origin>/api/a2a/<pool>` resource and the scope of the
requested operation. It does not send the source token to A2A members, artifact
URLs, prompts or logs. The normal Verse8 API host allowlist is unchanged.

Opaque Router credentials remain only in bounded process memory. The cache key
includes source-token hash, origin, resource and scope; credentials expire after
the server lifetime (at most five minutes), with a five-second renewal margin.
Renewal exchanges the current Verse8 token again. A resource authentication
failure clears the cache but does not automatically resend the operation.
Router checks current pool policy and owns agreement/identity authorization.

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
Symlinked `.verse8` or `ip-assets` directories are rejected. Files are not
uploaded or published automatically; move/register them in the project as
appropriate and keep `.verse8/ip-assets/` out of version control.

Exchange responses are limited to 64 KiB; A2A responses/streams to 32 MiB.
Redirects are disabled for both hops. Transport, exchange and JSON-RPC errors
return fixed error codes instead of raw server bodies or credentials. No shared
provider credential fallback exists.

## Validation

`tests/unit/routerFederation.test.mjs` tests origin restrictions, source-token
separation, scopes/resources, cache identity and renewal, actual file bytes,
symlink/URI rejection, malformed responses and interrupted/chunked SSE. These
use mocked HTTP responses; they do not claim live Verse8 acceptance or actual
Router/Bridge deployment validation.
