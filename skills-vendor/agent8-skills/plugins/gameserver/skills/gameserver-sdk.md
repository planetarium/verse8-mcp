---
name: gameserver-sdk
description: |
  Agent8 GameServer SDK 2.x (@agent8/gameserver 2.x), the default server documentation. Any logic related to the server must refer to this document: writing server code and calling it from the client, global/user/room state, collections, rooms and matchmaking, real-time messaging, assets, locks, and system event handlers.
  Read it before writing or modifying server code (server/src/ or a root server.js), when a project first needs a server, and when the user asks for online, multiplayer, leaderboard, room, chat, or any other client-server feature.
  Covers the structured project (server/src/server.ts, created by `bunx @agent8/gameserver-node init`), an existing root server.js, and upgrading 1.x code to 2.0. Server code a project already wrote against 1.x is described in gameserver-sdk-v1.
---

# Agent8 GameServer SDK

> **This is the SDK 2.x reference.** It describes `@agent8/gameserver` 2.x and must not be applied to a 1.x project unchanged — the room APIs and collection item ids differ in ways that fail at runtime rather than at build time. For a project still on 1.x, either upgrade it (see "Upgrading Existing Code from SDK 1.x to 2.0" below, which lists every such change) or read the frozen 1.x reference, the `gameserver-sdk-v1` skill.

Agent8 GameServer is a fully managed game server solution. You don't need to worry about server setup or management when developing your game.

## Project Setup — Structured Project (the default)

Server code lives in `server/src/server.ts` as an EXPORTED TypeScript class, `export class Server { … }`,
and is built to `server/dist/server.js`. Always work this way unless the project already has a root
`server.js` (see Legacy below).

1. **If `server/` does not exist, run `bunx @agent8/gameserver-node init` FIRST.** It generates
   `server/src/server.ts`, `server/test/server.test.ts`, `server/package.json` and
   `server/tsconfig.json`. NEVER create these files by hand, and never write server code before init.
2. **Write server functions** in `server/src/server.ts`. The class MUST be exported: without `export`
   the build still succeeds but the deployed server does not work.
3. **Write tests** in `server/test/server.test.ts` for every function, and run
   `bunx @agent8/gameserver-node test` from the project root (not from `server/`) — it builds first.
   Read the output and fix until all tests pass. The task is not done until server code AND passing
   tests both exist.
4. **Deploy** by pushing — the platform builds `server/src/` into `server/dist/server.js` and deploys it.
   `bunx @agent8/gameserver-node dev` is an interactive console for local use — never run it in this
   headless container. `build` exists, but `test` already runs it.

```typescript filename="server/src/server.ts"
export class Server {
  async ping(): Promise<string> {
    return 'pong';
  }

  async getMyAccount(): Promise<string> {
    return $sender.account;
  }

  async updateScore(points: number): Promise<number> {
    const myState = await $global.getMyState();
    const newScore = (myState.score || 0) + points;
    await $global.updateMyState({ score: newScore });
    return newScore;
  }
}
```

```typescript filename="server/test/server.test.ts"
describe('Server', () => {
  test('ping returns pong', async (server) => {
    const result = await server.ping();
    expect(result).toBe('pong');
  });

  test('connect changes user', async (server) => {
    server.connect({ account: 'user-alice' });
    const account = await server.getMyAccount();
    expect(account).toBe('user-alice');
  });
});
```

Calling it from the client:

```tsx filename='App.tsx'
import React from "react";
import { useGameServer } from "@agent8/gameserver";

export default function App() {
  const { connected, server } = useGameServer();

  if (!connected) return "Connecting...";

  const callServer = async () => {
    // args are positional: [10] maps to updateScore(points)
    const newScore = await server.remoteFunction("updateScore", [10]);
    console.log(newScore);
  };

  return <button onClick={callServer}>Add 10 points</button>;
}
```

## Handler Namespaces

For better code organization, separate functionality into handlers using the `@Handler` decorator:

```typescript filename="server/src/userHandler.ts"
@Handler('user')
class UserHandler {
  async getMyAccount(): Promise<string> {
    return $sender.account;
  }
}
```

**CRITICAL: handler files must sit DIRECTLY in `server/src/`.** The build auto-imports every `.ts`
file in that directory (other than `server.ts`) so the decorators run, but it does NOT recurse. A
handler at `server/src/handlers/userHandler.ts` is never imported, its `@Handler` never executes, and
the namespace is silently missing at runtime with no build error. Keep handler files flat in
`server/src/`, or import the nested file explicitly from `server.ts`.

Access namespaced functions:

**In tests:**
```typescript
const account = await server.user.getMyAccount();
```

**From client:**
```typescript
const result = await server.remoteFunction('user.getMyAccount');
```

## Runtime Limits (isolated-vm)

- ✅ Available: the provided globals (`$sender`, `$global`, `$room`, `$asset`, `$lock`), pure
  JavaScript/TypeScript libraries (lodash, date-fns, …), ordinary computation.
- ❌ Not available: Node.js built-ins (`fs`, `http`, `https`, `net`, `child_process`, …), network
  libraries (`axios`, `node-fetch`, …), file system access, external processes, and timers
  (`setTimeout` / `setInterval` — use `$roomTick`).

### ❌ No instance state between calls
**Each request creates a NEW `Server` instance**, so class-level variables reset per request — and so
do module-level variables, because the entire user module is re-evaluated on every call. There is no
in-process place to keep state. A match queue, timer map, cache, player roster or "last seen" map held
in `this.*` — or in a module-level `let` outside the class — is empty again on the very next call: it
will pass a single-call test and then silently lose everything. Use class fields ONLY for constants
(e.g. `private MAX_ROOM_USER = 3`). Anything that must survive a call belongs in `$global` state,
`$room` state, a collection, or `$asset`.

## Legacy `server.js` and Migration

A project that already has a root `server.js` holds `class Server { … }` with NO export —
`module.exports = Server`, `export default Server` and `export class Server` all break it. If a root
`server.js` exists it is deployed INSTEAD of `server/dist/server.js`. Keep using it only where it
already exists; to move to a Structured Project:

1. Run `bunx @agent8/gameserver-node init`.
2. Move the class into `server/src/server.ts`, add `export`, and add type annotations. The runtime API
   and client calls do not change.
3. Split a large file as you like: helpers can live in any module you import. `@Handler` namespaces
   are optional and DO change client call names (`remoteFunction('hello')` → `remoteFunction('game.hello')`).
4. Write tests and run `bunx @agent8/gameserver-node test` until they pass.
5. Do not delete `server.js` by hand: the first local `build`, `test` or `dev` copies it to
   `.server.old.js` (with a deprecation banner) and removes the original, logging
   `📦 Renamed legacy server.js → .server.old.js`. COMMIT that removal — a `server.js` still in the
   repo at deploy time shadows `server/dist/server.js`.

## Connection Status (optional, for production UX)

`useGameServer()` also returns a reactive `connectionStatus` so you can show *why* a connection is waiting or failed (server cold start, capacity, draining, broken, kicked) — not just a connected/connecting boolean. The simple `if (!connected) return "Connecting..."` is fine for prototypes; use `connectionStatus` for polished UX. The SDK reconnects automatically and honors the server's retry timing.

```ts
const { connectionStatus: cs, connect, disconnect } = useGameServer();
// cs.phase:        'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable'
// cs.reason?:      route reason ('not_ready' | 'at_capacity' | 'draining' | 'recovering' | ...) or WS close reason
// cs.retryAfterMs?: server-suggested wait before the next retry (for a countdown)

if (cs.phase === "connected") return <Game />;
// gave up: terminal failure (broken verse) or retry deadline, or a terminal close (duplicate login / kicked)
// A terminal close LATCHES the SDK: a bare connect() only logs a warning and returns.
// Only disconnect() clears the latch, so the retry must call both — and must not pass
// React's click event into connect(), which would overwrite the stored config.
if (cs.phase === "unavailable")
  return <button onClick={() => { disconnect(); connect(); }}>Unavailable — Retry</button>;
// connecting / reconnecting
return <div>{cs.reason === "not_ready" ? `Starting server… ${Math.ceil((cs.retryAfterMs ?? 0) / 1000)}s` : "Connecting…"}</div>;
```

# Upgrading Existing Code from SDK 1.x to 2.0

When handed a project written against `@agent8/gameserver` 1.x, check these before
anything else. Items 1 and 3 throw at runtime, except for one silent sub-change
inside item 3 that is flagged there. Items 2 and 4-6 keep running and silently
behave differently, so they must be checked by reading the code, not by testing —
nothing throws for them.

**0. Bump the packages first.** Install `@agent8/gameserver@latest` and confirm `package.json`
now reads 2.x. In a structured project also bump `@agent8/gameserver-node` in `server/package.json`
to 2.x — the two share a major version, not a patch number. `joinRoom` / `leaveRoom` / `rsConnected`
from `useGameServer()` do not exist in 1.x.

**1. Room join/leave moved to the client SDK.** `$global.joinRoom()`,
`$global.leaveRoom()`, `$room.join()` and `$room.leave()` all throw. The server
function must only RETURN a `roomId` (any name except `joinRoom` / `leaveRoom`, which the SDK
rejects in `remoteFunction()` — rename a 1.x `joinRoom` that did matchmaking, e.g. to `findMatch`, or
delete it if it only forwarded to `$global.joinRoom`); the client calls
`joinRoom(roomId)` from `useGameServer()`. Replace
`server.remoteFunction("joinRoom", [roomId])` on the client with `await joinRoom(roomId)`.

**2. Room UI and room subscriptions must gate on `rsConnected`, not `connected`.** `$room` state,
`useRoomState()` and every room subscription (`server.subscribeRoom*`, `onRoomMessage`,
`onRoomUserJoin` / `onRoomUserLeave`) need the Room Server connection; issued before `rsConnected`
is true, a subscription is dropped — no error, only a console warning
(`[GameServer] Cannot send room event "…": RS not connected`) — and nothing re-subscribes it later. Rewrite `if (!connected) return <Loading/>` on room
screens as `if (!rsConnected)`, and key room-subscription effects on `rsConnected` and `currentRoomId`.

**3. Room state is no longer reachable through `$global`.** Removed (they no longer
exist on `$global`): `getRoomState(roomId)`, `updateRoomState(roomId, s)`,
`getAllRoomStates()`, `getRoomMyState(roomId)`, `updateRoomMyState(roomId, s)`,
`getRoomUserState(roomId, acc)`, `updateRoomUserState(roomId, acc, s)`,
`getRoomAllUserStates(roomId)`, `currentRoomId()`. Use the `$room` equivalents
(no `roomId` argument — `$room` always targets the caller's room), and
`$sender.roomId` instead of `currentRoomId()` — that last swap is NOT a plain rename, and it is the
one SILENT change in this item: `currentRoomId()` returned `null` outside a room, `$sender.roomId`
returns the truthy string `'__no_room__'`, so an `if (roomId)` guard that used to be false is now
always true and nothing throws. (The local test runner still answers `$global.currentRoomId()` with
`'test-room'`, so a leftover call passes the local tests and throws only when deployed.) Still on `$global` and callable from
anywhere: `countRooms()`, `getAllRoomIds()`, `getRoomUserAccounts(roomId)`,
`countRoomUsers(roomId)`, `destroyRoom(roomId)` — but note `destroyRoom` now clears
room MEMBERSHIP only: it does not fire `onRoomDestroy`, does not delete the room's
collections, and does not disconnect clients. To reset a room, clear state yourself
with `$room.clearRoomState()` and broadcast so clients call `leaveRoom()`.
Also removed: `initializeAsset()` (use `$asset.clear([id])` then `$asset.mint(id, amount)`),
`loadUserState()`, `printThis()`. The CROSS Mini Hub helpers moved off `$global` too, but the shop
one has a direct CLIENT-side replacement: `createCrossRampShopUrl` / `generateShopUrl` become
`server.getCrossRampShopUrl(lang)`, called on the client, not from server code. The rest
(`subscribeCrossRampStatus`, `processCrossRampValidation`, `processCrossRampResult`,
`mintAirdropToken`, `getPlayerAssets`) are platform REST endpoints with no game-code equivalent.

**4. SILENT: a lobby that read other rooms' state needs redesign.** Room state is
readable only from inside the room. `$room.getAllRoomStates()` called from a
function that is not in a room returns only `roomId` and `$users` per room — custom
fields come back EMPTY, not as an error. Have the room's `onRoomCreate`/`onRoomJoin`
mirror what the lobby needs into `$global` state, or one global-collection item per
room via `$global.addCollectionItem`, and read that from the lobby. `$global` is
reachable both inside and outside a room, so it is also how one room reads another
room's data.

**5. SILENT: collection item ids.** 1.x honored `__id` set ON THE ITEM; 2.0 IGNORES
it and generates a fresh id. Rewrite
`addCollectionItem(cid, { __id: account, ...rest })` as
`addCollectionItem(cid, { ...rest }, { id: account })`. Grep for `__id` in server
code. Upsert also differs: 1.x merged fields into the existing item, 2.0's
`options.id` REPLACES the whole document.

**6. SILENT: behavior changes to check the game logic against.**
- Global collection writes (`$global.addCollectionItem` / `$global.updateCollectionItem` / …) are
  buffered for ~2s before they reach Firestore (1.x wrote through). Item reads see a buffered write
  at once and the buffer survives a game-server restart; `countCollectionItems` counts committed
  documents only, so it lags by up to ~2s. No store is safer here: global state, user state, `$asset`
  and collections are all persisted on a short trailing throttle (1s, 5s, 5s and 2s), so a failure of
  the verse's in-memory store loses the last few seconds of any of them. Keep currency / items /
  rewards in `$asset` because its balance changes are atomic.
  `$global.updateCollectionItem` on a MISSING item never fails when deployed — it silently creates a
  document holding only the fields you passed plus `__id` (`$room.updateCollectionItem` and the local
  test runner throw instead). If 1.x code relied on that update failing to detect a
  missing item, do NOT replace the check with `getCollectionItem`: that call also changed, from
  returning `{}` in 1.x to THROWING `Item <id> not found in collection <cid>` in 2.0, so a bare
  `const item = await $global.getCollectionItem(cid, id); if (!item.__id) …` now crashes on exactly
  the case it is testing for. Wrap it in try/catch, or use `getCollectionItems` with a filter and
  check the returned length.
- A dropped room connection — and an explicit `leaveRoom()` — now has a 30s grace period before
  `onRoomLeave` (1.x removed the user immediately); closing the tab still leaves at once. Logic that
  reacts to a player vanishing now runs up to 30s later — put it in `onRoomLeave`. Full rules:
  "Grace period" under Room Lifecycle Hooks.
- `$sender.isSubscriber` no longer checks expiry: 1.x returned true only for a live subscription,
  2.0 returns true whenever the token carried one, so an EXPIRED subscriber is still `true`. Code that
  gates premium content on it alone must also check
  `$sender.subscription && $sender.subscription.exp * 1000 > Date.now()`.
- 1.x had no room lifecycle hooks; room setup/cleanup belongs in `onRoomCreate` /
  `onRoomJoin` / `onRoomDisconnect` / `onRoomLeave` / `onRoomDestroy` now.

Everything else is additive — all 1.x client hooks keep their names and return
shapes, and `paths` partial reads, `getUserStates`, `$asset.getMany(ids)` (returns only the requested
ids; absent ones are OMITTED rather than zero-filled, so use `Object.hasOwn` to tell "never minted"
from "balance is 0") / `clear` /
optional `account`, the `clear*` state APIs, `{ returnState: false }`, and
`connectionStatus` are new capabilities, not replacements.

# remoteFunction

remoteFunction can be called through the GameServer instance when connected.

```
const { connected, server } = useGameServer();
if (connected) server.remoteFunction(...);
```

Three ways to call remoteFunction:

1. Call requiring return value
   Use `await remoteFunction('add', [1, 2])` when you need to wait for the server's computation result.
   Rate limit: 10 calls per rolling second PER FUNCTION NAME, counted on the client — the 11th rejects
   with `Too many calls to the function. Use throttle option.` before anything is sent. A rejected
   awaited call is an `Error` with `code` (`TIMEOUT`, `DISCONNECTED`, …) and `retryable`.

2. Fire-and-forget call (NOT reliable)
   `remoteFunction('updateMyNickname', [{nick: 'karl'}], { needResponse: false })`
   Resolves with `null` as soon as the call is queued. There is no acknowledgement: a server-side
   failure, or a socket that drops before the queue flushes, is invisible to the caller. Use it only
   for cosmetic or continuously re-sent updates, never for anything a player would notice losing.
   Still rate-limited like (1).

3. Overwritable update calls (fast call)
   `remoteFunction('updateMyPosition', [{x, y}], { throttle: 50 })`
   The throttle is LEADING-EDGE ONLY: it keeps the FIRST call of each window and drops the rest —
   including the LAST call of a burst. For a drag or a keyboard move that stops, the final resting
   position is exactly what gets dropped. Pass `throttleTrailing: true` to also send the last call of
   each window (usually what you want), or send one unthrottled call when the interaction ends.
   A `throttle` below 30 is silently raised to 30 ms.
   Use this for fast real-time updates like player positions. The server only receives throttled requests, effectively reducing load.

3-1. Throttling multiple values simultaneously
`remoteFunction('updateBall', [{ballId: 1, position: {x, y}}], { throttle: 50, throttleKey: '1'})`
`remoteFunction('updateBall', [{ballId: 2, position: {x, y}}], { throttle: 50, throttleKey: '2'})`
Use throttleKey to differentiate throttling targets when updating multiple entities with the same function.
Without throttleKey, function name is used as default throttle identifier.

# Security: every Server method is a public endpoint

Any client can call ANY method on your `Server` class, by name, with ANY arguments — a `$` prefix
alone protects nothing (only the reserved `$on*` / `$roomTick` / `$room*` names are refused). So:
take the caller's identity from `$sender.account`, never from an argument; decide amounts, prices
and targets on the server; and never pass a client argument straight into `updateUserState`,
`updateGlobalState`, `$asset.mint` / `burn`, or a collection write. Gate admin actions on a rule the
server owns (e.g. a constant allow-list of accounts).

# Users

Users making server requests have a unique `account` ID:

- Access via `$sender.account` in server code
- Access via `server.account` in client code

```typescript filename='server/src/server.ts'
export class Server {
  getMyAccount(): string {
    return $sender.account;
  }
}
```

```tsx filename='App.tsx'
  const { connected, server } = useGameServer();
  const myAccount = server.account;
```

# User Authentication & Premium Features

Users can have subscription and follower status in their authentication context. These properties enable premium features and follower-exclusive content:

- Access via `$sender.isGuest`, `$sender.isFollower`, `$sender.isSubscriber`, and `$sender.subscription` in server code
- `$sender.isGuest` - boolean indicating if user is a guest (not authenticated via Verse8)
- `$sender.isFollower` - boolean indicating if user follows the creator
- `$sender.isSubscriber` - boolean: whether the token carried a subscription AT ALL. It does NOT check
  expiry, so an expired subscriber is still true. To gate premium content on a live subscription,
  compare yourself: `$sender.subscription && $sender.subscription.exp * 1000 > Date.now()`

IMPORTANT — `$sender` is NOT a player in every context. Inside `$roomTick` and in
`onRoomCreate`/`onRoomDestroy`, `$sender.account` is the literal string `'$system'`; `$sender.isTick`
is present and true ONLY during a tick (the key is absent elsewhere, so test `if ($sender.isTick)`,
never `=== false`); and `$sender.isGuest` is `undefined` in ALL FIVE `onRoom*` hooks. In the three
hooks that receive an account (`onRoomJoin`/`onRoomDisconnect`/`onRoomLeave`) use that argument
rather than `$sender`. Any auth gate or per-player billing that can also run on a tick or a hook
must guard for this explicitly.
- `$sender.subscription` is `{ tier: string, exp: number } | null` (default tier: 'basic', expandable)
- `$sender.externalWallet` is `{ type: 'abstractSmartWallet', address: string } | null` — the linked on-chain wallet
- `isFollower`, `isSubscriber`, `subscription`, `externalWallet` are only available from server-signed authentication tokens (security feature). They are also absent in webhook handlers such as `$onItemPurchased`.

```typescript filename='server/src/server.ts'
export class Server {
  getMyStatus(): {
    isGuest: boolean;
    isFollower: boolean;
    isSubscriber: boolean;
    subscription: { tier: string; exp: number } | null;
    externalWallet: { type: 'abstractSmartWallet'; address: string } | null;  // linked on-chain wallet; null for guests and in webhook handlers
  } {
    return {
      isGuest: $sender.isGuest,
      isFollower: $sender.isFollower,
      isSubscriber: $sender.isSubscriber,
      subscription: $sender.subscription,
      externalWallet: $sender.externalWallet ?? null
    };
  }
}
// Returns:
// {
//   isGuest: true | false,
//   isFollower: true | false,
//   isSubscriber: true | false,
//   subscription: { tier: 'basic', exp: 1234567890 } | null,
//   externalWallet: { type: 'abstractSmartWallet', address: '0x...' } | null
// }
```

# Global State Management

Multiplayer games require management of user states, items, rankings, etc.
Access global state through the `$global` variable in server code.
Agent8 provides three types of persistent global state:

1. Global Shared State

- `$global.getGlobalState(paths?: string[]): Promise<Object>` - Retrieves current global state
- `$global.updateGlobalState(state: Object): Promise<Object>` - Updates global state

> Partial read (hot paths): `getGlobalState`, `getUserState`/`getMyState`, and `$room.getRoomState` accept an optional `paths: string[]` (dot-notation, max depth 5, e.g. `['stats.hp']`) to fetch only those fields (HMGET) instead of the whole document. Omit `paths` for the full state; `$room.getRoomState` always includes `roomId`/`$users`. Absent paths are silently omitted; `paths=[]` returns `{}`.

> Batch read (many accounts): `$global.getUserStates(accounts, paths?)` and `$room.getUserStates(accounts, paths?)` read a list of accounts in ONE pipelined call instead of N `getUserState` calls — use them for leaderboards, party rosters, and per-player reads inside a tick. Order-preserving 1:1 (`result[i].account === accounts[i]`); a user with no state comes back as `{ account }` only (check with `Object.hasOwn`). Best-effort snapshot (not atomic across accounts).

> Write returns: every `update*` on `$global`/`$room` resolves with THE PATCH YOU PASSED, not the merged document — the write is an HSET per field and nothing reads the document back, so never read a field you did not write out of an `update*` result. On a hot path that ignores the return value, pass `{ returnState: false }` as the last argument (e.g. `$room.updateRoomState(patch, { returnState: false })`) to skip copying that patch back across the VM boundary; the write is identical and the call resolves to `null`.

> Persistence limits: state is persisted to Firestore in the background and a state document is SKIPPED (no retry, one error to the game log) once it exceeds ~900 KB or ~35,000 estimated index entries (≈17,500 leaf fields). Redis keeps working, so the loss only shows up after a pod restart. Keep `$global`/`$asset` state small and put large keyed datasets in a collection (`$global.addCollectionItem`, one small document per item).

```typescript filename='server/src/server.ts'
export class Server {
  // Read-only view is fine to expose.
  async getGameStatus(): Promise<any> {
    return $global.getGlobalState(['status', 'maintenanceMessage']);
  }

  // NEVER expose `updateGlobalState(state)` as a pass-through — any client could
  // overwrite the whole game's state. Decide what to write on the server.
  async setMaintenance(enabled: boolean): Promise<void> {
    if (!['0xYOUR_ADMIN_ACCOUNT'].includes($sender.account)) throw new Error('Forbidden');
    await $global.updateGlobalState({ status: enabled ? 'MAINTENANCE' : 'ACTIVE' });
  }
}
```

2. User State

- `$sender.account: string` - Request sender's account
- `$global.getUserState(account: string, paths?: string[]): Promise<Object>` - Gets specific user's state
- `$global.getUserStates(accounts: string[], paths?: string[]): Promise<Array<Object & { account: string }>>` - Gets many users' state in one pipelined call (order-preserving 1:1; a user with no state returns `{ account }` only)
- `$global.updateUserState(account: string, state: Object): Promise<Object>` - Updates specific user's state
- `$global.getMyState(paths?: string[]): Promise<Object>` - Alias for <code>$global.getUserState($sender.account)</code>
- `$global.updateMyState(state: Object): Promise<Object>` - Alias for <code>$global.updateUserState($sender.account, state)</code>

3. Collection State (List management for specific keys, rankings)

- `$global.countCollectionItems(collectionId: string, options?: CollectionOptions): Promise<number>` - Retrieves number of items
- `$global.getCollectionItems(collectionId: string, options?: CollectionOptions): Promise<Item[]>` - Retrieves filtered/sorted items. Returns AT MOST 100 items per call and a `limit` above 100 is silently clamped to 100 — page with `startAfter` to read more. Filtering on one field while ordering by a DIFFERENT field needs a composite Firestore index that game code cannot create (the query fails); filter and order on the same field, or filter only and sort the ≤100 results in memory
- `$global.getCollectionItem(collectionId: string, itemId: string): Promise<Item>` - Gets single item by ID. THROWS when the item does not exist (`Item <id> not found in collection <cid>`) — it does not return `{}` or `null`. Wrap in try/catch, or use `getCollectionItems` with a filter when a miss is expected
- `$global.addCollectionItem(collectionId: string, item: any, options?: { id?: string }): Promise<Item>` - Adds new item. Pass `options.id` to control the item id (upsert / full overwrite — re-adding the same id replaces the item and drops stale fields). The id must be a non-empty string with no `/`, not `.`/`..`, not matching `\_\_...\_\_`, and <=1500 bytes; an invalid id throws. Without `options.id`, an id is generated automatically
- `$global.updateCollectionItem(collectionId: string, item: any): Promise<{ __id: string }>` - Merges `item` into an existing item. The item you pass MUST carry `__id` — it is how the target is found and the call throws without it. Returns only `{ __id }`, not the merged item. On an item that does not exist it does not fail: it creates a document holding just the fields you passed
- `$global.deleteCollectionItem(collectionId: string, itemId: string): Promise<{ \_\_id: string }>` - Deletes item
- `$global.deleteCollection(collectionId: string): Promise<{ collectionId: string }>` - Deletes the whole collection

Leaderboard pattern: keep ONE item per player, keyed by account. Inside
`$lock('score:' + $sender.account, …)` read the player's entry (`getCollectionItems` filtered on
`account`, which returns `[]` rather than throwing), and only if the new score is higher write
`$global.addCollectionItem('rankings', { account, nickname, score }, { id: $sender.account })` — an
upsert that replaces their previous entry. Top N: `orderBy: [{ field: 'score', direction: 'desc' }],
limit: N`. Rank: `countCollectionItems` with `score > myScore`, plus 1 (not capped at 100; it lags buffered
writes by up to ~2s). Do NOT
store one item per play and dedupe later — reads cap at 100 items.

CollectionOptions uses Firebase-style filtering:

```
interface QueryFilter {
field: string;
operator:
| '<'
| '<='
| '=='
| '!='
| '>='
| '>'
| 'array-contains'
| 'in'
| 'not-in'
| 'array-contains-any';
value: any;
}

interface QueryOrder {
field: string;
direction: 'asc' | 'desc';
}

interface CollectionOptions {
filters?: QueryFilter[];
orderBy?: QueryOrder[];
limit?: number;
startAfter?: any;
endBefore?: any;
}
```

**IMPORTANT** — this rule is about `$global` collections, which are Firestore-backed. `filters` and
`orderBy` CAN be combined, but only on the SAME field. Filtering on one field while ordering by a
DIFFERENT field is a composite query that needs a Firestore index game code cannot provision, and the
query fails with `FAILED_PRECONDITION`. So: filter and order on the same field, or filter only and
sort the ≤100 returned items in memory. Ordering alone is fine — but on ONE field only: a second
`orderBy` entry is itself a composite query and needs the same index, so the obvious leaderboard sort
(`score` desc, then `time` asc as a tiebreaker) fails for the same reason. `$room` collections take
the same `CollectionOptions` but are Redis-backed, not Firestore-backed: there, filters and `orderBy`
combine freely across different fields, multi-field sorts included.

Important: state updates merge at the TOP LEVEL ONLY. Each top-level key of your patch replaces
that whole field, so `updateMyState({ stats: { hp: 5 } })` on `{ stats: { hp: 10, mp: 3 } }` leaves
`{ stats: { hp: 5 } }` — `mp` is GONE. To change one nested field, read that branch and spread it:
`const { stats } = await $global.getMyState(['stats']); await $global.updateMyState({ stats: { ...stats, hp: 5 } })`.
A top-level value of `undefined` deletes that field.

```typescript filename='server/src/server.ts'
const state = await $global.getGlobalState(); // { "name": "kim" }
await $global.updateGlobalState({ age: 18 });
const newState = await $global.getGlobalState(); // { "name": "kim", "age": 18 }
```

# Rooms - Optimized for Real-Time Session Games

Rooms are optimized for creating real-time multiplayer games. While global states handle numerous users, tracking them all isn't ideal. Rooms allow real-time awareness of connected users in the same space and synchronize all user states. There's a maximum connection limit.

Room discovery functions are available on `$global` (work on both Game Server and Room Server):

- `$global.countRooms(): Promise<number>` - Gets the total number of rooms that currently have active users.
- `$global.getAllRoomIds(): Promise<string[]>` - Returns IDs of all rooms that currently have active users.
- `$global.getRoomUserAccounts(roomId: string): Promise<string[]>` - Gets an array of account strings for current users in a specific room.
- `$global.countRoomUsers(roomId: string): Promise<number>` - Gets the number of current users in a specific room.

IMPORTANT: Room state (`$room.getRoomState`, `$room.updateRoomState`, etc.) is only accessible via `$room` inside a room. `$global` does NOT have room state read/write methods. Room joining/leaving is handled entirely by the SDK on the client side:
- `joinRoom(roomId)` — connects to the Room Server and auto-joins
- `leaveRoom()` — disconnects from the Room Server

The server code does NOT join rooms. Instead, it provides any function that returns a `roomId` — the function name is up to the game developer (e.g., `findMatch`, `createRoom`, `getLobby`, etc.), with the sole exception of `joinRoom` and `leaveRoom`: the SDK rejects those two names in `remoteFunction()` before sending, so a server function keeping either name is registered but unreachable. The client calls this function, receives the `roomId`, and passes it to `joinRoom(roomId)`.

## Room Lifecycle Hooks

Five lifecycle hooks control the full room lifecycle. All are optional — define only what you need.

| Hook | When | Args | Failure |
|------|------|------|---------|
| `onRoomCreate(roomId)` | First user joins (room created) | roomId | Fails the join — but the room and its first member are ALREADY registered and are not rolled back |
| `onRoomJoin(roomId, account)` | Each user enters | roomId, account | Fails the join; the user is rolled back out of `$users`. NOTE: the runtime closes the socket with a TRANSIENT code (4506), so the client SDK RETRIES the join until its reconnect deadline — throwing here to reject a player produces a retry loop, not a clean rejection. Reject in your matching function instead, before the client ever calls joinRoom |
| `onRoomDisconnect(roomId, account)` | Connection lost (network drop) | roomId, account | Best-effort |
| `onRoomLeave(roomId, account)` | User permanently leaves | roomId, account | Best-effort |
| `onRoomDestroy(roomId)` | Last user left (room empty) — fires AFTER the room's public state has already been deleted; room user states and room collections are still readable and are deleted right after this hook | roomId | Best-effort |

**Grace period**: the WebSocket close code decides, and the result is counter-intuitive. Closing the tab / navigating away sends 1001 and leaves IMMEDIATELY (`onRoomLeave` fires at once, `onRoomDisconnect` NEVER fires). Calling `leaveRoom()`, losing the network, or crashing the tab sends NO code, which the runtime cannot tell apart from a drop, so all three get the 30s grace period: `onRoomDisconnect` fires now and `onRoomLeave` ~30s later. During grace the user is still "in" the room — `$users` includes them, `$roomTick` continues — and reconnecting inside the window resumes without re-joining. So `onRoomLeave` is the only hook that runs on every exit — put freeing a slot / awarding the win / substituting an AI there, and use `onRoomDisconnect` only for what you show DURING the grace window (a "reconnecting…" badge). To handle a deliberate leave before the 30s elapse, have the client call a server function before `leaveRoom()`.

**Room setup and lobby mirroring**: initialize room state in `onRoomCreate`, and mirror whatever a lobby needs into `$global` (room state is unreadable from outside the room). Data the Game Server prepares for a room (e.g. after matchmaking) travels the same way — write it to `$global` and read it in `onRoomCreate`:

```typescript filename='server/src/server.ts'
export class Server {
  private MAX_ROOM_USER = 3;

  // Game Server: matchmaking — store room init data in global state
  async findMatch(): Promise<string> {
    const roomIds = await $global.getAllRoomIds();
    for (const roomId of roomIds) {
      if (await $global.countRoomUsers(roomId) < this.MAX_ROOM_USER) {
        return roomId;
      }
    }
    return 'Room' + Math.random().toString(16).substring(2, 10);
  }

  // Room Server: room first created — initialize state, publish a lobby entry
  async onRoomCreate(roomId: string) {
    await $room.updateRoomState({ status: 'READY', createdAt: Date.now() });
    await $global.updateGlobalState({ [`lobby_${roomId}`]: { status: 'READY' } });
  }

  // Room Server: each user joins
  async onRoomJoin(roomId: string, account: string) {
    const userCount = await $room.countUsers();
    if (userCount === this.MAX_ROOM_USER) {
      await $room.updateRoomState({ status: 'START' });
    }
  }

  // Room Server: user connection lost (may reconnect)
  async onRoomDisconnect(roomId: string, account: string) {
    await $room.broadcastToRoom('playerDisconnected', { account });
  }

  // Room Server: user permanently left
  async onRoomLeave(roomId: string, account: string) {
    await $room.broadcastToRoom('playerLeft', { account });
  }

  // Room Server: room is empty, cleanup.
  // The room's PUBLIC state is ALREADY deleted by the time this runs, so
  // $room.getRoomState() here returns no custom fields — do NOT try to persist
  // the final score/result from it, you will write blanks and nothing will
  // throw. Persist from onRoomLeave instead. Room user states and room
  // collections are still readable here and are deleted when this returns.
  async onRoomDestroy(roomId: string) {
    // Cleanup only — drop the lobby entry onRoomCreate published to $global.
    await $global.clearGlobalState([`lobby_${roomId}`]);
  }
}
```

Client usage — matching via server function:
```typescript
const { server, joinRoom, leaveRoom, currentRoomId } = useGameServer();
// Call ANY server function that returns a roomId
const roomId = await server.remoteFunction("findMatch", []);
await joinRoom(roomId);  // SDK handles Gateway routing + RS connection
// currentRoomId (string | null) is the SDK's record of the joined room.
// ... later
leaveRoom();  // Disconnects from Room Server
```

`currentRoomId` from `useGameServer()` is the SDK's own record of which room you are currently in. It
lives in the SDK store rather than in your components, so it survives remounts, and it is cleared on
`leaveRoom()` or disconnect. (`$sender.roomId` is the server-side counterpart, not a client value.)
The `useRoom*` hooks read it internally (which is why they take no roomId), but every
`server.subscribeRoom*(roomId, …)` and `server.onRoomMessage(roomId, …)` call needs it passed
explicitly — take it from `currentRoomId`, not from component state you threaded by hand.

Client usage — direct roomId (invite link, fixed room, etc.):
```typescript
const { joinRoom } = useGameServer();
// No server call needed — use the roomId directly
await joinRoom("my-fixed-room-id");
```

The `$room` prefix automatically acts on the room that the `$sender` belongs to, so you don't need to explicitly specify roomId. All actions are queried and processed for the currently joined room.



Rooms provide a tick function that enables automatic server-side logic execution without explicit user calls.
The room tick will only repeat execution while users are present in the room.
The room tick runs on a FIXED 200 ms interval for every active room — it is not game-dependent and
not configurable. A tick still running when the next interval arrives is skipped, not queued, so a
slow tick lowers the effective rate rather than piling up. Use the `deltaMS` argument rather than
assuming 200. Declaring `static $roomTickIdleMs = <ms>` on the Server class throttles ticks in a room
that has seen no client activity since the last executed tick.

```typescript filename='server/src/server.ts'
export class Server {
  $roomTick(deltaMS: number, roomId: string): void {
    // ... your game logic here
  }
}
```

Important: Do not use `setInterval` or `setTimeout` in server code - you must use room ticks instead.

Room state can be accessed through the `$room` public variable in server code. Agent8 provides three
types of room state. None of them is persisted — they live only in the room server's memory store and
are gone when the pod restarts. When the last user leaves, the PUBLIC state is deleted first, then
`onRoomDestroy` runs, then every room USER state and room COLLECTION is deleted. A player LEAVING does
not clear their own room user state, though: one who leaves and rejoins a room that stayed alive gets
their old values back, so initialize per-match fields in `onRoomJoin`.

1. Room Public State

- `$room.getRoomState(paths?: string[]): Promise<Object>` - Retrieves the current room state.
- `$room.updateRoomState(state: Object): Promise<Object>` - Updates the room state with new values.
- `$room.getAllRoomStates(): Promise<Object[]>` - Every active room's full state. This is the only way to read another room's custom state, and it only works FROM INSIDE a room: called from a function that is not in a room it returns just `roomId` and `$users` per room, with custom fields EMPTY rather than erroring — so a lobby built on it silently renders blanks. For a lobby, mirror what you need into `$global` state or one global-collection item per room from `onRoomCreate`/`onRoomJoin`.
- `$room.countUsers(): Promise<number>` - Number of users in the CURRENT room (the `$global.countRoomUsers(roomId)` form needs an explicit roomId; `$room` has roomId-optional aliases for the `$global` discovery calls too).

Important: roomState contains these default values:

- `roomId: string`
- `$users: string[]` - Array of all user accounts in the room, automatically updated

2. Room User State

- `$sender.roomId: string` - The caller's room ID, or the sentinel string `'__no_room__'` when the caller is NOT in a room. It is never `null` and never empty, so `if ($sender.roomId)` is TRUTHY in both cases — a lobby/room branch must test `if ($sender.roomId === '__no_room__')`. `$roomTick` and the `onRoom*` hooks always see a real room ID; plain lobby calls and `$onItemPurchased` see the sentinel. (`$room.getId()` is not a null-returning alternative — outside a room it throws `You are not in a room`.)
- `$room.getUserState(account: string): Promise<Object>` — Retrieves a particular user's state in the room.
- `$room.getUserStates(accounts: string[], paths?: string[]): Promise<Array<Object & { account: string }>>` — Retrieves a chosen subset of users in one pipelined call, optionally only the given dot-notation paths. Prefer this over `getAllUserStates()` in a `$roomTick` that needs specific users or only a few fields.
- `$room.updateUserState(account: string, state: Object): Promise<Object>` — Updates a particular user's state in the room.
- `$room.getMyState(): Promise<Object>` — Retrieves $sender state in the room.
- `$room.updateMyState(state: Object): Promise<Object>` — Updates $sender state in the room.
- `$room.getAllUserStates(): Promise<Object[]>` - Retrieves all user states in the room (full state for every user — no `paths` filter).

3. Room Collection State

- `$room.countCollectionItems(collectionId: string, options?: CollectionOptions): Promise<number>` - Retrieves number of items from a room collection based on filtering, sorting, and pagination options.
- `$room.getCollectionItems(collectionId: string, options?: CollectionOptions): Promise<Item[]>` - Retrieves multiple items from a room collection based on filtering, sorting, and pagination options.
- `$room.getCollectionItem(collectionId: string, itemId: string): Promise<Item>` - Retrieves a single item from the room collection using its unique ID. THROWS when the item does not exist (`Item <id> not found in room <roomId> collection <cid>`) — it does not return `{}` or `null`. Wrap in try/catch, or use `getCollectionItems` with a filter when a miss is expected.
- `$room.addCollectionItem(collectionId: string, item: any, options?: { id?: string }): Promise<Item>` - Adds a new item to the specified room collection and returns the added item with its unique identifier. Pass `options.id` to control the item id (upsert / full overwrite — re-adding the same id replaces the item and drops stale fields). The id must be a non-empty string with no `/`, not `.`/`..`, not matching `\_\_...\_\_`, and <=1500 bytes; an invalid id throws. Without `options.id`, an id is generated automatically.
- `$room.updateCollectionItem(collectionId: string, item: any): Promise<{ __id: string }>` - Merges `item` into an existing room-collection item. The item MUST carry `__id` or the call throws; it also throws when no item with that id exists. Returns only `{ __id }`, not the merged item.
- `$room.deleteCollectionItem(collectionId: string, itemId: string): Promise<{ \_\_id: string }>` - Deletes an item from the room collection and returns a confirmation containing the deleted item's ID.
- `$room.deleteCollection(collectionId: string): Promise<{ collectionId: string }>` - Deletes the whole room collection.

# Messaging

Simple socket messaging is also supported. It is fire-and-forget pub/sub: a message reaches only the
clients subscribed at that moment — no acknowledgement, retry or replay — so anything a player must
not miss belongs in state, which they read on (re)connect.

1. Global Messages

- `$global.broadcastToAll(type: string, message: any)` - Broadcasts a message to all connected users globally.
- `$global.sendMessageToUser(type: string, account: string, message: any)` - Sends a direct message to a specific user account globally.

2. Room Messages

- `$room.broadcastToRoom(type: string, message: any)` - Broadcasts a message to all users in the current room.
- `$room.sendMessageToUser(type: string, account: string, message: any)` - Sends a direct message to a specific user within the current room.

Very Important: $global, $room, and $sender are all used in server code (`server/src/server.ts` for Structured Projects).

# Subscribing to State Changes on Client

The `server` object from `const { server } = useGameServer()` contains these subscription functions:

1. Global State Subscriptions

Subscription callbacks are COALESCED FULL SNAPSHOTS, not one callback per write: the server merges
changes on a 30 ms trailing edge per channel and sends the whole state each time, so several rapid
writes can arrive as a single callback and the argument is always the complete state, never a delta.
Subscriptions are also NOT restored after a reconnect — key the effect on `connected` / `rsConnected`
so it re-subscribes. Room subscriptions additionally require the room connection: one issued before
`rsConnected` is dropped AND still consumes a refcount slot, so the retry is skipped and updates
never arrive.

- `server.subscribeGlobalState((state: any) => {}): UnsubscribeFunction`
- `server.subscribeGlobalUserState(account, (state: any) => {}): UnsubscribeFunction`
- `server.subscribeGlobalMyState((state: any) => {}): UnsubscribeFunction`
- `server.subscribeGlobalCollection(collectionId, ({ items, changes } : { items: any[], changes: { op: 'add' | 'update' | 'delete' | 'deleteAll', items: any[]}}) => {}): UnsubscribeFunction`
  Starts from a snapshot of AT MOST 100 items in id order — no filter, no sort — then applies each
  change live. Fine for a small list. For a large or sorted one (chat history, leaderboard), query what
  you need with `$global.getCollectionItems(...)` in a server function and call it with
  `server.remoteFunction(...)`.
- `server.subscribeAsset(account: string, (assets: Record<string, number>) => {}): UnsubscribeFunction`
  Push updates for one account's asset balances — the same `Record<assetId, amount>` map
  `$asset.getAll()` returns. This is the only push path for balances: do NOT poll them with
  `remoteFunction`. Pass `server.account` for the current user, or use the `useAsset()` hook.

2. Room State Subscriptions

- `server.subscribeRoomState(roomId, (state: {...state: any, $users: string[]}) => {}): UnsubscribeFunction`
- `server.subscribeRoomUserState(roomId, account, (state: any) => {}): UnsubscribeFunction`
- `server.subscribeRoomAllUserStates(roomId, (states: { ...state: any, account: string, __updated?: boolean }[]) => {}): UnsubscribeFunction` - All user states. The entry that changed carries `__updated: true` (TWO leading underscores); the key is ABSENT, not false, on unchanged entries — test with `if (s.__updated)`.
- `server.subscribeRoomMyState(roomId, (state: any) => {}): UnsubscribeFunction`
- `server.subscribeRoomCollection(roomId, collectionId, ({ items, changes} : { items: any[], changes: {op: 'add' | 'update' | 'delete' | 'deleteAll', items: any[]}}) => {}): UnsubscribeFunction`
- `server.onRoomUserJoin(roomId, (account: string) => {}): UnsubscribeFunction` - Triggered when a user joins the room.
- `server.onRoomUserLeave(roomId, (account: string) => {}): UnsubscribeFunction` - Triggered when a user leaves the room.

3. Message Receiving

- `server.onGlobalMessage(type: string, (message: any) => {})`
- `server.onRoomMessage(roomId: string, type: string, (message: any) => {})`

IMPORTANT: All subscribe functions are triggered when the state is updated. When subscribing, the current value is received once.

# Real-time State with React Hooks

In environments supporting React hooks, you can get real-time server state updates on the client without explicit subscriptions.

- Getting global state:

```tsx filename='App.tsx'
import {
useGlobalState,
useGlobalMyState,
useGlobalUserState,
useGlobalCollection,
} from "@agent8/gameserver";

const globalState = useGlobalState();
const myState = useGlobalMyState();
const userState = useGlobalUserState(account); // Specific user's state
const { items } = useGlobalCollection(collectionId); // first 100 items by id, then live changes
                                                    // (see subscribeGlobalCollection above)
```

- Getting room state (roomId is automatically handled in hooks):

```tsx filename='App.tsx'
import {
useRoomState,
useRoomMyState,
useRoomUserState,
useRoomAllUserStates,
useRoomCollection,
} from "@agent8/gameserver";
const roomState = useRoomState(); // Room public state
const roomMyState = useRoomMyState(); // my state
const userState = useRoomUserState(account); // Specific user's state
const states = useRoomAllUserStates(); // all users states in the room ({ ...state:any, account: string }[])
const { items } = useRoomCollection(collectionId); // Collection
```

## Asset Management

Agent8 provides comprehensive asset management for in-game currencies and fungible resources. All operations are automatically validated and synchronized:

### Server-side Asset API ($asset)

Amounts must be POSITIVE INTEGERS. `mint`/`burn`/`transfer` throw on a negative, fractional or
non-finite amount, so never pass a computed value straight through — `Math.floor()` it first.
`$asset.mint('gold', score * 0.1)` and `$asset.mint('gold', price * 1.5)` are the common way this
fails at runtime.
- `$asset.get(assetId: string, account?: string): Promise<number>` - Get asset amount
- `$asset.getAll(account?: string): Promise<Record<string, number>>` - Get all assets
- `$asset.getMany(assetIds: string[], account?: string): Promise<Record<string, number>>` - Balances for a subset of asset ids in ONE call (cheaper than `getAll` when you only need a few). Absent ids are OMITTED rather than zero-filled, so use `Object.hasOwn(result, id)` to tell "never minted" from "balance is 0"
- `$asset.has(assetId: string, amount: number, account?: string): Promise<boolean>` - Check asset availability
- `$asset.mint(assetId: string, amount: number, account?: string): Promise<Record<string, number>>` - Create assets
- `$asset.burn(assetId: string, amount: number, account?: string): Promise<Record<string, number>>` - Destroy assets
- `$asset.transfer(toAccount: string, assetId: string, amount: number): Promise<Record<string, number>>` - Transfer assets
- `$asset.clear(assetIds?: string[], account?: string): Promise<Record<string, number>>` - Delete assets. `clear()` wipes the entire account hash; `clear([id, ...])` deletes only the named fields; `clear([])` is a no-op (safe against dynamic empty arrays). Synchronously flushes to Firestore — the returned map is the durable post-deletion state.

When `account` is omitted, operations apply to the current caller. Specify `account` to operate on another user's assets.

### State Deletion APIs

`$global` and `$room` expose `clear*State` methods that mirror the `$asset.clear` shape:

- `$global.clearGlobalState(fields?: string[])` — wipe verse-wide global state. `fields=undefined` clears all user-defined fields (lifecycle metadata such as `__created` is preserved), `fields=[]` is a no-op, `fields=[id…]` deletes only those fields. Synchronously flushes to Firestore.
- `$global.clearUserState(account: string, fields?: string[])` — same semantics for a specific user.
- `$global.clearMyState(fields?: string[])` — shorthand for the caller.
- `$room.clearRoomState(fields?: string[])` — wipe the current room's user-defined state (`roomId` / `$users` metadata is preserved). Room state is ephemeral by design; no Firestore round-trip.
- `$room.clearUserState(account, fields?)` / `$room.clearMyState(fields?)` — same shape inside the current room.

```typescript filename='server/src/server.ts'
export class Server {
  // Your own rule — $sender carries no admin flag. Gate on something the
  // server owns; a constant allow-list is the simplest form. Do NOT take an
  // isAdmin flag from the client.
  private isAdmin(account: string): boolean {
    return ['0xYOUR_ADMIN_ACCOUNT'].includes(account);
  }

  // Admin: reset only seasonal global flags while keeping persistent counters
  async resetSeasonGlobals(): Promise<Record<string, any>> {
    if (!this.isAdmin($sender.account)) throw new Error('Forbidden');
    return await $global.clearGlobalState(['seasonId', 'seasonStartedAt']);
  }

  // Admin: wipe a user's profile state (separate from their assets — that
  // requires $asset.clear)
  async wipeUserProfile(targetAccount: string): Promise<Record<string, any>> {
    if (!this.isAdmin($sender.account)) throw new Error('Forbidden');
    return await $global.clearUserState(targetAccount);
  }

  // End-of-match cleanup inside a room — a clean slate for the next match
  // without leaving the room. Any room member can call this, so gate it on
  // state the server owns rather than trusting the caller.
  async endMatch(): Promise<Record<string, any>> {
    const { phase } = await $room.getRoomState(['phase']);
    if (phase !== 'ended') throw new Error('Match is not over');
    return await $room.clearRoomState();
  }
}
```

**IMPORTANT**: Never expose mint/burn directly to clients. Always wrap in server-controlled logic:

```typescript filename='server/src/server.ts'
export class Server {
  // Your own rule — $sender carries no admin flag. Gate on something the
  // server owns; a constant allow-list is the simplest form. Do NOT take an
  // isAdmin flag from the client.
  private isAdmin(account: string): boolean {
    return ['0xYOUR_ADMIN_ACCOUNT'].includes(account);
  }

  // Server determines reward amount - client only sends missionId
  async completeMission(missionId: string): Promise<Record<string, number>> {
    const rewards: Record<string, number> = { 'daily': 100, 'boss': 500 };
    const reward = rewards[missionId];
    if (!reward) throw new Error('Invalid mission');
    return await $asset.mint('gold', reward);
  }

  // Server defines prices - client only sends itemId
  async buyItem(itemId: string): Promise<Record<string, number>> {
    const prices: Record<string, number> = { 'sword': 100, 'potion': 25 };
    const price = prices[itemId];
    if (!price) throw new Error('Item not found');
    if (!await $asset.has('gold', price)) throw new Error('Insufficient gold');
    await $asset.burn('gold', price);
    return await $asset.mint(itemId, 1);
  }

  // Admin: wipe one account's seasonal assets, keep everything else.
  // (`$asset.clear` without an account only touches the CALLER — a verse-wide
  // reset has to visit each account.)
  async resetSeasonFor(targetAccount: string): Promise<Record<string, number>> {
    if (!this.isAdmin($sender.account)) throw new Error('Forbidden');
    return await $asset.clear(['season_token', 'season_xp'], targetAccount);
  }

  // Admin: full account asset wipe (use sparingly)
  async wipeAccount(targetAccount: string): Promise<Record<string, number>> {
    if (!this.isAdmin($sender.account)) throw new Error('Forbidden');
    return await $asset.clear(undefined, targetAccount);
  }
}
```

### Client-side Asset Hook (useAsset)

The `useAsset` hook provides **read-only** access to the current user's assets. All modifications must be done server-side.

```tsx
import { useAsset } from "@agent8/gameserver";
const { assets, getAsset, hasAsset } = useAsset();

// Check if user can afford something
if (hasAsset('gold', 100)) {
  // Call server function to perform the purchase
  await server.remoteFunction('buyItem', ['sword']);
}
```

## Distributed Lock ($lock)

`$lock` provides atomic read-modify-write operations to prevent race conditions from concurrent requests (e.g., double-claiming rewards, lost updates).

### Server-side Lock API
- `$lock<T>(lockKey: string, fn: () => T | Promise<T>, options?: LockOptions): Promise<T>` - Acquire lock, execute fn, auto-release

**LockOptions:**
- `ttlSeconds` (default: 10, minimum 1 — smaller values are silently raised) — Lock auto-expires after this duration
- `maxWaitMs` (default: 5000) — Max wait time to acquire the lock. On timeout `$lock` THROWS
  (`$lock timeout: could not acquire lock "<key>" within <ms>ms`) and your `fn` never runs — catch it
  and tell the client to retry. Re-entering the SAME key inside a lock you already hold always hits
  this timeout.
- `retryIntervalMs` (default: 50) — Retry interval

**Key design:** Always include `$sender.account` in lock keys for per-user operations to avoid serializing all users.

```typescript filename='server/src/server.ts'
export class Server {
  // Prevent double-claiming daily rewards
  async claimDailyReward(): Promise<{ success: boolean }> {
    return $lock(`daily:${$sender.account}`, async () => {
      const state = await $global.getMyState();
      const today = new Date().toISOString().slice(0, 10);
      if (state?.lastClaimDate === today) {
        throw new Error('Already claimed today');
      }
      await $asset.mint('gold', 100);
      await $global.updateMyState({ lastClaimDate: today });
      return { success: true };
    });
  }

  // Buying an item: a read-modify-write spanning TWO stores ($asset gold and
  // $global inventory). No single call covers both, so without the lock two
  // concurrent buys can both pass the price check.
  // NOTE: do NOT hand-roll a player-to-player transfer with get/burn — use
  // $asset.transfer(toAccount, assetId, amount), which debits AND credits.
  async buyItem(itemId: string, price: number): Promise<{ inventory: string[] }> {
    return $lock(`buy:${$sender.account}`, async () => {
      const gold = await $asset.get('gold');
      if (gold < price) throw new Error('Insufficient gold');
      await $asset.burn('gold', price);

      const state = await $global.getMyState(['inventory']);
      const inventory = [...(state.inventory || []), itemId];
      await $global.updateMyState({ inventory });
      return { inventory };
    });
  }
}
```

**IMPORTANT:** `$lock` is server-side only. The lock is automatically released even if `fn` throws. Keep locked sections short.

## System Event Handlers

Special handlers called automatically by the system. Clients cannot call them: the runtime rejects
any function whose name starts with `$on`, `$roomTick` or `$room`. (The SDK separately refuses the
names `joinRoom` and `leaveRoom` in `remoteFunction`.)

### $onItemPurchased - VX Shop Purchase Handler

Called when a user purchases an item from VX Shop. Use to deliver purchased items.

The platform dedupes by `purchaseId`: while a claim is PROCESSING or already COMPLETED the handler is
not invoked again. But a claim whose handler THREW is marked FAILED and may be retried, and the
retry re-runs your handler from the top. So a handler that grants several things must not leave a
partial grant behind — either do all the granting in one `$lock` and make the whole body
re-runnable, or record `purchaseId` in `$global` state yourself and skip what you already granted.
Never put an unconditional `$asset.mint` after something that can throw. If you use `$lock` here, pass
`{ maxWaitMs: 1500 }`: the webhook gives the handler a 5s budget, the same as `$lock`'s default wait,
so a contended lock would time out, record the claim FAILED and trigger the retry you are guarding
against.

- `account: string` - User's wallet address
- `purchaseId: number` - Unique purchase ID
- `productId: string` - Product identifier
- `quantity: number` - Number purchased
- `metadata?: object` - Optional data

```typescript filename='server/src/server.ts'
export class Server {
  async $onItemPurchased({ 
    account, 
    purchaseId, 
    productId, 
    quantity 
  }: { 
    account: string; 
    purchaseId: number; 
    productId: string; 
    quantity: number; 
  }): Promise<{ success: boolean }> {
    // A handler that threw is recorded FAILED and may be re-invoked with the
    // same purchaseId. The marker below is written LAST, so this guard makes a
    // retry after a FULLY applied claim a no-op; it does NOT cover a throw
    // part-way through. Order the grants so a partial replay is survivable.
    const granted = (await $global.getUserState(account, ['grantedPurchases']))
      .grantedPurchases || {};
    if (granted[purchaseId]) return { success: true };

    // Grant items by productId
    if (productId === 'gold_pack') {
      await $asset.mint('gold', 100 * quantity, account);
    } else if (productId === 'premium_skin') {
      const user = await $global.getUserState(account, ['skins']);
      await $global.updateUserState(account, { skins: [...(user.skins || []), productId] });
    } else {
      await $asset.mint(productId, quantity, account);
    }

    await $global.updateUserState(account, {
      grantedPurchases: { ...granted, [purchaseId]: true },
    });
    return { success: true };
  }
}
```

ULTRA IMPORTANT: Does not support `setInterval` or `setTimeout` in server code. NEVER use them.

ULTRA IMPORTANT: Project Initialization:
- **ALWAYS run `bunx @agent8/gameserver-node init` FIRST** if `server/` directory doesn't exist
- **NEVER manually create** `server/package.json`, `server/tsconfig.json`, or `server/src/server.ts` without running init
- **DO NOT skip the init command** - it generates all necessary configuration files correctly
- Only modify files AFTER init completes successfully

ULTRA IMPORTANT: Export syntax differences:
- **Structured Project (`server/src/server.ts`)**: MUST use `export class Server` - the export statement is REQUIRED
- **Legacy (`server.js`)**: MUST NOT use any export statement - just define `class Server` without export

ULTRA IMPORTANT: File locations:
- **Structured Projects**: server code must be in `server/src/server.ts` and built to `server/dist/server.js`
- **Legacy projects**: `server.js` must be placed in the project root
