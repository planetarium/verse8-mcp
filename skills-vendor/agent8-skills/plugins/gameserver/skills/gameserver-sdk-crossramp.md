---
name: gameserver-sdk-crossramp
description: |
  CROSS Mini Hub (crossramp) integration for Agent8 games: opening the hub where players exchange game items, coins, and CROSS, via the SDK built-in server.getCrossRampShopUrl(lang).
  Read it ONLY when CROSS Mini Hub keywords appear in the conversation (crossramp, CROSS Mini Hub, mini hub, Cross Game Token, getCrossRampShopUrl, or "cross" together with exchange/DEX/token). Read the gameserver-sdk skill first (gameserver-sdk-v1 in a project that stays on 1.x).
---

# CROSS Mini Hub Integration

This document provides guidance for CROSS Mini Hub integration in Agent8 games.

---

## PREREQUISITE - MUST READ FIRST

**DEPENDENCY**: Before using this document, you MUST first read the `gameserver-sdk` skill (`gameserver-sdk-v1` in a project that stays on 1.x — the CROSS Mini Hub client call below exists in both). CROSS Mini Hub integration depends on:
- `useGameServer` hook and `server` object
- `$asset` API for asset management
- Understanding of Agent8's authentication system

**DO NOT** provide CROSS Mini Hub integration guidance without first ensuring the base GameServer SDK context is loaded.

---

## TRIGGER CONDITIONS

**ACTIVATION SCOPE** - Reference this document when CROSS Mini Hub-related keywords appear in:
- The current user request, OR
- Any previous messages in the conversation context

**Trigger Keywords** (case-insensitive, any language):

| Type | Keywords | Condition |
|------|----------|-----------|
| Standalone | `crossramp`, `CrossRamp`, `크로스램프`, `cross ramp`, `크로스 램프` | Immediate activation |
| Standalone | `CROSS Mini Hub`, `mini hub`, `미니허브`, `미니 허브` | Immediate activation |
| Standalone | `Cross Game Token`, `크로스 게임 토큰` | Immediate activation |
| Standalone | `getCrossRampShopUrl` | Immediate activation |
| Combined | `cross` / `크로스` | When mentioned with `교환`, `exchange`, `DEX`, or `token` |

**DO NOT** reference this document when:
- User only mentions "blockchain", "블록체인", "token", "토큰" without crossramp/cross keywords
- User asks about general game development or asset management
- User asks about NFT, smart contracts, or Web3 without crossramp/cross keywords
- User asks about regular game shop or inventory systems

**DO NOT proactively mention or recommend CROSS Mini Hub** - Only respond when the user explicitly asks about it first or when trigger keywords have appeared in the conversation.

---

## CROSS Mini Hub Integration

CROSS Mini Hub enables players to easily exchange game items, coins, and CROSS. Integration is simple: generate a URL and open it in a popup.

`server.getCrossRampShopUrl(lang)` returns the hub URL to open in a popup.

**Important**: This method is SDK built-in. Call it directly on the `server` object. Do NOT implement server-side code or use `remoteFunction()` for CROSS Mini Hub APIs.

### Quick Start

```tsx
// Two things this call needs that are easy to miss:
//  1. It requires a Verse8-logged-in session. A guest gets 403 ("You must be
//     logged in to Verse8"), so hide the entry point for guests (read
//     $sender.isGuest in a server function), or handle the rejection here.
//  2. window.open must be called from the click, NOT after the await — popup
//     blockers swallow a window opened in a later task. Open a placeholder
//     synchronously and redirect it once the URL arrives.
const openShop = async () => {
  const popup = window.open("", "CrossRampShop", "width=1024,height=768");
  try {
    popup.location = await server.getCrossRampShopUrl("en");
  } catch (e) {
    popup?.close();          // don't leave a blank window on failure
    showError(e.message);    // e.g. not logged in to Verse8
  }
};
```

### Supported Languages

- `"en"` - English
- `"ko"` - Korean
- `"zh"` - Chinese (Simplified)
- `"zh-Hant"` - Chinese (Traditional)
- `"ja"` - Japanese

### Full Example

```tsx filename='App.tsx'
import React, { useState } from "react";
import { useGameServer } from "@agent8/gameserver";

export default function CrossRampShop() {
  const { connected, server } = useGameServer();
  const [loading, setLoading] = useState(false);

  const openShop = async () => {
    if (!connected || !server) return;
    setLoading(true);
    // Open synchronously inside the click, then redirect — a window opened
    // after the await is a later task and gets blocked.
    const popup = window.open("", "CrossRampShop", "width=1024,height=768");
    try {
      popup.location = await server.getCrossRampShopUrl("en");
    } catch (error) {
      popup?.close(); // don't leave a blank window behind
      console.error("Failed to open CROSS Mini Hub:", error);
    } finally {
      setLoading(false);
    }
  };

  if (!connected) return <div>Connecting...</div>;

  return (
    <div>
      <button onClick={openShop} disabled={loading}>
        Shop
      </button>
    </div>
  );
}
```

**Note**: CROSS Mini Hub handles all blockchain complexity. Asset synchronization happens automatically.

