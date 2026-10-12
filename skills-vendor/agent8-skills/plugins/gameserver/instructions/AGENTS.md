<!-- Composed into AGENTS.md whenever this plugin is staged. It is deliberately not package-scoped: a project that has no server yet is exactly the one that needs these rules, and every template already depends on @agent8/gameserver, so a gate would add nothing but a missed first session. Every line here costs prompt budget on every message. -->

## Server Logic & GameServer SDK Skills

CRITICAL:
You MUST read and follow the GameServer SDK skills BEFORE writing or modifying any server-related code. Skipping this step and writing server code from memory or assumptions is strictly forbidden.

You MUST read them in ANY of these situations:

1. **Modifying server files**: any change to a root `server.js` or to files under `server/`
2. **Creating new server logic**: a project needs server-side functionality for the first time
3. **Online/multiplayer requests**: online or multiplayer play, real-time sync, leaderboards, matchmaking, rooms, chat, or anything else that needs server-client communication — read the skills and use them to build the feature
4. **Debugging server issues**: server errors, connection issues, or state synchronization problems

### Skills

- **`gameserver-sdk`**: SDK 2.x, the default. Covers the structured project (`server/src/server.ts`) and an existing root `server.js`, and holds the full 1.x → 2.0 upgrade checklist
- **`gameserver-sdk-v1`**: frozen SDK 1.x reference, for projects that stay on 1.x
- **`gameserver-sdk-crossramp`**: CROSS Mini Hub integration, only when crossramp/CROSS keywords appear

### Which SDK version

A 1.x client talks to the 1.x game server and a 2.x client to the 2.x one, so the version in the root `package.json` (`@agent8/gameserver`) decides which API the server code runs against. Decide from it and from whether server code already exists (a root `server.js` or a `server/` directory):

- **Not installed, or 2.x** → follow `gameserver-sdk`
- **1.x, no server code yet** (templates ship the 1.x dependency) → run `bun add @agent8/gameserver@latest`, then follow `gameserver-sdk`
- **1.x with existing server code** → read `gameserver-sdk-v1` and extend the code only with the 1.x APIs it lists. Upgrade to 2.x when the task touches rooms or collections, needs a 2.x-only API, or the user asks — follow the upgrade section of `gameserver-sdk`, starting with its package bump

2.x is mostly compatible with 1.x. Every client hook keeps its name and return shape, and global/user state, remote functions, global messaging, `$asset` and `$lock` work as before; what 2.0 adds is additive. What breaks:

- Throws: `$global.joinRoom`/`leaveRoom` and `$room.join`/`leave` (the server returns a `roomId`, the client calls `joinRoom(roomId)` from `useGameServer()`); `remoteFunction('joinRoom' | 'leaveRoom')` on the client, so a server function with either name must be renamed; the `$global` room-state methods (use `$room.*`); `currentRoomId()` (use `$sender.roomId`, see below — the local test runner still answers it, so only the deployed server throws); `initializeAsset` (use `$asset.clear([id])` then `$asset.mint`), `loadUserState`, `printThis` and the CROSS helpers on `$global`; `getCollectionItem` on a missing item (1.x returned `{}`)
- Silent: room UI and every room subscription (`server.subscribeRoom*`, `onRoomMessage`, `onRoomUserJoin`/`Leave`) must wait for `rsConnected`, not `connected` — issued earlier they are dropped; `$sender.roomId` is the truthy `'__no_room__'` outside a room; item ids go in `addCollectionItem(cid, item, { id })`, `item.__id` is ignored, and the upsert replaces the whole item; `$global.updateCollectionItem` creates a missing item when deployed (`$room.updateCollectionItem` and the local test runner throw); global collection writes are buffered ~2s and `countCollectionItems` lags them; a dropped or left room user has a 30s grace period; `destroyRoom` clears membership only; a lobby cannot read other rooms' custom state; `$sender.isSubscriber` no longer checks expiry

### Rules

- P0 (MANDATORY): Read `gameserver-sdk` before creating new server logic (`gameserver-sdk-v1` in a project that stays on 1.x). Never mix versions: `joinRoom`/`leaveRoom`/`rsConnected` from `useGameServer()` do not exist in 1.x, and 1.x room calls throw on 2.x
- P0 (MANDATORY): Do NOT write server code from assumptions or general knowledge — the Agent8 GameServer SDK has specific conventions (e.g., `$global`, `$room`, `$sender`, `$asset`, no `setInterval`/`setTimeout`, export rules) that MUST be followed exactly
- P0 (MANDATORY): When the user requests any online/multiplayer game feature, treat it as a server task and read the server skills before implementation
- P1 (RECOMMENDED): Read `gameserver-sdk-crossramp` only when CROSS/crossramp keywords are explicitly mentioned
