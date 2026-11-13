---
name: r3f-weather
description: |
  Code recipe for weather and atmosphere in a React Three Fiber game on the kinematic-controller templates: fog, rain, snow, storms with lightning, overcast skies, a frosted-screen snow effect, weather that changes over time. No weather library, no textures.

  Covers:
  - Exponential fog per weather; an overcast dome that greys out drei `<Sky>`.
  - Rain and snow as GPU particles wrapping around the camera (no per-frame CPU work), with amount and intensity.
  - Lightning flashes and sun dimming.
  - Snow on the "lens" (screen frost) without React re-renders.
  - Presets (clear, foggy, rain, storm, snow), smooth transitions, a timed cycle or scripted `setWeather()`.
  - Night skies with drei `Stars`.

  Use this whenever the user asks for weather, rain, snow, storm, thunder, lightning, fog, mist, gloomy / cozy atmosphere, day-night mood, or "make it feel cold / wet" — even if they don't say "particles". Do not install `vibe-starter-3d-environment` for this.
---

# Weather recipe (state machine + GPU particles)

Two files: a pure state module (presets, cycle, blending — no three, testable) and one component that applies the current blend every frame. All per-frame values live in a plain mutable object, never in React state (`AGENTS.md`).

## 1. `src/game/weather.ts` (pure)

```ts
// Weather state: presets, a timed cycle, and the blended values the scene reads
// every frame. Plain mutable objects (never React state). No three, no React.

export type WeatherKind = 'clear' | 'foggy' | 'rain' | 'storm' | 'snow';

export type WeatherLook = {
  /** FogExp2 density (0.002 clear … 0.06 thick). */
  fogDensity: number;
  fogColor: [number, number, number];
  /** 0…1 rain and snow particle amount. */
  rain: number;
  snow: number;
  /** Sun intensity multiplier. */
  sun: number;
  /** Lightning flashes per second (0 = none). */
  lightning: number;
  /** Frost overlay on screen while it snows (0…1). */
  frost: number;
};

export const WEATHER: Record<WeatherKind, WeatherLook> = {
  clear: { fogDensity: 0.004, fogColor: [0.81, 0.89, 0.96], rain: 0, snow: 0, sun: 1, lightning: 0, frost: 0 },
  foggy: { fogDensity: 0.05, fogColor: [0.78, 0.8, 0.82], rain: 0, snow: 0, sun: 0.5, lightning: 0, frost: 0 },
  rain: { fogDensity: 0.02, fogColor: [0.55, 0.6, 0.66], rain: 0.6, snow: 0, sun: 0.45, lightning: 0, frost: 0 },
  storm: { fogDensity: 0.03, fogColor: [0.35, 0.38, 0.44], rain: 1, snow: 0, sun: 0.25, lightning: 0.15, frost: 0 },
  snow: { fogDensity: 0.025, fogColor: [0.88, 0.9, 0.94], rain: 0, snow: 0.8, sun: 0.6, lightning: 0, frost: 0.7 },
};

/** A timed cycle; set `cycle` to [] and call setWeather() for scripted weather. */
export const weather = {
  cycle: [
    { kind: 'clear', seconds: 40 },
    { kind: 'foggy', seconds: 25 },
    { kind: 'rain', seconds: 30 },
    { kind: 'storm', seconds: 20 },
    { kind: 'snow', seconds: 35 },
  ] as { kind: WeatherKind; seconds: number }[],
  /** Seconds a transition takes. */
  blend: 6,
  from: 'clear' as WeatherKind,
  to: 'clear' as WeatherKind,
  /** 0…1 progress of from → to. */
  t: 1,
  /** Seconds left in the current cycle entry. */
  left: 40,
  index: 0,
  /** Current blended look — read this. */
  now: { ...WEATHER.clear, fogColor: [...WEATHER.clear.fogColor] } as WeatherLook,
  /** 0…1 flash brightness, decays quickly. */
  flash: 0,
};

/** Start a transition to `kind` (from whatever is showing now). */
export function setWeather(kind: WeatherKind) {
  weather.from = weather.to;
  weather.to = kind;
  weather.t = 0;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Advance cycle, blend and lightning. Call once per frame. */
export function stepWeather(dt: number, rand = Math.random) {
  if (weather.cycle.length) {
    weather.left -= dt;
    if (weather.left <= 0) {
      weather.index = (weather.index + 1) % weather.cycle.length;
      const next = weather.cycle[weather.index];
      weather.left = next.seconds;
      setWeather(next.kind);
    }
  }
  weather.t = Math.min(1, weather.t + dt / weather.blend);
  const a = WEATHER[weather.from];
  const b = WEATHER[weather.to];
  const t = weather.t * weather.t * (3 - 2 * weather.t);
  const n = weather.now;
  n.fogDensity = lerp(a.fogDensity, b.fogDensity, t);
  for (let i = 0; i < 3; i++) n.fogColor[i] = lerp(a.fogColor[i], b.fogColor[i], t);
  n.rain = lerp(a.rain, b.rain, t);
  n.snow = lerp(a.snow, b.snow, t);
  n.sun = lerp(a.sun, b.sun, t);
  n.lightning = lerp(a.lightning, b.lightning, t);
  n.frost = lerp(a.frost, b.frost, t);
  weather.flash = Math.max(0, weather.flash - dt * 4);
  if (n.lightning > 0 && rand() < n.lightning * dt) weather.flash = 1;
}
```

## 2. `src/components/Weather.tsx`

```tsx
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { stepWeather, weather } from '../game/weather';

const COUNT = 10000;
/** Particles live in a (2·R)³ box that wraps around the camera, so they never run out. */
const R = 20;

const vertex = /* glsl */ `
  uniform float uTime, uAmount, uFall, uDrift, uSize;
  uniform vec3 uCenter;
  attribute float seed;
  varying float vAlpha;
  void main() {
    vec3 p = position + vec3(sin(uTime * 0.7 + seed * 40.0) * uDrift, -uTime * uFall * (0.8 + 0.4 * seed), uTime * uDrift * 0.3);
    p = mod(p - uCenter + ${R.toFixed(1)}, ${(2 * R).toFixed(1)}) - ${R.toFixed(1)} + uCenter;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (300.0 / -mv.z);
    vAlpha = seed < uAmount ? smoothstep(${R.toFixed(1)}, 4.0, -mv.z) : 0.0; // fewer drops when lighter, fade far ones
  }
`;

const rainFragment = /* glsl */ `
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.0) discard;
    vec2 c = gl_PointCoord - 0.5;
    float a = (1.0 - smoothstep(0.02, 0.09, abs(c.x))) * (1.0 - smoothstep(0.25, 0.5, abs(c.y)));
    gl_FragColor = vec4(0.8, 0.86, 0.95, a * 0.8 * vAlpha);
  }
`;

const snowFragment = /* glsl */ `
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.0) discard;
    float a = 1.0 - smoothstep(0.2, 0.5, length(gl_PointCoord - 0.5));
    gl_FragColor = vec4(1.0, 1.0, 1.0, a * 0.9 * vAlpha);
  }
`;

function usePrecipitation(fragment: string, fall: number, drift: number, size: number) {
  return useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * R;
      pos[i * 3 + 1] = (Math.random() * 2 - 1) * R;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * R;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uFall: { value: fall },
        uDrift: { value: drift },
        uSize: { value: size },
        uCenter: { value: new THREE.Vector3() },
      },
    });
    const points = new THREE.Points(g, m);
    points.frustumCulled = false; // positions are computed in the shader
    return points;
  }, [fragment, fall, drift, size]);
}

const WHITE = new THREE.Color('#ffffff');

/** Fog, rain, snow, lightning and the frost overlay, all driven by game/weather.ts. Replaces Level's <fog>. */
export function Weather() {
  const scene = useThree((s) => s.scene);
  const rain = usePrecipitation(rainFragment, 18, 0.3, 1.4);
  const snow = usePrecipitation(snowFragment, 1.6, 1.2, 0.35);
  const fog = useMemo(() => new THREE.FogExp2('#cfe3f5', 0.004), []);
  // drei <Sky> ignores fog: an overcast dome inside it (camera far is 500) greys the sky out.
  const dome = useMemo(() => {
    const m = new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, fog: false });
    return new THREE.Mesh(new THREE.SphereGeometry(400, 24, 12), m);
  }, []);

  useEffect(() => {
    const prev = scene.fog;
    scene.fog = fog;
    return () => {
      scene.fog = prev;
    };
  }, [scene, fog]);

  useFrame(({ camera }, dt) => {
    stepWeather(dt);
    const n = weather.now;
    fog.density = n.fogDensity;
    fog.color.setRGB(n.fogColor[0], n.fogColor[1], n.fogColor[2]).lerp(WHITE, weather.flash * 0.6);
    const dm = dome.material as THREE.MeshBasicMaterial;
    dm.color.copy(fog.color);
    dm.opacity = Math.min(0.97, Math.max(0, (1 - n.sun) / 0.7 + n.fogDensity * 10));
    dome.position.copy(camera.position);
    for (const [p, amount] of [
      [rain, n.rain],
      [snow, n.snow],
    ] as const) {
      const u = (p.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = (u.uTime.value + dt) % 600; // keeps shader float precision; the wrap is invisible in falling rain
      u.uAmount.value = amount;
      u.uCenter.value.copy(camera.position);
      p.visible = amount > 0.01;
    }
    if (frost.el) frost.el.style.opacity = String(n.frost);
  });

  return (
    <>
      <primitive object={dome} />
      <primitive object={rain} />
      <primitive object={snow} />
    </>
  );
}

/** The overlay element, written from useFrame (no React state). */
const frost: { el: HTMLDivElement | null } = { el: null };

/** Snow-on-the-lens vignette. Render OUTSIDE <Canvas>, next to the HUD. */
export function FrostOverlay() {
  return (
    <div
      ref={(el) => {
        frost.el = el;
      }}
      className="pointer-events-none absolute inset-0"
      style={{
        opacity: 0,
        background:
          'radial-gradient(ellipse at center, transparent 55%, rgba(235,242,250,0.55) 80%, rgba(255,255,255,0.9) 100%)',
      }}
    />
  );
}
```

## 3. Wire it into the template

1. `src/components/Level.tsx` — **delete** `<fog attach="fog" args={['#cfe3f5', 40, 120]} />` (`<Weather>` owns `scene.fog` now; two fogs fight). In `Lights`' `useFrame`, after `l.target.position.set(...)`, dim the sun and add the lightning flash:

   ```ts
   import { weather } from '../game/weather';
   // inside Lights' useFrame:
   l.intensity = 2.2 * weather.now.sun + weather.flash * 4;
   ```

2. `src/App.tsx` — `<Weather />` inside `<Canvas>`, `<FrostOverlay />` outside it (next to the hint label, before `<MobileControls>` so the buttons stay on top):

   ```tsx
   import { FrostOverlay, Weather } from './components/Weather';
   <Canvas …>
     <Level />
     …
     <Weather />
   </Canvas>
   <FrostOverlay />
   ```

3. Scripted weather instead of the cycle — at startup `weather.cycle = []`, then from game events `setWeather('storm')` (blends over `weather.blend` seconds). A fixed look: `weather.cycle = []; setWeather('foggy'); weather.t = 1;`.

4. Night: add drei `<Stars radius={200} depth={50} count={3000} fade />` and lower the `<Sky>` `sunPosition` y (e.g. `[100, -5, 80]`) plus `hemisphereLight` intensity. Keep `Stars` radius under the camera `far` (500).

## Pitfalls

- **React state for weather.** `useState` for the fog density or the frost opacity re-renders the tree 60×/s. Read `weather.now` in `useFrame`, write DOM styles through a ref (as `FrostOverlay` does).
- **Fog left in `Level.tsx`.** Linear `<fog>` and this `FogExp2` overwrite each other on mount; only one may own `scene.fog`.
- **Particles following the player only.** They wrap around the *camera* (`uCenter`) — keep it that way or particles empty out when the orbit camera zooms.
- **Rain through roofs.** The particles ignore geometry. For indoor areas, set `weather.now.rain = 0` while the player is in an `r3f-trigger` zone (after `stepWeather`), or switch with `setWeather('clear')` on enter and back on exit.
- **Heavy fog vs. draw distance.** `fogDensity` 0.05 hides everything beyond ~40 m — good for horror, bad for navigation; also lower grass `drawDistance` to match for free performance.
- **drei `<Cloud>` / `<Clouds>`** load a cloud texture from a CDN by default; use them only if the project allows external assets (or pass a project texture URL), never a guessed URL.
