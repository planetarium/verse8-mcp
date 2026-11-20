---
name: verse8-analytics
description: Send analytics events from a Verse8 game (`gtm_event`) and know where they end up. Use when adding tracking / GA4 / funnel events to a game, when choosing event names or parameters, or when asked whether events "arrived".
---

# verse8-analytics

A game runs in an iframe on verse8.io (or a WebView in the Verse8 mobile app). It cannot load analytics itself; it hands events to the host page with `postMessage`. This skill is what the host does with them, as of verse8-vibe `95db35c9` and verse8-mobile `develop` `3f6831f`.

## Sending an event

```ts
// src/analytics.ts
export function track(event: string, params: Record<string, string | number | boolean> = {}) {
  window.parent?.postMessage(
    {
      type: "gtm_event",
      payload: { event, game_id: import.meta.env.VITE_AGENT8_VERSE, ...params },
    },
    "*",
  );
}

track("stage_clear", { stage: 3, time_ms: 41250 });
```

- `payload.event` is the event name. Everything else in `payload` becomes event parameters.
- **Add `game_id` yourself.** The host adds nothing to a game's payload — no game id, no user id. Without `game_id` the event cannot be told apart from every other game's.
- Do **not** send `platform`. The mobile app drops an event whose `platform` is set to anything but `"app"`.
- Keep values flat (string / number / boolean). Nested objects are passed through but analytics tools do not use them as parameters.

## What the host does with it

| Host | Handling | Source |
|---|---|---|
| verse8.io web | `window.dataLayer.push(payload)` as-is, from any origin. GTM decides what is forwarded to GA4. | verse8-vibe `src/app/layout.tsx:185-199` |
| Verse8 mobile app | Ignored when `event` is missing / empty or `platform` is present and not `"app"`. Otherwise sent to Firebase Analytics, Meta and TikTok: a name listed in the app's Remote Config mapping goes to that SDK's standard event, any other name is sent as a custom event; parameters are the payload minus null values. | verse8-mobile `lib/src/views/game_play/game_play_view_analytics.dart:229-256`, `lib/src/services/analytics_service.dart:327-…` |
| Local preview (`http://localhost:5173`) | Nowhere — there is no Verse8 host page around the game. | — |

`gtm_set_user_properties` (`{ type: "gtm_set_user_properties", properties: {...} }`) is also accepted by the web host and calls `gtag('set', 'user_properties', …)` when gtag is loaded (`layout.tsx:193-195`); the site loads GA4 through GTM only, so treat it as a no-op.

## Names the platform already sends — do not reuse

The web sends these itself, with `platform: "web"` and the player's `user_id` (verse8-vibe `src/utils/analytics.ts:31-45`). Game events with the same names would be counted as platform events:

- per game play, with `game_id` = verse id: `game_start`, `game_play_15s`, `game_play_30s`, `game_play_60s`, `game_play_120s`, `game_end` (`src/components/GameSessionTracker.tsx:16,194-246`)
- `game_like`, `game_comment`, `spend_vx`, `purchase`, `sign_up`, `sign_in`, `user_id_set`, `experiment_viewed`, `create_game_start`, `create_game_launch`

Prefix your own names (e.g. `hd_stage_clear`) if in doubt. GA4 / Firebase naming limits (length, characters, reserved prefixes such as `firebase_`, `google_`, `ga_`) apply on their side (see Google's GA4 event naming rules) and are not checked by Verse8.

## Checking that events arrived

There is no Verse8 API or MCP tool that reads events back, and whether GTM forwards a given custom event to GA4 is GTM container configuration, not code. From an agent you can only confirm that the game *sends*: in the browser console on verse8.io, `window.dataLayer.filter(e => e.game_id === "<verse id>")` after playing. Ask the Verse8 team for the GA4 side.
