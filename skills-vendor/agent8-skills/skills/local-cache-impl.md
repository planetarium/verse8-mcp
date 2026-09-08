---
name: local-cache-impl
description: |
  How to cache large, regenerable data on the player's device with `@verse8/local-cache` so it is restored quickly instead of recomputed or re-downloaded.

  Read this whenever the request is about:
  - Caching big data locally: terrain/world/dungeon generated from a seed, decoded or processed assets (textures, meshes, audio), precomputed tables (pathfinding, noise, lookups), downloaded bundles.
  - "local cache", "IndexedDB", "localStorage for big data", "cache in the browser", "keep it on the device".
  - Restoring quickly after the page is discarded, on iOS Safari reload, tab kill, or returning to the game (in-frame IndexedDB/localStorage is ephemeral on Safari/iOS inside the Verse8 iframe; this SDK solves that).

  Do NOT use this skill for: player progress, inventory, currency, save games, unlocks, or any setting that must follow the user across devices. That data belongs on the game server — read the `gameserver-sdk` skill instead. The local cache is device-local, best-effort, and evictable at any time.
---

# Local Cache Implementation Guide (`@verse8/local-cache`)

## What it is / what it is not

**Read this first — it decides whether the local cache is the right tool.**

- **Device-local.** Never synced across devices, browsers, or platforms (web / app / OneStore). Logging in on another device gives an empty cache.
- **Best-effort.** Any entry can disappear at any time (quota pressure, LRU eviction, user clearing site data, OS/browser purge). `get()` returning `null` is a **normal cache miss**, not an error.
- **Regenerable, derived data only.** Seeded terrain, decoded assets, precomputed tables, downloaded bundles. **Never store player progress here** — progress, inventory, save games, currency, and unlocks go to the game server (`gameserver-sdk` skill).

Why the SDK exists: Verse8 games run as a cross-site iframe (`{id}.verse8.games` inside `verse8.io`). WebKit (Safari, every iOS browser) makes third-party IndexedDB and localStorage ephemeral — writes succeed but nothing reaches disk and it all disappears when the page is discarded. `@verse8/local-cache` moves the bytes to the hosting shell's first-party origin over a `MessageChannel`, where they persist, and falls back to in-frame storage everywhere else. Do not hand-roll IndexedDB/localStorage for this; use the SDK.

## Instructions

### 1. Install

1. Ensure the package is installed. If not, run: `bun add @verse8/local-cache` (npm / pnpm / yarn are fine too).
2. Import it in the game: `import { Verse8LocalCache } from "@verse8/local-cache";`
3. **No `init()` call is required** — the first call bootstraps. No v8-inject setup, no host configuration, no keys: the SDK auto-detects the Verse8 shell (host origin) by itself. Call `Verse8LocalCache.init({ ... })` only when you need options (e.g. `silent: true`), and call it before the first `get`/`set`.

### 2. Usage pattern (mandatory: regenerate on miss)

Every read must be able to fall back to producing the data itself. The pattern is always:

1. `get(key)` → if non-null, use it (hit).
2. Otherwise regenerate / decode / download the data (miss — always possible by definition).
3. `set(key, data)` best-effort; inspect the result but **never block gameplay on it**. If `set` fails, the game must still work exactly the same, just slower next time.

Never write code that requires a cached value to exist, and never treat `null` from `get()` or `{ ok: false }` from `set()` as a fatal error.

### 3. API summary

All methods are `async`. **Failures are values, never exceptions** (except programming errors such as a non-string key).

| Method | Returns | Notes |
|---|---|---|
| `init(opts?)` | `void` | Optional. `{ parentOrigin?, handshakeTimeoutMs? (default 1500), limits?, dbName?, debug?, silent? }`. `limits`/`dbName` only affect the in-frame fallback. |
| `ready()` | `Promise<'host' \| 'local' \| 'memory'>` | Resolves once the backend is decided. |
| `getBackend()` | `'host' \| 'local' \| 'memory' \| null` | `null` before `ready()` settles. Use it to branch (e.g. skip caching multi-MB blobs on `memory`). |
| `get(key)` | `Promise<ArrayBuffer \| null>` | `null` = miss (normal path). |
| `set(key, value, opts?)` | `Promise<{ ok: true } \| { ok: false; reason }>` | `value` is `ArrayBuffer \| ArrayBufferView`. `reason` is `'QUOTA_EXCEEDED' \| 'TOO_LARGE' \| 'UNAVAILABLE'`. |
| `delete(key)` | `Promise<void>` | |
| `keys(prefix?)` | `Promise<string[]>` | Optionally filtered by key prefix. |
| `clear()` | `Promise<void>` | Clears this game's namespace. |
| `quota()` | `Promise<{ usedBytes: number; limitBytes: number }>` | |
| `getJSON<T>(key)` | `Promise<T \| null>` | UTF-8 JSON convenience over `get`. |
| `setJSON(key, value)` | `Promise<SetResult>` | UTF-8 JSON convenience over `set`. |

**`set` copy vs transfer:**
- Default: the SDK **copies** `value`, so your buffer stays usable afterwards.
- `set(key, buffer, { transfer: true })`: only meaningful for a raw `ArrayBuffer` (typed-array views are always copied out). The buffer is moved zero-copy and becomes **detached (`byteLength === 0`)** afterwards on the `host` backend — do not read it again. Use it for large buffers you will not touch again (e.g. you already uploaded them to the GPU or you keep working from a fresh copy).

**Set failure reasons:**
- `QUOTA_EXCEEDED` — the game's namespace would exceed its byte limit. Free space (`delete`/`clear` old keys) or store less.
- `TOO_LARGE` — the single value (or the key) exceeds the hard per-item limit.
- `UNAVAILABLE` — backend unreachable / threw. Treat like a miss and move on.

### 4. Backend semantics (`ready()`)

| Backend | When | Durability |
|---|---|---|
| `host` | Game is framed by a Verse8 shell that runs `@verse8/local-cache/parent` (verse8.io, onestore.verse8.io) | Durable (shell's first-party IndexedDB) |
| `local` | Game is the **top-level document** (Verse8 mobile app WebView, standalone) — or the host is silent / declines | Durable when top-level. **Ephemeral on Safari/iOS when cross-site framed** |
| `memory` | IndexedDB unusable (private mode, storage blocked) | Lost on reload |

The SDK prints **one** console line describing its decision: `console.info` when top-level, `console.warn` when the host is silent/declined/untrusted (falling back to in-frame IndexedDB — ephemeral on Safari/iOS), `console.warn` when it had to fall back to memory. This one-time warning is deliberate; pass `Verse8LocalCache.init({ silent: true })` to suppress it. Either way, `getBackend()` lets you branch.

You do not need to await `ready()` before calling `get`/`set` — they wait internally. Await it only when you want to branch on the backend up front.

### 5. Key namespacing

- The platform enforces **one namespace per game** (derived from the game's origin by the shell), so games cannot read each other's cache. You do not add a game prefix.
- Inside your namespace, keys are yours. If the cached data differs per player (e.g. per-account decoded loadout), **prefix keys per account yourself**: `` `${account}:terrain:${seed}` ``.
- Include every input that affects the bytes in the key (seed, version, resolution, format) — e.g. `terrain:v2:${seed}:${lod}` — so a generator change never serves stale data. Bumping the version segment is the cheap way to invalidate.

### 6. Limits and eviction

| | Default |
|---|---|
| Per game (namespace) | 64 MB soft cap → `QUOTA_EXCEEDED` |
| Single value | 32 MB → `TOO_LARGE` |
| Key length | 512 UTF-16 units → `TOO_LARGE` |
| Shell total (all games) | 512 MB → least-recently-used games evicted on next connect |

**Guarantee level: best-effort.** Entries disappear when: the shell total cap is exceeded (LRU across games), the user clears site data, the browser purges the shell origin (Safari ITP purges script-writable storage of sites without user interaction for 7 days of Safari use), or the app is uninstalled. The shell requests `navigator.storage.persist()` once to reduce browser-initiated eviction, but it is advisory. Design for the empty-cache case at every launch.

## Example

### Binary data: seeded terrain

```ts
import { Verse8LocalCache } from "@verse8/local-cache";

const TERRAIN_VERSION = 1; // bump when generateTerrain() output changes

// Your own deterministic generator — must always be able to produce the data.
declare function generateTerrain(seed: number): ArrayBuffer;

export async function loadTerrain(seed: number): Promise<ArrayBuffer> {
  const key = `terrain:v${TERRAIN_VERSION}:${seed}`;

  // 1. Cache hit → use it.
  const cached = await Verse8LocalCache.get(key);
  if (cached) return cached;

  // 2. Miss (null is normal) → regenerate. Always possible.
  const fresh = generateTerrain(seed);

  // 3. Best-effort store. Never block gameplay on this.
  //    Skip large blobs when only the in-memory backend is available.
  if (Verse8LocalCache.getBackend() !== "memory") {
    const result = await Verse8LocalCache.set(key, fresh); // copies; `fresh` stays usable
    if (!result.ok) {
      // QUOTA_EXCEEDED | TOO_LARGE | UNAVAILABLE — still playable, just not cached
      console.debug("terrain not cached:", result.reason);
    }
  }

  return fresh;
}
```

Zero-copy variant when you will not touch the buffer again (e.g. you already uploaded a copy to the GPU):

```ts
const upload = fresh.slice(0);            // keep a copy for the game
await Verse8LocalCache.set(key, fresh, { transfer: true }); // `fresh` is detached (byteLength 0) after this
return upload;
```

### JSON data: precomputed table

```ts
import { Verse8LocalCache } from "@verse8/local-cache";

type PathTable = Record<string, number[]>;

declare function computePathTable(mapId: string): PathTable;

export async function loadPathTable(mapId: string): Promise<PathTable> {
  const key = `paths:v1:${mapId}`;

  const cached = await Verse8LocalCache.getJSON<PathTable>(key);
  if (cached) return cached;

  const table = computePathTable(mapId);
  const result = await Verse8LocalCache.setJSON(key, table);
  if (!result.ok) console.debug("path table not cached:", result.reason);
  return table;
}
```

### Optional: inspect the backend and quota

```ts
Verse8LocalCache.init({ silent: true });      // optional — before the first get/set
const backend = await Verse8LocalCache.ready(); // 'host' | 'local' | 'memory'
const { usedBytes, limitBytes } = await Verse8LocalCache.quota();

// Housekeeping: drop old versions of a key family
for (const k of await Verse8LocalCache.keys("terrain:v0:")) {
  await Verse8LocalCache.delete(k);
}
```

## Do / Don't

**Do**
- Cache only data you can regenerate, decode, or re-download on demand.
- Always implement the hit → regenerate → best-effort `set` pattern; treat `get() === null` and `{ ok: false }` as normal.
- Put every input that affects the bytes (seed, version, LOD, format) in the key; bump a version segment to invalidate.
- Prefix keys per account yourself when cached content is player-specific.
- Check `getBackend()` (or `await ready()`) before caching multi-MB blobs; skip on `memory`.
- Use `{ transfer: true }` for large raw `ArrayBuffer`s you will not read again; keep the default copy otherwise.
- Use `getJSON`/`setJSON` for small structured data instead of encoding JSON by hand.

**Don't**
- Don't store player progress, inventory, currency, unlocks, save games, or cross-device settings here — use the game server (`gameserver-sdk` skill).
- Don't rely on an entry existing later; anything can be evicted at any time.
- Don't hand-roll IndexedDB or localStorage for large data in a Verse8 game — it is ephemeral on Safari/iOS inside the iframe.
- Don't wrap calls in try/catch expecting storage errors — failures are returned as values, not thrown.
- Don't call `init()` after the first `get`/`set`, and don't add any host/v8-inject configuration — the SDK auto-detects the shell.
- Don't read a buffer after passing it with `{ transfer: true }`.
- Don't invent methods: the full surface is `init`, `ready`, `getBackend`, `get`, `set`, `delete`, `keys`, `clear`, `quota`, `getJSON`, `setJSON`.
