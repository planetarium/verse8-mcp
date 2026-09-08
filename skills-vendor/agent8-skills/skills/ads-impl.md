---
name: ads-impl
description: The implementation details related to Verse8 Ads (rewarded video and interstitial ads) should unconditionally refer to this document. Verse8 Ads is the platform's advertising system — a game installs `@verse8/ads`, calls `showRewarded` or `showInterstitial` from a user gesture, and branches on the returned status. Covers the `AdResult` states and error codes, the rules for triggering ads and disabling the button while busy, and the optional server-side verification flow against the ads-verifier endpoint that must be used before granting valuable rewards.
---

# Verse8 Ads — agent implementation guide

Two surfaces for two audiences. Implement the client side first; add server-side verification only when the reward is valuable.

## SDK (`@verse8/ads`) — client side

Install:

```bash
pnpm add @verse8/ads
```

Or via CDN — the bundle exposes a single `Verse8Ads` global:

```html
<script
  src="https://unpkg.com/@verse8/ads@latest/dist/index.global.js"
  crossorigin="anonymous"
></script>
```

Show a rewarded ad. Trigger from a user gesture (click/tap); never auto-show on page load.

```tsx
import { Verse8Ads } from "@verse8/ads";

const result = await Verse8Ads.showRewarded({ placementId: "revive-hero" });

switch (result.status) {
  case "rewarded":
    // User watched the ad. Grant the in-game reward.
    // (Optionally verify server-side first — see below.)
    grantRewardLocally();
    break;
  case "dismissed":
    ui.toast("Watch the full ad to earn the reward");
    break;
  case "failed":
    if (result.error.code === "busy") return;             // ignore — disable button while busy
    if (result.error.code === "unsupported_env") return;  // hide ad UI for the session
    ui.toast("Ad unavailable, please try again later");
    break;
}
```

Result shape:

```ts
type AdResult =
  | { status: "rewarded";  reward: { amount: number; type: string }; requestId: string }
  | { status: "dismissed"; requestId: string }
  | { status: "failed";    error: { code: "busy" | "timeout" | "unsupported_env" | "platform_error"; message?: string }; requestId: string };
```

Interstitials follow the same call shape (`Verse8Ads.showInterstitial({ placementId })`) but never grant rewards — don't branch on the result.

Rules:
- Trigger from a user gesture. Never auto-show.
- Disable the button while busy — the SDK only shows one ad at a time.
- Hide the button when `unsupported_env` arrives.
- Use `@latest` (e.g. the CDN URL above); the SDK is kept backward-compatible.
- `result.reward.amount` is a UX hint, not the grant amount.

## Server-side verification (optional)

Skip for cosmetic / low-stakes rewards. Implement for currency, premium items, rare drops.

> **Coming soon:** native Agent8 GameServer SDK helper for server-side ad verification. Until then (or if you run your own game server), use the flow below.

Endpoint (no auth, read-only):

```
GET https://ads-verifier.verse8.io/ads/status?requestId=<requestId>
```

| `body.status` | Action |
|---|---|
| `verified` | Grant the reward |
| `dismissed` / `failed` | Don't grant |
| `pending` (HTTP 202) | Retry shortly with bounded budget |

Server pattern (any fetch-capable runtime):

```ts
const REWARD_TABLE = {
  "revive-hero":        { amount: 1, type: "revive"  },
  "double-stage-coins": { amount: 1, type: "coin-2x" },
};

async function checkVerified(requestId, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(
      `https://ads-verifier.verse8.io/ads/status?requestId=${encodeURIComponent(requestId)}`,
    );
    if (!res.ok && res.status !== 202) return false;
    const body = await res.json();
    if (body.status === "verified") return true;
    if (body.status === "pending") {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    return false; // dismissed | failed
  }
  return false;
}

async function claimAdReward({ account, requestId, placementId }) {
  if (typeof requestId !== "string" || !requestId) throw new Error("missing_requestId");
  const reward = REWARD_TABLE[placementId];
  if (!reward) throw new Error("unknown_placement");

  if (!(await checkVerified(requestId))) throw new Error("verification_failed");

  // Atomic insert + credit. Unique constraint on (account, requestId) makes
  // replays fail at the database layer; rollback prevents double-credit.
  try {
    await db.transaction(async (tx) => {
      await tx.adGrants.insert({ account, requestId, placementId });
      await tx.playerWallet.credit(account, reward.type, reward.amount);
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new Error("already_granted");
    throw err;
  }

  return { success: true };
}
```

Server rules:
- Match `placementId` against the table; refuse unknown placements.
- Grant amount comes from the server-side `REWARD_TABLE`, not from the client or the verifier response.
- Replay protection comes from a unique constraint on `(account, requestId)` inside the same transaction that credits the reward.
- Daily caps and other game-economy limits live in your normal player-state code; they're not part of `/ads/status` verification.
