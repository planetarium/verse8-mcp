---
name: r3f-character-sync
description: |
  3D multiplayer character synchronization patterns built on @agent8/gameserver SDK.
  Covers Zustand network store, throttled position sync, and 3D remote player interpolation (lerp/slerp) with React Three Fiber + Rapier.
  MANDATORY: Always read this skill when converting a single-player 3D game into a multiplayer game, or when adding multiplayer features to any 3D game.
  DEPENDENCY: Requires the gameserver-sdk skill for the raw SDK API reference ($room, $global, remoteFunction, joinRoom/rsConnected, subscriptions).
  Written for @agent8/gameserver 2.x; a project pinned to 1.x must upgrade first, as gameserver-sdk describes.
---

# Multiplayer Game State Synchronization

This skill provides reusable sync patterns for sharing player state across clients in real-time. Focused on 3D games (React Three Fiber + Rapier), with notes on adapting to other engines where relevant.

---

## PREREQUISITE - MUST READ FIRST

**DEPENDENCY**: Before implementing anything in this skill, you MUST first read the `gameserver-sdk` skill. Multiplayer sync depends on:
- `useGameServer` hook: `server.remoteFunction` with the `throttle`/`throttleTrailing` options, and `joinRoom`/`leaveRoom`/`rsConnected`/`currentRoomId`
- `$room`, `$global` APIs for state read/write, and the room lifecycle hooks (`onRoomJoin`, `onRoomLeave`)
- Client subscription APIs (`subscribeRoomAllUserStates`, `subscribeRoomState`, `onRoomUserLeave`)

**SDK version**: every pattern below is written for `@agent8/gameserver` 2.x. If the project's `package.json` pins 1.x, upgrade it first as `gameserver-sdk` describes — 1.x has no client-side `joinRoom`/`rsConnected`, and the 1.x server-side join (`$global.joinRoom`) throws on 2.x. The server layout (a root `server.js` or `server/src/server.ts`) does not change the patterns; `gameserver-sdk` covers both.

**DO NOT** implement multiplayer sync without first loading the `gameserver-sdk` skill context.

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
- User asks about general gameserver SDK usage → use `gameserver-sdk` instead

---

## Architecture

```
Client A: remoteFunction("findRoom") → roomId → joinRoom(roomId)   [SDK connects to the Room Server]
  → Server: onRoomJoin hook initializes the player's room user state

Client A (useFrame game loop, once rsConnected)
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
  actionSeq?: number;          // changes ONLY when a one-shot action is sent — replays it on remotes
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

Generic Zustand factory — same store shape for every project, different types. The joined room's id is not kept here: `currentRoomId` from `useGameServer()` is the SDK's own record of it.

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

    setMyState: (state) => set((prev) => ({ myState: { ...prev.myState, ...state } })),
    setRoomState: (state) => set((prev) => ({ roomState: { ...prev.roomState, ...state } })),
    setRoomUserState: (account, state) =>
      set((prev) => ({
        roomUsersState: {
          ...prev.roomUsersState,
          [account]: { ...prev.roomUsersState[account], ...state },
        },
      })),
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
| Character sync | `throttle: 50` + `throttleTrailing: true` — at most 20 sends/sec, fire-and-forget. The throttle is leading-edge only by default, so without `throttleTrailing` the final resting pose of a movement is the call that gets dropped |
| Send only once `rsConnected` | The SDK builds a throttled sender once per function + key and keeps the Game Server / Room Server route of its FIRST call. A first call made before the room connection is up sends every later update to the Game Server, where `$room` throws — and throttled calls never report the error |
| One-shot actions | Unthrottled and separate from the position stream: within a throttle window only the latest payload is sent, so the next frame's position update would replace an attack |
| Room join | A server function RETURNS a `roomId`; the client passes it to `joinRoom(roomId)` from `useGameServer()`. Never name a server function `joinRoom`/`leaveRoom` — the SDK rejects those names in `remoteFunction()` |
| Subscriptions | Subscribe in an effect keyed on `rsConnected` + `currentRoomId` (a room subscription issued before `rsConnected` is dropped, and none survive a reconnect). Use `useNetworkStore.getState()` inside callbacks to avoid stale closures |
| Room UI | Gate room screens on `rsConnected`, not `connected` |

```typescript
// hooks/useGameNetwork.ts
// Mount once, in the component that owns the room session — every instance runs its own subscriptions.
export const useGameNetwork = () => {
  const { connected, rsConnected, currentRoomId, server, joinRoom, leaveRoom } = useGameServer();
  const clearAllRoomStates = useNetworkStore((s) => s.clearAllRoomStates);
  const leavingRef = useRef(false);
  const joiningRef = useRef(false);  // one join at a time: overlapping joins break the SDK's Room Server connection

  // Position/animation stream. Returns false when nothing was sent, so the caller can retry.
  // Never send before the room connection is up (see the table above), and swallow rejections:
  // throttled calls are fire-and-forget.
  const updateCharacterState = useCallback(
    (characterState: Partial<MyCharacterState>): boolean => {
      if (leavingRef.current || !server.rsConnected) return false;
      server.remoteFunction("updateCharacterState", [{ ...characterState, updateTimestamp: Date.now() }], {
        throttle: 50, throttleTrailing: true, throttleKey: "updateCharacter",
      }).catch(() => {});
      return true;
    },
    [server]
  );

  // One-shot actions (attack, hit): unthrottled, with their own sequence number (see Pattern 6).
  const sendAction = useCallback(
    (action: MyActionType) => {
      if (leavingRef.current || !server.rsConnected) return;
      server.remoteFunction("updateCharacterState", [{ currentAction: action, actionSeq: Date.now() }])
        .catch(() => {});
    },
    [server]
  );

  // The server only picks the room; the SDK joins it (Gateway routing + Room Server connection).
  const findAndJoinRoom = useCallback(async () => {
    if (!connected || joiningRef.current) return null;
    joiningRef.current = true;
    try {
      const roomId: string = await server.remoteFunction("findRoom", []);
      await joinRoom(roomId);
      return roomId;
    } finally {
      joiningRef.current = false;
    }
  }, [connected, server, joinRoom]);

  const leaveCurrentRoom = useCallback(async () => {
    leavingRef.current = true;  // no new sync calls
    // Skipping calls does not cancel a trailing throttled call that is already scheduled (up to 50 ms
    // away): wait it out, so it cannot land after markLeaving and restore isPositionStable.
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Hide me from the others now (see Pattern 7); a failure here must not block leaving.
    await server.remoteFunction("markLeaving", []).catch(() => {});
    leaveRoom();  // synchronous: disconnects from the Room Server
    clearAllRoomStates();
    leavingRef.current = false;
  }, [server, leaveRoom, clearAllRoomStates]);

  // Room subscriptions need the Room Server connection and are not restored after a reconnect,
  // so they live in an effect that re-runs whenever rsConnected or the room changes.
  // Each subscription delivers the current value once on subscribe, so a late joiner sees the room immediately.
  useEffect(() => {
    if (!rsConnected || !currentRoomId) return;
    // Drop the previous room's players and fields; the snapshots below repopulate the store.
    useNetworkStore.getState().clearAllRoomStates();
    const unsub1 = server.subscribeRoomState(currentRoomId, (state) =>
      useNetworkStore.getState().setRoomState(state)
    );
    const unsub2 = server.subscribeRoomAllUserStates(currentRoomId, (states) =>
      states.forEach((s) => useNetworkStore.getState().setRoomUserState(s.account, s))
    );
    const unsub3 = server.onRoomUserLeave(currentRoomId, (account) => {
      useNetworkStore.getState().removeRoomUser(account);  // remove departed player from store
    });
    return () => { unsub1?.(); unsub2?.(); unsub3?.(); };
  }, [rsConnected, currentRoomId, server]);

  return { connected, rsConnected, currentRoomId, updateCharacterState, sendAction, findAndJoinRoom, leaveCurrentRoom };
};
```

Choose the screen from the SDK's own room record. A lost room — `leaveRoom()`, a Game Server drop (the SDK tears the room down with it and does not rejoin), or an admin close — sets `currentRoomId` back to null, so the player lands in the lobby and simply matches again:

```tsx
const { currentRoomId, rsConnected } = useGameServer();
if (!currentRoomId) return <Lobby />;              // findAndJoinRoom() from here
if (!rsConnected) return <div>Joining room…</div>; // Room Server connecting or reconnecting
```

---

## Pattern 4: Local Player Sync + Position Stability

Read position every frame, send only when changed beyond threshold.

**Position stability**: The local player starts with `isPositionStable: false`. After `STABLE_FRAME_COUNT` frames above a valid Y threshold, it flips to `true`. Remote clients use this flag to gate rendering and prevent flicker at origin (0,0,0). The flip itself triggers a send — a player who spawns and stands still would otherwise stay hidden — and the flag is sent again after every (re)join, because the server resets it (`onRoomJoin`, `markLeaving`).

```typescript
// Example: 3D physics with React Three Fiber + Rapier
const THRESHOLD = 0.01;
const STABLE_FRAME_COUNT = 30;
const lastSync = useRef({ position: [0, 0, 0], rotation: [0, 0, 0, 1], animation: "", stable: false });
const frameCount = useRef(0);
const isStable = useRef(false);
const { currentRoomId, rsConnected } = useGameServer();
// updateCharacterState comes from the session owner's useGameNetwork() — pass it down as a prop or
// context; calling the hook again here would run a second set of room subscriptions.

// After every (re)join and Room Server reconnect, send a full payload again: the server may have reset
// isPositionStable (onRoomJoin), and a throttled update flushed while the connection was down is lost.
useEffect(() => { if (rsConnected) lastSync.current.stable = false; }, [currentRoomId, rsConnected]);

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
    curAnim !== lastSync.current.animation ||
    isStable.current !== lastSync.current.stable;

  // Only remember what was actually sent: before rsConnected nothing goes out.
  if (changed && updateCharacterState({
    transform: { position: curPos, rotation: curRot },
    currentAnimation: curAnim,
    isGrounded,
    isPositionStable: isStable.current,
  })) {
    lastSync.current = { position: curPos, rotation: curRot, animation: curAnim, stable: isStable.current };
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
const hasTarget = useRef(false);

// Update interpolation targets when network state changes
useEffect(() => {
  if (!characterState?.transform) return;
  const [x, y, z] = characterState.transform.position;
  const [rx, ry, rz, rw] = characterState.transform.rotation as number[];
  targetPos.current.set(x, y, z);
  targetRot.current.set(rx, ry, rz, rw);
  if (!hasTarget.current) {
    // First transform: start there instead of sliding in from the origin
    currentPos.current.copy(targetPos.current);
    currentRot.current.copy(targetRot.current);
    hasTarget.current = true;
  }
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
// Replays when actionSeq changes — NOT on every state update (updateTimestamp changes ~20x a second
// while the player moves, and would restart the clip on every frame). The action already in state
// when this player mounts (late join, or the stability gate re-showing them) is old news: skip it.
const lastActionSeq = useRef(characterState?.actionSeq);
useEffect(() => {
  const seq = characterState?.actionSeq;
  if (seq === undefined || seq === lastActionSeq.current) return;
  lastActionSeq.current = seq;
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
}, [characterState?.currentAction, characterState?.actionSeq, actions, mixer]);
```

**Sending one-shot actions from local player:**

```typescript
// sendAction (Pattern 3) stamps a fresh actionSeq, so the same action can re-trigger (rapid attacks).
// It is NOT sent through the throttled updateCharacterState: the next frame's position payload would replace it.
sendAction("attack");
```

> **Key**: `currentAnimation` drives looping states; `currentAction` + `actionSeq` drives one-shot events. `actionSeq` changes only when an action is sent, so the same action string can replay while ordinary position updates never restart it. Unthrottled calls are rate-limited to 10 per second per function name — plenty for actions, never for the position stream.

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

The server never joins or leaves rooms — the client does, with `joinRoom`/`leaveRoom` from `useGameServer()`. The server picks a room and initializes each player in the `onRoomJoin` hook.

```typescript
// server/src/server.ts  (a root server.js holds the same class, without `export` and types)
export class Server {
  private MAX_ROOM_USERS = 8;

  // Matchmaking: RETURN a roomId; the client joins it with joinRoom(roomId).
  // Never name this joinRoom/leaveRoom — the SDK rejects those names in remoteFunction().
  async findRoom(): Promise<string> {
    for (const roomId of await $global.getAllRoomIds()) {
      if ((await $global.countRoomUsers(roomId)) < this.MAX_ROOM_USERS) return roomId;
    }
    return "room-" + Math.random().toString(16).substring(2, 10);
  }

  // Runs on the Room Server as each player enters. A player's room user state survives
  // leaving and rejoining a room that stayed alive, so reset per-match fields here.
  // isPositionStable: false until the client confirms a valid position.
  // Rejoining the SAME room within the 30 s grace after leaveRoom() counts as a reconnect and does
  // not run this hook; the client re-sends the flag on every (re)join (Pattern 4), so that case is covered.
  async onRoomJoin(roomId: string, account: string) {
    // Hook names are callable as remote functions too; in the real hook $sender.account is the joiner,
    // so this stops a client from resetting another player.
    if (account !== $sender.account) return;
    await $room.updateUserState(account, {
      characterState: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        isPositionStable: false,
      },
    });
  }

  // Relay partial character state update from client and broadcast to room.
  // State updates merge at the TOP LEVEL only, so the nested characterState is spread by hand.
  async updateCharacterState(updated: Partial<CharacterState>) {
    const prev = await $room.getMyState();
    await $room.updateMyState({ characterState: { ...prev.characterState, ...updated } });
  }

  // Called (awaited, unthrottled) right before the client's leaveRoom(): hides the leaver at once.
  async markLeaving() {
    const prev = await $room.getMyState();
    await $room.updateMyState({ characterState: { ...prev.characterState, isPositionStable: false } });
  }
}
```

> **Leaving is not instant.** A player who calls `leaveRoom()` — or whose network drops — stays in `$users` for a 30s grace period before `onRoomLeave` fires and the other clients get `onRoomUserLeave`; closing the tab removes them at once. To hide a deliberate leaver immediately, `leaveCurrentRoom` (Pattern 3) stops the local sync, waits out the throttle window — skipping calls does not cancel a trailing call that is already scheduled — and then awaits `markLeaving` before `leaveRoom()`. The rendering gate in Pattern 6 already skips players without a stable position. Do not use the throttled `updateCharacterState` itself for this: its trailing call can fire after `leaveRoom()` has closed the room connection, and is then lost.

---

## Performance Checklist

| Pattern | Why |
|---------|-----|
| `throttle: 50` + `throttleTrailing: true` + `throttleKey` | Caps to 20 updates/sec per entity, prevents server overload, and still delivers the final pose of each movement |
| Position threshold 0.01 | Skips trivial movements, reduces network traffic |
| `isPositionStable` gate | Prevents remote player flicker on spawn |
| `kinematicPosition` RigidBody (3D) | No physics sim overhead for remote players |
| `useNetworkStore.getState()` in callbacks | Avoids stale closure bugs in subscriptions |
| `useMemo` for `$users` → record lookup | O(1) access to remote player states |
| Subscribe in an effect keyed on `rsConnected` + `currentRoomId`, clear the store at its start, clean up in its return | Re-subscribes after a Room Server reconnect, never shows the previous room's players, prevents ghost subscriptions |
| No room call before `rsConnected` | A throttled function keeps the route of its first call for good |
| Lobby whenever `currentRoomId` is null, one join at a time | A lost room (leave, Game Server drop, admin close) returns the player to matchmaking; overlapping joins break the Room Server connection |
| `fadeIn/fadeOut(0.2)` on animation switch | Smooth crossfade — avoids jarring snaps between clips |
| `currentAction` + `actionSeq`, sent unthrottled | Replays repeated one-shot actions (rapid attacks) without restarting them on every position update |
| `LoopOnce` + `clampWhenFinished` on actions | One-shot clips freeze on last frame instead of snapping back |
