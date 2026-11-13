---
name: r3f-model-placer
description: |
  Code recipe for finding, loading and placing 3D models — props, cover, pickups, trees, enemy and NPC characters — in a React Three Fiber game on the kinematic-controller templates.

  Covers:
  - What to search the resource context for, per genre (shooter, platformer, RPG, dungeon, nature), and which asset packs carry it.
  - Bringing a model in: assets.json, `useGLTF`, sizing to metres from its bounding box, ground alignment, AABB collider.
  - Animated enemy / NPC models that differ from the player (own clips or borrowed mixamo clips).
  - Positions: manual, circle, grid, spiral, seeded scatter; keep-out rules; instancing for many copies.
  - Trees: instanced, lazy-loaded ez-tree forests or resource-context GLBs — never primitives.

  Use this whenever the user wants things in the world: enemies, NPCs, crates, barrels, cover, coins, houses, rocks, trees, "decorate the map" — even if they don't say "model" or "placement". Do not install `vibe-starter-3d-environment` for this.
---

# Model placement recipe

Placement is split in two: a pure module that decides **where** (positions → `Placement[]`, testable, deterministic with a seed), and a component that draws a GLB at every placement. Solid props additionally become AABBs in the player's collider list.

**Models:** register every URL in `src/assets.json` (`"models": { "props/rock": { "url": "…", "description": "…" } }`) and read it from there. Use only URLs the project's resources give you — never invent an asset URL.

## What to look for in the resource context

**Search first, with the resource search tool.** When the `search_resources_vectordb_items` tool is available (the Vectorsearch MCP), it *is* the resource context for 3D models — the URLs it returns are the ones you may use. Before writing any enemy, NPC, prop, cover or pickup:

1. **Search.** Call `search_resources_vectordb_items` once with every thing the game needs, as separate keywords taken from the table below — e.g. a top-down action game: `{ "keywords": ["soldier character", "robot character", "monster", "crate", "barrel", "barrier", "rock", "tree"] }`. Each keyword is searched on its own; English nouns like the ones in the table match best. If a needed kind comes back empty, one more call with other words for it ("box" for crate, "zombie" for monster) is fine.
2. **Pick.** From the returned `items`, choose by `description` (and `similarity`) the ones that fit the role and the style; copy each item's `url` exactly — never edit, shorten or guess one.
3. **Register** each chosen item in `src/assets.json` under `models` with a key and its description: `"enemies/soldier": { "url": "<item.url>", "description": "<item.description>" }`.
4. **Bring it in** with the steps in "Bringing a model in" below (load, size in metres, ground, collider, animation).

**"There is no model for this" is a search result, not an assumption.** Decide that only after the search above returned nothing usable for that kind — and say so in your summary. Without a search tool, the resource context is the asset list in your instructions / project; search that the same way.

Enemies, NPCs, props, cover and pickups should be models, not capsules and colored boxes. Search with the words below (the asset names and descriptions use them) and register what you find. This is a search list, not a URL list: take URLs only from the search results / resource context. If nothing fits, fall back to a **textured** primitive (`TexturedBoxes` from `r3f-stage-maze` with a CDN set), never a flat-colored one. If the user chose a style (voxel, neon, minimal…), that style wins over these defaults.

| Game | Search for | Packs that carry them |
|---|---|---|
| Platformer | floating island, rock, crystal, cloud, coin, flag, platform | CartoonCubeWorld, Low Poly Fantasy Forest, LowPolyFantasyValley |
| Shooter / survival | crate, box, barrel, barrier, fence, container, sandbag, turret, car; soldier / robot characters | Low Poly FPS Map Vol.1–6, Low Poly Sci-Fi City, Low Poly Post Apocalyptic Village, LowPolyWeapons |
| RPG / adventure | house, fence, campfire, well, cart, market stall, sign; villager / knight / monster characters | Low Poly Fantasy Medieval Village (+ Vol.2), Low Poly Medieval Characters, Low Poly Farm Pack, monsters |
| Dungeon | torch, chest, pillar, barrel, door, skeleton, altar | Low Poly Dungeons, Low Poly Fantasy Arena, Low Poly RPG Weapons |
| Nature / island | tree, palm, bush, rock, flower, grass, log, mushroom | Low Poly Nature Pack (+ Vol.2), Low Poly 4 Seasons Nature, Low Poly Tropical Island, Cartoon Grass and Plants, polyhaven rocks / plants |
| City / interior | building, street lamp, bench, car, furniture | Cartoon Low Poly City Pack, Low Poly Megapolis, Low Poly Cozy Interiors, Low Poly Cartoon Vehicles |
| Characters (any) | the role you need: soldier, knight, robot, zombie, wizard, villager… | characters / realistic style, characters / casual style, monsters |

**Enemies and NPCs must not look like the player.** The player is the verse8 base model (`characters/base`); for anyone else pick a different character from the resource context by role (search "soldier", "robot", "skeleton", "villager"…) and draw it with the template's `AnimatedModel` (section 2b). Only when the context offers no other character, reuse the base model with a clear tint or size difference.

## Bringing a model in — the steps

**The template already has the model parts. Import them; don't write them again.**

| Part | Import | For |
|---|---|---|
| `fitModel(object, { height }) → { unit, lift }` | `src/game/fitModel.ts` | draw with `scale={unit}` `position-y={lift}`: any GLB `height` m tall, lowest point at y = 0 |
| `Props({ url, at: Placement[], height, instanced?, castShadow?, fallback? })` | `src/components/models/Props.tsx` | static models at every placement (clones; instanced past 30 copies) |
| `AnimatedModel({ url, height, source?, fallback? })` | `src/components/models/AnimatedModel.tsx` | rigged enemies / NPCs / creatures, clip picked from `source.state` |

`height` (metres) is required in all three.

- **Don't create a component with the same name** (`Props`, `AnimatedModel`, a `ModelProps`, a `components/Props.tsx`…) or a local copy of one. Import the template's.
- **Don't write the size calculation yourself.** No `new Box3().setFromObject(…)`, no hand-tuned `scale={0.01}`. Pass `height` to `Props` / `AnimatedModel`, or call `fitModel` for a custom mesh.
- **Old project without `src/components/models/`?** Only then add the three files from the appendix ("Fallback") at those exact paths, and then import them the same way.

1. **Register** the URL in `src/assets.json` under `models` (from the resource context; with a one-line description).
2. **Load and draw** it with `Props` (static) or `AnimatedModel` (rigged). Both load with `useGLTF` inside their own `<Suspense>`.
3. **Size it in metres.** Library models come at any scale (a barrel may be 100 units tall or 0.01). `height` is required: decide it from the model's **role** and pass it. Reference sizes: player 1.6 m · crate 1 m · barrel 1 m · barrier 1.1 m · chest 0.8 m · torch 1.5 m · house 5–7 m · palm 6–8 m. Enemies: soldier / human 1.7–1.8 m, small robot or creature 1.2–1.5 m, boss 2.5–4 m.
4. **Stand it on the ground:** positions from `place(…, { groundAt: groundHeight })` (section 1).
5. **Make it solid** if the player shouldn't walk through: `placementColliders(placements, radius, height)` appended to the player's `COLLIDERS` (section 3). Pickups and grass-like dressing stay non-solid.
6. **Animate rigged characters:** `AnimatedModel` plays the model's own clips when they are named (idle / walk / run…). A mixamorig rig without usable clips borrows the template's idle / walk / run. Drive it with a `{ state }` source, such as a navigator mover's `anim`.
7. **More than 30 copies of a static model → instanced** (`Props` does it automatically).

**Trees and plants — pick one of two paths, never primitives.** Cones on cylinders, boxes on sticks and spheres on poles read as placeholder art; don't ship them as trees, bushes or rocks.
- **(a) Realistic:** procedural ez-tree trees (`bun add @dgreenheck/ez-tree`), generated once per variant and instanced at these placements — `EzForest` in section 4. Same library as `r3f-tree`, but instanced and dynamically imported (ez-tree is ~4 MB; a static import blows the first-load budget).
- **(b) Low-poly / stylized:** tree, bush and rock GLBs from the agent8-library assets in the resource context — look for packs such as *Low Poly Nature Pack*, *4 Seasons Nature*, *Tropical Island*, and polyhaven plants / rocks. Register the URLs you find in `assets.json` and draw them with `Props` (instanced past ~30 copies). Take URLs only from the resource context; if none is offered, use path (a).

## 1. `src/game/placement.ts` (pure)

```ts
// Where to put props: pattern generators + rules (ground height, keep-out,
// spacing). Pure — outputs plain transforms that a renderer and colliders use.
import type { Aabb } from './world';

export type Placement = { x: number; y: number; z: number; rotY: number; scale: number };
type XZ = [number, number];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- patterns: positions only -------------------------------------------

export const circle = (cx: number, cz: number, radius: number, count: number): XZ[] =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return [cx + Math.cos(a) * radius, cz + Math.sin(a) * radius];
  });

export const grid = (cx: number, cz: number, cols: number, rows: number, spacing: number): XZ[] =>
  Array.from({ length: cols * rows }, (_, i) => [
    cx + ((i % cols) - (cols - 1) / 2) * spacing,
    cz + (Math.floor(i / cols) - (rows - 1) / 2) * spacing,
  ]);

/** Archimedean spiral: `turns` loops out to `radius`. */
export const spiral = (cx: number, cz: number, radius: number, turns: number, count: number): XZ[] =>
  Array.from({ length: count }, (_, i) => {
    const t = (i + 1) / count;
    const a = t * turns * Math.PI * 2;
    return [cx + Math.cos(a) * radius * t, cz + Math.sin(a) * radius * t];
  });

/** Random points in a rectangle at least `minDist` apart (dart throwing — fine up to a few thousand). */
export function scatter(
  rect: { minX: number; maxX: number; minZ: number; maxZ: number },
  count: number,
  minDist: number,
  seed = 1,
): XZ[] {
  const rand = rng(seed);
  const cell = minDist / Math.SQRT2;
  const cols = Math.ceil((rect.maxX - rect.minX) / cell);
  const buckets = new Map<number, XZ>();
  const out: XZ[] = [];
  for (let tries = 0; out.length < count && tries < count * 30; tries++) {
    const x = rect.minX + rand() * (rect.maxX - rect.minX);
    const z = rect.minZ + rand() * (rect.maxZ - rect.minZ);
    const gi = Math.floor((x - rect.minX) / cell);
    const gj = Math.floor((z - rect.minZ) / cell);
    let ok = true;
    for (let j = gj - 2; j <= gj + 2 && ok; j++)
      for (let i = gi - 2; i <= gi + 2 && ok; i++) {
        const p = buckets.get(j * cols + i);
        if (p && Math.hypot(p[0] - x, p[1] - z) < minDist) ok = false;
      }
    if (!ok) continue;
    buckets.set(gj * cols + gi, [x, z]);
    out.push([x, z]);
  }
  return out;
}

// --- rules ----------------------------------------------------------------

export type PlaceRules = {
  /** Ground height, e.g. groundHeight from world.ts. Default: the floor (0). */
  groundAt?: (x: number, z: number) => number;
  /** Footprint radius (m) used for the keep-out checks. */
  radius?: number;
  /** Boxes to stay out of, e.g. BOXES.slice(1).map(boxAabb) (skip the floor). */
  avoid?: Aabb[];
  /** Extra no-go test: water, paths, the spawn plaza … */
  forbidden?: (x: number, z: number, y: number) => boolean;
  /** Skip spots steeper than this (ground rise per m). */
  maxSlope?: number;
  /** Already placed props to keep `radius` away from (pass the result of earlier calls). */
  others?: Placement[];
  /** Random yaw and a scale range. */
  randomYaw?: boolean;
  scale?: [number, number];
  /** Sink into the ground (m) so slopes don't show a gap under the base. */
  sink?: number;
  seed?: number;
};

/** Apply the rules to candidate positions: drop the bad ones, set y from the ground. */
export function place(points: XZ[], r: PlaceRules = {}): Placement[] {
  const rand = rng(r.seed ?? 1);
  const ground = r.groundAt ?? (() => 0);
  const rad = r.radius ?? 0.5;
  const [s0, s1] = r.scale ?? [1, 1];
  const out: Placement[] = [];
  const taken = [...(r.others ?? [])];
  for (const [x, z] of points) {
    const y = ground(x, z);
    if (r.maxSlope !== undefined) {
      const rise = Math.max(Math.abs(ground(x + rad, z) - ground(x - rad, z)), Math.abs(ground(x, z + rad) - ground(x, z - rad)));
      if (rise / (2 * rad) > r.maxSlope) continue;
    }
    if (r.avoid?.some((b) => x + rad > b.minX && x - rad < b.maxX && z + rad > b.minZ && z - rad < b.maxZ && y < b.maxY)) continue;
    if (r.forbidden?.(x, z, y)) continue;
    if (taken.some((p) => Math.hypot(p.x - x, p.z - z) < rad * 2)) continue;
    const pl = { x, y: y - (r.sink ?? 0.05), z, rotY: r.randomYaw ? rand() * Math.PI * 2 : 0, scale: s0 + rand() * (s1 - s0) };
    out.push(pl);
    taken.push(pl);
  }
  return out;
}

/** Solid props: AABBs (trunk/rock core) to append to the player's COLLIDERS. */
export function placementColliders(ps: Placement[], radius: number, height: number): Aabb[] {
  return ps.map((p) => ({
    minX: p.x - radius * p.scale,
    maxX: p.x + radius * p.scale,
    minZ: p.z - radius * p.scale,
    maxZ: p.z + radius * p.scale,
    minY: p.y - 1,
    maxY: p.y + height * p.scale,
  }));
}
```

## 2. Static models — the template's `Props`

Already in the template at `src/components/models/Props.tsx`. Import it and don't rewrite it. Don't make another component with this name, and don't compute a scale for it yourself.

```tsx
import { Props } from './models/Props'; // from src/components/

<Props url={assets.models['props/barrel'].url} at={BARRELS} height={1} />
<Props url={assets.models['props/rock'].url} at={ROCKS} height={1.2} /> {/* > 30 copies → instanced */}
```

`url`, `at` and `height` are required. `at` is a `Placement[]` (`{ x, y, z, rotY, scale }`), e.g. from `place()` in section 1. `Props.tsx` exports the same `Placement` type. Optional props: `instanced` (default `at.length > 30`), `castShadow`, and `fallback` (shown while the GLB loads). Skinned meshes are skipped by the instanced path, so draw those with `AnimatedModel`.

A custom mesh that isn't drawn through `Props` (e.g. a pickup that spins) gets its size from the same helper:

```tsx
import { fitModel } from '../game/fitModel';

const { unit, lift } = useMemo(() => fitModel(scene, { height: 0.5 }), [scene]);
<group scale={unit} position-y={lift}><primitive object={scene} /></group>
```

### 2b. Rigged characters — the template's `AnimatedModel` (enemies, NPCs, creatures)

Already in the template at `src/components/models/AnimatedModel.tsx`. Import it and don't rewrite it. Don't write your own animated-character component or clip-picking loop next to it.

```tsx
import { AnimatedModel } from './models/AnimatedModel'; // from src/components/

<AnimatedModel url={assets.models['enemies/soldier'].url} height={1.8} source={m.anim} />
```

`url` and `height` are required. `source?: { state }` picks the clip (idle / walk / run), for example a navigator mover's `anim`. Without it the model idles. `fallback?` shows while the GLB loads.

**Attack, hit, death or a hit flash are not a reason to write your own model component.** `AnimatedModel` drives idle / walk / run only. Keep it for the body and put the extra beat on a `<group>` you wrap around it:
- an attack as a lunge or a turn toward the target,
- a hit as a knock-back with a spark or flash mesh next to it,
- a death as sinking or scaling out before you unmount it.

Don't copy its `useGLTF` / `clone` / `useAnimations` code into a `Monster` / `Enemy` component, even to play the model's own one-shot clips. If the game really needs those clips, say so in your summary as a request to extend the shared part. Feet are at the origin and it faces its own +z. If the model has its own clips named idle / walk / run it plays those. A mixamorig rig without usable clips borrows the template's shared idle / walk / run through `retarget`.

This was checked with library characters: a mixamorig soldier with no clips and a mixamorig robot whose clips are all named `Armature|mixamo.com|Layer0…` both walk with the borrowed clips. Monsters with their own named clips (`idle`, `hit`, `die`…) play those. Some "characters" in prop packs (e.g. the dungeon skeleton) are static meshes; draw those with `Props`.

## 3. Wire it in

Compute placements once at module level (not inside a component — a new array each render rebuilds the instances), e.g. in `src/game/world.ts` or a `src/game/props.ts`:

```ts
import { circle, grid, place, placementColliders, scatter, spiral } from './placement';
import { BOXES, WATER, boxAabb, groundHeight } from './world';

const WALLS = BOXES.slice(1).map(boxAabb); // everything but the floor
const wet = (_x: number, _z: number, y: number) => y < WATER.level + 0.2; // only with r3f-water

export const TREES = place(scatter({ minX: -55, maxX: 55, minZ: -55, maxZ: 55 }, 400, 3, 11), {
  groundAt: groundHeight,
  radius: 0.8,
  avoid: WALLS,
  forbidden: (x, z, y) => wet(x, z, y) || Math.hypot(x, z) < 8, // keep the spawn clear
  maxSlope: 0.6,
  randomYaw: true,
  scale: [0.8, 1.4],
});
export const PILLARS = place(circle(0, 0, 5, 8), { groundAt: groundHeight, others: TREES });
export const STALLS = place(grid(-14, 0, 4, 2, 2.5), { groundAt: groundHeight, others: [...TREES, ...PILLARS] });
export const STONES = place(spiral(14, -10, 6, 2, 20), { groundAt: groundHeight, others: [...TREES, ...PILLARS, ...STALLS] });
export const PROP_COLLIDERS = placementColliders(TREES, 0.2, 2.5); // trunks block, crowns don't matter
// manual: place([[3, 4], [-2, 7]], { groundAt: groundHeight })
```

Draw inside `<Canvas>`:

```tsx
import assets from '../assets.json';
import { Props } from './models/Props'; // the template's part — not a local copy
import { TREES, PILLARS } from '../game/props';

<Props url={assets.models['props/rock'].url} at={STONES} height={1.2} />     {/* > 30 copies → instanced */}
<Props url={assets.models['props/barrel'].url} at={PILLARS} height={1} />
<Props url={assets.models['props/chest'].url} at={place([[0, 9]], { groundAt: groundHeight })} height={0.8} />
```

Enemies / NPCs on `r3f-navigator` movers, each with its own model:

```tsx
import { AnimatedModel } from './models/AnimatedModel';
import { Npcs } from './Npcs';

<Npcs movers={ENEMIES} model={(m) => <AnimatedModel url={assets.models['enemies/soldier'].url} height={1.8} source={m.anim} />} />
// standing NPC without a mover: <group position={[x, groundHeight(x, z), z]}><AnimatedModel url={…} height={1.7} /></group>
```

Make them solid — `src/components/Player.tsx`:

```ts
const COLLIDERS: Aabb[] = [...BOXES.map(boxAabb), ...PROP_COLLIDERS];
```

(NPCs from `r3f-navigator` should get the same list.) Sitting a prop on the slope instead of upright: `alignToSurface(TERRAIN, p.x, p.z)` from `r3f-terrain` → `rotation={[rx, p.rotY, rz]}` (Clones path only).

## 4. Realistic trees (path a) — first-screen budget

**Gate: first-screen JS ≤ 1.5 MB.** First-screen JS = every `.js` the page requested before the canvas was ready (first frame drawn and the assets the first screen asked for — character GLB, textures — arrived). The template's own bundle is ~1.25 MB; ez-tree alone is ~4 MB (it inlines its bark and leaf images). A dynamic `import('@dgreenheck/ez-tree')` fired when the forest mounts is still requested during start-up and lands in the first screen (measured: 5.28 MB). So:

- ez-tree and the generation code live in one module, `ezTreeVariants.ts`, reached **only** through the fixed `import('./ezTreeVariants')` — Vite makes it a separate chunk.
- `EzForest` starts that import after the first frame, once three's loading manager is idle (drei `useProgress().active === false`) and the browser has an idle moment (`requestIdleCallback`, `setTimeout` fallback).
- Until then, cheap instanced impostors (trunk + canopy) stand at the same placements and are swapped for the real trees.

**Measure it:** `bun run build`, serve `dist`, open it with the network log (Playwright `performance.getEntriesByType('resource')` or DevTools). Take *ready* = the later of the first canvas frame and the `responseEnd` of the non-JS requests that started before that frame. Sum the sizes of `.js` entries whose `startTime` < ready. The ez-tree chunk (`ezTreeVariants-*.js`) must start after ready. With this recipe the eval scene (terrain + maze + forest + lake + grass) measured 1.29 MB first-screen JS, ez-tree chunk starting ~0.8 s after ready.

### 4a. `src/components/ezTreeVariants.ts` (lazy chunk)

```ts
// Loaded ONLY through `import('./ezTreeVariants')` in EzForest.tsx: ez-tree (~4 MB, it inlines its
// bark and leaf images) and the generation code end up in their own chunk, never in the first load.
import { Tree } from '@dgreenheck/ez-tree';
import * as THREE from 'three';

export type TreePart = { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; unit: number };

/** One generated tree per preset → [branches, leaves] with the scale that makes it `height` m tall. */
export function buildVariants(presets: string[], seed: number, height: number): TreePart[][] {
  return presets.map((name, i) => {
    const tree = new Tree();
    tree.loadPreset(name);
    tree.options.seed = seed * 1000 + i;
    tree.generate();
    const box = new THREE.Box3().setFromObject(tree);
    const unit = height / Math.max(1e-6, box.max.y - box.min.y);
    // ez-tree's leaf material animates wind with its own vertex code, which ignores instanceMatrix:
    // instanced, every tree's leaves would pile up at the origin. Draw them with a stock material
    // using the same leaf texture (no wind, but correctly placed and lit).
    const src = [tree.leavesMesh.material].flat()[0] as THREE.MeshStandardMaterial;
    const leaves = new THREE.MeshLambertMaterial({ map: src.map, color: src.color, alphaTest: 0.5, side: THREE.DoubleSide });
    return [
      { geometry: tree.branchesMesh.geometry, material: tree.branchesMesh.material, unit },
      { geometry: tree.leavesMesh.geometry, material: leaves, unit },
    ];
  });
}
```

### 4b. `src/components/EzForest.tsx`

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useProgress } from '@react-three/drei';
import * as THREE from 'three';
import { envPlaceholder, envTask } from '../game/envReady';
import type { Placement } from '../game/placement';
import type { TreePart } from './ezTreeVariants';

/** ez-tree presets: Ash / Aspen / Oak / Pine × Small / Medium / Large, and Bush 1–3 (Pine renders nearly bare — prefer Oak / Ash / Aspen). */
export type TreePresetName = `${'Ash' | 'Aspen' | 'Oak' | 'Pine'} ${'Small' | 'Medium' | 'Large'}` | `Bush ${1 | 2 | 3}`;

/**
 * Run `cb` once the first screen is up: called after the first frame, it waits
 * until the initial asset loads (character GLB, terrain textures — everything on
 * three's DefaultLoadingManager, tracked by drei useProgress) are finished, then
 * for an idle moment (≤ 300 ms). The loading manager also reports "done" when a
 * file fails, so the 30 s safety net only matters if a loader hangs — an early
 * timeout would pull ez-tree into the first screen on slow networks.
 */
function afterFirstScreen(cb: () => void) {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    unsub();
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 50));
    idle(cb, { timeout: 300 });
  };
  const unsub = useProgress.subscribe((s) => {
    if (!s.active) go();
  });
  window.setTimeout(() => !useProgress.getState().active && go(), 300); // give the first loaders time to register
  window.setTimeout(go, 30000);
}

/** Fade every material of `meshes` to `opacity` (transparent while below 1). */
function setOpacity(meshes: THREE.InstancedMesh[], opacity: number) {
  for (const im of meshes)
    for (const m of [im.material].flat()) {
      const t = opacity < 1;
      if (m.transparent !== t) {
        m.transparent = t;
        m.needsUpdate = true;
      }
      m.opacity = opacity;
    }
}

/** Instance transforms for `list`, scaled per placement. */
function place(im: THREE.InstancedMesh, list: Placement[], scaleOf: (p: Placement) => number) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  list.forEach((p, i) => {
    q.setFromAxisAngle(up, p.rotY);
    const s = scaleOf(p);
    im.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(s, s, s)));
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.castShadow = true;
  im.receiveShadow = true;
  return im;
}

/**
 * Realistic procedural trees (`bun add @dgreenheck/ez-tree`) at model-placer
 * placements: a few generated variants, each drawn as instanced branches +
 * leaves → 2 draw calls per variant however many trees there are.
 *
 * First-screen budget: ez-tree is ~4 MB, so it is fetched only after the first
 * screen (see afterFirstScreen), through the fixed `import('./ezTreeVariants')`
 * path that keeps it in its own chunk. Until then cheap instanced impostors
 * (trunk + canopy) stand at the same spots, then cross-fade (`fade` s) to the
 * real trees. Reports to envReady ('trees' task + placeholder while impostors
 * show), so a loading gate stays closed until the real forest is up.
 */
export function EzForest({
  at,
  presets = ['Oak Medium', 'Ash Medium', 'Aspen Medium'],
  height = 9,
  seed = 1,
  fade = 0.4,
}: {
  at: Placement[];
  presets?: TreePresetName[];
  /** Tree height in metres (× each placement's scale). ez-tree's own units are far larger than the 1.6 m player. */
  height?: number;
  seed?: number;
  /** Seconds of impostor → tree cross-fade (for games without a loading gate; pass 0 behind a gate — it only delays "ready"). */
  fade?: number;
}) {
  const [variants, setVariants] = useState<TreePart[][] | null>(null);
  const [stubsGone, setStubsGone] = useState(false);
  const [failed, setFailed] = useState(false); // ez-tree chunk or generation failed: impostors stay as the final look
  const started = useRef(false);
  const done = useRef<() => void>(undefined);
  useEffect(() => {
    done.current = envTask(`trees ${seed}`);
    return () => done.current?.();
  }, [seed]);
  useEffect(() => (stubsGone || failed ? undefined : envPlaceholder()), [stubsGone, failed]);
  useEffect(() => {
    if (stubsGone || failed) done.current?.();
  }, [stubsGone, failed]);

  useFrame(() => {
    if (started.current) return;
    started.current = true;
    afterFirstScreen(() => {
      import('./ezTreeVariants')
        .then((m) => setVariants(m.buildVariants(presets, seed, height)))
        .catch((e) => {
          console.warn('EzForest: ez-tree failed, keeping the impostors', e);
          setFailed(true); // ends the 'trees' task and the placeholder, so the gate still opens
        });
    });
  });

  // Impostor: unit-height trunk + canopy, scaled to `height` — only until the real trees have faded in.
  const stubs = useMemo(() => {
    const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.45, 6).translate(0, 0.225, 0);
    const canopy = new THREE.IcosahedronGeometry(0.28, 1).scale(1, 1.25, 1).translate(0, 0.62, 0);
    return [
      place(new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: '#5b4632' }), at.length), at, (p) => p.scale * height),
      place(new THREE.InstancedMesh(canopy, new THREE.MeshLambertMaterial({ color: '#3f5a2a' }), at.length), at, (p) => p.scale * height),
    ];
  }, [at, height]);

  // Placement i uses variant i % variants.length.
  const trees = useMemo(() => {
    if (!variants) return [];
    const out: THREE.InstancedMesh[] = [];
    variants.forEach((parts, v) => {
      const mine = at.filter((_, i) => i % variants.length === v);
      for (const part of parts) out.push(place(new THREE.InstancedMesh(part.geometry, part.material, mine.length), mine, (p) => p.scale * part.unit));
    });
    setOpacity(out, fade > 0 ? 0 : 1);
    return out;
  }, [variants, at, fade]);

  const t = useRef(0);
  useFrame((_, dt) => {
    if (!variants || stubsGone) return;
    t.current += dt;
    const k = fade > 0 ? Math.min(1, t.current / fade) : 1;
    setOpacity(trees, k);
    setOpacity(stubs, 1 - k);
    if (k >= 1) setStubsGone(true);
  });

  return (
    <>
      {!stubsGone && stubs.map((im, i) => <primitive key={`stub-${i}`} object={im} />)}
      {trees.map((im, i) => (
        <primitive key={`tree-${i}`} object={im} />
      ))}
    </>
  );
}
```

Use it with the same placements as anything else (`bun add @dgreenheck/ez-tree` first):

```tsx
import { EzForest } from './EzForest';
import { TREES, STALLS } from '../game/props';

<EzForest at={TREES} />                                                       {/* oak / ash / aspen, 9 m */}
<EzForest at={STALLS} presets={['Bush 1', 'Bush 2', 'Bush 3']} height={1.2} seed={2} /> {/* bushes */}
```

Trunks stay solid with `placementColliders(TREES, 0.2, 2.5)` (section 3). 3 variants × 2 parts = 6 draw calls for any number of trees.

### 4c. `src/game/envReady.ts` — loading gate (shared; skip if the project already has it)

While ez-tree downloads and generates (≈ 1 s after the textures, more on slow networks), impostors stand in. `EzForest` reports a `trees` task and counts the impostors as a placeholder, so a loading gate can keep the play screen closed until the real trees are up. Wire the gate — `<EnvFrame />` inside the canvas, `<LoadingOverlay />` (or `<StartButton />` in a title) outside, and the input block in `Player.tsx` — from `r3f-terrain` sections 4b–4c, and pass `fade={0}` to `EzForest` behind a gate. Without a gate, keep the default `fade` (0.4 s cross-fade instead of a pop).

```ts
// Environment readiness — one signal for "the world is fully drawn", for the
// title / loading gate. Lazy environment pieces register a task and finish it
// (terrain textures, ez-tree forest, water); placeholders (flat-color terrain,
// tree impostors) count while they are on screen. Ready = first frame drawn,
// no task pending, no placeholder visible, three's loading manager idle.
// Plain mutable object + subscribe — not React state, nothing per frame.
import { useSyncExternalStore } from 'react';
import { useProgress } from '@react-three/drei';

export const env = {
  pending: new Set<string>(),
  placeholders: 0,
  firstFrame: false,
  /** Everything ready right now. */
  ready: false,
  /** Latched: true from the first time `ready` was reached (gates open once, never close again). */
  open: false,
  /** performance.now() timeline — read it to tune loading (also on window.__env). */
  log: [] as { at: number; what: string }[],
};

const listeners = new Set<() => void>();
const mark = (what: string) => env.log.push({ at: Math.round(performance.now()), what });

function update() {
  const ready = env.firstFrame && env.pending.size === 0 && env.placeholders === 0 && !useProgress.getState().active;
  if (ready === env.ready) return;
  env.ready = ready;
  if (ready && !env.open) {
    env.open = true;
    mark('ready');
  }
  listeners.forEach((l) => l());
}
useProgress.subscribe(update);

/** Register a loading task; call the returned function when it is done (safe to call twice). */
export function envTask(name: string) {
  env.pending.add(name);
  mark(`start ${name}`);
  update();
  return () => {
    if (!env.pending.delete(name)) return;
    mark(`done ${name}`);
    update();
  };
}

/** A placeholder is on screen (impostor, flat-color terrain); call the returned function when it is gone. */
export function envPlaceholder() {
  env.placeholders++;
  update();
  return () => {
    env.placeholders--;
    update();
  };
}

/** Called by <EnvFrame /> on the first frame. A short settle lets everything mounted register first. */
export function envFirstFrame() {
  if (env.firstFrame) return;
  env.firstFrame = true;
  mark('first frame');
  window.setTimeout(update, 100);
}

export const subscribeEnv = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** React hook for UI outside the frame loop (overlay, start button): re-renders only when readiness flips. */
export const useEnvOpen = () => useSyncExternalStore(subscribeEnv, () => env.open);

Object.assign(window, { __env: env });
```

## Pitfalls

- **Impostors on the play screen.** Without a loading gate the first seconds of play show the trunk + canopy stand-ins. Wire the gate (4c); its first play frame then has none.

- **Primitive trees.** A cone on a cylinder (or a box on a stick) is placeholder art. Use path (a) `EzForest` or path (b) resource-context GLBs. (`EzForest`'s impostors are only the few-second stand-in before ez-tree arrives.)
- **ez-tree in the first screen.** A static `import { Tree } from '@dgreenheck/ez-tree'`, or a dynamic import fired on mount, puts ~4 MB into start-up. Import `Tree` only inside `ezTreeVariants.ts`, and reach that module only through `EzForest`'s delayed `import('./ezTreeVariants')`. Check the gate (≤ 1.5 MB first-screen JS) as described in section 4.
- **ez-tree at its native size.** Its trees are tens of units tall next to a 1.6 m player; `EzForest` rescales every variant to `height` metres. Pine presets render nearly bare — prefer Oak / Ash / Aspen.
- **Instancing ez-tree leaves with their own material.** Its leaf material animates wind in a custom vertex path that ignores `instanceMatrix`, so all leaves pile up at the origin; `EzForest` swaps in a stock alpha-tested material with the same texture.
- **Guessed or hard-coded URLs.** Every model URL comes from `src/assets.json`, which only lists URLs from the project's resources. A 404 inside `<Suspense>` throws; keep a `fallback` and an error boundary if the URL may be missing.
- **Primitive enemies, NPCs, props and cover.** A capsule enemy, a colored-box crate or a cylinder barrel reads as unfinished when the resource context has soldiers, crates and barrels. Search it first ("What to look for"); fall back to textured boxes, not flat colors.
- **Models at their native size.** Without `height`, a library model can be 100× too big or invisible-small, and its origin may sit at its center (half buried). Always pass `height`, chosen by role.
- **Re-writing the template's model parts.** A new `Props` / `AnimatedModel` / `fitModel`, or a hand-written `Box3().setFromObject` scale, drifts from the template and has repeated old bugs, e.g. measuring before `updateMatrixWorld(true)`, which put enemies off screen. Import `./models/Props`, `./models/AnimatedModel` and `../game/fitModel` instead. The usual trigger is wanting attack / hit / die clips. Wrap `AnimatedModel` in a group for those beats (section 2b) instead of forking it.
- **Enemies that are clones of the player.** Use a different character model for them (section 2b).
- **Instancing a skinned / animated model.** `InstancedMesh` cannot share a skeleton; the recipe skips skinned meshes in the instanced path. Rigged characters go through `AnimatedModel` (one skeleton clone each — keep it to a few dozen on screen).
- **T-posing character.** Its clips are missing or anonymously named and it isn't a mixamorig rig, so nothing can be borrowed. Pick another model, or play its clips by index after checking `useGLTF(url).animations`.
- **Floating / buried props on terrain.** Always pass `groundAt`; use `sink` (default 5 cm) for wide bases on slopes, or skip steep spots with `maxSlope`.
- **Props in walls or water.** `avoid` checks footprints against boxes; water and paths go in `forbidden`. Placements are not re-checked later — generate after the level data exists.
- **Invisible collisions / walking through props.** A prop is only solid if its AABB is in the player's `COLLIDERS`. Keep the collider small (trunk, not crown) so the player isn't stopped by leaves. Rotated footprints are still axis-aligned boxes.
- **Many draw calls.** More than ~30 copies → instanced (default). Each distinct GLB costs one draw call per sub-mesh; prefer few distinct models with variety from yaw/scale.
- **Rapier for props.** Static props never need rapier; only props that should topple or roll go in the lazy physics chunk (`src/physics/`).

## Fallback: the project has no `src/components/models/`

Only for an older R3F project that predates the shared model parts. Add these three files **at exactly these paths, with these signatures**, then import them as in sections 2 and 2b. If the files already exist, keep them and don't add these.

### A1. `src/game/fitModel.ts`

```ts
// Shared by every R3F template — import it, don't rewrite it.
import * as THREE from 'three';

/**
 * Library models come in any size and with their origin anywhere. Fit one to the
 * game: `unit` scales it to `height` metres and `lift` puts its lowest point on
 * y = 0, so a placement's y is where it stands. Draw it with `scale={unit}` and
 * `position-y={lift}` (the object itself is not changed).
 *
 * The world matrices are updated first: a GLB fresh from the loader (or a clone)
 * has not been rendered yet, and a rig with a scaled root (a mixamo Armature at
 * 0.01) would otherwise be measured at its raw size — a 100× wrong scale.
 */
export function fitModel(object: THREE.Object3D, { height }: { height: number }) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const unit = height / Math.max(1e-6, box.max.y - box.min.y);
  return { unit, lift: -box.min.y * unit };
}
```

### A2. `src/components/models/Props.tsx`

```tsx
// Shared by every R3F template — import it, don't rewrite it.
import { Suspense, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Clone, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { fitModel } from '../../game/fitModel';

/** Where one copy stands: feet at (x, y, z), turned `rotY` rad, × `scale` on top of the fitted size. */
export type Placement = { x: number; y: number; z: number; rotY: number; scale: number };

/** Few copies (≲ 30): one <Clone> each. */
function Clones({ url, at, height }: { url: string; at: Placement[]; height: number }) {
  const { scene } = useGLTF(url);
  const { unit, lift } = useMemo(() => fitModel(scene, { height }), [scene, height]);
  return (
    <>
      {at.map((p, i) => (
        <Clone
          key={i}
          object={scene}
          position={[p.x, p.y + lift * p.scale, p.z]}
          rotation={[0, p.rotY, 0]}
          scale={p.scale * unit}
          castShadow
          receiveShadow
        />
      ))}
    </>
  );
}

/** Many copies of a static model: one InstancedMesh per mesh in the GLB → a handful of draw calls for thousands of props. */
function Instanced({ url, at, height, castShadow }: { url: string; at: Placement[]; height: number; castShadow: boolean }) {
  const { scene } = useGLTF(url);
  const { parts, unit, lift } = useMemo(() => {
    const fit = fitModel(scene, { height }); // also updates matrixWorld, read below
    const list: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; local: THREE.Matrix4 }[] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return; // skinned meshes can't be instanced — use AnimatedModel
      list.push({ geometry: m.geometry, material: m.material, local: m.matrixWorld.clone() });
    });
    return { parts: list, ...fit };
  }, [scene, height]);
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);

  useLayoutEffect(() => {
    const placeM = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const out = new THREE.Matrix4();
    parts.forEach((part, k) => {
      const mesh = refs.current[k];
      if (!mesh) return;
      at.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rotY);
        const s = p.scale * unit;
        placeM.compose(new THREE.Vector3(p.x, p.y + lift * p.scale, p.z), q, new THREE.Vector3(s, s, s));
        mesh.setMatrixAt(i, out.multiplyMatrices(placeM, part.local));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }, [parts, at, unit, lift]);

  return (
    <>
      {parts.map((part, k) => (
        <instancedMesh
          key={k}
          ref={(el) => {
            refs.current[k] = el;
          }}
          args={[part.geometry, part.material, at.length]}
          castShadow={castShadow}
          receiveShadow
        />
      ))}
    </>
  );
}

/**
 * Draw a static model (URL from src/assets.json) at every placement.
 * `height` (m) rescales it from its bounding box — library models are not in
 * metres. More than 30 copies are instanced automatically.
 * `fallback` shows while the GLB loads.
 */
export function Props({
  url,
  at,
  height,
  instanced = at.length > 30,
  castShadow = true,
  fallback = null,
}: {
  url: string;
  at: Placement[];
  height: number;
  instanced?: boolean;
  castShadow?: boolean;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      {instanced ? <Instanced url={url} at={at} height={height} castShadow={castShadow} /> : <Clones url={url} at={at} height={height} />}
    </Suspense>
  );
}
```

### A3. `src/components/models/AnimatedModel.tsx`

Uses the template's `src/game/anim.ts` (`retarget`, `AnimState`) and the shared `anims/idle`, `anims/walk` and `anims/run` in `assets.json`.

```tsx
// Shared by every R3F template — import it, don't rewrite it.
import { Suspense, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useAnimations, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import assets from '../../assets.json';
import { retarget, type AnimState } from '../../game/anim';
import { fitModel } from '../../game/fitModel';

// The template's shared mixamo clips (src/assets.json `animations`): any model on the
// mixamorig skeleton that ships without clips of its own can borrow them.
const SHARED = ['idle', 'walk', 'run'] as const;
const SHARED_URLS = SHARED.map((n) => assets.animations[`anims/${n}`].url);
const FADE = 0.15;

function Model({ url, height, source }: { url: string; height: number; source?: { state: AnimState } }) {
  const gltf = useGLTF(url);
  const shared = useGLTF(SHARED_URLS);
  const { scene, clips, unit, lift } = useMemo(() => {
    const scene = clone(gltf.scene); // skinned models need a real skeleton clone per instance
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    // Own clips win when they are named (idle / walk / run …). A mixamorig rig with no clips —
    // or only anonymous ones ("Armature|mixamo.com|Layer0") — borrows the template's idle / walk / run.
    let clips = gltf.animations;
    const named = clips.some((c) => /idle|walk|run/i.test(c.name));
    if (!named && scene.getObjectByName('mixamorigHips')) {
      clips = SHARED.map((name, i) => {
        const c = retarget(shared[i].animations[0], scene, shared[i].scene);
        c.name = name;
        return c;
      });
    }
    return { scene, clips, ...fitModel(scene, { height }) };
  }, [gltf, shared, height]);

  const group = useRef<THREE.Group>(null);
  const { actions, names } = useAnimations(clips, group);
  const current = useRef('');
  useFrame(() => {
    // The clip whose name contains the state ("Walk", "walking", "Armature|walk"); run falls
    // back to walk, anything else to idle, a single-clip model just loops its clip.
    const want = source?.state ?? 'idle';
    const find = (k: string) => names.find((n) => n.toLowerCase().includes(k));
    const pick = find(want) ?? (want === 'run' ? find('walk') : undefined) ?? find('idle') ?? names[0];
    if (!pick || pick === current.current) return;
    actions[pick]?.reset().fadeIn(FADE).play();
    actions[current.current]?.fadeOut(FADE);
    current.current = pick;
  });

  return (
    <group ref={group} scale={unit} position-y={lift}>
      <primitive object={scene} />
    </group>
  );
}

/**
 * An animated character / creature model for enemies and NPCs (URL from src/assets.json):
 * feet at the origin, `height` m tall, facing its own +z. Plays the clip matching
 * `source.state` (idle / walk / run — e.g. a navigator mover's `anim`).
 */
export function AnimatedModel({
  url,
  height,
  source,
  fallback = null,
}: {
  url: string;
  height: number;
  source?: { state: AnimState };
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <Model url={url} height={height} source={source} />
    </Suspense>
  );
}
```
