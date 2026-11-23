---
name: r3f-navigator
description: |
  Code recipe for code-driven movement of NPCs, enemies and pets (no physics engine) in a React Three Fiber game on the kinematic-controller templates (`stepPlayer` in `src/game/player.ts`). No AI library — paste the files.

  Covers:
  - Seek, arrive (smooth stop), patrol (loop or back-and-forth, waits), pursue with lead, flee / evade.
  - Following terrain, ramps and step-ups and being blocked by walls — every mover runs through the player's own `stepPlayer`.
  - Walking a maze by its solved route (`r3f-stage-maze`).
  - Per-NPC animation state (idle / walk / run / fall) driving the template's `AnimatedModel` part (base character by default, or any rigged model).

  Use this whenever the user wants NPCs, enemies, monsters, villagers, pets, guards, followers or anything that moves on its own — "make it chase me", "patrol between points", "walk to the door" — even if they don't say "AI" or "pathfinding". Do not install `vibe-starter-3d-environment` for this, and don't use rapier for walking characters.
---

# Navigator recipe (steering → `stepPlayer`)

Each mover owns a `PlayerState` (`createPlayer()`) and is advanced with `stepPlayer`, so it collides with exactly the same `BOXES` / `RAMPS` / `FIELDS` as the player — ground following, step-up and walls come for free. A behaviour only decides the move direction each substep. The anim state is written into the mover's own `{ state, jumps }`, which the template's `AnimatedModel` part plays (`source={mover.anim}`). The player's `Character` is not used for NPCs.

## 1. `src/game/navigator.ts` (pure)

```ts
// Code-driven movers (NPCs, pets, enemies): steering behaviours that output a
// move direction, fed through the SAME stepPlayer the player uses — so movers
// follow terrain, ramps and step-ups, and are blocked by walls, for free.
// Pure: no React, no three.
import { PLAYER } from '../config';
import type { AnimState } from './anim';
import { createPlayer, stepPlayer, type PlayerState } from './player';
import type { Aabb, HeightField, Ramp } from './world';

type V = { x: number; z: number };

export type Behaviour =
  | { kind: 'idle' }
  | { kind: 'seek'; target: V }
  /** Like seek, slows down inside `slowRadius` and stops at `stopRadius`. */
  | { kind: 'arrive'; target: V; slowRadius?: number; stopRadius?: number }
  | { kind: 'flee'; from: V; panicRadius?: number }
  /** Seek / flee a moving target's predicted position (pass its pos and vel objects — read live). */
  | { kind: 'pursue'; target: V; targetVel: V }
  | { kind: 'evade'; from: V; fromVel: V; panicRadius?: number }
  | { kind: 'patrol'; path: V[]; loop?: boolean; wait?: number };

export type Mover = {
  body: PlayerState;
  behaviour: Behaviour;
  /** Top speed (m/s, ≤ PLAYER.runSpeed). Above the walk/run midpoint the anim is 'run'. */
  speed: number;
  /** Read by <AnimatedModel source={mover.anim} />. */
  anim: { state: AnimState; jumps: number };
  /** Patrol bookkeeping. */
  waypoint: number;
  dir: 1 | -1;
  waitLeft: number;
  /** Set when an arrive / a non-looping patrol has finished. */
  arrived: boolean;
};

const NO_JUMP = { jumpPressedAt: -Infinity };

export function createMover(x: number, z: number, groundAt: (x: number, z: number) => number, behaviour: Behaviour, speed = PLAYER.walkSpeed): Mover {
  const body = createPlayer();
  Object.assign(body.pos, { x, y: groundAt(x, z) + 0.05, z });
  return { body, behaviour, speed, anim: { state: 'idle', jumps: 0 }, waypoint: 0, dir: 1, waitLeft: 0, arrived: false };
}

/** Desired velocity direction × fraction of `speed` (length ≤ 1), in world space. */
function steer(m: Mover, dt: number): V {
  const p = m.body.pos;
  const toward = (t: V, k = 1): V => {
    const dx = t.x - p.x;
    const dz = t.z - p.z;
    const d = Math.hypot(dx, dz);
    return d < 1e-6 ? { x: 0, z: 0 } : { x: (dx / d) * k, z: (dz / d) * k };
  };
  const b = m.behaviour;
  switch (b.kind) {
    case 'idle':
      return { x: 0, z: 0 };
    case 'seek':
      return toward(b.target);
    case 'arrive': {
      const d = Math.hypot(b.target.x - p.x, b.target.z - p.z);
      const stop = b.stopRadius ?? 0.4;
      m.arrived = d <= stop;
      if (m.arrived) return { x: 0, z: 0 };
      // floor of 0.15 so it actually reaches stopRadius instead of creeping forever
      return toward(b.target, Math.min(1, Math.max(0.15, (d - stop) / (b.slowRadius ?? 3))));
    }
    case 'flee': {
      const d = Math.hypot(b.from.x - p.x, b.from.z - p.z);
      if (d > (b.panicRadius ?? 8)) return { x: 0, z: 0 };
      const t = toward(b.from);
      return { x: -t.x, z: -t.z };
    }
    case 'pursue':
    case 'evade': {
      const src = b.kind === 'pursue' ? b.target : b.from;
      const vel = b.kind === 'pursue' ? b.targetVel : b.fromVel;
      const d = Math.hypot(src.x - p.x, src.z - p.z);
      if (b.kind === 'evade' && d > (b.panicRadius ?? 8)) return { x: 0, z: 0 };
      const lead = Math.min(1.5, d / Math.max(0.1, m.speed)); // look ahead ≈ time to reach it
      const t = toward({ x: src.x + vel.x * lead, z: src.z + vel.z * lead });
      return b.kind === 'pursue' ? t : { x: -t.x, z: -t.z };
    }
    case 'patrol': {
      if (m.waitLeft > 0) {
        m.waitLeft -= dt;
        return { x: 0, z: 0 };
      }
      const wp = b.path[m.waypoint];
      if (Math.hypot(wp.x - p.x, wp.z - p.z) < 0.5) {
        m.waitLeft = b.wait ?? 0;
        const last = b.path.length - 1;
        if (b.loop ?? true) m.waypoint = (m.waypoint + 1) % b.path.length;
        else if (last > 0) {
          // ping-pong (a single waypoint just stays there)
          if (m.waypoint === last && m.dir === 1) m.dir = -1;
          else if (m.waypoint === 0 && m.dir === -1) m.dir = 1;
          m.waypoint += m.dir;
        }
        return { x: 0, z: 0 };
      }
      return toward(wp);
    }
  }
}

const move = { x: 0, z: 0 };

/** Advance a mover one substep against the same level data as the player. */
export function stepMover(m: Mover, now: number, dt: number, colliders: Aabb[], ramps: Ramp[], fields: HeightField[]) {
  const s = steer(m, dt);
  const k = m.speed / PLAYER.runSpeed;
  move.x = s.x * k;
  move.z = s.z * k;
  stepPlayer(m.body, move, NO_JUMP, now, dt, colliders, false, ramps, fields);
  const v = Math.hypot(m.body.vel.x, m.body.vel.z);
  m.anim.state = !m.body.grounded && m.body.vel.y < -1 ? 'fall' : v > (PLAYER.walkSpeed + PLAYER.runSpeed) / 2 ? 'run' : v > 0.3 ? 'walk' : 'idle';
}
```

## 2. `src/components/Npcs.tsx`

```tsx
import { useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { nowSeconds } from '../game/input';
import { stepMover, type Mover } from '../game/navigator';
import { BOXES, FIELDS, RAMPS, boxAabb } from '../game/world';
import assets from '../assets.json';
import { PLAYER } from '../config';
import { AnimatedModel } from './models/AnimatedModel'; // the template's part — not a local copy

const SUBSTEP = 1 / 120;
const COLLIDERS = BOXES.map(boxAabb);

function Npc({ mover, children }: { mover: Mover; children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const g = group.current;
    const b = body.current;
    if (!g || !b) return;
    const p = mover.body.pos;
    g.position.set(p.x, p.y, p.z);
    let d = mover.body.facing - b.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    b.rotation.y += d * Math.min(1, dt * 14);
  });
  return (
    <group ref={group}>
      <group ref={body}>{children}</group>
    </group>
  );
}

/**
 * Steps every mover in the same 1/120 s substeps as the player, then draws them.
 * `model` picks what each one looks like — by default the verse8 base character
 * through the template's AnimatedModel; for enemies / NPCs return another model, e.g.
 * `(m) => <AnimatedModel url={assets.models['enemies/soldier'].url} height={1.8} source={m.anim} />`
 * (register the URL in src/assets.json first — r3f-model-placer).
 * `active` (optional, default: always) is read every frame; while it returns false
 * the movers don't move and their anim state stays put — for a loading gate / title.
 */
export function Npcs({
  movers,
  model = (m) => <AnimatedModel url={assets.models['characters/base'].url} height={PLAYER.height} source={m.anim} />,
  active,
}: { movers: Mover[]; model?: (m: Mover, i: number) => ReactNode; active?: () => boolean }) {
  useFrame((_, delta) => {
    if (active && !active()) return; // gate closed: no steps, no anim changes
    const dt = Math.min(delta, 0.1);
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
    const now = nowSeconds();
    for (let i = 0; i < steps; i++) {
      const t = now - dt + ((i + 1) * dt) / steps;
      for (const m of movers) stepMover(m, t, dt / steps, COLLIDERS, RAMPS, FIELDS);
    }
  });
  return (
    <>
      {movers.map((m, i) => (
        <Npc key={i} mover={m}>
          {model(m, i)}
        </Npc>
      ))}
    </>
  );
}
```

If props are solid (`r3f-model-placer`), use the same list as `Player.tsx`: `const COLLIDERS = [...BOXES.map(boxAabb), ...PROP_COLLIDERS];`.

## 3. Pick each NPC's model

`Npcs` draws every mover with the template's `AnimatedModel` (`src/components/models/AnimatedModel.tsx`): it fits the model to `height` m, puts the feet on the ground and plays the clip matching `source.state`. Leave `Character.tsx` alone — it is the player's model and reads the player's global `anim`; don't add a `source` prop to it or render it for NPCs.

Enemies and NPCs should not look like the player: pick another character from the resource context, register it in `src/assets.json`, and pass `model={(m) => <AnimatedModel url={…} height={1.8} source={m.anim} />}` to `<Npcs>`, importing `AnimatedModel` from `./models/AnimatedModel` (don't write your own). How to choose the model and its height is in `r3f-model-placer` (use only URLs from the project's resources).

## 4. Create movers

Module-level (e.g. `src/game/npcs.ts`), then `<Npcs movers={MOVERS} />` inside `<Canvas>`:

```ts
import { createMover } from './navigator';
import { player } from './state';
import { groundHeight } from './world'; // no terrain: () => 0

const guard = createMover(3, 3, groundHeight, { kind: 'patrol', path: [{ x: 3, z: 3 }, { x: -4, z: 4 }, { x: -4, z: -4 }, { x: 4, z: -4 }], wait: 1 });
const chaser = createMover(-6, 2, groundHeight, { kind: 'pursue', target: player.pos, targetVel: player.vel }, 3.5);
const deer = createMover(10, 10, groundHeight, { kind: 'flee', from: player.pos, panicRadius: 6 }, 5.5);
export const MOVERS = [guard, chaser, deer];

// Maze route (r3f-stage-maze): straight-line seek stops at the first wall.
// const route = solveMaze(MAZE, [4, 7], [4, 0]).map(([c, r]) => { const [x, z] = cellCenter(MAZE, MAZE_LAYOUT, c, r); return { x, z }; });
// createMover(route[0].x, route[0].z, groundHeight, { kind: 'patrol', path: route, loop: false }, 4);
```

Behind the loading gate (`r3f-terrain` section 4), hold them with the same test as `Player.tsx` — `Npcs` takes it as a function, so this file never imports the gate's modules (a navigator-only game has no `envReady.ts`):

```tsx
import { env } from '../game/envReady';
import { game } from '../game/state';

<Npcs movers={MOVERS} active={() => env.open} />                   {/* loading gate, no title (<LoadingOverlay />) */}
<Npcs movers={MOVERS} active={() => env.open && game.started} />   {/* title screen with <StartButton /> */}
```

No gate: leave `active` out (the movers run from the first frame).

Switch behaviour at runtime by assigning `mover.behaviour = { kind: 'arrive', target: { x, z } }` (e.g. from an `r3f-trigger` callback or a `canSee` check). Catching the player: compare `Math.hypot(chaser.body.pos.x - player.pos.x, chaser.body.pos.z - player.pos.z) < 0.8` in a `useFrame`.

## Pitfalls

- **No obstacle avoidance.** Steering goes in a straight line and slides along walls; around big obstacles it gets stuck. Give patrols waypoints that go around them, use `solveMaze` in mazes, or a grid BFS over `BOXES` for open levels.
- **One mover per `PlayerState`.** Never pass the player's `player` object to `stepMover`. Don't put movers in React state; mutate them in `useFrame`.
- **Different collider lists.** Movers must collide with the same data as the player (`BOXES`, `RAMPS`, `FIELDS`, plus solid props), or they walk through walls the player can't.
- **Fall-off respawn.** `stepPlayer` respawns below `PLAYER.killY` at `PLAYER.spawn` — a mover that walks off the world appears at the player spawn. Keep movers inside the level (or check `body.pos.y` and reset them yourself).
- **Many movers.** Each mover is a full `stepPlayer` per substep (cheap) plus one skinned character (expensive to draw). Past ~20 animated NPCs, use simpler models, or stop animating far ones.
- **Multiplayer.** Run behaviours on one authority (host / server) and sync positions; don't let every client steer its own copy.
