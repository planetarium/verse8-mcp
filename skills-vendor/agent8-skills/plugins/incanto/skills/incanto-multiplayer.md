---
name: incanto-multiplayer
description: |
  Core document for multiplayer in Incanto — a pluggable NetworkTransport with
  declarative owner replication, remote-player spawning, and built-in transports.

  This document covers:
  - The transport-agnostic model: built-in LoopbackTransport (offline, zero infra),
    the @agent8/gameserver adapter, and how to implement a custom transport for ANY
    backend (Socket.IO, Colyseus, Supabase Realtime, custom WebSocket servers…).
  - Scene JSON `multiplayer{}` and per-node `network{}` replication blobs.
  - NetworkManager boot and its API; authority rules and casual-sync scoping.
  - NetworkSpawner for remote players and collection entities.
  - The agent8 server kernel at `node_modules/incanto/templates/agent8-server.ts`.

  Reference this document when a user requests multiplayer features: shared rooms, seeing
  other players, synced state, chat/events, or spawned networked entities.

  [Important] You must install the engine first: `bun add incanto three`. Only the agent8
  platform additionally needs `bun add @agent8/gameserver`.
---

## Instructions

1. Ensure the package is installed. If not, run: `bun add incanto three`
2. Read the documentation file at `node_modules/incanto/skills/incanto-multiplayer.md` and follow its
   instructions — it always matches the INSTALLED engine version.
3. Older installed docs use this platform's former skill names: where one says `gameserver-sdk-v2`,
   read `gameserver-sdk` (2.x), and where it calls `gameserver-sdk` the legacy v1 reference, that is
   now `gameserver-sdk-v1`.
