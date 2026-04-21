---
name: how-to-3d-multiplayer-character-sync
description: |
  3D multiplayer character synchronization patterns built on @agent8/gameserver SDK.
  Covers Zustand network store, throttled position sync, and 3D remote player interpolation (lerp/slerp) with React Three Fiber + Rapier.
  MANDATORY: Always read this skill when converting a single-player 3D game into a multiplayer game, or when adding multiplayer features to any 3D game.
  DEPENDENCY: Requires the appropriate gameserver-sdk skill for raw SDK API reference ($room, $global, remoteFunction, subscriptions).
  Use gameserver-sdk-v2 for new projects (server/ directory, TypeScript). Use gameserver-sdk for existing projects with server.js in root.
---

# Multiplayer Game State Synchronization

This skill provides reusable sync patterns for sharing player state across clients in real-time. Focused on 3D games (React Three Fiber + Rapier), with notes on adapting to other engines where relevant.

---

## PREREQUISITE - MUST READ FIRST

**DEPENDENCY**: Before implementing anything in this skill, you MUST first read the appropriate gameserver-sdk skill. Multiplayer sync depends on:
- `useGameServer` hook, `server.remoteFunction`, `throttle`/`needResponse` options
- `$room`, `$global` APIs for state read/write
- Client subscription APIs (`subscribeRoomAllUserStates`, `subscribeRoomState`, `onRoomUserLeave`)

**Which skill(s) to read:**

| Project type | Skills to read |
|--------------|----------------|
| `server/` directory exists, or new project | `gameserver-sdk-v2` only |
| `server.js` in project root (legacy) | `gameserver-sdk-v2` + **`gameserver-sdk`** both |

For legacy projects, `gameserver-sdk` contains the actual conventions that apply (no export, JS syntax). Read it alongside `gameserver-sdk-v2`.

**DO NOT** implement multiplayer sync without first loading the appropriate gameserver-sdk skill context.

---

## TRIGGER CONDITIONS

> **Note for developers**: This section is for human reference only. Actual skill triggering is controlled by the `description` field in the frontmatter above — not by this list.

**This skill is relevant when the user asks about:**

| Type | Keywords |
|------|----------|
| English | `multiplayer`, `sync players`, `show other players`, `remote player`, `interpolation`, `lerp`, `network store`, `player state`, `position sync` |
| Korean | `멀티플레이어`, `멀티플레이`, `다른 플레이어`, `위치 동기화`, `네트워크 동기화`, `원격 플레이어`, `플레이어 동기화` |

**DO NOT** activate this skill when:
- User asks only about room joining/matching without player state sync
- User asks about game logic (HP, score, kills) without mentioning position/state sync
- User asks about general gameserver SDK usage → use `gameserver-sdk-v2` (new projects) or `gameserver-sdk` (legacy) instead

---

## Architecture

```
Client A (useFrame game loop)
  → detect change (threshold) → updateCharacterState() [throttled 50ms]
      → Server: $room.updateMyState({ characterState })
          → broadcasts to all room subscribers
              → Client B: subscribeRoomAllUserStates → Zustand store
                  → lerp/slerp toward latest position
```

**Core principles:**

| Principle | Detail |
|-----------|--------|
| Client-authoritative movement | Position/rotation sent directly — no round-trip latency |
| Server-authoritative game logic | HP, score, kills calculated server-side |
| Throttled full snapshots | 50ms intervals, full state each time (no delta encoding) |
| `isPositionStable` gate | Remote players hidden until local player has valid position |

---

## Pattern 1: Define Types

```typescript
// Transform supports both 2D and 3D
export interface Transform {
  position: number[];           // [x,y,z] for 3D, [x,y] for 2D
  rotation: number[] | number;  // quaternion [x,y,z,w] for 3D, angle for 2D
}

export interface BaseCharacterState<AnimationType, ActionType = never> {
  transform: Transform;
  currentAnimation: AnimationType;
  currentAction: ActionType | null;
  isPositionStable?: boolean;  // gates remote player rendering — false until position is valid
}

// Extend for your game
export interface MyCharacterState extends BaseCharacterState<MyAnimationType, MyActionType> {
  isGrounded: boolean;
  updateTimestamp?: number;  // client-set, for ordering
}

export interface MyRoomUserState {
  account: string;
  characterState: MyCharacterState;
}
```

---

## Pattern 2: Network Store

Generic Zustand factory — same store shape for every project, different types.

```typescript
// core/store/networkStore.ts
import { create } from "zustand";

export const createNetworkStore = <TGlobal, TRoom, TRoomUser>(
  initialState: { myState: TGlobal; roomState: TRoom }
) =>
  create((set) => ({
    myState: initialState.myState,
    roomState: initialState.roomState,
    roomUsersState: {} as Record<string, TRoomUser>,
    currentRoomId: undefined as string | undefined,

    setMyState: (state) => set((prev) => ({ myState: { ...prev.myState, ...state } })),
    setRoomState: (state) => set((prev) => ({ roomState: { ...prev.roomState, ...state } })),
    setRoomUserState: (account, state) =>
      set((prev) => ({
        roomUsersState: {
          ...prev.roomUsersState,
          [account]: { ...prev.roomUsersState[account], ...state },
        },
      })),
    setCurrentRoomId: (roomId) => set({ currentRoomId: roomId }),
    clearAllRoomStates: () => set({ roomState: initialState.roomState, roomUsersState: {} }),
    removeRoomUser: (account) =>
      set((prev) => {
        const { [account]: _, ...rest } = prev.roomUsersState;
        return { roomUsersState: rest };
      }),
  }));

// Instantiate for your game
export const useNetworkStore = createNetworkStore<MyGlobalUserState, MyRoomState, MyRoomUserState>({
  myState: { account: "" },
  roomState: { $users: [] },
});
```

---

## Pattern 3: Network Hook

Central hook composing SDK calls into a game-ready interface.

| Pattern | Config |
|---------|--------|
| Character sync | `throttle: 50` + `needResponse: false` — fire-and-forget at 20Hz |
| Room operations | `needResponse: true` — await server confirmation |
| Subscriptions | Use `useNetworkStore.getState()` inside callbacks to avoid stale closures |

```typescript
// hooks/useGameNetwork.ts
export const useGameNetwork = () => {
  const { connected, server } = useGameServer();
  const { setRoomState, setRoomUserState, setCurrentRoomId, clearAllRoomStates, removeRoomUser } = useNetworkStore();

  const updateCharacterState = useCallback(
    (characterState: Partial<MyCharacterState>) =>
      server.remoteFunction("updateCharacterState", [{ ...characterState, updateTimestamp: Date.now() }], {
        needResponse: false, throttle: 50, throttleKey: "updateCharacter",
      }),
    [server]
  );

  const joinRoom = useCallback(async (roomId: string) => {
    if (!connected) return null;
    const result = await server.remoteFunction("joinRoom", [roomId], { needResponse: true });
    setCurrentRoomId(roomId);
    // Populate store with existing room state so late-joining players see current state immediately
    if (result?.roomState) setRoomState(result.roomState);
    return result;
  }, [connected, server, setCurrentRoomId, setRoomState]);

  const leaveRoom = useCallback(async () => {
    const result = await server.remoteFunction("leaveRoom", [], { needResponse: true });
    setCurrentRoomId("");
    clearAllRoomStates();
    return result;
  }, [server, setCurrentRoomId, clearAllRoomStates]);

  // Combines all room subscriptions into a single cleanup function
  const subscribeRoom = useCallback((roomId: string) => {
    const unsub1 = server.subscribeRoomState(roomId, (state) =>
      useNetworkStore.getState().setRoomState(state)
    );
    const unsub2 = server.subscribeRoomAllUserStates(roomId, (states) =>
      states.forEach((s) => useNetworkStore.getState().setRoomUserState(s.account, s))
    );
    const unsub3 = server.onRoomUserLeave(roomId, (account) => {
      useNetworkStore.getState().removeRoomUser(account);  // remove departed player from store
    });
    return () => { unsub1?.(); unsub2?.(); unsub3?.(); };
  }, [server]);

  return { connected, updateCharacterState, joinRoom, leaveRoom, subscribeRoom };
};
```

---

## Pattern 4: Local Player Sync + Position Stability

Read position every frame, send only when changed beyond threshold.

**Position stability**: The local player starts with `isPositionStable: false`. After `STABLE_FRAME_COUNT` frames above a valid Y threshold, it flips to `true`. Remote clients use this flag to gate rendering and prevent flicker at origin (0,0,0).

```typescript
// Example: 3D physics with React Three Fiber + Rapier
const THRESHOLD = 0.01;
const STABLE_FRAME_COUNT = 30;
const lastSync = useRef({ position: [0, 0, 0], rotation: [0, 0, 0, 1], animation: "" });
const frameCount = useRef(0);
const isStable = useRef(false);

useFrame(() => {
  if (!rigidBodyRef.current) return;

  const pos = rigidBodyRef.current.translation();
  const rot = rigidBodyRef.current.rotation();
  const curPos = [pos.x, pos.y, pos.z];
  const curRot = [rot.x, rot.y, rot.z, rot.w];
  const curAnim = calculateAnimation(velocity, isGrounded);

  if (!isStable.current) {
    frameCount.current++;
    if (frameCount.current >= STABLE_FRAME_COUNT && curPos[1] > -10) {
      isStable.current = true;
    }
  }

  const changed =
    curPos.some((v, i) => Math.abs(v - lastSync.current.position[i]) > THRESHOLD) ||
    curRot.some((v, i) => Math.abs(v - lastSync.current.rotation[i]) > THRESHOLD) ||
    curAnim !== lastSync.current.animation;

  if (changed) {
    updateCharacterState({
      transform: { position: curPos, rotation: curRot },
      currentAnimation: curAnim,
      isGrounded,
      isPositionStable: isStable.current,
    });
    lastSync.current = { position: curPos, rotation: curRot, animation: curAnim };
  }
});
```

> **Other engines:** Replace `rigidBodyRef.current.translation()` with your engine's position API (e.g., `mesh.position` for Three.js, `sprite.x/y` for 2D). The threshold check and stability gate are identical.

**`calculateAnimation()` implementation example:**

```typescript
// velocity and isGrounded → animation name mapping
const calculateAnimation = (velocity: Vector3, isGrounded: boolean): MyAnimationType => {
  const speed = new Vector3(velocity.x, 0, velocity.z).length(); // horizontal speed only
  if (!isGrounded) return "jump";
  if (speed > 5) return "run";
  if (speed > 0.1) return "walk";
  return "idle";
};
```

---

## Pattern 5: Remote Player Interpolation

Remote players don't run physics — they lerp/slerp toward the latest network position.

```typescript
// Example: 3D with React Three Fiber + Rapier (kinematicPosition RigidBody)
const targetPos = useRef(new Vector3());
const targetRot = useRef(new Quaternion());
const currentPos = useRef(new Vector3());
const currentRot = useRef(new Quaternion());

// Update interpolation targets when network state changes
useEffect(() => {
  if (!characterState?.transform) return;
  const [x, y, z] = characterState.transform.position;
  const [rx, ry, rz, rw] = characterState.transform.rotation as number[];
  targetPos.current.set(x, y, z);
  targetRot.current.set(rx, ry, rz, rw);
}, [
  characterState?.transform?.position?.[0],
  characterState?.transform?.position?.[1],
  characterState?.transform?.position?.[2],
  characterState?.transform?.rotation?.[0],
  characterState?.transform?.rotation?.[1],
  characterState?.transform?.rotation?.[2],
  characterState?.transform?.rotation?.[3],
]);

useFrame((_, delta) => {
  if (!rigidBodyRef.current) return;
  const factor = Math.min(1, delta * 10);
  currentPos.current.lerp(targetPos.current, factor);
  currentRot.current.slerp(targetRot.current, factor);
  rigidBodyRef.current.setNextKinematicTranslation(currentPos.current);
  rigidBodyRef.current.setNextKinematicRotation(currentRot.current);
});
```

> **Other engines:** Apply the same lerp/slerp to your engine's position setter (e.g., `mesh.position.lerp()` for Three.js, linear interpolation for 2D sprites).

**Troubleshooting: Remote player floating above ground**

`rigidBodyRef.current.translation()` returns the **capsule collider center**, not the feet. The local player's framework internally offsets the mesh downward so feet align to the ground. If the remote player skips this offset, it renders at the capsule center and appears to float.

**Option A — apply the same mesh Y offset on the remote player:**

When using `vibe-starter-3d`'s `RigidBodyPlayer` for the local player, the internal offset is `targetHeight / 2`. Apply the same value on the remote player:

```tsx
const TARGET_HEIGHT = 1.6; // must match local player's targetHeight

<RigidBody type="kinematicPosition" colliders={false}>
  <group position={[0, -TARGET_HEIGHT / 2, 0]}>  {/* ← matches RigidBodyPlayer's internal offset */}
    <RemotePlayer userId={userId} characterState={state.characterState} />
  </group>
</RigidBody>
```

> **Why `targetHeight / 2`**: `RigidBodyPlayer` renders its children inside `<group position={[0, -targetHeight/2, 0]}>`. The synced `translation()` is the rigid body center (feet + `targetHeight/2`), so the remote player must apply the same offset.

**Option B — sync feet position instead of capsule center:**

```typescript
// Local player: subtract offset before sending
updateCharacterState({
  transform: {
    position: [pos.x, pos.y - TARGET_HEIGHT / 2, pos.z],  // feet Y
    rotation: curRot,
  },
});

// Remote player: no offset needed — position is already at feet
```

> Option A is simpler when `targetHeight` is fixed. Option B is cleaner if remote players use a plain `<group>` without a RigidBody.

---

## Pattern 6: Remote Player Animation Playback

Remote players receive `currentAnimation` and `currentAction` from network state — use `useAnimations` (R3F/drei) to drive the actual animation clip.

**Loop animations** (idle, walk, run, jump) — crossfade on change:

```typescript
// components/RemotePlayer.tsx
import { useAnimations } from "@react-three/drei";

const RemotePlayer = ({ characterState, animations, groupRef }) => {
  const { actions, mixer } = useAnimations(animations, groupRef);

  // Switch loop animation on change — fadeIn/fadeOut for smooth blend
  useEffect(() => {
    const animName = characterState?.currentAnimation;
    if (!animName) return;
    const action = actions[animName];
    if (!action) return;
    action.reset().fadeIn(0.2).play();
    return () => { action.fadeOut(0.2); };
  }, [characterState?.currentAnimation, actions]);

  return <group ref={groupRef}>{/* model */}</group>;
};
```

**One-shot actions** (attack, hit, death) — play once and return to loop:

```typescript
// currentAction: one-shot events sent with a unique timestamp to force re-trigger
useEffect(() => {
  const actionName = characterState?.currentAction;
  if (!actionName) return;
  const action = actions[actionName];
  if (!action) return;

  const loopAnim = actions[characterState.currentAnimation];
  action.reset().setLoop(LoopOnce, 1).play();
  action.clampWhenFinished = true;

  // Return to loop animation when one-shot finishes
  const onFinish = () => loopAnim?.reset().fadeIn(0.2).play();
  mixer.addEventListener("finished", onFinish);
  return () => mixer.removeEventListener("finished", onFinish);
}, [characterState?.currentAction, characterState?.updateTimestamp, actions, mixer]);
```

**Sending one-shot actions from local player:**

```typescript
// Attach updateTimestamp so the same action can re-trigger (e.g., rapid attacks)
updateCharacterState({
  currentAction: "attack",
  updateTimestamp: Date.now(),
});
```

> **Key**: `currentAnimation` drives looping states; `currentAction` + `updateTimestamp` drives one-shot events. `updateTimestamp` forces a new effect invocation even when `currentAction` string is identical.

**Gate rendering on position stability** — skip render until remote player has valid position

```typescript
// roomUsersState is already a Record<string, TRoomUser> — use directly as a lookup map
const { roomState, roomUsersState: roomUsersRecord } = useNetworkStore();
```

```tsx
const networkPlayers = useMemo(() =>
  roomState?.$users
    ?.filter((id) => id !== myAccount)
    .map((userId) => {
      const state = roomUsersRecord[userId];
      if (!state?.characterState?.isPositionStable) return null;  // prevents flicker
      return (
        <RigidBody key={userId} type="kinematicPosition" colliders={false}>
          <group position={[0, -TARGET_HEIGHT / 2, 0]}>  {/* ← offset to align feet to ground */}
            <RemotePlayer userId={userId} characterState={state.characterState} />
          </group>
        </RigidBody>
      );
    }),
  [roomState?.$users, myAccount, roomUsersRecord]
);
```

---

## Pattern 7: Server Side

```typescript
// server/src/server.ts
export class Server {
  // Initialize player state — isPositionStable: false until client confirms valid position
  async joinRoom(roomId: string) {
    await $global.joinRoom(roomId);
    await $room.updateMyState({
      characterState: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        isPositionStable: false,
      },
    });
    return { roomState: await $room.getRoomState(), myRoomState: await $room.getMyState() };
  }

  // Relay partial character state update from client and broadcast to room
  async updateCharacterState(updated: Partial<CharacterState>) {
    const prev = await $room.getMyState();
    await $room.updateMyState({ characterState: { ...prev.characterState, ...updated } });
  }

  async leaveRoom() {
    return $room.leave();
  }
}
```

---

## Performance Checklist

| Pattern | Why |
|---------|-----|
| `throttle: 50` + `throttleKey` | Caps to 20 updates/sec per entity, prevents server overload |
| Position threshold 0.01 | Skips trivial movements, reduces network traffic |
| `isPositionStable` gate | Prevents remote player flicker on spawn |
| `kinematicPosition` RigidBody (3D) | No physics sim overhead for remote players |
| `useNetworkStore.getState()` in callbacks | Avoids stale closure bugs in subscriptions |
| `useMemo` for `$users` → record lookup | O(1) access to remote player states |
| Cleanup all subscriptions in `useEffect` return | Prevents memory leaks and ghost subscriptions |
| `fadeIn/fadeOut(0.2)` on animation switch | Smooth crossfade — avoids jarring snaps between clips |
| `currentAction` + `updateTimestamp` | Forces re-trigger for repeated one-shot actions (e.g., rapid attacks) |
| `LoopOnce` + `clampWhenFinished` on actions | One-shot clips freeze on last frame instead of snapping back |
