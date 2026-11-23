---
name: r3f-terrain
description: |
  Code recipe for procedural terrain (hills, mountains, dunes, islands) in a React Three Fiber game on the kinematic-controller templates (`world.ts` `FIELDS` / `HeightField`). No terrain library — paste the files.

  Covers:
  - Seeded simplex-noise height map (octaves, roughness, flat spawn plaza) baked so `heightAt(x, z)` is cheap.
  - Registered as a `HeightField`, so the player walks on it with the template's slope limit and step-up.
  - Texture splatting from the verse8 CDN (grass, dirt, stone, sand, snow …, albedo + normal + AO) by height and slope; vertex-color fallback.
  - `groundHeight(x, z)` for placing the player, props, water, grass, NPCs and walls; the player starts ON the terrain.
  - Tilting objects to the slope.

  Use this whenever the user asks for terrain, ground that is not flat, hills, mountains, valleys, an island, a heightmap, or anything that needs "the ground height at x, z" — even if they don't say "terrain". Do not install `vibe-starter-3d-environment` for this.
---

# Terrain recipe (HeightField)

The template's controller already stands on height fields: anything in `world.ts` `FIELDS` is drawn by `Level.tsx` and collided by `stepPlayer` (slopes steeper than `PLAYER.maxSlope` 60° are walls, rises above `PLAYER.stepHeight` 0.35 m block). This recipe supplies a good `heightAt`, a textured mesh, and the spawn fix.

`simplex-noise` is already a template dependency (`^4.0.3`). If `package.json` lacks it, `bun add simplex-noise`.

**Textures — platform defaults on the verse8 CDN.** These fixed URLs are the one exception to "asset URLs only from the resource context": they are the platform's own default textures (the same files `vibe-starter-3d-environment` used), CORS-open, 512² PNG. Base `https://agent8-games.verse8.io/assets/3d/default/textures/terrain/`, each name has `{name}.png` (albedo, sRGB), `{name}_normal.png`, `{name}_ao.png`:

| name | use |
|---|---|
| `grass` | meadows, default ground (olive) |
| `dirt` | hilltops, paths, bare ground |
| `stone` | cliffs, steep slopes |
| `gravel` | high slopes, riverbeds, roads |
| `sand` | beaches, lake shores, deserts |
| `snow` | mountain caps (only on tall terrain) |
| `asphalt` | roads, plazas |

A textured terrain is the default. Never leave the ground a single flat color when these exist.

## 1. `src/game/terrain.ts` (pure — no React, no three)

```ts
// Seeded noise terrain as a HeightField (world.ts). Pure: no React, no three.
// The heights are baked into a grid once, so heightAt is a cheap bilinear
// lookup — stepPlayer calls it several times per 1/120 s substep.
import { createNoise2D } from 'simplex-noise';
import type { HeightField } from './world';

export type TerrainOptions = {
  /** Same seed → same terrain on every client and every reload. */
  seed: number;
  /** Square side (m), centered on the origin unless `center` is given. */
  size: number;
  center?: [number, number];
  /** Baked sample spacing (m). 1 is plenty for the 0.5 m render grid. */
  resolution?: number;
  /** Peak height above `base` (m). */
  height: number;
  /** Feature size (m): larger = broader hills. */
  scale: number;
  /** fBm layers: 1 = smooth dunes, 4–5 = rugged. */
  octaves?: number;
  /** 0.4 smooth … 0.6 rough: how much each octave keeps. */
  roughness?: number;
  /** >1 flattens valleys and sharpens peaks (mountains), <1 rounds them (hills). */
  sharpness?: number;
  /** Lowest surface height (m). Keep ≥ 0 if the template floor box stays. */
  base?: number;
  /** Radius (m) around the center flattened to `base` + flatHeight — a safe spawn plaza. */
  flatRadius?: number;
  flatHeight?: number;
  color?: string;
};

export type Terrain = HeightField & {
  /** Height normalized to 0…1 at (x, z) — used for vertex colors. */
  normalizedAt: (x: number, z: number) => number;
  base: number;
  peak: number;
};

/** mulberry32: a tiny seeded PRNG so createNoise2D is deterministic. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createTerrain(o: TerrainOptions): Terrain {
  const [cx, cz] = o.center ?? [0, 0];
  const half = o.size / 2;
  const res = o.resolution ?? 1;
  const octaves = o.octaves ?? 4;
  const roughness = o.roughness ?? 0.5;
  const sharpness = o.sharpness ?? 1.4;
  const base = o.base ?? 0;
  const flatR = o.flatRadius ?? 0;
  const noise = createNoise2D(seeded(o.seed));

  const n = Math.ceil(o.size / res) + 1;
  const grid = new Float32Array(n * n);
  const minX = cx - half;
  const minZ = cz - half;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = minX + i * res;
      const z = minZ + j * res;
      let amp = 1;
      let freq = 1 / o.scale;
      let sum = 0;
      let norm = 0;
      for (let k = 0; k < octaves; k++) {
        sum += amp * noise(x * freq, z * freq);
        norm += amp;
        amp *= roughness;
        freq *= 2;
      }
      let h = Math.pow((sum / norm + 1) / 2, sharpness); // 0…1
      if (flatR > 0) {
        // smoothstep blend from the plaza (0) to full terrain (1)
        const d = Math.hypot(x - cx, z - cz);
        const t = Math.min(1, Math.max(0, (d - flatR) / flatR));
        const s = t * t * (3 - 2 * t);
        h = (o.flatHeight ?? 0) / o.height + (h - (o.flatHeight ?? 0) / o.height) * s;
      }
      grid[j * n + i] = base + h * o.height;
    }
  }

  const heightAt = (x: number, z: number) => {
    const fx = Math.min(n - 1.0001, Math.max(0, (x - minX) / res));
    const fz = Math.min(n - 1.0001, Math.max(0, (z - minZ) / res));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = grid[j * n + i];
    const b = grid[j * n + i + 1];
    const c = grid[(j + 1) * n + i];
    const d = grid[(j + 1) * n + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };

  return {
    minX,
    maxX: cx + half,
    minZ,
    maxZ: cz + half,
    heightAt,
    normalizedAt: (x, z) => (heightAt(x, z) - base) / o.height,
    base,
    peak: base + o.height,
    color: o.color,
  };
}

/** Surface normal y (1 = flat, 0 = vertical) by central differences. */
export function slopeAt(f: HeightField, x: number, z: number, e = 0.5): number {
  const dx = (f.heightAt(x + e, z) - f.heightAt(x - e, z)) / (2 * e);
  const dz = (f.heightAt(x, z + e) - f.heightAt(x, z - e)) / (2 * e);
  return 1 / Math.hypot(dx, 1, dz);
}

/** Tilt that stands an object's +y on the slope normal: [rotX, rotZ] (radians, for rotation={[rx, yaw, rz]}). */
export function alignToSurface(f: HeightField, x: number, z: number, e = 0.5): [number, number] {
  const dx = (f.heightAt(x + e, z) - f.heightAt(x - e, z)) / (2 * e);
  const dz = (f.heightAt(x, z + e) - f.heightAt(x, z - e)) / (2 * e);
  return [-Math.atan(dz), Math.atan(dx)];
}
```

Shape presets (`createTerrain` options): rolling hills `{ height: 6, scale: 40, octaves: 3, sharpness: 0.9 }` · mountains `{ height: 25, scale: 60, octaves: 5, roughness: 0.55, sharpness: 2 }` · dunes `{ height: 3, scale: 18, octaves: 1 }` · almost flat `{ height: 1, scale: 30, octaves: 2 }`. Keep the walkable part under 60°: steep `height / scale` ratios make walls the player cannot climb.

## 2. `src/components/TerrainMesh.tsx` (texture splatting, vertex-color fallback)

Per-vertex layer weights (height band × slope band, normalized) go into a `splat` attribute; a `MeshStandardMaterial` patched in `onBeforeCompile` samples 4 albedo / normal / AO sets on world-space UVs and blends them — scene lights, shadows and fog keep working. Albedo is sampled at two scales mixed by low-frequency noise so the 512² tiles don't repeat visibly. Textures load through drei `useTexture` inside `<Suspense>`; while loading, and if a URL fails, the same mesh shows the layers' flat colors.

```tsx
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { envPlaceholder, envTask } from '../game/envReady';
import type { HeightField } from '../game/world';

// Platform default textures (verse8 CDN, CORS-open, 512² PNG). Fixed URLs — the
// one exception to "asset URLs only from the resource context".
const BASE = 'https://agent8-games.verse8.io/assets/3d/default/textures/terrain/';
export type TerrainTexture = 'grass' | 'dirt' | 'stone' | 'gravel' | 'sand' | 'snow' | 'asphalt';
const urls = (n: TerrainTexture) => [`${BASE}${n}.png`, `${BASE}${n}_normal.png`, `${BASE}${n}_ao.png`];

export type SplatLayer = {
  texture: TerrainTexture;
  /** Metres per texture repeat. */
  tile: number;
  /** Normalized height band 0…1 (of this field's lowest…highest point). */
  height: [number, number];
  /** Slope band in degrees (0 = flat). */
  slope: [number, number];
  /** Flat color used before the textures arrive (and if they fail). */
  color: string;
};

/** Up to 4 layers, blended by height and slope (weights are normalized where bands overlap). */
export const DEFAULT_LAYERS: SplatLayer[] = [
  { texture: 'sand', tile: 6, height: [0, 0.1], slope: [0, 35], color: '#d9a94a' },
  { texture: 'grass', tile: 5, height: [0.06, 0.85], slope: [0, 30], color: '#6b6b2e' },
  { texture: 'dirt', tile: 6, height: [0.8, 1], slope: [0, 34], color: '#6e5338' },
  { texture: 'stone', tile: 8, height: [0, 1], slope: [27, 90], color: '#8a8580' },
];
/** Tall mountains (peaks ≳ 20 m): snow caps instead of dirt tops. Snow on low rolling hills looks wrong. */
export const MOUNTAIN_LAYERS: SplatLayer[] = [
  { texture: 'grass', tile: 5, height: [0, 0.55], slope: [0, 30], color: '#6b6b2e' },
  { texture: 'gravel', tile: 6, height: [0.5, 0.8], slope: [0, 34], color: '#7c7468' },
  { texture: 'stone', tile: 8, height: [0, 1], slope: [27, 90], color: '#8a8580' },
  { texture: 'snow', tile: 7, height: [0.78, 1], slope: [0, 38], color: '#f2f2f2' },
];

/** Grid spacing (m). 0.5 keeps hills smooth up to ~200 m fields; use 1 beyond that. */
const STEP = 0.5;
const HEIGHT_BLEND = 0.05;
const SLOPE_BLEND = 6;

const band = (v: number, [lo, hi]: [number, number], blend: number) =>
  v < lo ? Math.max(0, 1 - (lo - v) / blend) : v > hi ? Math.max(0, 1 - (v - hi) / blend) : 1;

/** Displaced plane + per-vertex layer weights (`splat`, vec4) and a matching fallback vertex color. */
function useTerrainGeometry(field: HeightField, layers: SplatLayer[]) {
  return useMemo(() => {
    const w = field.maxX - field.minX;
    const d = field.maxZ - field.minZ;
    const g = new THREE.PlaneGeometry(w, d, Math.ceil(w / STEP), Math.ceil(d / STEP));
    g.rotateX(-Math.PI / 2); // uv: u → +x, v → −z (the shader's world UVs match, so normal maps face the right way)
    const pos = g.attributes.position;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (field.minX + field.maxX) / 2;
      const z = pos.getZ(i) + (field.minZ + field.maxZ) / 2;
      const y = field.heightAt(x, z);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
      pos.setXYZ(i, x, y, z);
    }
    g.computeVertexNormals(); // after displacement, or lighting and slopes are those of a flat plane
    const nrm = g.attributes.normal;
    const splat = new Float32Array(pos.count * 4);
    const colors = new Float32Array(pos.count * 3);
    const flat = layers.map((l) => new THREE.Color(l.color));
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) - lo) / Math.max(1e-6, hi - lo);
      const deg = (Math.acos(Math.min(1, nrm.getY(i))) * 180) / Math.PI;
      const wts = [0, 0, 0, 0];
      let sum = 0;
      layers.forEach((l, k) => {
        wts[k] = band(t, l.height, HEIGHT_BLEND) * band(deg, l.slope, SLOPE_BLEND);
        sum += wts[k];
      });
      if (sum === 0) {
        wts[Math.min(1, layers.length - 1)] = 1;
        sum = 1;
      }
      c.setRGB(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        splat[i * 4 + k] = wts[k] / sum;
        if (flat[k]) c.add(flat[k].clone().multiplyScalar(wts[k] / sum));
      }
      c.toArray(colors, i * 3);
    }
    g.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [field, layers]);
}

/**
 * MeshStandardMaterial + onBeforeCompile: 4 albedo/normal/AO sets sampled on world
 * UVs, weighted by `splat`. Albedo is sampled twice at different scales and mixed
 * by low-frequency noise so the tiling doesn't show; AO darkens the albedo.
 */
function splatMaterial(layers: SplatLayer[], tex: THREE.Texture[]) {
  const n = layers.length;
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  m.normalMap = tex[1]; // turns on the tangent-space normal path (tbn); the chunk below replaces the sampling
  m.normalScale.set(1, 1);
  m.onBeforeCompile = (s) => {
    for (let k = 0; k < 4; k++) {
      const j = Math.min(k, n - 1);
      s.uniforms[`tA${k}`] = { value: tex[j * 3] };
      s.uniforms[`tN${k}`] = { value: tex[j * 3 + 1] };
      s.uniforms[`tO${k}`] = { value: tex[j * 3 + 2] };
      s.uniforms[`uTile${k}`] = { value: layers[j].tile };
    }
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vSplatPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;\nvSplatPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec4 vSplat;
        varying vec3 vSplatPos;
        uniform sampler2D tA0, tA1, tA2, tA3, tN0, tN1, tN2, tN3, tO0, tO1, tO2, tO3;
        uniform float uTile0, uTile1, uTile2, uTile3;
        float splatHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float splatNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(splatHash(i), splatHash(i + vec2(1, 0)), f.x), mix(splatHash(i + vec2(0, 1)), splatHash(i + vec2(1, 1)), f.x), f.y);
        }
        vec2 splatUv() { return vec2(vSplatPos.x, -vSplatPos.z); }
        vec3 albedo(sampler2D t, float tile, float n) {
          vec2 uv = splatUv() / tile;
          return mix(texture2D(t, uv).rgb, texture2D(t, uv * 0.37 + 0.13).rgb, n);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `float sn = smoothstep(0.25, 0.75, splatNoise(splatUv() / 23.0));
        vec2 suv = splatUv();
        vec3 splatCol = albedo(tA0, uTile0, sn) * vSplat.x + albedo(tA1, uTile1, sn) * vSplat.y
                      + albedo(tA2, uTile2, sn) * vSplat.z + albedo(tA3, uTile3, sn) * vSplat.w;
        float splatAo = texture2D(tO0, suv / uTile0).r * vSplat.x + texture2D(tO1, suv / uTile1).r * vSplat.y
                      + texture2D(tO2, suv / uTile2).r * vSplat.z + texture2D(tO3, suv / uTile3).r * vSplat.w;
        diffuseColor.rgb *= splatCol * mix(1.0, splatAo, 0.8) * (0.88 + 0.24 * splatNoise(suv / 61.0));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 mapN = (texture2D(tN0, suv / uTile0).xyz * vSplat.x + texture2D(tN1, suv / uTile1).xyz * vSplat.y
                   + texture2D(tN2, suv / uTile2).xyz * vSplat.z + texture2D(tN3, suv / uTile3).xyz * vSplat.w) * 2.0 - 1.0;
        mapN.xy *= normalScale;
        normal = normalize(tbn * mapN);`,
      );
  };
  return m;
}

/** The textured mesh; fades in over `fade` s on top of the flat one (same depth, drawn after), then reports `onShown`. */
function Splatted({ layers, geometry, fade, onShown }: { layers: SplatLayer[]; geometry: THREE.BufferGeometry; fade: number; onShown: () => void }) {
  const tex = useTexture(layers.flatMap((l) => urls(l.texture)));
  const material = useMemo(() => {
    tex.forEach((t, i) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.colorSpace = i % 3 === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace; // albedo is sRGB, normal/AO are data
      t.needsUpdate = true;
    });
    const m = splatMaterial(layers, tex);
    m.transparent = fade > 0;
    m.opacity = fade > 0 ? 0 : 1;
    return m;
  }, [tex, layers, fade]);
  const t = useRef(0);
  const reported = useRef(false);
  useFrame((_, dt) => {
    if (reported.current) return;
    t.current += dt;
    material.opacity = fade > 0 ? Math.min(1, t.current / fade) : 1;
    if (material.opacity < 1) return;
    material.transparent = false;
    material.needsUpdate = true;
    reported.current = true;
    onShown();
  });
  return <mesh geometry={geometry} material={material} receiveShadow />;
}

/**
 * Vertex colors from the same layer weights — shown while loading (a placeholder:
 * the loading gate waits for it to go) and, if a texture fails, as the final look.
 */
function Flat({ geometry, placeholder, onMount }: { geometry: THREE.BufferGeometry; placeholder: boolean; onMount?: () => void }) {
  useEffect(() => {
    onMount?.();
    return placeholder ? envPlaceholder() : undefined;
    // mount-only
  }, []);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.95} />
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

/**
 * A height field drawn with texture splatting (height + slope). Until the 12
 * textures are in, the vertex-color mesh shows; the textured one fades in over it
 * (`fade` s), then the flat one is dropped. Reports to envReady ('terrain' task +
 * placeholder), so a loading gate stays closed until the textured ground is up.
 * If a texture fails, the flat mesh stays as the final look and the task ends.
 */
export function TerrainMesh({ field, layers = DEFAULT_LAYERS, fade = 0.4 }: { field: HeightField; layers?: SplatLayer[]; fade?: number }) {
  const geometry = useTerrainGeometry(field, layers);
  const [shown, setShown] = useState(false); // one state change, when the textured mesh is fully in
  const done = useRef<() => void>(undefined);
  useEffect(() => {
    done.current = envTask('terrain');
    return () => done.current?.();
  }, []);
  useEffect(() => {
    if (shown) done.current?.();
  }, [shown]);
  return (
    <>
      {!shown && <Flat geometry={geometry} placeholder />}
      <Fallback fallback={<Flat geometry={geometry} placeholder={false} onMount={() => setShown(true)} />}>
        <Suspense fallback={null}>
          <Splatted layers={layers} geometry={geometry} fade={fade} onShown={() => setShown(true)} />
        </Suspense>
      </Fallback>
    </>
  );
}
```

Layer presets: `DEFAULT_LAYERS` (sand shore · grass · dirt tops · stone cliffs) for hills up to ~15 m; `MOUNTAIN_LAYERS` (grass · gravel · stone · snow caps) for peaks ≳ 20 m — `<TerrainMesh field={f} layers={MOUNTAIN_LAYERS} />`. Custom: up to 4 `SplatLayer`s with any CDN `texture`, `tile` in metres (4–8 reads well at player scale), `height` 0…1 and `slope` in degrees.

## 3. Wire it into the template

`src/game/world.ts` — replace `export const FIELDS: HeightField[] = [];` and add `groundHeight` right after `fieldHeight`:

```ts
import { createTerrain } from './terrain';

export const TERRAIN = createTerrain({ seed: 7, size: 120, height: 9, scale: 38, octaves: 4, flatRadius: 6, flatHeight: 2 });
export const FIELDS: HeightField[] = [TERRAIN];

// (keep fieldHeight as it is)

/** Highest height-field surface at (x, z); 0 (the floor top) where there is none. Below 0 too (a `base < 0` field with the floor removed). */
export function groundHeight(x: number, z: number): number {
  let h = -Infinity;
  for (const f of FIELDS) {
    const y = fieldHeight(f, x, z);
    if (y !== null && y > h) h = y;
  }
  return h === -Infinity ? 0 : h;
}
```

`src/game/state.ts` — start (and respawn) on the surface, not inside the hill. Put the spawn fix here, right before `export const player = createPlayer();` (which reads `PLAYER.spawn`), not in `world.ts`: `config.ts` → `game/camera.ts` → `world.ts` is an import cycle, so when `App.tsx` loads `config` first, `PLAYER` doesn't exist yet while `world.ts` runs and the app dies on start.

```ts
import { CAMERA, PLAYER } from '../config';
import { groundHeight } from './world';

PLAYER.spawn[1] = groundHeight(PLAYER.spawn[0], PLAYER.spawn[2]) + 0.05;
```

`src/components/Level.tsx` — draw fields with the textured mesh: `import { TerrainMesh } from './TerrainMesh';` and change `<Field key={i} field={f} />` to `<TerrainMesh key={i} field={f} />` (delete the now-unused `Field` / `FIELD_STEP`, or keep `Field` for flat-colored fields).

`src/components/CameraRig.tsx` — keep the orbit camera out of the hill (behind the player on an uphill slope it would be inside the terrain, and the screen fills with ground seen from below). Import `groundHeight` from `'../game/world'` and add one line right after `camera.position.set(...)`, before `camera.lookAt(...)`:

```ts
camera.position.y = Math.max(camera.position.y, groundHeight(camera.position.x, camera.position.z) + 1);
```

(1 m clears `r3f-grass` blades; a smaller margin puts the lens inside the grass.)

`Player.tsx` already passes `FIELDS` to `stepPlayer` — nothing to change there. Other recipes (`r3f-stage-maze`, `r3f-water`, `r3f-grass`, `r3f-model-placer`, `r3f-navigator`) take `groundHeight` as their `groundAt`.

Moving the player later (teleport, checkpoint, new level): set `player.pos.y = groundHeight(x, z) + 0.05` together with x/z, and zero `player.vel`.

## 4. Loading gate — no placeholders on the play screen

The textured terrain, the ez-tree forest (`r3f-model-placer`), textured walls (`r3f-stage-maze`) and water (`r3f-water`) load after the first frame, so the first-screen JS stays small. While they load, flat-color terrain and tree impostors stand in. A loading gate hides that: the environment reports when it's done, and the title / loading screen only opens the play screen then (the same idea as the old vibe templates' `isMapPhysicsReady` + loading screen).

- `envReady.ts` — one readiness signal. Components register a **task** (`envTask('terrain')` → call the returned function when done) and count **placeholders** while they're on screen (`envPlaceholder()`). Ready = first frame drawn + no pending task + no placeholder visible + drei `useProgress` idle (character GLB etc.). A plain mutable object with subscribe — not React state. `env.open` latches the first time it's ready.
- `TerrainMesh`, `EzForest`, `TexturedBoxes` and `Water` from these recipes already report to it.
- `LoadingOverlay.tsx` — `<EnvFrame />` (inside the canvas) marks the first frame; `<LoadingOverlay />` is the gate for games without a title; `<StartButton />` is the gate for games with one.

### 4a. `src/game/envReady.ts` (shared — skip if the project already has it)

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

### 4b. `src/components/LoadingOverlay.tsx`

```tsx
import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useProgress } from '@react-three/drei';
import { envFirstFrame, useEnvOpen } from '../game/envReady';

/** Mount once INSIDE <Canvas>: tells envReady that the first frame was drawn. */
export function EnvFrame() {
  useFrame(() => envFirstFrame());
  return null;
}

/**
 * For games WITH a title screen: put this in the title instead of a plain button.
 * Disabled (showing progress) until the environment is ready; the title keeps
 * covering the canvas — and blocking input — until the player presses it.
 */
export function StartButton({ onStart, label = 'Start' }: { onStart: () => void; label?: string }) {
  const open = useEnvOpen();
  const { progress } = useProgress();
  return (
    <button
      disabled={!open}
      onClick={onStart}
      className="rounded bg-white px-6 py-2 font-semibold text-neutral-900 disabled:cursor-wait disabled:opacity-50"
    >
      {open ? label : `Loading… ${Math.round(progress)}%`}
    </button>
  );
}

/**
 * Loading gate for games without a title screen. Render OUTSIDE <Canvas>, above
 * everything (and above MobileControls). It covers the canvas — and so blocks
 * pointer input — until the environment is ready, then fades out and unmounts.
 * The scene keeps rendering underneath, so textures and trees finish while it shows.
 */
export function LoadingOverlay({ title = 'Loading…' }: { title?: string }) {
  const open = useEnvOpen();
  const { progress } = useProgress();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setGone(true), 400); // after the fade
    return () => window.clearTimeout(t);
  }, [open]);
  if (gone) return null;
  return (
    <div
      data-env-loading
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-neutral-900 text-white"
      style={{ opacity: open ? 0 : 1, transition: 'opacity 0.35s', pointerEvents: open ? 'none' : 'auto' }}
    >
      <div className="text-lg tracking-wide">{title}</div>
      <div className="h-1.5 w-56 overflow-hidden rounded bg-white/20">
        <div className="h-full bg-white/80 transition-all" style={{ width: `${Math.max(8, Math.min(100, progress))}%` }} />
      </div>
    </div>
  );
}
```

### 4c. Wire the gate

`src/App.tsx`:

```tsx
import { EnvFrame, LoadingOverlay } from './components/LoadingOverlay';

<Canvas …>
  …
  <EnvFrame />
</Canvas>
…
<MobileControls touch={touch} />
<LoadingOverlay />            {/* last, so it covers the HUD and the touch buttons too */}
```

With a title screen, keep the title up until the player starts and use `<StartButton onStart={() => { game.started = true; setStarted(true); }} />` in it instead of `<LoadingOverlay />` (one React state change for the title is fine). `game` is a mutable flag next to the player in `src/game/state.ts` — `export const game = { started: false };` — so the frame loop can read it.

`src/components/Player.tsx` — no movement or jumps while the gate is closed (keys pressed during loading would otherwise move the hidden player). Right after `moveAxis(axis);` (with a title, test `!env.open || !game.started` instead — the gate opens while the title is still up, and the keyboard is bound to the window):

```ts
import { env } from '../game/envReady';

if (!env.open) {
  // loading gate still closed: ignore movement and jumps
  axis.x = axis.y = 0;
  input.jumpPressedAt = -Infinity;
}
```

Behind a gate, pass `fade={0}` to `TerrainMesh` and `EzForest`: their cross-fades exist for games that start without a loading screen (a 0.4 s fade from placeholder to final look instead of a pop) and only delay "ready" behind one.

**Measured** (eval scene: textured terrain + block maze + reflective lake + 140 ez-trees + bushes + grass; production build, no cache, desktop, headed Chrome):

| | first frame | textures (15 PNG ≈ 8 MB, CDN) | ez-tree chunk | environment ready | play screen shows placeholders |
|---|---|---|---|---|---|
| no gate (before) | 0.51 s | 0.67 → 2.06 s | 2.08 → 2.19 s | — | yes: impostors, flat terrain, capsule character |
| gate, `fade={0}` | 0.21 s | 0.44 → 1.56 s | 1.58 → 1.68 s | **2.41 s** (2.2 s after the first frame) | none |

First-screen JS (requested before the canvas was ready) 1.28 MB either way. The loading time is dominated by the texture download from the CDN — about 0.7–1.3 s per 0.8 MB file here — so ≈ 2–3 s is the expectation on a good connection; when the CDN is slow it grows with it (one run: 33 s, textures arriving at 31–33 s). The gate keeps the screen correct either way; for a faster load use fewer splat layers (each layer is 3 PNGs).

## Pitfalls

- **Placeholders on the play screen.** With lazy environment assets and no gate, the first seconds of play show impostor trees, flat-color ground and the template's capsule character. Wire `<EnvFrame />` + `<LoadingOverlay />` (or `<StartButton />` in a title) — section 4.
- **A gate that never opens.** Every `envTask` must finish, including on failure (the recipes end the task when a texture fails and keep the fallback as the final look). Never `envTask` something that isn't guaranteed to finish.
- **White character, "GLTFLoader: Couldn't load texture blob:…".** The character GLB's embedded texture is fetched from a `blob:` URL *after* the GLB arrives, on three's shared `DefaultLoadingManager`; `DefaultLoadingManager.abort()` at that moment drops it (mesh loads, `map` stays null). Don't abort or reassign that manager's `onLoad` / `onProgress` / `onStart` / `onError` (drei `useProgress`, and so `envReady`, live there) — to give up on a slow asset, end its `envTask` and keep the fallback.
- **Spawning inside the hill.** `PLAYER.spawn` defaults to y = 2; on terrain higher than that the player starts under the surface and `resolveFields` treats the face as a wall. Always set the spawn from `groundHeight` (the `state.ts` line above), and give the spawn a `flatRadius` plaza.
- **Reading or changing config at the top of `world.ts`.** Don't: `config.ts` imports `game/camera.ts`, which imports `world.ts`, so a top-level `PLAYER` / `CAMERA` read or write there runs before `config` exists (ReferenceError as modules, `TypeError … PLAYER.spawn` in the bundle). Spawn changes go in `state.ts` before `createPlayer()`; reading config inside functions is fine.
- **Camera inside the hill.** The template's orbit camera knows nothing about terrain; without the `CameraRig` clamp above, walking uphill puts the camera under the surface. Every camera view (freeview, quarterview, sideview) needs the same clamp.
- **Flat-colored ground.** A single-color `meshStandardMaterial` on terrain looks unfinished next to everything else; use `TerrainMesh` (textured by default). The vertex colors are only the loading / failure fallback.
- **Texture budget.** 4 layers = 12 textures (~6 MB download, 12 of the 16 fragment samplers). Don't add more layers to the same material; split very different regions into separate fields instead. The textures are images fetched at runtime, not JS, and they never hold up the first frame: `TerrainMesh` has its own `<Suspense>` showing the flat-color mesh, so the canvas draws immediately and the textures swap in as they arrive (measured: first frame at ~0.2 s, textures after it). Keep that inner `<Suspense>` — don't rely on a scene-wide one, which would blank the whole canvas until all 12 images load.
- **Layers as an inline array.** `layers={[…]}` written inline creates a new array every render and rebuilds the geometry; define layer sets as module constants (like `DEFAULT_LAYERS`).
- **Snow on low hills.** Height bands are relative to the field's own lowest…highest point, so a 6 m hill gets "peaks" too. Use `MOUNTAIN_LAYERS` (snow) only for tall terrain.
- **Expensive `heightAt`.** Calling noise with 4–5 octaves inside `heightAt` runs thousands of times per second (several calls per substep, every NPC, grass and props at build time). Bake once (this recipe) and sample.
- **Floor box showing through.** The template floor's top is y = 0. Keep `base ≥ 0`, or remove the floor box from `BOXES` and make the terrain cover the whole play area. Outside the terrain rectangle there is only the floor (or nothing → the player falls to `killY` and respawns).
- **Terrain larger than the shadow camera / fog.** Shadows follow the player (±20 m); fog in `Level.tsx` hides the far edge. Up to ~200 × 200 m at the 0.5 m render step is fine; larger, raise `STEP` to 1.
- **Slopes the player can't climb.** Faces steeper than 60° block; for a climbable mountain lower `sharpness` or raise `scale`. Rapier is not needed for any of this — never add a rapier heightfield collider for the player.
- **Multiplayer.** Use the same `seed` on every client; never `Math.random()` inside the generator.
