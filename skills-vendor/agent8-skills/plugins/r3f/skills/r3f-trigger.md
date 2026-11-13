---
name: r3f-trigger
description: |
  Code recipe for trigger zones and timed area events in a React Three Fiber game on the kinematic-controller templates (player position in `src/game/state.ts`). No physics sensors, no library — paste the files.

  Covers:
  - Box, sphere and ground-circle zones checked against the player's feet every frame.
  - Enter / exit (doors, hints), effects while inside (lava, healing), periodic ticks (spawners), one-time (checkpoints), cooldowns, conditions (needs a key).
  - Line of sight (security camera, guard vision): view cone, range, blocked by walls (`BOXES`) and terrain (`FIELDS`).
  - A HUD toast through a ref (no React state per frame) and a debug view of the zones.

  Use this whenever the user wants something to happen when the player goes somewhere or is seen: doors, checkpoints, goals, traps, lava, spawners, pressure plates, alarms, "if the guard sees me" — even if they don't say "trigger". Do not install `vibe-starter-3d-environment` or use rapier sensors for this.
---

# Trigger recipe (zones + line of sight)

Zones are plain data tested against `player.pos` (the feet) in one `useFrame`. Callbacks fire on transitions (enter / exit / tick), so game code reacts to events instead of polling. Line of sight is a segment test against the same `BOXES` / `FIELDS` the player collides with.

## 1. `src/game/triggers.ts` (pure)

```ts
// Trigger zones and line of sight, checked against plain positions every frame.
// Pure: no React, no three. Callbacks fire on transitions, never every frame
// unless you ask for onStay.
import type { Aabb, HeightField } from './world';

type P = { x: number; y: number; z: number };

export type Zone =
  | { kind: 'box'; minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
  | { kind: 'sphere'; x: number; y: number; z: number; r: number }
  /** Vertical cylinder — the usual "area on the ground" (ignores height between minY and maxY). */
  | { kind: 'circle'; x: number; z: number; r: number; minY?: number; maxY?: number };

export type Trigger = {
  id: string;
  zone: Zone;
  /** Only counts while this is true (has the key, quest stage …). Re-checked every frame. */
  when?: () => boolean;
  onEnter?: () => void;
  onExit?: () => void;
  /** Every frame inside, with dt — damage over time, healing pads. */
  onStay?: (dt: number) => void;
  /** Every `every` seconds while inside (first tick on entry) — spawners, pulses. */
  every?: number;
  onTick?: () => void;
  /** Fire onEnter once ever (checkpoints, cutscenes), then stop checking. */
  once?: boolean;
  /** Seconds after an exit before onEnter can fire again. */
  cooldown?: number;
  // runtime
  inside?: boolean;
  done?: boolean;
  tickIn?: number;
  readyAt?: number;
};

/** Is the point (player feet) in the zone? The player's body is ~1.6 m above its feet; box zones should cover that. */
export function inZone(z: Zone, p: P): boolean {
  switch (z.kind) {
    case 'box':
      return p.x >= z.minX && p.x <= z.maxX && p.y >= z.minY && p.y <= z.maxY && p.z >= z.minZ && p.z <= z.maxZ;
    case 'sphere':
      return (p.x - z.x) ** 2 + (p.y - z.y) ** 2 + (p.z - z.z) ** 2 <= z.r * z.r;
    case 'circle':
      return (p.x - z.x) ** 2 + (p.z - z.z) ** 2 <= z.r * z.r && p.y >= (z.minY ?? -Infinity) && p.y <= (z.maxY ?? Infinity);
  }
}

/** Run every trigger against one position. Call from useFrame with the clock time. */
export function updateTriggers(triggers: Trigger[], p: P, now: number, dt: number) {
  for (const t of triggers) {
    if (t.done) continue;
    const ok = inZone(t.zone, p) && (t.when?.() ?? true);
    if (ok && !t.inside) {
      if (now < (t.readyAt ?? -Infinity)) continue;
      t.inside = true;
      t.onEnter?.();
      t.tickIn = 0;
      if (t.once) {
        t.done = true;
        continue;
      }
    } else if (!ok && t.inside) {
      t.inside = false;
      t.readyAt = now + (t.cooldown ?? 0);
      t.onExit?.();
      continue;
    }
    if (!t.inside) continue;
    t.onStay?.(dt);
    if (t.every && t.onTick) {
      t.tickIn = (t.tickIn ?? 0) - dt;
      if (t.tickIn <= 0) {
        t.tickIn += t.every;
        t.onTick();
      }
    }
  }
}

/** Segment (a → b) against an AABB, slab method. True if it passes through the box. */
function segmentHitsBox(a: P, b: P, box: Aabb): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [o, d, lo, hi] of [
    [a.x, b.x - a.x, box.minX, box.maxX],
    [a.y, b.y - a.y, box.minY, box.maxY],
    [a.z, b.z - a.z, box.minZ, box.maxZ],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

export type Viewer = {
  eye: P;
  /** Facing yaw (radians, 0 = +z — same convention as PlayerState.facing). */
  yaw: number;
  /** Full cone angle (radians) and range (m). */
  fov: number;
  range: number;
};

/**
 * Can the viewer see the target point? Range, then view cone, then walls
 * (boxes) and terrain (sampled every 0.5 m along the ray) in between.
 */
export function canSee(v: Viewer, target: P, blockers: Aabb[], fields: HeightField[] = []): boolean {
  const dx = target.x - v.eye.x;
  const dy = target.y - v.eye.y;
  const dz = target.z - v.eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > v.range) return false;
  if (dist > 1e-6) {
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const flat = Math.hypot(dx, dz);
    const cos = flat < 1e-6 ? 1 : (dx * fx + dz * fz) / flat;
    if (cos < Math.cos(v.fov / 2)) return false;
  }
  for (const b of blockers) if (segmentHitsBox(v.eye, target, b)) return false;
  const steps = Math.ceil(dist / 0.5);
  for (const f of fields) {
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = v.eye.x + dx * t;
      const z = v.eye.z + dz * t;
      if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
      if (f.heightAt(x, z) > v.eye.y + dy * t) return false;
    }
  }
  return true;
}
```

## 2. `src/components/Triggers.tsx`

```tsx
import { useFrame } from '@react-three/fiber';
import { nowSeconds } from '../game/input';
import { player } from '../game/state';
import { updateTriggers, type Trigger, type Zone } from '../game/triggers';

/** Checks `triggers` against the player's feet every frame. Mount once inside <Canvas>. */
export function Triggers({ triggers, show = false }: { triggers: Trigger[]; show?: boolean }) {
  useFrame((_, dt) => updateTriggers(triggers, player.pos, nowSeconds(), Math.min(dt, 0.1)));
  return show ? (
    <>
      {triggers.map((t) => (
        <ZoneMesh key={t.id} zone={t.zone} />
      ))}
    </>
  ) : null;
}

/** Translucent zone outline for debugging / visible pads. */
function ZoneMesh({ zone: z }: { zone: Zone }) {
  const mat = <meshBasicMaterial color="#ffcc33" transparent opacity={0.25} depthWrite={false} />;
  if (z.kind === 'box')
    return (
      <mesh position={[(z.minX + z.maxX) / 2, (z.minY + z.maxY) / 2, (z.minZ + z.maxZ) / 2]}>
        <boxGeometry args={[z.maxX - z.minX, z.maxY - z.minY, z.maxZ - z.minZ]} />
        {mat}
      </mesh>
    );
  if (z.kind === 'sphere')
    return (
      <mesh position={[z.x, z.y, z.z]}>
        <sphereGeometry args={[z.r, 24, 12]} />
        {mat}
      </mesh>
    );
  const lo = Math.max(z.minY ?? 0, -50);
  const hi = Math.min(z.maxY ?? lo + 2, lo + 50);
  return (
    <mesh position={[z.x, (lo + hi) / 2, z.z]}>
      <cylinderGeometry args={[z.r, z.r, hi - lo, 32, 1, true]} />
      {mat}
    </mesh>
  );
}

/** A HUD line written by trigger callbacks through a ref — no React state per frame. Render OUTSIDE <Canvas>. */
const hud: { el: HTMLDivElement | null; until: number } = { el: null, until: 0 };
export function toast(text: string, seconds = 2) {
  if (!hud.el) return;
  hud.el.textContent = text;
  hud.el.style.opacity = '1';
  hud.until = nowSeconds() + seconds;
  setTimeout(() => {
    if (hud.el && nowSeconds() >= hud.until) hud.el.style.opacity = '0';
  }, seconds * 1000);
}
export function Toast() {
  return (
    <div
      ref={(el) => {
        hud.el = el;
      }}
      className="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2 rounded bg-black/60 px-3 py-1 text-sm text-white transition-opacity"
      style={{ opacity: 0 }}
    />
  );
}
```

## 3. Define triggers

Module-level list (e.g. `src/game/triggers-level.ts` or next to the level data); mount `<Triggers triggers={TRIGGERS} />` inside `<Canvas>` and `<Toast />` outside it in `App.tsx`:

```ts
import { toast } from '../components/Triggers';
import { canSee, type Trigger } from './triggers';
import { BOXES, FIELDS, boxAabb } from './world';
import { player } from './state';

const game = { hp: 100, hasKey: false, checkpoint: [0, 0] as [number, number] };
const WALLS = BOXES.slice(1).map(boxAabb);

export const TRIGGERS: Trigger[] = [
  // enter / exit
  { id: 'pad', zone: { kind: 'circle', x: 0, z: -4, r: 1.5, minY: -5, maxY: 10 }, onEnter: () => toast('entered pad'), onExit: () => toast('left pad') },
  // damage over time
  { id: 'lava', zone: { kind: 'box', minX: 8, maxX: 12, minY: -1, maxY: 2, minZ: -2, maxZ: 2 }, onStay: (dt) => (game.hp -= 20 * dt) },
  // periodic
  { id: 'spawner', zone: { kind: 'circle', x: -10, z: 0, r: 6 }, every: 3, onTick: () => toast('a slime appears') },
  // one-time checkpoint
  { id: 'cp1', zone: { kind: 'circle', x: 0, z: 20, r: 2 }, once: true, onEnter: () => { game.checkpoint = [0, 20]; toast('checkpoint'); } },
  // conditional door
  { id: 'door', zone: { kind: 'box', minX: -1, maxX: 1, minY: -1, maxY: 3, minZ: 29, maxZ: 31 }, when: () => game.hasKey, onEnter: () => toast('the door opens') },
  // line of sight: a camera at (5, 3, 5) looking toward −z
  {
    id: 'camera',
    zone: { kind: 'sphere', x: 5, y: 3, z: 5, r: 12 },
    cooldown: 2,
    onStay: () => {
      const seen = canSee({ eye: { x: 5, y: 3, z: 5 }, yaw: Math.PI, fov: Math.PI / 3, range: 12 }, { x: player.pos.x, y: player.pos.y + 1, z: player.pos.z }, WALLS, FIELDS);
      if (seen) toast('spotted!', 1);
    },
  },
];
```

Doors that open: keep the door as a box in `BOXES` and, on enter, move it out of the way in the collider list the player uses (e.g. set its AABB's `minY`/`maxY` below the floor and move its mesh), or treat it like a moving platform (`Aabb.moved`) for a sliding door. An NPC's vision: `eye` from `mover.body.pos` (+1.5 m), `yaw: mover.body.facing` (`r3f-navigator`).

## Pitfalls

- **Feet, not center.** `player.pos` is the feet. A thin floor-level box (`maxY` < 0.05) is missed on slopes and while jumping; give zones head room (`minY` below the ground, `maxY` ≥ ground + 2), or use `circle` zones.
- **React state on every frame.** `onStay` runs at 60 Hz — mutate plain objects there. `setState` is fine only in rare discrete events (`onEnter`, `once`), and HUD text should go through a ref like `toast`.
- **New buttons.** If a trigger asks the player to press something ("press E to open"), add the key in `src/game/input.ts` AND an on-screen button in `MobileControls.tsx` — touch users have no keyboard.
- **Rapier sensors.** Not needed and not allowed in the first-load code: rapier is only in the lazy `src/physics/` chunk. Use these zones for the player; sensors only for dynamic bodies inside that chunk.
- **Big `canSee` costs.** Terrain sampling is every 0.5 m along the ray — fine for a few viewers per frame; for many guards, check every few frames or only within `range` (wrap it in a sphere zone as above).
- **Multiplayer.** Run triggers that change shared state (doors, checkpoints for everyone) on the authority, and only local effects (toasts, screen shake) on each client.
