---
name: projectile-systems
description: |
  Mandatory reference for all projectile, launch, or throw system tasks in React Three Fiber (R3F). Applies to any object (rocks, spells, bullets, missiles, markers) being thrown, fired, or launched.

  This document covers:
  - RigidBody reference readiness patterns to prevent common failures.
  - Input handling for keyboard and mouse-based firing.
  - Direction and trajectory calculation for FPS and TPS cameras.
  - Physics integration with Rapier (RigidBody, collision groups, raycasting).
  - Collision detection and lifecycle management of projectiles.

  Use this skill whenever implementing shooting, throwing, launching, or any form of projectile mechanics in R3F games. This includes spells, grenades, arrows, energy blasts, or any object that travels from a source to a target.
---

# Projectile Systems Reference Guide

## Core Principle

TPS and FPS firing logic are fundamentally different. Determine which one applies before writing any code:

- **TPS (Third-Person)**: Projectiles fire from the **character**, in the direction the character faces.
- **FPS (First-Person)**: Projectiles fire from the **camera**, in the direction the camera faces.

Applying FPS firing logic to a third-person game is a common mistake that causes severe aiming errors.

## Required Imports

```typescript
// React & R3F
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useFrame, Canvas } from '@react-three/fiber';
import { useKeyboardControls, KeyboardControls } from '@react-three/drei';
import * as THREE from 'three';

// Rapier physics engine
import { RigidBody, RapierRigidBody, Physics, useRapier, interactionGroups } from '@react-three/rapier';
// ActiveCollisionTypes and InteractionGroups are NOT in @react-three/rapier — import from here
import { ActiveCollisionTypes, InteractionGroups } from '@dimforge/rapier3d-compat';

// vibe-starter-3d (if used)
import { useControllerState } from 'vibe-starter-3d';
```

## Section Combination Guide

| System | Required Sections |
|--------|-------------------|
| Keyboard projectile | 1 (RigidBody readiness) + 2 (Keyboard) + 5 (Projectile component) |
| Mouse projectile | 1 (RigidBody readiness) + 3 (Mouse) + 5 (Projectile component) |
| vibe-starter-3d integration | 1 (vibe-starter-3d pattern) + desired input + 5 (Projectile component) |

---

## 1. RigidBody Reference Readiness (Required)

### Problem: RigidBody ref is null for the first few frames

```typescript
// ❌ This pattern fails — ref is null in early frames, so fire logic is never reached
useFrame(() => {
  if (!rigidBodyRef.current) return; // always exits here
});
```

### Solution: useRigidBodyReady hook

```typescript
const useRigidBodyReady = (rigidBodyRef: React.RefObject<RapierRigidBody | null>) => {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const check = () => {
      if (rigidBodyRef.current) {
        setIsReady(true);
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }, []);

  return isReady;
};

// ✅ Usage
const Player = () => {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const isReady = useRigidBodyReady(rigidBodyRef);

  useFrame(() => {
    if (!isReady) return; // only runs after rigidBody is ready
    // fire logic here
  });

  return (
    <RigidBody ref={rigidBodyRef} type="dynamic" position={[0, 1, 0]}>
      <mesh><boxGeometry /><meshStandardMaterial color="blue" /></mesh>
    </RigidBody>
  );
};
```

### vibe-starter-3d RigidBody Reference Rules

In `vibe-starter-3d`, `RigidBodyPlayerRef` directly returns the `RapierRigidBody` instance via `useImperativeHandle`. There is no intermediate wrapper — access it directly:

```typescript
// ❌ Forbidden — raw() and rigidBody property do not exist
rigidBodyPlayerRef.current?.raw()
rigidBodyPlayerRef.current?.rigidBody

// ✅ Correct direct access
const rigidBodyPlayerRef = useRef<RigidBodyPlayerRef>(null);

if (rigidBodyPlayerRef.current) {
  const position = rigidBodyPlayerRef.current.translation();
  const velocity = rigidBodyPlayerRef.current.linvel();
  const rotation = rigidBodyPlayerRef.current.rotation();
  rigidBodyPlayerRef.current.setTranslation({ x: 0, y: 10, z: 0 }, true);
}
```

### Rapier API Notes

```typescript
// ❌ Non-existent properties (these are THREE.js properties, not Rapier)
rigidBody.position;
rigidBody.matrixWorld;

// ✅ Correct Rapier API
const pos = rigidBody.translation(); // position
const vel = rigidBody.linvel();      // linear velocity
const rot = rigidBody.rotation();    // rotation (quaternion)
```

---

## 2. Keyboard Input Handling

Keyboard input hooks must be used inside a `KeyboardControls` component. Otherwise you get `TypeError: object null is not iterable`.

```typescript
// 1. Define keyboard mapping
const keyboardMap = [
  { name: 'forward', keys: ['ArrowUp', 'w', 'W'] },
  { name: 'backward', keys: ['ArrowDown', 's', 'S'] },
  { name: 'left', keys: ['ArrowLeft', 'a', 'A'] },
  { name: 'right', keys: ['ArrowRight', 'd', 'D'] },
  { name: 'fire', keys: ['KeyF', 'f'] },
];

// 2. Wrap with KeyboardControls
const Game = () => (
  <KeyboardControls map={keyboardMap}>
    <Canvas>
      <Physics>
        <ProjectileSystem>
          <Player />
        </ProjectileSystem>
      </Physics>
    </Canvas>
  </KeyboardControls>
);

// 3. Implement firing in player component
const Player = () => {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const isReady = useRigidBodyReady(rigidBodyRef);
  const lastFireTime = useRef(0);
  const [, getKeys] = useKeyboardControls();
  const { spawnProjectile } = useProjectileSystem();

  const fireProjectile = useCallback(() => {
    if (!rigidBodyRef.current) return;

    const pos = rigidBodyRef.current.translation();
    const startPos = new THREE.Vector3(pos.x, pos.y + 0.5, pos.z);
    const direction = new THREE.Vector3(1, 0, 0); // Calculate per game type — see Section 4

    spawnProjectile({
      startPosition: startPos,
      direction,
      speed: 10,
      maxDistance: 20
    });
  }, [spawnProjectile]);

  useFrame(() => {
    if (!isReady) return;

    const { fire } = getKeys();
    const now = Date.now();

    if (fire && now - lastFireTime.current > 500) {
      lastFireTime.current = now;
      fireProjectile();
    }
  });

  return (
    <RigidBody ref={rigidBodyRef} type="dynamic" position={[0, 1, 0]}>
      <mesh><boxGeometry /><meshStandardMaterial color="blue" /></mesh>
    </RigidBody>
  );
};
```

---

## 3. Mouse Input Handling

Mouse input is handled by attaching event listeners directly to the canvas DOM element via R3F's `useThree` hook.

```typescript
import { useThree, useFrame } from '@react-three/fiber';

const PlayerComponent: React.FC = () => {
  const { gl } = useThree();
  const [mouseState, setMouseState] = useState({ left: false });
  const leftPressedLastFrame = useRef(false);
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const isReady = useRigidBodyReady(rigidBodyRef);
  const { spawnProjectile } = useProjectileSystem();

  // Set up mouse event listeners
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) setMouseState(prev => ({ ...prev, left: true }));
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) setMouseState(prev => ({ ...prev, left: false }));
    };

    const domElement = gl.domElement;
    domElement.addEventListener('mousedown', handleMouseDown);
    domElement.addEventListener('mouseup', handleMouseUp);

    return () => {
      domElement.removeEventListener('mousedown', handleMouseDown);
      domElement.removeEventListener('mouseup', handleMouseUp);
    };
  }, [gl]);

  const fireProjectile = useCallback(() => {
    if (!rigidBodyRef.current) return;

    const pos = rigidBodyRef.current.translation();
    const startPos = new THREE.Vector3(pos.x, pos.y + 0.5, pos.z);
    const direction = new THREE.Vector3(1, 0, 0); // Calculate per game type — see Section 4

    spawnProjectile({ startPosition: startPos, direction, speed: 10, maxDistance: 20 });
  }, [spawnProjectile]);

  useFrame(() => {
    if (!isReady) return;

    // Detect "just pressed" by comparing to previous frame
    const leftJustPressed = mouseState.left && !leftPressedLastFrame.current;
    leftPressedLastFrame.current = mouseState.left;

    if (leftJustPressed) {
      fireProjectile();
    }
  });

  return (
    <RigidBody ref={rigidBodyRef} type="dynamic" position={[0, 1, 0]}>
      <mesh><boxGeometry /><meshStandardMaterial color="red" /></mesh>
    </RigidBody>
  );
};
```

---

## 4. Direction Calculation (FPS vs TPS)

Analyze project code to determine game type before implementing. The character's forward vector is `(0, 0, 1)`.

### FPS / TPS Detection Criteria

| FPS Signals | TPS Signals |
|-------------|-------------|
| Uses `PointerLockControls` | Uses `OrbitControls` |
| `crosshair`, `firstPerson` in code | `thirdPerson`, `characterMesh` in code |
| `camera.getWorldDirection` pattern | Direction from `rigidBody.rotation()` |
| Camera and player positions nearly identical | Character mesh rendered on screen |

Quick check: if the character model is visible on screen, it's TPS. If not, it's FPS.

### 4.1 FPS — Camera-Based Direction

```typescript
import { useThree, useFrame } from '@react-three/fiber';

export const getCameraDirection = (camera: THREE.Camera): THREE.Vector3 => {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  return direction; // already normalized
};

export const getProjectileStartPositionFPS = (
  camera: THREE.Camera,
  offsetDistance: number = 0
): THREE.Vector3 => {
  const position = new THREE.Vector3();
  camera.getWorldPosition(position);
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  return position.add(direction.multiplyScalar(offsetDistance));
};

// FPS player component
const FPSPlayer = () => {
  const { camera } = useThree();
  const lastFireTime = useRef(0);
  const [, getKeys] = useKeyboardControls();
  const { spawnProjectile } = useProjectileSystem();

  const fireProjectile = useCallback(() => {
    const startPos = getProjectileStartPositionFPS(camera, 0.5);
    const direction = getCameraDirection(camera);

    spawnProjectile({ startPosition: startPos, direction, speed: 20, maxDistance: 50 });
  }, [camera, spawnProjectile]);

  useFrame(() => {
    const { fire } = getKeys();
    const now = Date.now();
    if (fire && now - lastFireTime.current > 300) {
      lastFireTime.current = now;
      fireProjectile();
    }
  });

  return null; // FPS typically has no player model
};
```

### 4.2 TPS — Character-Based Direction

```typescript
import { useFrame } from '@react-three/fiber';
import { RapierRigidBody } from '@react-three/rapier';

export const getCharacterDirection = (rigidBody: RapierRigidBody): THREE.Vector3 | null => {
  if (!rigidBody) return null;

  const rotation = rigidBody.rotation();
  const quaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);

  // Apply quaternion to forward vector (0, 0, 1)
  return new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
};

export const getCharacterPosition = (rigidBody: RapierRigidBody): THREE.Vector3 | null => {
  if (!rigidBody) return null;
  const pos = rigidBody.translation();
  return new THREE.Vector3(pos.x, pos.y, pos.z);
};

export const getProjectileStartPositionTPS = (
  rigidBody: RapierRigidBody,
  offsetDistance: number = 0,
  heightOffset: number = 0
): THREE.Vector3 | null => {
  const position = getCharacterPosition(rigidBody);
  const direction = getCharacterDirection(rigidBody);
  if (!position || !direction) return null;

  return position.clone()
    .add(direction.clone().multiplyScalar(offsetDistance))
    .add(new THREE.Vector3(0, heightOffset, 0));
};

// TPS player component
const TPSPlayer = () => {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const isReady = useRigidBodyReady(rigidBodyRef);
  const lastFireTime = useRef(0);
  const [, getKeys] = useKeyboardControls();
  const { spawnProjectile } = useProjectileSystem();

  const fireProjectile = useCallback(() => {
    if (!rigidBodyRef.current) return;

    const startPos = getProjectileStartPositionTPS(rigidBodyRef.current, 0.2, 0.5);
    const direction = getCharacterDirection(rigidBodyRef.current);

    if (startPos && direction) {
      spawnProjectile({ startPosition: startPos, direction, speed: 15, maxDistance: 30 });
    }
  }, [spawnProjectile]);

  useFrame(() => {
    if (!isReady) return;
    const { fire } = getKeys();
    const now = Date.now();
    if (fire && now - lastFireTime.current > 500) {
      lastFireTime.current = now;
      fireProjectile();
    }
  });

  return (
    <RigidBody ref={rigidBodyRef} type="dynamic" position={[0, 1, 0]}>
      <mesh><boxGeometry args={[0.5, 1, 0.5]} /><meshStandardMaterial color="blue" /></mesh>
    </RigidBody>
  );
};
```

### Verification Checklist

**FPS**: Direction changes with mouse movement, fires toward screen center, spawns at camera position.
**TPS**: Direction changes with character rotation, spawns in front of character, fires in character's facing direction.

If the direction is wrong, try swapping the FPS/TPS implementation.

---

## 5. Projectile Movement & Collision Detection

### 5.0 InteractionGroups — Collision Group Management

InteractionGroups is a bitmask-based pairwise filtering system. In a 32-bit value, the upper 16 bits represent the groups this object belongs to, and the lower 16 bits represent the groups it can collide with.

For two objects to collide, each must include the other's group in its collision target mask.

Use the `interactionGroups` helper from `@react-three/rapier` instead of raw bit manipulation:

```typescript
import { interactionGroups } from '@react-three/rapier';

const GROUPS = {
  PLAYER: 0,
  ENEMY: 1,
  PLAYER_PROJECTILE: 2,
  ENEMY_PROJECTILE: 3,
  ENVIRONMENT: 4
};

// Player projectile: collides with enemies and environment only
const playerProjectileGroups = interactionGroups(
  GROUPS.PLAYER_PROJECTILE,
  [GROUPS.ENEMY, GROUPS.ENVIRONMENT]
);

// Enemy projectile: collides with player and environment only
const enemyProjectileGroups = interactionGroups(
  GROUPS.ENEMY_PROJECTILE,
  [GROUPS.PLAYER, GROUPS.ENVIRONMENT]
);

// Environment: collides with all entities
const environmentGroups = interactionGroups(
  GROUPS.ENVIRONMENT,
  [GROUPS.PLAYER, GROUPS.ENEMY, GROUPS.PLAYER_PROJECTILE, GROUPS.ENEMY_PROJECTILE]
);
```

### 5.1 Projectile Component

Uses a hybrid approach: each frame, a raycast checks for forward collisions, then `setTranslation` moves the projectile. When a raycast detects a hit, the projectile moves to that position and freezes, waiting for `onCollisionEnter`/`onIntersectionEnter` events to fire.

```typescript
import React, { useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RigidBody, useRapier, RapierRigidBody, CollisionPayload } from '@react-three/rapier';
import { ActiveCollisionTypes, InteractionGroups } from '@dimforge/rapier3d-compat';

interface ProjectileProps {
  startPosition: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  maxDistance: number;
  owner?: RapierRigidBody;
  effectCollisionGroups?: InteractionGroups;
  onHit?: (payload: CollisionPayload) => void;
  onComplete?: () => void;
}

const Projectile: React.FC<ProjectileProps> = React.memo(
  ({ startPosition, direction, speed, maxDistance, owner, effectCollisionGroups, onHit, onComplete }) => {
    const [active, setActive] = useState(true);
    const rigidBodyRef = useRef<RapierRigidBody>(null);
    const { rapier, world } = useRapier();
    const distanceTraveled = useRef(0);
    const frozen = useRef(false);
    const framesSinceFrozen = useRef(0);
    const normalizedDirection = direction.clone().normalize();

    const removeProjectile = useCallback(() => {
      setActive(false);
      onComplete?.();
    }, [onComplete]);

    useFrame((_, delta) => {
      if (!active || !rigidBodyRef.current) return;

      const rigidBody = rigidBodyRef.current;
      if (!rigidBody || rigidBody.numColliders() === 0) return;

      const frameTravelDistance = speed * delta;
      const newDistanceTraveled = distanceTraveled.current + frameTravelDistance;

      if (newDistanceTraveled >= maxDistance) {
        const finalPosition = startPosition.clone().addScaledVector(normalizedDirection, maxDistance);
        rigidBody.setTranslation(finalPosition, true);
        removeProjectile();
        return;
      }

      // While frozen, wait for collision event callback
      if (frozen.current) {
        framesSinceFrozen.current++;
        // If no collision event after 3 frames, unfreeze and continue
        if (framesSinceFrozen.current > 3) {
          frozen.current = false;
          framesSinceFrozen.current = 0;
        }
        return;
      }

      const originVec = rigidBody.translation();
      const ray = new rapier.Ray(originVec, normalizedDirection);
      const ownCollider = rigidBody.collider(0);

      const hit = world.castRay(
        ray,
        frameTravelDistance,
        true,       // solid
        undefined,  // queryFlags
        effectCollisionGroups ?? 0xffffffff,
        ownCollider, // exclude projectile's own collider
        owner,       // exclude the firer
      );

      if (hit) {
        const hitPoint = ray.pointAt(hit.timeOfImpact);
        const hitPointVec3 = new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z);
        frozen.current = true;
        framesSinceFrozen.current = 0;
        rigidBody.setTranslation(hitPointVec3, true);
      } else {
        distanceTraveled.current = newDistanceTraveled;
        const curVec3 = new THREE.Vector3(originVec.x, originVec.y, originVec.z);
        const nextPosition = curVec3.addScaledVector(normalizedDirection, frameTravelDistance);
        rigidBody.setTranslation(nextPosition, true);
      }
    });

    const handleCollisionEnter = (payload: CollisionPayload) => {
      frozen.current = false;
      framesSinceFrozen.current = 0;
      // Ignore collision with the firer
      if (owner && payload.other.rigidBody && owner.handle === payload.other.rigidBody.handle) {
        return;
      }
      onHit?.(payload);
      removeProjectile();
    };

    if (!active) return null;

    return (
      <RigidBody
        ref={rigidBodyRef}
        type="kinematicVelocity"
        position={[startPosition.x, startPosition.y, startPosition.z]}
        sensor={true}
        colliders="cuboid"
        collisionGroups={effectCollisionGroups ?? 0xffffffff}
        activeCollisionTypes={ActiveCollisionTypes.ALL}
        onCollisionEnter={handleCollisionEnter}
        onIntersectionEnter={handleCollisionEnter}
      >
        <mesh>
          <sphereGeometry args={[0.1, 16, 16]} />
          <meshStandardMaterial color="orange" emissive="red" emissiveIntensity={2} />
        </mesh>
      </RigidBody>
    );
  },
);

export default Projectile;
```

### 5.2 ProjectileSystem Manager

Manages creation and removal of multiple projectiles via React Context. Must be used inside `<Physics>`.

```typescript
import React, { useState, useCallback, useMemo, createContext, useContext } from 'react';
import * as THREE from 'three';
import { RapierRigidBody, CollisionPayload } from '@react-three/rapier';
import { InteractionGroups } from '@dimforge/rapier3d-compat';
import Projectile from './Projectile';

interface ProjectileData {
  id: string;
  startPosition: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  maxDistance: number;
  owner?: RapierRigidBody;
  effectCollisionGroups?: InteractionGroups;
  onHit?: (payload: CollisionPayload) => void;
}

interface ProjectileSystemContextType {
  spawnProjectile: (data: Omit<ProjectileData, 'id'>) => void;
}

const ProjectileSystemContext = createContext<ProjectileSystemContextType | undefined>(undefined);

export const useProjectileSystem = () => {
  const context = useContext(ProjectileSystemContext);
  if (!context) {
    throw new Error('useProjectileSystem must be used within a ProjectileSystem');
  }
  return context;
};

let projectileIdCounter = 0;
const generateUniqueId = () => `proj-${projectileIdCounter++}`;

const ProjectileSystem: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [projectiles, setProjectiles] = useState<ProjectileData[]>([]);

  const spawnProjectile = useCallback((data: Omit<ProjectileData, 'id'>) => {
    const id = generateUniqueId();
    setProjectiles((prev) => [...prev, { ...data, id }]);
  }, []);

  const removeProjectile = useCallback((id: string) => {
    setProjectiles((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const contextValue = useMemo(() => ({ spawnProjectile }), [spawnProjectile]);

  return (
    <ProjectileSystemContext.Provider value={contextValue}>
      {projectiles.map((projectile) => (
        <Projectile
          key={projectile.id}
          {...projectile}
          onComplete={() => removeProjectile(projectile.id)}
        />
      ))}
      {children}
    </ProjectileSystemContext.Provider>
  );
};

export default ProjectileSystem;
```

---

## 6. Project Integration Guide

When integrating the projectile system into an existing project, first analyze the codebase to identify existing patterns and extend them accordingly:

1. **Identify the player reference system**: `useRef<RapierRigidBody>` vs `useRef<RigidBodyPlayerRef>` vs custom type
2. **Identify the input system**: direct `useKeyboardControls` vs centralized InputController vs Zustand/Redux integration
3. **Identify scene composition**: single Experience component vs modular scene components

The key is to extend existing patterns rather than introducing new ones. For example, if the project uses a Zustand-based action system:

```typescript
// Extend existing patterns — add fire action
const Player = () => {
  const { getPlayerAction } = usePlayerActionStore();
  const { spawnProjectile } = useProjectileSystem();

  useFrame(() => {
    const firePressed = getPlayerAction('fire');
    if (firePressed) {
      fireProjectile();
    }
  });
};
```

Implement the entire feature in one pass rather than incremental steps. Maintain existing naming conventions, file structure, and error handling patterns.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot read property 'current' of null` | RigidBody not initialized | Use `useRigidBodyReady` from Section 1 |
| `useKeyboardControls is not a function` | Not wrapped in `KeyboardControls` | Check Section 2 structure |
| Projectiles not spawning | `ProjectileSystem` not set up | Use component from Section 5.2 |
| Collisions not detected | InteractionGroups misconfigured | Check group setup in Section 5.0 |
| `rigidBody.translation is not a function` | Wrong API usage | See Rapier API notes in Section 1 |
| Projectile direction is wrong | FPS/TPS confusion | Re-check detection criteria in Section 4 |

## Implementation Checklist

1. Use `useRigidBodyReady` hook to confirm RigidBody is ready
2. Add `if (!isReady) return;` guard in useFrame
3. Use correct Rapier API (`rigidBody.translation()`, not `rigidBody.position`)
4. Set up input system (wrap with KeyboardControls or register DOM event listeners)
5. Set cooldown time (lastFireTime pattern)
6. Use both Raycast and RigidBody setTranslation for projectile movement
7. Configure InteractionGroups correctly
8. Wrap scene with ProjectileSystem inside Physics
9. Implement the entire feature in one pass, not incremental steps
