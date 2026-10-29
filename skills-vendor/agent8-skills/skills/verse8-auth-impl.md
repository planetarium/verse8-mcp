---
name: verse8-auth-impl
description: The implementation details related to Verse8 auth helpers — reading and verifying the signed-in user — should unconditionally refer to this document. The `Verse8` namespace in `@verse8/platform` parses and cryptographically verifies the `?auth=` token the Verse8 host injects into a game iframe, exposing `getUser` and `parseAuthToken`. Covers the three entry points, the `UserCredential` shape, the logged-in vs guest trust model and the `requireTrustedSigner` strict mode that entitlement checks require, the thrown error causes, the `REQUEST_LOGIN` / `REQUEST_LOGOUT` postMessage flow for opening the platform login modal from inside the game, and `OPEN_ACCOUNT_DIALOG` for opening the Verse8 account dialog (standalone store apps only, gated on `window.verse8.platform`, and recommended there because store policy requires in-app account deletion).
---

# Verse8 auth helpers — agent implementation guide

The `Verse8` namespace in `@verse8/platform` parses and cryptographically verifies the `?auth=<token>` credential the Verse8 host injects into a game iframe. Reach for it when the game needs the user's identity itself — rendering "Welcome, 0x123…" in a header, or reading the user's verse id for a call outside the VXShop API.

`VXShop.init()` already consumes this token internally, so don't wire these helpers up on VXShop's behalf. They exist for your own UI and logic.

## Install

The same `Verse8` namespace ships from all three entry points. Pick the one matching the stack.

React app (default entry):

```ts
import { Verse8 } from "@verse8/platform";
```

Vanilla / non-React (bundler):

```ts
import { Verse8 } from "@verse8/platform/vanilla";
```

Script tag (no build step) — the global build installs `window.Verse8` *and* `window.VXShop` from the same bundle, so VXShop needs no second tag:

```html
<script src="https://unpkg.com/@verse8/platform/dist/index.global.js"></script>
<script>
  // `Verse8` is attached to `window` synchronously once the global script runs,
  // so any following inline / deferred / module script can call it directly.
  console.log(Verse8.getUser().account);
</script>
```

A jsdelivr mirror is published too — swap `unpkg.com` for `cdn.jsdelivr.net/npm/...`. Pin the version in production (e.g. `@verse8/platform@2.1.0`) so a later release can't swap the bundle underneath.

## API

```ts
const Verse8 = {
  /** Read `?auth=` from `window.location.search`, verify it, and return the parsed
   *  credential. Throws when missing / malformed / expired / signature mismatch. */
  getUser(opts?: ParseAuthTokenOptions): UserCredential;

  /** Verify + parse a token string directly, without touching the URL. For server-side
   *  checks, tests, and tokens arriving from anywhere but the page URL. */
  parseAuthToken(token: string, opts?: ParseAuthTokenOptions): UserCredential;
};

interface UserCredential {
  verse: string;
  account: `0x${string}`;                      // Verse8 primary EOA
  exp: number;                                 // unix seconds
  sub?: { tier: string; exp: number } | null;  // server-signed tokens only
  follow?: boolean;                            // server-signed tokens only
  externalWallet?: {                           // server-signed tokens only
    type: "abstractSmartWallet";
    address: string;                           // e.g. the user's Abstract Global Wallet
  } | null;
}

interface ParseAuthTokenOptions {
  /** Override the trusted Verse8 signer address. Default: the production signer. */
  trustedSigner?: `0x${string}` | string;
  /** Skip the `exp` check — for tooling that replays historical tokens. */
  ignoreExpiration?: boolean;
  /** Reject self-signed (guest) tokens: accept only tokens signed by the trusted
   *  Verse8 signer, i.e. only *logged-in* users. */
  requireTrustedSigner?: boolean;
}
```

Both helpers cache the verified credential per token string, so repeat calls are cheap — signature recovery is the expensive step. A changed URL (a different `?auth=`) invalidates the cache on the next call.

## Trust model — read this before granting anything

The SDK accepts a token when the recovered signer address matches either:

- **the Verse8 production signer** — the logged-in path. When a user logs in, the Verse8 host issues the token with its server-side signing key. The server-only fields (`sub`, `follow`, `externalWallet`) are populated on this path alone.
- **the credential's own `account`** — the guest / anonymous path. A logged-out visitor's client mints a wallet and signs the credential JSON with it, proving the holder owns the address named in `account`.

Both paths yield a verified `account`; they differ in what that account *means*. For a logged-in user it's the Verse8 EOA they logged in with, vouched for by Verse8's server. For a guest it's a client-generated wallet — a different account per guest session, with no external identity behind it.

A page that sets its own `?auth=` can mint a valid self-signed token, but only for an address it holds the private key to; it can't claim another user's account. So `account` is always a real key holder — it's only the login path that ties it to a Verse8 user identity.

**Rule:** any surface tied to a Verse8 account identity — reading `sub` / `follow` / `externalWallet`, or granting an entitlement such as VXShop purchase history — must opt into strict mode:

```ts
const user = Verse8.getUser({ requireTrustedSigner: true });
```

Self-signed tokens then throw `[Verse8] signature verification failed: recovered signer ... is not the trusted Verse8 signer ...`. Catch it and route to a login prompt:

```ts
try {
  showLoggedInUI(Verse8.getUser({ requireTrustedSigner: true }));
} catch {
  showLoginPrompt();
}
```

## Errors

Both helpers throw on verification failure. Messages start with `[Verse8]` and identify the cause.

| Cause | Message contains |
|---|---|
| No `?auth=` query parameter on the page URL (`getUser` only) | `no auth query parameter found` |
| The `?auth=` value is not valid base64 | `is not valid base64` |
| The decoded payload is not valid JSON | `is not valid JSON` |
| The outer envelope lacks `msg` or `signature` | `missing msg or signature` |
| The inner credential lacks `verse` / `account` / `exp` | `missing required fields` |
| `exp` is in the past | `is expired` |
| The signature matches neither the trusted signer nor `account` | `signature verification failed` |
| The signature bytes are the wrong length or not hex | `signature verification failed: ...` |

Always wrap the call:

```ts
let user: UserCredential | null = null;
try {
  user = Verse8.getUser();
} catch (err) {
  console.error("[Verse8] no usable auth:", err.message);
  // e.g. prompt the user to reload from the Verse8 portal
}
```

## Examples

Show the current user (vanilla):

```ts
import { Verse8 } from "@verse8/platform/vanilla";

const headerEl = document.querySelector("#user-account");
try {
  headerEl.textContent = Verse8.getUser().account;
} catch {
  headerEl.textContent = "guest";
}
```

React:

```tsx
import { Verse8 } from "@verse8/platform";
import { useMemo } from "react";

function CurrentUser() {
  const user = useMemo(() => {
    try {
      return Verse8.getUser();
    } catch {
      return null;
    }
  }, []);

  return <span>{user?.account ?? "guest"}</span>;
}
```

Inspect the full credential:

```ts
const user = Verse8.getUser();
console.log(user.verse, user.account, new Date(user.exp * 1000));

if (user.sub) {
  // Subscription info — server-signed tokens only.
  console.log("subscription tier:", user.sub.tier);
}
if (user.externalWallet) {
  // Secondary on-chain identity (e.g. an Abstract Global Wallet). `account` is
  // still the Verse8 primary EOA; this is for games that need the external chain.
  console.log("external wallet:", user.externalWallet.address);
}
```

## Asking the platform to log the user in (postMessage)

A game running inside the Verse8 iframe can ask the platform to open its login modal. Use it at the in-game moment login becomes necessary — the user pressing "Buy", say — and especially in in-app browsers where Google OAuth redirects are blocked.

`REQUEST_LOGIN` asks the platform for the login UI:

```ts
window.parent.postMessage(
  { type: "REQUEST_LOGIN", payload: { loginMethods: ["email"] } },
  window.verse8.parentOrigin,
);
```

- `payload` is optional. `payload.loginMethods` is an array of `"email" | "google" | "x" | "discord"`; listing some shows only those in the modal, omitting it shows all of them. Unsupported values are ignored, and if none of the supplied values are supported all methods are shown.
- Practical tip: in Facebook, Instagram and other in-app browsers, pass `loginMethods: ["email"]` — Google OAuth redirects are blocked there.
- If the user is already logged in, no modal opens and the response is sent immediately.
- If the user dismisses the modal without logging in, **no response message arrives**.
- `window.verse8.parentOrigin` is the verified parent origin the platform's inject script exposes. Pass it as `targetOrigin` so the message only reaches the trusted host.

The platform answers the game iframe with:

```ts
{ type: "LOGIN_COMPLETED", payload: { success: true, account, auth: { type, token } } }
```

Full round trip — note the origin check on the way back, and that `auth.token` is still verified rather than trusted:

```ts
// Ask the platform to open the login modal.
window.parent.postMessage(
  { type: "REQUEST_LOGIN", payload: { loginMethods: ["email", "google"] } },
  window.verse8.parentOrigin,
);

// Wait for the result.
window.addEventListener("message", (event) => {
  if (event.origin !== window.verse8.parentOrigin) return;
  if (event.data?.type !== "LOGIN_COMPLETED") return;

  const { auth } = event.data.payload;
  try {
    const user = Verse8.parseAuthToken(auth.token);
    console.log("logged in as", user.account);
  } catch (err) {
    console.error("[Verse8] token verification failed:", err);
  }
});
```

`REQUEST_LOGOUT` asks the platform to log the user out. The platform shows a confirmation dialog and logs the user out on confirm; there is no response message, and the request is ignored when already logged out:

```ts
window.parent.postMessage({ type: "REQUEST_LOGOUT" }, window.verse8.parentOrigin);
```

## Opening the Verse8 account dialog (standalone apps only)

A Verse8 game can also ship as its own Android / iOS store app — one game, one app. In these **standalone apps**, the game can ask the app to open its Verse8 account dialog, where the user sees their account and can log out or delete it.

**Recommended for any game shipped as a standalone app: put an "Account" button on the game's settings or menu screen.** App Store Review Guideline [5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage) and Google Play's [account deletion requirement](https://support.google.com/googleplay/android-developer/answer/13327111) require that users can start account deletion inside the app, and Apple asks that the option be [easy to find, typically in account settings](https://developer.apple.com/support/offering-account-deletion-in-your-app/). The app offers log-out and account deletion on its own start and loading screens, but those are gone once the game is running, and a returning logged-in user skips the start screen. An in-game button is the easiest place for players and store reviewers to find account deletion.

Only standalone apps handle this message; the web and the Verse8 mobile app ignore it. So show the button only when `window.verse8.platform` is `"standalone-app"`:

```js
const accountButton = document.querySelector("#account-button");

// "web" on verse8.io, "app" in the Verse8 mobile app, "standalone-app" in a standalone app.
accountButton.hidden = window.verse8?.platform !== "standalone-app";

accountButton.addEventListener("click", () => {
  window.parent.postMessage({ type: "OPEN_ACCOUNT_DIALOG" }, window.verse8.parentOrigin);
});
```

- No payload, and **no response message** — don't wait for one.
- What happens next is up to the app:
  - Not logged in: it opens its login sheet instead, the same as `REQUEST_LOGIN`, and on success reloads the game with the new auth.
  - Closed without changes: nothing happens; the game keeps running.
  - Logged out or account deleted: the app goes back to its first screen, which closes the game.
- Requests sent while the dialog is already open are ignored.
- No account data reaches the game. After a login the game reloads and reads the user with `Verse8.getUser()` like on any load; keep game progress on the server as usual.
- It does nothing on the web and in the Verse8 mobile app, so **never make it part of a required flow** — it is an extra entry point, shown only in standalone apps.

## Verifying a token that didn't come from the URL

`parseAuthToken` verifies a token string directly — one arriving over postMessage, a WebSocket frame, or handed back to the client by your own server:

```ts
import { Verse8 } from "@verse8/platform/vanilla";

window.addEventListener("message", (event) => {
  if (event.data?.type !== "AUTH_REFRESH") return;
  try {
    const user = Verse8.parseAuthToken(event.data.token);
    console.log("refreshed user:", user.account);
  } catch (err) {
    console.error("[Verse8] rejected refreshed token:", err);
  }
});
```

## Custom trusted signer (staging, custom verse)

```ts
const user = Verse8.getUser({
  trustedSigner: "0xMyCustomVerse8SignerAddress...",
});
```

## Token format

For reference: the `?auth=` token is `base64(JSON.stringify({ msg, signature }))`, where `msg` is either the raw JSON `{ verse, account, exp, ... }` or that JSON base64-encoded — the SDK handles both variants. `signature` is an EIP-191 `personal_sign` over `msg`, as a 65-byte hex string (`0x` + 130 hex chars). The SDK recovers the signer address from the signature and accepts the token only when it matches the trusted Verse8 signer or the credential's `account`.

Bundle cost: signature verification adds ~7.3 KB gzipped to the script-tag bundle (via `@noble/secp256k1` + `@noble/hashes`). The ESM / CJS entries externalize both as peer deps, so a consumer's bundler can share and tree-shake them.
