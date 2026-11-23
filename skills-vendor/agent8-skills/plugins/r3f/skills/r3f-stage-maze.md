---
name: r3f-stage-maze
description: |
  Code recipe for maze (미로), labyrinth, dungeon (던전) and arena (아레나) wall structures in a React Three Fiber game on the kinematic-controller templates (`world.ts` `BOXES`, `stepPlayer` AABB collision). No library — paste the files.

  Covers:
  - Seeded backtracker or Prim maze, braiding, rooms / plazas, random dungeon rooms; arena ring with gates and pillars.
  - Output as `BOXES`, so the same walls are drawn and block the player; blocks merged into few boxes.
  - Walls textured with the verse8 CDN stone-block set (albedo + normal + AO) in one draw call; stone floor.
  - Wall height, thickness, passage width, height variation; entrances, exits; cell → world coordinates.
  - Shortest route (BFS) as NPC waypoints; walls on terrain (`groundHeight` from `r3f-terrain`).

  Use this whenever the user wants a maze, 미로, labyrinth, dungeon, 던전, arena, 아레나, walled level, corridors or a procedurally generated level — even if they only say "make the map more interesting". Do not install `vibe-starter-3d-environment` for this.
---

# Maze / dungeon / arena recipe (`BOXES`)

Walls are plain `Box` entries in `world.ts` `BOXES`. `Level.tsx` already draws every box and `Player.tsx` already collides with `BOXES.map(boxAabb)`, so generating boxes is the whole job — no rapier, no extra collider code. The floor stays the template floor box (or `r3f-terrain`).

Numbers that matter (`PLAYER` in `config.ts`): the player is 0.7 m wide and 1.6 m tall, walks up ledges ≤ 0.35 m, and a jump lifts the feet ≈ 1.56 m. So passages ≥ 1.5 m and walls ≥ 1.8 m tall keep the maze a maze.

## 1. `src/game/maze.ts` (pure)

```ts
// Seeded maze / dungeon / arena generator that outputs world.ts boxes, so the
// same data is drawn (Level.tsx) and collided (stepPlayer). Pure TypeScript.
import type { Box } from './world';

export type MazeOptions = {
  seed: number;
  /** Cells across (x) and deep (z). */
  cols: number;
  rows: number;
  /** 'backtracker' = long winding corridors; 'prim' = short branchy ones. */
  algorithm?: 'backtracker' | 'prim';
  /** 0…1 share of dead ends knocked open into loops (0 = perfect maze). */
  braid?: number;
  /** Open rectangular rooms (plazas), in cells: [col, row, w, h]. */
  rooms?: [number, number, number, number][];
  /** Random extra rooms (dungeon look): count and max side in cells. */
  randomRooms?: { count: number; maxSize: number };
};

/** Block grid (2·cols+1) × (2·rows+1): true = wall. Cell (c, r) is block (2c+1, 2r+1). */
export type Maze = { w: number; h: number; wall: boolean[]; cols: number; rows: number };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function generateMaze(o: MazeOptions): Maze {
  const rand = rng(o.seed);
  const w = o.cols * 2 + 1;
  const h = o.rows * 2 + 1;
  const wall = new Array<boolean>(w * h).fill(true);
  const open = (x: number, y: number) => (wall[y * w + x] = false);
  const seen = new Uint8Array(o.cols * o.rows);
  const carve = (c: number, r: number, nc: number, nr: number) => {
    open(2 * c + 1, 2 * r + 1);
    open(c + nc + 1, r + nr + 1); // the wall block between the two cells
    open(2 * nc + 1, 2 * nr + 1);
  };
  const neighbors = (c: number, r: number) =>
    DIRS.map(([dx, dy]) => [c + dx, r + dy] as const).filter(
      ([x, y]) => x >= 0 && y >= 0 && x < o.cols && y < o.rows && !seen[y * o.cols + x],
    );

  if ((o.algorithm ?? 'backtracker') === 'backtracker') {
    const stack: [number, number][] = [[0, 0]];
    seen[0] = 1;
    open(1, 1);
    while (stack.length) {
      const [c, r] = stack[stack.length - 1];
      const next = neighbors(c, r);
      if (!next.length) {
        stack.pop();
        continue;
      }
      const [nc, nr] = next[Math.floor(rand() * next.length)];
      seen[nr * o.cols + nc] = 1;
      carve(c, r, nc, nr);
      stack.push([nc, nr]);
    }
  } else {
    // Prim: grow from a frontier of (from, to) edges picked at random.
    const frontier: [number, number, number, number][] = [];
    const add = (c: number, r: number) => {
      seen[r * o.cols + c] = 1;
      open(2 * c + 1, 2 * r + 1);
      for (const [nc, nr] of neighbors(c, r)) frontier.push([c, r, nc, nr]);
    };
    add(0, 0);
    while (frontier.length) {
      const k = Math.floor(rand() * frontier.length);
      const [c, r, nc, nr] = frontier[k];
      frontier[k] = frontier[frontier.length - 1];
      frontier.pop();
      if (seen[nr * o.cols + nc]) continue;
      carve(c, r, nc, nr);
      add(nc, nr);
    }
  }

  // Braid: open one wall of a share of dead ends so the maze gets loops.
  const isWall = (x: number, y: number) => x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1 || wall[y * w + x];
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const x = 2 * c + 1;
      const y = 2 * r + 1;
      const closed = DIRS.filter(([dx, dy]) => isWall(x + dx, y + dy));
      if (closed.length !== 3 || rand() >= (o.braid ?? 0)) continue;
      const inner = closed.filter(([dx, dy]) => x + 2 * dx > 0 && y + 2 * dy > 0 && x + 2 * dx < w - 1 && y + 2 * dy < h - 1);
      if (!inner.length) continue;
      const [dx, dy] = inner[Math.floor(rand() * inner.length)];
      open(x + dx, y + dy);
    }
  }

  // Rooms: clear everything inside (walls between the room's cells too).
  const rooms = [...(o.rooms ?? [])];
  for (let i = 0; i < (o.randomRooms?.count ?? 0); i++) {
    const s = o.randomRooms!.maxSize;
    const rw = 2 + Math.floor(rand() * (s - 1));
    const rh = 2 + Math.floor(rand() * (s - 1));
    rooms.push([Math.floor(rand() * (o.cols - rw)), Math.floor(rand() * (o.rows - rh)), rw, rh]);
  }
  for (const [c, r, rw, rh] of rooms) {
    for (let y = 2 * r + 1; y <= 2 * (r + rh) - 1; y++) for (let x = 2 * c + 1; x <= 2 * (c + rw) - 1; x++) open(x, y);
  }
  return { w, h, wall, cols: o.cols, rows: o.rows };
}

export type MazeLayout = {
  /** Passage width (m). Keep ≥ 1.5: the player is 0.7 m wide. */
  cell: number;
  /** Wall thickness (m). */
  thickness: number;
  /** Wall height (m). Keep ≥ 1.8: a jump lifts the feet ≈ 1.56 m. */
  height: number;
  /** Extra random height per wall run, 0…heightJitter (m). */
  heightJitter?: number;
  /** World x/z of the maze center. */
  center?: [number, number];
  /** Terrain under the maze, e.g. groundHeight from world.ts. Walls reach from below it to `height` above its highest point. */
  groundAt?: (x: number, z: number) => number;
  color: string;
  seed?: number;
};

/** Block index → world coordinate of its min edge, along one axis. */
function edge(i: number, cell: number, t: number) {
  return Math.floor(i / 2) * (cell + t) + (i % 2 ? t : 0);
}

/**
 * Wall blocks merged into boxes: horizontal runs first, then vertical runs of
 * what is left — far fewer boxes (draw calls, collision checks) than one per block.
 * On terrain, runs are capped at 5 blocks so a wall's flat top follows the slope.
 */
export function mazeBoxes(m: Maze, L: MazeLayout): Box[] {
  const rand = rng(L.seed ?? 1);
  const [cx, cz] = L.center ?? [0, 0];
  const ox = cx - edge(m.w, L.cell, L.thickness) / 2;
  const oz = cz - edge(m.h, L.cell, L.thickness) / 2;
  const size = (i: number) => (i % 2 ? L.cell : L.thickness);
  const maxRun = L.groundAt ? 5 : Infinity;
  const used = new Uint8Array(m.w * m.h);
  const free = (x: number, y: number) => m.wall[y * m.w + x] && !used[y * m.w + x];
  const boxes: Box[] = [];
  const emit = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) used[y * m.w + x] = 1;
    const minX = ox + edge(x0, L.cell, L.thickness);
    const maxX = ox + edge(x1, L.cell, L.thickness) + size(x1);
    const minZ = oz + edge(y0, L.cell, L.thickness);
    const maxZ = oz + edge(y1, L.cell, L.thickness) + size(y1);
    let lo = 0;
    let hi = 0;
    if (L.groundAt) {
      lo = Infinity;
      hi = -Infinity;
      for (let s = 0; s <= 4; s++) {
        for (const [px, pz] of [
          [minX + ((maxX - minX) * s) / 4, minZ],
          [minX + ((maxX - minX) * s) / 4, maxZ],
          [minX, minZ + ((maxZ - minZ) * s) / 4],
          [maxX, minZ + ((maxZ - minZ) * s) / 4],
        ]) {
          const g = L.groundAt(px, pz);
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
      }
    }
    const bottom = lo - 0.5; // sink into the terrain so no gap shows on slopes
    const top = hi + L.height + rand() * (L.heightJitter ?? 0);
    boxes.push({ pos: [(minX + maxX) / 2, (bottom + top) / 2, (minZ + maxZ) / 2], size: [maxX - minX, top - bottom, maxZ - minZ], color: L.color });
  };
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!free(x, y)) continue;
      let x1 = x;
      while (x1 + 1 < m.w && free(x1 + 1, y) && x1 + 1 - x < maxRun) x1++;
      if (x1 > x) emit(x, x1, y, y);
      x = x1;
    }
  }
  for (let x = 0; x < m.w; x++) {
    for (let y = 0; y < m.h; y++) {
      if (!free(x, y)) continue;
      let y1 = y;
      while (y1 + 1 < m.h && free(x, y1 + 1) && y1 + 1 - y < maxRun) y1++;
      emit(x, x, y, y1);
      y = y1;
    }
  }
  return boxes;
}

/** World x/z of cell (c, r)'s center — spawn points, goals, pickups. */
export function cellCenter(m: Maze, L: MazeLayout, c: number, r: number): [number, number] {
  const [cx, cz] = L.center ?? [0, 0];
  const ox = cx - edge(m.w, L.cell, L.thickness) / 2;
  const oz = cz - edge(m.h, L.cell, L.thickness) / 2;
  return [ox + edge(2 * c + 1, L.cell, L.thickness) + L.cell / 2, oz + edge(2 * r + 1, L.cell, L.thickness) + L.cell / 2];
}

/** Shortest cell path from → to (BFS over open blocks), as [col, row] cells. Empty if unreachable. */
export function solveMaze(m: Maze, from: [number, number], to: [number, number]): [number, number][] {
  const start = (2 * from[1] + 1) * m.w + 2 * from[0] + 1;
  const goal = (2 * to[1] + 1) * m.w + 2 * to[0] + 1;
  const prev = new Int32Array(m.w * m.h).fill(-1);
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length && prev[goal] < 0; qi++) {
    const i = queue[qi];
    for (const d of [1, -1, m.w, -m.w]) {
      const j = i + d;
      if (j < 0 || j >= m.wall.length || m.wall[j] || prev[j] >= 0) continue;
      if (Math.abs(d) === 1 && Math.floor(j / m.w) !== Math.floor(i / m.w)) continue; // no wrap across rows
      prev[j] = i;
      queue.push(j);
    }
  }
  if (prev[goal] < 0) return [];
  const cells: [number, number][] = [];
  for (let i = goal; ; i = prev[i]) {
    const x = i % m.w;
    const y = Math.floor(i / m.w);
    if (x % 2 && y % 2) cells.push([(x - 1) / 2, (y - 1) / 2]); // keep cell blocks, skip the gaps between them
    if (i === start) break;
  }
  return cells.reverse();
}

/** Open a gap in the outer wall next to a border cell (entrance / exit). */
export function openBorder(m: Maze, c: number, r: number, side: 'n' | 's' | 'e' | 'w') {
  const x = 2 * c + 1 + (side === 'e' ? 1 : side === 'w' ? -1 : 0);
  const y = 2 * r + 1 + (side === 's' ? 1 : side === 'n' ? -1 : 0);
  m.wall[y * m.w + x] = false;
}

/** Arena: a ring of wall segments with `gates` openings, plus optional pillars inside. */
export function arenaBoxes(o: {
  radius: number;
  segments: number;
  gates: number;
  height: number;
  thickness: number;
  pillars?: number;
  center?: [number, number];
  color: string;
}): Box[] {
  const [cx, cz] = o.center ?? [0, 0];
  const boxes: Box[] = [];
  const len = 2 * o.radius * Math.sin(Math.PI / o.segments) + o.thickness;
  const gateEvery = o.gates > 0 ? Math.floor(o.segments / o.gates) : Infinity;
  for (let i = 0; i < o.segments; i++) {
    if (i % gateEvery === 0) continue;
    const a = ((i + 0.5) / o.segments) * Math.PI * 2;
    // Boxes are axis-aligned (AABB collision): approximate the ring with square blocks.
    const x = cx + Math.cos(a) * o.radius;
    const z = cz + Math.sin(a) * o.radius;
    const s = Math.max(o.thickness, len); // neighbours overlap, so the ring has no diagonal gaps
    boxes.push({ pos: [x, o.height / 2, z], size: [s, o.height, s], color: o.color });
  }
  for (let i = 0; i < (o.pillars ?? 0); i++) {
    const a = (i / (o.pillars ?? 1)) * Math.PI * 2;
    const r = o.radius * 0.5;
    boxes.push({ pos: [cx + Math.cos(a) * r, o.height / 2, cz + Math.sin(a) * r], size: [1.2, o.height, 1.2], color: o.color });
  }
  return boxes;
}
```

## 2. Wire it into `src/game/world.ts`

Append after `BOXES` (and after `groundHeight` if you use `r3f-terrain`):

```ts
import { cellCenter, generateMaze, mazeBoxes, openBorder, type MazeLayout } from './maze';

export const MAZE_LAYOUT: MazeLayout = { cell: 2.4, thickness: 0.6, height: 2.2, heightJitter: 0.8, center: [0, -26], color: '#9a8f7d' };
// Courses run from the spawn toward −z (template rule). Width = edge(2·8+1, 2.4, 0.6) = 24.6 m → z −38.3 … −13.7,
// inside the template's 80 × 80 floor (|z| ≤ 40). Keep |center| + width / 2 ≤ 40 when you move or grow it.
// On terrain add `groundAt: groundHeight` to the layout.
export const MAZE = generateMaze({ seed: 3, cols: 8, rows: 8, braid: 0.3, rooms: [[3, 3, 2, 2]] });
openBorder(MAZE, 4, 7, 's'); // entrance on the +z side, facing the spawn (row 7 is the +z edge)
openBorder(MAZE, 4, 0, 'n'); // exit on the far −z side (row 0 is the −z edge)
export const MAZE_GOAL = cellCenter(MAZE, MAZE_LAYOUT, 4, 0);
export const MAZE_BOXES = mazeBoxes(MAZE, MAZE_LAYOUT);
BOXES.push(...MAZE_BOXES); // collision (stepPlayer reads BOXES); drawing is textured, see section 3
```

Variants:
- Dungeon: `generateMaze({ seed, cols: 12, rows: 12, algorithm: 'prim', braid: 0.5, randomRooms: { count: 5, maxSize: 4 } })`.
- Arena: `BOXES.push(...arenaBoxes({ radius: 15, segments: 24, gates: 4, height: 2.5, thickness: 0.8, pillars: 6, color: '#8d8478' }))`.
- Start inside the maze: set `PLAYER.spawn` in `state.ts` right before `export const player = createPlayer();` — `const [sx, sz] = cellCenter(MAZE, MAZE_LAYOUT, 4, 7); PLAYER.spawn[0] = sx; PLAYER.spawn[2] = sz;` (plus `PLAYER.spawn[1] = groundHeight(sx, sz) + 0.05` on terrain; import `PLAYER` from `'../config'` and `MAZE`, `MAZE_LAYOUT`, `groundHeight` from `'./world'`, `cellCenter` from `'./maze'`). Not in `world.ts`: `config` → `game/camera` → `world` is an import cycle, so `PLAYER` doesn't exist yet there at load.
- NPC walking the maze: `solveMaze(MAZE, [4, 7], [4, 0]).map(([c, r]) => cellCenter(MAZE, MAZE_LAYOUT, c, r))` → `{ x, z }` waypoints for an `r3f-navigator` patrol. Straight-line seek/arrive stops at the first wall.
- Goal / exit detection: a `r3f-trigger` zone around `MAZE_GOAL`.

## 3. `src/components/TexturedBoxes.tsx` (textured walls, one draw call)

Walls use the platform's stone-block set on the verse8 CDN (`…/textures/wall/blocks.png`, `blocks_normal.png`, `blocks_ao.png`) — fixed platform URLs, the exception to "asset URLs only from the resource context". All wall boxes are merged into one mesh with world-scaled UVs, so bricks keep their size on every wall. The same component draws any box list with a terrain texture (`set="stone"` for a floor, `"asphalt"`, `"gravel"` …). A flat color shows while loading and if a texture fails.

```tsx
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { envPlaceholder, envTask } from '../game/envReady';
import type { Box } from '../game/world';

// Platform default textures (verse8 CDN, CORS-open, 512² PNG) — fixed URLs, the
// exception to "asset URLs only from the resource context".
const CDN = 'https://agent8-games.verse8.io/assets/3d/default/textures/';
export const TEXTURE_SETS = {
  blocks: 'wall/blocks', // stone-block wall
  stone: 'terrain/stone',
  gravel: 'terrain/gravel',
  dirt: 'terrain/dirt',
  asphalt: 'terrain/asphalt',
  grass: 'terrain/grass',
  sand: 'terrain/sand',
  snow: 'terrain/snow',
} as const;
export type TextureSet = keyof typeof TEXTURE_SETS;
const urls = (s: TextureSet) => ['', '_normal', '_ao'].map((k) => `${CDN}${TEXTURE_SETS[s]}${k}.png`);

// Box faces: outward normal, then the two in-face axes (u, v) as axis indices 0 = x, 1 = y, 2 = z.
const FACES: { n: [number, number, number]; u: number; v: number }[] = [
  { n: [1, 0, 0], u: 2, v: 1 },
  { n: [-1, 0, 0], u: 2, v: 1 },
  { n: [0, 1, 0], u: 0, v: 2 },
  { n: [0, 0, 1], u: 0, v: 1 },
  { n: [0, 0, -1], u: 0, v: 1 },
  // the bottom face is never seen (boxes stand on the ground)
];

/**
 * All boxes merged into ONE geometry with world-scaled UVs: the texture keeps
 * its size on long and short walls alike (`tile` m per repeat), and the whole
 * maze is a single draw call.
 */
function boxesGeometry(boxes: Box[], tile: number) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const { pos: c, size: s } of boxes) {
    const min = [c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2];
    const max = [c[0] + s[0] / 2, c[1] + s[1] / 2, c[2] + s[2] / 2];
    for (const f of FACES) {
      const a = f.n.findIndex((x) => x !== 0);
      const side = f.n[a] > 0 ? max[a] : min[a];
      const base = pos.length / 3;
      for (const [cu, cv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const p = [0, 0, 0];
        p[a] = side;
        p[f.u] = cu ? max[f.u] : min[f.u];
        p[f.v] = cv ? max[f.v] : min[f.v];
        pos.push(p[0], p[1], p[2]);
        nrm.push(...f.n);
        uv.push(p[f.u] / tile, p[f.v] / tile);
      }
      // corners go (0,0) (1,0) (1,1) (0,1) in (u, v): counter-clockwise from outside iff u × v points along n
      const cross = [0, 0, 0];
      cross[3 - f.u - f.v] = (f.v - f.u + 3) % 3 === 1 ? 1 : -1; // x×y = z, y×z = x, z×x = y; reversed order flips
      const ccw = cross[a] === f.n[a];
      if (ccw) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function Textured({ geometry, set, onShown }: { geometry: THREE.BufferGeometry; set: TextureSet; onShown: () => void }) {
  const [map, normalMap, aoMap] = useTexture(urls(set));
  useMemo(() => {
    for (const t of [map, normalMap, aoMap]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
    map.colorSpace = THREE.SRGBColorSpace;
  }, [map, normalMap, aoMap]);
  useEffect(onShown, []);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial map={map} normalMap={normalMap} aoMap={aoMap} roughness={0.9} />
    </mesh>
  );
}

class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Flat-color boxes: a placeholder while the textures load (the loading gate waits), the final look if they fail. */
function FlatBoxes({ geometry, color, placeholder, onMount }: { geometry: THREE.BufferGeometry; color: string; placeholder: boolean; onMount?: () => void }) {
  useEffect(() => {
    onMount?.();
    return placeholder ? envPlaceholder() : undefined;
    // mount-only
  }, []);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>
  );
}

/** Draw boxes with a CDN texture set (flat `color` while loading / if it fails). Reports a 'walls' task to envReady. */
export function TexturedBoxes({ boxes, set = 'blocks', tile = 3, color = '#9a8f7d' }: { boxes: Box[]; set?: TextureSet; tile?: number; color?: string }) {
  const geometry = useMemo(() => boxesGeometry(boxes, tile), [boxes, tile]);
  const done = useRef<() => void>(undefined);
  // Layout effect: registered before the children's effects. With cached textures <Textured>
  // mounts in the same commit and its onShown effect runs first — a plain useEffect here
  // would register the task after it was "finished", and the gate would never open.
  useLayoutEffect(() => {
    done.current = envTask(`walls ${set}`);
    return () => done.current?.();
  }, [set]);
  const finish = () => done.current?.();
  return (
    <Fallback fallback={<FlatBoxes geometry={geometry} color={color} placeholder={false} onMount={finish} />}>
      <Suspense fallback={<FlatBoxes geometry={geometry} color={color} placeholder />}>
        <Textured geometry={geometry} set={set} onShown={finish} />
      </Suspense>
    </Fallback>
  );
}
```

`src/components/Level.tsx` — draw the maze walls textured and skip them in the plain per-box meshes:

```tsx
import { TexturedBoxes } from './TexturedBoxes';
import { MAZE_BOXES } from '../game/world';

/** Maze walls are drawn textured (one mesh) by <TexturedBoxes>; the plain per-box meshes skip them. */
const MAZE_SET = new Set(MAZE_BOXES);

// in Level(): replace the BOXES.map with
{BOXES.map((b, i) =>
  MAZE_SET.has(b) ? null : (
    <mesh key={i} position={b.pos} castShadow={i > 0} receiveShadow>
      <boxGeometry args={b.size} />
      <meshStandardMaterial color={b.color} />
    </mesh>
  ),
)}
<TexturedBoxes boxes={MAZE_BOXES} set="blocks" />
```

**Floor — textured by default.** On terrain, `r3f-terrain`'s textured `TerrainMesh` is the floor. Without terrain, draw the template floor box textured too — add `BOXES[0]` to the skip set and render `<TexturedBoxes boxes={[BOXES[0]]} set="stone" tile={4} />` (dungeon, arena), `set="asphalt"` (city, shooter) or `set="grass"` (garden maze). Don't leave the template's flat green floor under a built level.

**Cover, barricades, platforms, steps — same rule.** Anything the player hides behind or stands on is a `Box` in `BOXES` for collision; draw it one of two ways, never as a flat-colored box:
- **Resource model** (first choice when the resource context has one — crate, barrel, barrier, container, sandbag; see the search table in `r3f-model-placer`): keep the `Box` as the invisible collider (add it to the skip set so `Level.tsx` doesn't draw it) and draw the model at the same spot with `Props`, `height` = the box height.
- **Textured box:** put the boxes in their own list and draw them with `TexturedBoxes` — `set="blocks"` for walls and cover, `"stone"` / `"gravel"` for platforms and steps, `"asphalt"` for ramps and roads.

```ts
// world.ts — cover for an arena / shooter: collide through BOXES, draw textured
export const COVER: Box[] = [
  { pos: [4, 0.6, -3], size: [2.4, 1.2, 0.6], color: '#9a8f7d' },
  { pos: [-5, 0.6, 2], size: [0.6, 1.2, 2.4], color: '#9a8f7d' },
  { pos: [0, 0.25, 6], size: [3, 0.5, 3], color: '#8a8580' }, // low platform (0.5 m: jump on)
];
BOXES.push(...COVER);
// Level.tsx: add COVER to the skip set, then <TexturedBoxes boxes={COVER} set="blocks" tile={2} />
```

A single-color box is a placeholder for the first minutes of blocking out a level, not something to ship.

## 4. `src/game/envReady.ts` — loading gate (shared; skip if the project already has it)

`TexturedBoxes` reports to this signal: a `walls` task until the block textures are on screen, and the flat-color walls count as a placeholder meanwhile. Wire the gate so the play screen never shows flat walls — `<EnvFrame />` inside the canvas and `<LoadingOverlay />` (or `<StartButton />` in a title) outside it, plus the input block in `Player.tsx`: copy `LoadingOverlay.tsx` and follow `r3f-terrain` sections 4b–4c.

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

- **Separate collider list.** Don't keep maze walls in a second array that only `Level.tsx` draws, or only `Player.tsx` collides with — push them into `BOXES` so both see the same data. If NPCs are added, give them the same `BOXES.map(boxAabb)`.
- **Rotated walls.** `stepPlayer` collides axis-aligned boxes; a `Box` has no rotation. Diagonal or round walls must be approximated with blocks (as `arenaBoxes` does) — don't rotate the mesh, the collision would not follow.
- **Flat-colored walls.** A maze of single-color boxes looks unfinished; the CDN block texture exists — draw walls with `TexturedBoxes`. Stretched textures come from per-box `boxGeometry` UVs (0…1 per face); the merged geometry's world-scaled UVs avoid that.
- **Too many boxes.** Every box is a collision check per substep. `mazeBoxes` merges runs (an 8 × 8 maze is ~40 boxes instead of ~160 blocks), and `TexturedBoxes` draws all of them in one call.
- **Walls you can jump over / gaps you can't fit.** Keep `height ≥ 1.8` and `cell ≥ 1.5` (see the numbers above). Thin walls (< 0.3 m) are fine for collision because the player moves in 1/120 s substeps.
- **Camera inside walls.** The orbit camera can end up behind a wall in narrow corridors; lower `CAMERA.free.distance` or raise pitch for maze games.
- **Multiplayer.** Every client must use the same `seed`; never `Math.random()` here.
- **Reading or changing config at the top of `world.ts`.** Don't: `config` → `game/camera` → `world` is an import cycle, so `PLAYER` / `CAMERA` don't exist yet there and the app dies on start. Set the maze spawn in `state.ts` (above).
