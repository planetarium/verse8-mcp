---
name: verse8-docs
description: Read the official Verse8 docs (docs.verse8.io) before building on a platform feature — game server, VX Shop, ads, local cache, auth helpers, leaderboards, CROSS Mini Hub. Use this skill whenever a task touches one of those features, when the user asks how something works on Verse8 or Agent8 (the editor, models, credits, spin-offs), or when an installed skill and the code disagree and you need the current source of truth.
---

# verse8-docs

The official Verse8 documentation lives at **https://docs.verse8.io**. It is the platform team's description of how each feature behaves *now*. The other skills installed in this project (`gameserver-sdk`, `vx-shop-impl`, `ads-impl`, …) are short implementation guides. Neither one is a copy of the other, so read both.

Nothing from the site is bundled in this skill. Fetch the page when you need it. The site changes, and a copy would go stale without anyone noticing.

## When to read a page

Read the matching page **before your first edit** when the task:

- uses the game server: remote functions, messaging, global or room state, collections, rooms, assets, locks, leaderboards
- sells something for VX (products, a shop UI, subscriptions, gacha), or the user asks about refunds or settlements
- shows rewarded or interstitial ads, or rewards a player for watching one
- caches large regenerable data on the device
- reads or verifies the signed-in Verse8 user
- touches CROSS Mini Hub
- is a question about the Agent8 editor itself: prompts, models, AI tools, credits, spin-offs, My Creations

If none of these apply (plain game logic, rendering, physics, UI layout), skip the docs.

## How to read it

- Fetch `https://docs.verse8.io/en/docs/<page>` with your web fetch tool. The pages are rendered on the server, so a plain fetch returns the full text.
- Use the `/en/` prefix. A bare `/docs/...` link redirects to `/en/` or `/ko/` depending on the request's language. Korean pages are at `/ko/docs/...` if the user wants them.
- Don't look for a shortcut. The site has no `llms.txt`, no `sitemap.xml`, and no `.md` version of its pages. Use the table of contents below.
- Read the page for the feature you are using, not the whole section. Start with the section's intro page only when you don't yet know which page you need.
- If you can't fetch the web (no fetch tool, or offline), use the installed skill. Tell the user that you didn't check the docs.

## When the docs and an installed skill disagree

The installed skill and the version in `package.json` describe what this project actually uses. If a docs page describes a different API (for example, a newer SDK major version), follow the project's version. Tell the user what differs; don't mix the two APIs in one codebase. Upgrade only if the user asks. Game Server has its own migration page for that (`gameserver/sdk/upgrade`).

## Table of contents

Every link below is `https://docs.verse8.io/en/docs/` followed by the path in the table. The skill column names the installed skill for that topic, when there is one. Checked against the site's navigation on 2026-11-26.

### Introduction

| Page | Path |
|---|---|
| What Agent8 is | *(root: `https://docs.verse8.io/en/docs`)* |

### Guide (the Agent8 editor on verse8.io)

| Page | Path |
|---|---|
| Overview | `guide/intro` |
| Writing Prompts | `guide/prompt` |
| Choosing a Model | `guide/models` |
| AI Tools | `guide/tools` |
| The Editor | `guide/editor` |
| Spinable Games | `guide/spinoff` |
| My Creations | `guide/my-creations` |
| Credits | `guide/credits` |
| Tutorials | `guide/tutorials` |

### Verse8 Platform

| Page | Path | Skill |
|---|---|---|
| Auth Helpers (signed-in user, token verification) | `verse8/auth-helpers` | `verse8-auth-impl` |

### Game Server

| Page | Path | Skill |
|---|---|---|
| Introduction | `gameserver/intro` | `gameserver-sdk` |
| Getting Started | `gameserver/sdk/gettingStarted` | |
| Server Globals | `gameserver/sdk/serverGlobals` | |
| Structured Server Project | `gameserver/sdk/structuredProject` | |
| server.js (legacy format) | `gameserver/sdk/server.js` | `gameserver-sdk` |
| Remote Function | `gameserver/sdk/remoteFunction` | |
| Real-time Messaging | `gameserver/sdk/messaging` | |
| Global State | `gameserver/sdk/globalState` | |
| Global User State | `gameserver/sdk/globalUserState` | |
| Global Collection | `gameserver/sdk/globalCollection` | |
| Room System | `gameserver/sdk/rooms` | |
| Room State | `gameserver/sdk/roomState` | |
| Room User State | `gameserver/sdk/roomUserState` | |
| Room Collection | `gameserver/sdk/roomCollection` | |
| Asset | `gameserver/sdk/asset` | |
| Distributed Lock | `gameserver/sdk/lock` | |
| Leaderboard | `gameserver/sdk/leaderboard` | `leaderboard-impl` |
| CROSS Mini Hub | `gameserver/sdk/crossramp` | `gameserver-sdk-crossramp` |
| System Prompt | `gameserver/sdk/systemPrompt` | `gameserver-sdk` |
| CROSS Mini Hub System Prompt | `gameserver/sdk/systemPromptCrossramp` | `gameserver-sdk-crossramp` |
| Upgrading to 2.0 | `gameserver/sdk/upgrade` | `gameserver-sdk` (code still on 1.x: `gameserver-sdk-v1`) |

### VX Shop

| Page | Path | Skill |
|---|---|---|
| Introduction | `vxshop/intro` | `vx-shop-impl` |
| Prerequisites | `vxshop/prerequisites` | |
| 1. Register Products | `vxshop/registering-products` | |
| 2. Implement Shop (React) | `vxshop/implementing-shop` | |
| 2. Implement Shop (Vanilla) | `vxshop/implementing-shop-vanilla` | |
| Premium Subscription example | `vxshop/premium-example` | |
| Gacha System example | `vxshop/gacha-example` | |
| Disputes & Refunds | `vxshop/disputes-refunds` | |
| Settlements | `vxshop/settlements` | |
| Legal Notice | `vxshop/legal-notice` | |
| Import Options | `vxshop/import-options` | |
| System Prompt | `vxshop/system-prompt` | `vx-shop-impl` |

### Ads

| Page | Path | Skill |
|---|---|---|
| Verse8 Ads (rewarded, interstitial) | `ads/intro` | `ads-impl` |
| Server-Side Verification | `ads/server-verification` | |
| Skill Prompt | `ads/skill` | `ads-impl` |

### Local Cache

| Page | Path | Skill |
|---|---|---|
| Verse8 Local Cache | `local-cache/intro` | `local-cache-impl` |
| Skill Prompt | `local-cache/skill` | `local-cache-impl` |

If a path returns 404, the docs were reorganized. Open `https://docs.verse8.io/en/docs` and find the page in the sidebar.
