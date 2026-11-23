---
name: r3f-grass
description: |
  Code recipe for large amounts of grass on the ground or terrain in a React Three Fiber game on the kinematic-controller templates. One component using instanced meshes and a wind vertex shader — no grass library, no textures.

  Covers:
  - Tens of thousands of blades in a few draw calls (one `InstancedMesh` per tile), placed on `groundHeight` from `r3f-terrain`.
  - Density, blade height, base/tip color for meadows, lawns or savanna; natural clusters from noise.
  - Wind sway with travelling gusts, keeping scene lights and fog.
  - Keeping grass out of water, walls, paths and steep slopes.
  - Per-tile frustum culling, distance culling and fewer blades far away (LOD).

  Use this whenever the user asks for grass, a meadow, a field, a lawn, vegetation on the ground, "make the ground look alive", or wind in the grass — even if they don't say "instancing". For trees and bushes use `r3f-tree`; for rocks and props use `r3f-model-placer`. Do not install `vibe-starter-3d-environment` for this.
---

# Grass recipe (instanced blades + wind shader)

Each blade is a tiny tapered strip (10 vertices). Blades are grouped into square tiles; each tile is one `InstancedMesh`, so off-screen tiles are frustum-culled and far tiles draw a random subset. Wind bends the blade tips in the vertex shader of a stock `MeshLambertMaterial` (via `onBeforeCompile`), so lights and fog keep working.

Grass is decoration — it has no collision and does not need to be in `world.ts`. `simplex-noise` is already a template dependency.

## 1. `src/components/Grass.tsx`

```tsx
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { createNoise2D } from 'simplex-noise';
import * as THREE from 'three';

export type GrassOptions = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Ground height (e.g. groundHeight from world.ts). */
  groundAt: (x: number, z: number) => number;
  /** Blades per m² where the cluster noise is full. 8–20 for meadows, 2–5 for savanna. */
  density?: number;
  /** Blade height range (m). */
  height?: [number, number];
  baseColor?: string;
  tipColor?: string;
  /** 0 = uniform, 1 = sharp patches. */
  clustering?: number;
  /** Cluster feature size (m). */
  clusterScale?: number;
  wind?: number;
  /** Return true where no grass may grow (water, walls, paths). Slopes steeper than maxSlope are skipped too. */
  exclude?: (x: number, z: number, y: number) => boolean;
  /** Steepest slope (normal y) grass grows on. */
  minNormalY?: number;
  /** Tile size (m) for culling, and the distance (m) beyond which tiles are hidden; between fadeStart and it the blade count thins out. */
  tile?: number;
  drawDistance?: number;
  fadeStart?: number;
  seed?: number;
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One blade: 4-segment tapered strip, 1 m tall (scaled per instance), base color → tip color in vertex colors. */
function bladeGeometry(base: THREE.Color, tip: THREE.Color) {
  const SEG = 4;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const w = 0.035 * (1 - t);
    pos.push(-w, t, 0, w, t, 0);
    c.copy(base).lerp(tip, t);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    if (i < SEG) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Lambert + vertex colors, with a wind bend added in the vertex shader (keeps lights and fog). */
function grassMaterial(time: { value: number }, wind: number) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uWind = { value: wind };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uWind;')
      // Bend after the instance transform so every blade leans the same world direction.
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        float gust = sin(uTime * 1.7 + mvPosition.x * 0.35 + mvPosition.z * 0.2) * 0.6 + sin(uTime * 3.1 + mvPosition.x * 1.3) * 0.25;
        float bend = position.y * position.y * uWind * (0.5 + gust);
        mvPosition.x += bend;
        mvPosition.z += bend * 0.4;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  return m;
}

type Tile = { cx: number; cz: number; matrices: THREE.Matrix4[] };

/**
 * Grass: one InstancedMesh per tile so frustum culling drops off-screen tiles,
 * and far tiles draw fewer blades (instances are shuffled, so a lower count is a random subset).
 */
export function Grass(o: GrassOptions) {
  const time = useRef({ value: 0 }).current;
  const { geometry, material, tiles } = useMemo(() => {
    const rand = rng(o.seed ?? 1);
    const noise = createNoise2D(rand);
    const tileSize = o.tile ?? 16;
    const [hMin, hMax] = o.height ?? [0.35, 0.7];
    const density = o.density ?? 10;
    const clustering = o.clustering ?? 0.6;
    const clusterScale = o.clusterScale ?? 12;
    const minNy = o.minNormalY ?? 0.8;
    const tiles: Tile[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let tz = o.minZ; tz < o.maxZ; tz += tileSize) {
      for (let tx = o.minX; tx < o.maxX; tx += tileSize) {
        const tw = Math.min(tileSize, o.maxX - tx);
        const td = Math.min(tileSize, o.maxZ - tz);
        const tries = Math.round(tw * td * density);
        const matrices: THREE.Matrix4[] = [];
        for (let i = 0; i < tries; i++) {
          const x = tx + rand() * tw;
          const z = tz + rand() * td;
          // clusters: keep a blade with probability from noise
          const n = (noise(x / clusterScale, z / clusterScale) + 1) / 2;
          if (rand() > 1 - clustering + clustering * n * n * 2) continue;
          const y = o.groundAt(x, z);
          const dx = o.groundAt(x + 0.3, z) - o.groundAt(x - 0.3, z);
          const dz = o.groundAt(x, z + 0.3) - o.groundAt(x, z - 0.3);
          if (0.6 / Math.hypot(dx, 0.6, dz) < minNy) continue;
          if (o.exclude?.(x, z, y)) continue;
          const h = hMin + rand() * (hMax - hMin);
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          m.compose(p.set(x, y, z), q, s.set(1 + rand() * 0.6, h, 1));
          matrices.push(m.clone());
        }
        for (let i = matrices.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [matrices[i], matrices[j]] = [matrices[j], matrices[i]];
        }
        if (matrices.length) tiles.push({ cx: tx + tw / 2, cz: tz + td / 2, matrices });
      }
    }
    // Defaults match the CDN grass.png (olive) used by r3f-terrain, so blades read as part of the ground.
    const geometry = bladeGeometry(new THREE.Color(o.baseColor ?? '#3f4519'), new THREE.Color(o.tipColor ?? '#9c9a4c'));
    return { geometry, material: grassMaterial(time, o.wind ?? 0.25), tiles };
    // Rebuilds when the area, ground, density or seed change; looks are fixed at build.
  }, [o.minX, o.maxX, o.minZ, o.maxZ, o.groundAt, o.density, o.seed]);

  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  useLayoutEffect(() => {
    tiles.forEach((t, i) => {
      const mesh = meshes.current[i];
      if (!mesh) return;
      t.matrices.forEach((mat, k) => mesh.setMatrixAt(k, mat));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere(); // per-instance bounds → correct frustum culling
    });
  }, [tiles]);

  const far = o.drawDistance ?? 60;
  const fade = o.fadeStart ?? 30;
  useFrame(({ camera }, dt) => {
    time.value += dt;
    tiles.forEach((t, i) => {
      const mesh = meshes.current[i];
      if (!mesh) return;
      const d = Math.hypot(camera.position.x - t.cx, camera.position.z - t.cz);
      mesh.visible = d < far;
      const k = d <= fade ? 1 : Math.max(0.15, 1 - (d - fade) / (far - fade));
      mesh.count = Math.ceil(t.matrices.length * k);
    });
  });

  return (
    <>
      {tiles.map((t, i) => (
        <instancedMesh
          key={i}
          ref={(el) => {
            meshes.current[i] = el;
          }}
          args={[geometry, material, t.matrices.length]}
          receiveShadow
        />
      ))}
    </>
  );
}
```

## 2. Wire it in

Mount inside `<Canvas>` (in `Level.tsx` or next to `<Level />`). Pass a **stable** `groundAt` / `exclude` (module-level functions, not inline arrows recreated per render) — they are memo dependencies.

```tsx
import { Grass } from './Grass';
import { BOXES, WATER, boxAabb, groundHeight } from '../game/world';

const WALLS = BOXES.slice(1).map(boxAabb); // skip the floor box
const noGrass = (x: number, z: number, y: number) =>
  y < WATER.level + 0.2 || // r3f-water: no grass under water or on the wet beach
  WALLS.some((b) => x > b.minX - 0.2 && x < b.maxX + 0.2 && z > b.minZ - 0.2 && z < b.maxZ + 0.2); // r3f-stage-maze walls

<Grass minX={-40} maxX={40} minZ={-40} maxZ={40} groundAt={groundHeight} exclude={noGrass} />
// lush meadow: density={18} height={[0.4, 0.9]} clustering={0.3}
// savanna:     density={4}  height={[0.6, 1.2]} baseColor="#8a7a3a" tipColor="#e0c872" clustering={0.8}
// lawn:        density={25} height={[0.12, 0.2]} clustering={0} wind={0.08}
```

Without terrain, `groundAt={() => 0}` (the floor top) and no `WATER` in `noGrass`.

## Pitfalls

- **Frame rate.** Blade count ≈ area × density × (1 − clustering/2). Keep the visible total under ~80 k on mobile: shrink the area to around the play space, lower `density`, or lower `drawDistance`. Build time also grows with count (5 `groundAt` calls per blade), so very large fields belong behind a loading screen or in smaller areas.
- **One giant InstancedMesh.** Without tiles, frustum culling is all-or-nothing and LOD is impossible. Keep `tile` 12–24 m.
- **Missing `computeBoundingSphere()`.** An `InstancedMesh`'s default bounds are the single blade at the origin, so whole tiles disappear when the origin leaves the view. The recipe calls it after writing matrices — keep that if you edit matrices later.
- **Grass through walls / under water.** Use `exclude`; the controller doesn't know about grass, so it never pushes anything.
- **Shadows.** Blades receive shadows but don't cast them (the shadow pass would not have the wind bend, and thousands of casters are expensive). Leave `castShadow` off.
- **Per-blade React components (drei `<Instance>`).** Fine for a few hundred props, far too slow for grass — keep the raw `InstancedMesh`.
