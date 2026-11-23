---
name: r3f-water
description: |
  Code recipe for water — lakes, ponds, rivers, oceans — in a React Three Fiber game on the kinematic-controller templates. One component, no library, no texture assets.

  Lakes, ponds and puddles use reflect mode (the default); the wave shader is only for wide moving water like seas and rivers.

  Covers:
  - Water at a chosen level; lakes form wherever the terrain (`groundHeight` from `r3f-terrain`) dips below it.
  - Reflections (drei `MeshReflectorMaterial`, scrolling ripple normal map) — default.
  - Wave shader for seas (`reflect={false}`): waves, shore damping, depth color, fresnel, foam, fog.
  - A generated tileable water normal map (the CDN has none).
  - Underwater test for swimming, drowning and triggers; keeping grass and props out of the water.

  Use this whenever the user asks for water, sea, ocean, lake, river, pond, beach, shoreline, reflections, swimming or "make the low parts flooded" — even if they don't say "water shader". Do not install `vibe-starter-3d-environment` for this.
---

# Water recipe (reflective lake or wave shader)

**Lakes, ponds, puddles and moats use reflect mode — it is the default (`<Water … />`). The wave shader (`reflect={false}`) is only for wide, moving water: sea, ocean, a big river.** An island's inland lake is a lake: reflect. Its surrounding sea is the wave shader.

Two looks in one component:
- **reflect** (default): a flat plane with drei `MeshReflectorMaterial`; the scene (trees, walls, sky, the player) is mirrored, rippled by a scrolling normal map and blurred with distance. It renders the scene a second time, so use it for one water body at a time.
- **wave shader** (`reflect={false}`; seas, big rivers, rough water): a plane displaced in the vertex shader. Depth below the surface is baked per vertex from `groundAt`, so shore foam and depth color need no depth texture and no extra render pass.

The verse8 CDN has no water normal texture, so `waterNormals()` generates a tileable one (sum of sine waves with whole-number periods) once at startup. The player is not affected by water unless you add it (see "Swimming / damage").

## 1. `src/components/Water.tsx`

It imports `src/game/envReady.ts` (the loading-gate signal) — copy that file from `r3f-terrain` section 4a if the project doesn't have it yet, and wire the gate as in `r3f-terrain` section 4c.

```tsx
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { MeshReflectorMaterial } from '@react-three/drei';
import * as THREE from 'three';
import { envTask } from '../game/envReady';

export type WaterOptions = {
  /** Water rectangle and surface height (m). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  level: number;
  /** Ground under the water (e.g. groundHeight from world.ts) — drives shore foam and depth tint. Omit for open sea. */
  groundAt?: (x: number, z: number) => number;
  shallow?: string;
  deep?: string;
  /** 0 calm lake … 1 rough sea. */
  waveHeight?: number;
  /** Wavelength of the main swell (m). */
  waveLength?: number;
  waveSpeed?: number;
  /** Surface alpha in deep water (shallows fade further). */
  opacity?: number;
  /** Shore foam width (m of depth). 0 = none. */
  foam?: number;
  /** Direction to the sun, for the highlight. */
  sunDir?: [number, number, number];
  /**
   * Default true: real reflections (drei MeshReflectorMaterial), the scene mirrored
   * in a flat, rippled surface — lakes, ponds, puddles, moats. Set false only for
   * wide moving water (sea, ocean, big river): the wave shader, no second render pass.
   */
  reflect?: boolean;
};

let ripples: THREE.DataTexture | null = null;
/**
 * Tileable ripple normal map, generated once (the verse8 CDN has no water
 * normal texture). Sum of sine waves with whole-number periods → seamless.
 */
export function waterNormals(size = 256) {
  if (ripples) return ripples;
  const data = new Uint8Array(size * size * 4);
  const waves = [
    [3, 1, 0.5],
    [-2, 4, 0.35],
    [5, -3, 0.25],
    [-7, -5, 0.15],
    [11, 6, 0.1],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      for (const [kx, ky, a] of waves) {
        const ph = ((kx * x + ky * y) / size) * Math.PI * 2;
        dx += a * kx * Math.cos(ph) * 0.08;
        dy += a * ky * Math.cos(ph) * 0.08;
      }
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  ripples = new THREE.DataTexture(data, size, size);
  ripples.wrapS = ripples.wrapT = THREE.RepeatWrapping;
  ripples.magFilter = THREE.LinearFilter;
  ripples.minFilter = THREE.LinearMipmapLinearFilter;
  ripples.generateMipmaps = true;
  ripples.needsUpdate = true;
  return ripples;
}

const vertex = /* glsl */ `
  uniform float uTime, uAmp, uLen, uSpeed;
  attribute float depth;
  varying float vDepth;
  varying vec3 vWorld, vNormal;
  #include <fog_pars_vertex>

  // Sum of 3 directional sine waves; returns height and accumulates the slope.
  float wave(vec2 p, vec2 dir, float len, float amp, inout vec2 grad) {
    float k = 6.2831 / len;
    float ph = k * dot(dir, p) - uTime * uSpeed * sqrt(9.8 * k);
    grad += dir * k * amp * cos(ph);
    return amp * sin(ph);
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 grad = vec2(0.0);
    float shoreDamp = clamp(depth / 1.5, 0.0, 1.0); // waves flatten on the beach
    float h = wave(world.xz, normalize(vec2(1.0, 0.3)), uLen, uAmp, grad)
            + wave(world.xz, normalize(vec2(-0.4, 1.0)), uLen * 0.57, uAmp * 0.5, grad)
            + wave(world.xz, normalize(vec2(0.7, -0.8)), uLen * 0.31, uAmp * 0.25, grad);
    world.y += h * shoreDamp;
    grad *= shoreDamp;
    vNormal = normalize(vec3(-grad.x, 1.0, -grad.y));
    vWorld = world.xyz;
    vDepth = depth;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uShallow, uDeep, uSun;
  uniform float uOpacity, uFoam, uTime;
  uniform sampler2D uRipples;
  varying float vDepth;
  varying vec3 vWorld, vNormal;
  #include <fog_pars_fragment>

  void main() {
    // small ripples on top of the swell: the ripple map scrolled two ways and summed
    vec2 r = texture2D(uRipples, vWorld.xz / 9.0 + uTime * vec2(0.03, 0.01)).xy
           + texture2D(uRipples, vWorld.xz / 5.0 - uTime * vec2(0.01, 0.04)).xy - 1.0;
    vec3 n = normalize(vNormal + vec3(r.x, 0.0, r.y) * 0.6);
    vec3 view = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0);
    vec3 col = mix(uShallow, uDeep, clamp(vDepth / 4.0, 0.0, 1.0));
    col = mix(col, vec3(0.75, 0.86, 0.95), fresnel * 0.6); // sky reflection stand-in
    float spec = pow(max(dot(reflect(-normalize(uSun), n), view), 0.0), 120.0);
    col += vec3(1.0, 0.95, 0.85) * spec * 1.5;
    float alpha = mix(uOpacity * 0.5, uOpacity, clamp(vDepth / 2.0, 0.0, 1.0)) + fresnel * 0.3;
    if (uFoam > 0.0) {
      float edge = 1.0 - smoothstep(0.0, uFoam, vDepth);
      float pulse = 0.65 + 0.35 * sin(uTime * 1.5 + vWorld.x * 0.7 + vWorld.z * 0.5);
      float foam = edge * edge * pulse;
      col = mix(col, vec3(1.0), foam);
      alpha = max(alpha, foam);
    }
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
    #include <fog_fragment>
  }
`;

/**
 * Water: reflective lake (default) or, with reflect={false}, the wave shader for seas and rivers.
 * Reports a 'water' task to envReady, finished on the first frame it is drawn (the ripple
 * normal map is generated in code, so there is nothing to download).
 */
export function Water(o: WaterOptions) {
  const done = useRef<() => void>(undefined);
  useEffect(() => {
    done.current = envTask('water');
    return () => done.current?.();
  }, []);
  useFrame(() => done.current?.());
  return o.reflect === false ? <WaveWater {...o} /> : <ReflectiveWater {...o} />;
}

/** Flat rippled mirror. The ripple normal map scrolls; the reflection blurs with distance. */
function ReflectiveWater(o: WaterOptions) {
  const normalMap = useMemo(() => {
    const t = waterNormals().clone(); // own repeat/offset, shared pixels
    t.repeat.set((o.maxX - o.minX) / 6, (o.maxZ - o.minZ) / 6);
    t.needsUpdate = true;
    return t;
  }, [o.minX, o.maxX, o.minZ, o.maxZ]);
  useFrame((_, dt) => {
    normalMap.offset.x += dt * 0.02;
    normalMap.offset.y += dt * 0.012;
  });
  return (
    <mesh rotation-x={-Math.PI / 2} position={[(o.minX + o.maxX) / 2, o.level, (o.minZ + o.maxZ) / 2]} renderOrder={1}>
      <planeGeometry args={[o.maxX - o.minX, o.maxZ - o.minZ]} />
      <MeshReflectorMaterial
        resolution={512}
        mirror={0.75}
        blur={[200, 80]}
        mixBlur={0.8}
        mixStrength={1.6}
        mixContrast={1}
        depthScale={0}
        color={o.deep ?? '#1f5566'}
        roughness={0.25}
        metalness={0.3}
        normalMap={normalMap}
        normalScale={new THREE.Vector2(0.35, 0.35)}
        distortionMap={normalMap}
        distortion={0.25}
        transparent
        opacity={o.opacity ?? 0.92}
      />
    </mesh>
  );
}

/** Wave-shader water plane. Draw it after opaque geometry (transparent), no reflections pass needed. */
function WaveWater(o: WaterOptions) {
  const { geometry, material } = useMemo(() => {
    const w = o.maxX - o.minX;
    const d = o.maxZ - o.minZ;
    // ~1 m grid: enough for the swell, cheap to displace.
    const g = new THREE.PlaneGeometry(w, d, Math.ceil(w), Math.ceil(d));
    g.rotateX(-Math.PI / 2);
    g.translate((o.minX + o.maxX) / 2, o.level, (o.minZ + o.maxZ) / 2);
    const pos = g.attributes.position;
    const depth = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) depth[i] = o.groundAt ? o.level - o.groundAt(pos.getX(i), pos.getZ(i)) : 10;
    g.setAttribute('depth', new THREE.BufferAttribute(depth, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime: { value: 0 },
        uAmp: { value: 0.05 + 0.6 * (o.waveHeight ?? 0.25) },
        uLen: { value: o.waveLength ?? 8 },
        uSpeed: { value: o.waveSpeed ?? 1 },
        uShallow: { value: new THREE.Color(o.shallow ?? '#3fb6c9') },
        uDeep: { value: new THREE.Color(o.deep ?? '#0d3b66') },
        uSun: { value: new THREE.Vector3(...(o.sunDir ?? [10, 20, 8])).normalize() },
        uOpacity: { value: o.opacity ?? 0.8 },
        uFoam: { value: o.foam ?? 0.25 },
        uRipples: { value: waterNormals() },
      },
    });
    return { geometry: g, material: m };
    // Rebuild only when the water's footprint changes; change the other looks through material.uniforms.
  }, [o.minX, o.maxX, o.minZ, o.maxZ, o.level, o.groundAt]);

  useFrame((_, dt) => {
    material.uniforms.uTime.value += dt;
  });
  return <mesh geometry={geometry} material={material} renderOrder={1} />;
}

/** Is the point below the surface inside the water rectangle? (swimming, drowning, splash triggers) */
export function isUnderwater(w: Pick<WaterOptions, 'minX' | 'maxX' | 'minZ' | 'maxZ' | 'level'>, x: number, y: number, z: number) {
  return x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ && y < w.level;
}
```

## 2. Wire it in

Keep the water's data next to the level data so gameplay code can read it — `src/game/world.ts`:

```ts
/** Lakes wherever the terrain dips below `level`. */
export const WATER = { minX: TERRAIN.minX, maxX: TERRAIN.maxX, minZ: TERRAIN.minZ, maxZ: TERRAIN.maxZ, level: 1.6 };
// Without terrain: a pool, e.g. { minX: -6, maxX: 6, minZ: 8, maxZ: 16, level: 0.05 } (the floor top is y = 0).
```

Mount inside `<Canvas>` (e.g. at the end of `Level.tsx`'s fragment, or in `App.tsx` next to `<Level />`):

```tsx
import { Water } from './Water';
import { WATER, groundHeight } from '../game/world';

<Water {...WATER} groundAt={groundHeight} />                   {/* lake / pond / puddle: reflect (default) */}
// island: inland lake reflects, the sea around it waves
// <Water {...LAKE} groundAt={groundHeight} />
// <Water {...SEA} groundAt={groundHeight} reflect={false} waveHeight={0.9} waveLength={14} waveSpeed={1.2} foam={0.5} />
// murky pond: <Water {...POND} deep="#2b3d22" opacity={0.97} />
```

Choosing the level on terrain: water fills everything with `groundHeight < level`. Start with `TERRAIN.base + 0.15 × (TERRAIN.peak − TERRAIN.base)` and check the spawn plaza stays dry (the player can still walk underwater — the controller ignores water).

## 3. Swimming / damage / splash

The controller walks on the lake bed. For gameplay, check the player each frame — e.g. in `Player.tsx` after the substeps, or with an `r3f-trigger` box zone `{ minY: -20, maxY: WATER.level - 0.6, … }`:

```ts
import { isUnderwater } from './Water';
// head under water (feet + ~1.4 m) → drowning timer; feet under → slow down / splash
const headUnder = isUnderwater(WATER, player.pos.x, player.pos.y + 1.4, player.pos.z);
```

To make the player slower in water without touching `player.ts`, scale `move.x` / `move.z` in `Player.tsx` before `stepPlayer` when the feet are under water. Keep grass and props out of the water with `exclude` / `forbidden: (x, z, y) => y < WATER.level + 0.2` (`r3f-grass`, `r3f-model-placer`).

## Pitfalls

- **Wave shader on a lake.** A lake or pond drawn with `reflect={false}` looks like flat paint next to the reflective trees around it. Keep the default; waves are for seas and rivers.
- **More than one reflective water.** Each `reflect` surface re-renders the whole scene from below. One lake is fine on desktop; for several ponds, make only the main one `reflect` and the rest wave-shader, and on low-end mobile prefer the wave shader everywhere.
- **Reflector on a huge sea.** A 500 m reflective plane renders far geometry twice for nothing; use the wave shader for seas and let fog hide the horizon.
- **Water hiding the ground or the player.** The wave shader is transparent with `depthWrite: false` — leave it that way, or objects under water vanish and the sky shows through. If you set `transparent: false`, the foam alpha stops working.
- **No `groundAt` on terrain** (wave mode) → depth is treated as 10 m everywhere: no shore foam, waves clip into the beach. Pass `groundHeight`.
- **Guessed water textures.** three's `examples/jsm/objects/Water.js` needs a normal-map URL; the CDN has none, and asset URLs must never be guessed — use `waterNormals()`.
- **Huge wave planes.** The wave mesh has one vertex per m²; a 1 km ocean is 1 M vertices. For a sea beyond the play area, make a coarse second plane (`Math.ceil(w / 8)` segments) with `waveHeight={0}`, or let fog hide the edge.
- **Rapier water.** Buoyancy for dynamic bodies belongs in the lazy physics chunk (`src/physics/`), never statically imported here.
