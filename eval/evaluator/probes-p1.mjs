// P1 (3rd-person platformer) requirement probes — design doc §5.2.
// Every probe reads window.__qa; without the hook most of them return null
// ("hook missing, needs a human") rather than 0, and the report counts those.
import {
  callQa,
  clickText,
  dist,
  distXZ,
  hold,
  isVec,
  manual,
  qa,
  score,
  sleep,
  touchDrag,
  visibleText,
  waitQa,
} from "./lib.mjs";

const START = /^\s*(시작|start|play)\s*$/i;
const RETRY = /다시\s*하기|retry|restart|play again/i;
const P1_KEYS = ["state", "coins", "lives", "elapsedSec", "player", "grounded", "camera", "checkpoint", "goal", "coinPositions"];

function hookSchema(q) {
  if (!q) return { present: false, missing: P1_KEYS };
  const missing = P1_KEYS.filter((k) => !(k in q));
  const badVec = ["player", "camera", "checkpoint", "goal"].filter((k) => k in q && !isVec(q[k]));
  return { present: true, missing, badVec, teleport: q.teleport === "fn" };
}

const azimuth = (q) => (q && isVec(q.camera) && isVec(q.player) ? Math.atan2(q.camera.x - q.player.x, q.camera.z - q.player.z) : NaN);
const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

async function startGame(page) {
  const clicked = await clickText(page, START);
  const r = await waitQa(page, (q) => q.state === "playing", 5000);
  return { clicked, ...r };
}

// Track y over `ms` while optionally pressing Space again at the apex.
async function jumpTrace(page, ms, doubleTapAtMs) {
  const t0 = Date.now();
  const ys = [];
  await page.keyboard.press("Space");
  let tapped = false;
  while (Date.now() - t0 < ms) {
    const q = await qa(page);
    if (q && isVec(q.player)) ys.push(q.player.y);
    if (doubleTapAtMs && !tapped && Date.now() - t0 > doubleTapAtMs) {
      await page.keyboard.press("Space");
      tapped = true;
    }
    await sleep(30);
  }
  return ys;
}

export async function probeP1(page, ctx) {
  const R = {};
  const t = { audio: async () => page.evaluate(() => window.__eval.audioStarts.length) };

  const loaded = await waitQa(page, () => true, 20000);
  const schema = hookSchema(loaded.qa);
  R.R15 = schema.present
    ? score(schema.missing.length === 0 && schema.badVec.length === 0 ? 1 : 0.5, "auto", { schema })
    : score(0, "auto", { schema, note: "window.__qa missing — dependent probes need a human" });
  R.R16 = score(schema.teleport ? 1 : 0, "auto");
  const hook = schema.present && isVec(loaded.qa?.player);

  await ctx.shot("p1-title");
  const titleState = loaded.qa?.state;
  const s = await startGame(page);
  R.R11 = hook
    ? score(titleState === "title" && s.ok ? 1 : s.ok || s.clicked ? 0.5 : 0, "auto", { titleState, clicked: s.clicked })
    : score(s.clicked ? null : 0, s.clicked ? "vision/manual" : "auto", { clicked: s.clicked });
  if (!hook) {
    await ctx.shot("p1-after-start");
    for (const k of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R12", "R13"]) R[k] = manual("no usable __qa hook");
    return R;
  }
  await page.mouse.click(ctx.viewport.width / 2, ctx.viewport.height / 2).catch(() => {});
  await sleep(500);
  await ctx.shot("p1-playing");

  // R2 move + camera follow (R3 distance stability).
  let q0 = await qa(page);
  const camDist = [];
  await page.keyboard.down("w");
  for (let i = 0; i < 20; i++) {
    await sleep(50);
    const q = await qa(page);
    camDist.push(dist(q.camera, q.player));
  }
  await page.keyboard.up("w");
  let q1 = await qa(page);
  const moved = distXZ(q0.player, q1.player);
  const camStd = (() => {
    const v = camDist.filter(Number.isFinite);
    const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length || 1));
  })();

  // Rotate the camera with the mouse (drag, and raw moves for pointer lock).
  const az0 = azimuth(await qa(page));
  const c = { x: ctx.viewport.width / 2, y: ctx.viewport.height / 2 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + i * 30, c.y, { steps: 2 });
  await page.mouse.up();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + i * 30, c.y, { steps: 2 });
  await sleep(600);
  const qa1 = await qa(page);
  const az1 = azimuth(qa1);
  const rotated = angleDiff(az0, az1);

  // After rotating, W must move away from the camera (camera-relative).
  q0 = await qa(page);
  await hold(page, "w", 800);
  q1 = await qa(page);
  const mv = { x: q1.player.x - q0.player.x, z: q1.player.z - q0.player.z };
  const fwd = { x: q0.player.x - q0.camera.x, z: q0.player.z - q0.camera.z };
  const cos = (mv.x * fwd.x + mv.z * fwd.z) / (Math.hypot(mv.x, mv.z) * Math.hypot(fwd.x, fwd.z) || 1);

  // Jump: rise > 0.5 within 1 s, then grounded; a second press mid-air must
  // not add height.
  await sleep(500);
  const audioBeforeJump = await t.audio();
  const single = await jumpTrace(page, 1400);
  const audioJump = (await t.audio()) - audioBeforeJump;
  const groundedAfter = (await waitQa(page, (q) => q.grounded === true, 2000)).ok;
  await sleep(400);
  const dbl = await jumpTrace(page, 1600, 300);
  const rise = (ys) => (ys.length ? Math.max(...ys) - ys[0] : NaN);
  const r1 = rise(single), r2 = rise(dbl);
  const noDouble = Number.isFinite(r1) && Number.isFinite(r2) && r2 < r1 + 0.3;

  const moveOk = moved > 1 ? 1 : 0;
  const relOk = cos > 0.7 ? 1 : cos > 0.3 ? 0.5 : 0;
  const jumpOk = r1 > 0.5 && groundedAfter ? (noDouble ? 1 : 0.5) : 0;
  R.R2 = score(moveOk && relOk === 1 && jumpOk === 1 ? 1 : moveOk || jumpOk ? 0.5 : 0, "auto", {
    moved,
    cameraRelativeCos: cos,
    jumpRise: r1,
    doubleTapRise: r2,
    groundedAfter,
  });
  R.R3 = score(camStd < 1.5 && rotated > 0.2 ? 1 : camStd < 1.5 || rotated > 0.2 ? 0.5 : 0, "auto+vision", {
    cameraDistStd: camStd,
    rotatedRad: rotated,
    note: "occlusion handling needs a screenshot judgement",
  });
  R.R1 = manual("model + animation switching: judge p1-playing / video");
  R.R4 = manual("platform counts from the overview screenshot");
  R.R5 = manual("needs a moving platform position; __qa does not expose platforms");
  R.R6 = manual("checkpoint visual change");
  await ctx.shot("p1-after-moves");

  // R7 coins: teleport onto each, expect the count to rise and a sound.
  let q = await qa(page);
  const coinsAt = Array.isArray(q.coinPositions) ? q.coinPositions.filter(isVec) : [];
  const coins0 = q.coins;
  const audio0 = await t.audio();
  let picked = 0;
  for (const p of coinsAt.slice(0, 10)) {
    const before = (await qa(page)).coins;
    await callQa(page, "teleport", p.x, p.y + 0.2, p.z);
    const r = await waitQa(page, (x) => x.coins > before, 1500);
    if (r.ok) picked++;
  }
  q = await qa(page);
  const audioCoins = (await t.audio()) - audio0;
  const listShrank = Array.isArray(q.coinPositions) && q.coinPositions.length < coinsAt.length;
  // Coins already collected while walking count toward the 10 placed.
  const placed = (coins0 ?? 0) + coinsAt.length;
  const allPicked = coinsAt.length > 0 && picked === coinsAt.length;
  R.R7 = score(
    placed >= 10 && allPicked && q.coins === placed && audioCoins >= picked * 0.8 ? 1 : picked > 0 ? 0.5 : 0,
    "auto+vision",
    { coinsListed: coinsAt.length, placed, picked, coinsBefore: coins0, coinsAfter: q.coins, listShrank, audioStarts: audioCoins, hudText: await visibleText(page, /코인\s*\d+\s*\/\s*10/) },
  );
  await ctx.shot("p1-coins");

  // R8 fall: lives - 1 and respawn near the checkpoint (or start).
  q = await qa(page);
  const lives0 = q.lives;
  const respawnRef = q.checkpoint;
  await callQa(page, "teleport", q.player.x, -100, q.player.z);
  const fell = await waitQa(page, (x) => x.lives === lives0 - 1, 4000);
  await sleep(800);
  const qf = await qa(page);
  const nearCp = distXZ(qf.player, respawnRef) < 3 || distXZ(qf.player, qf.checkpoint) < 3;
  R.R8 = score(fell.ok && nearCp ? 1 : fell.ok ? 0.5 : 0, "auto", { livesBefore: lives0, livesAfter: qf.lives, distToCheckpoint: distXZ(qf.player, qf.checkpoint) });

  // R12: jump sound observed; shadows and sky are judged from screenshots.
  R.R12 = score(audioJump > 0 && audioCoins > 0 ? null : 0, audioJump > 0 && audioCoins > 0 ? "auto+vision" : "auto", {
    jumpAudioStarts: audioJump,
    coinAudioStarts: audioCoins,
    note: "shadows / sky / landing sound: vision",
  });

  // R9 goal → won with time + coin count on screen.
  q = await qa(page);
  await callQa(page, "teleport", q.goal.x, q.goal.y + 0.2, q.goal.z);
  const won = await waitQa(page, (x) => x.state === "won", 4000);
  await sleep(500);
  await ctx.shot("p1-won");
  const retryVisible = await visibleText(page, RETRY);
  R.R9 = score(won.ok && retryVisible ? 1 : won.ok ? 0.5 : 0, "auto+vision", { state: won.qa?.state, retryVisible, note: "time/coin text: vision" });

  // R10: retry → fall three times → lost → retry resets everything.
  await clickText(page, RETRY);
  let st = await waitQa(page, (x) => x.state === "playing", 4000);
  if (!st.ok) st = await startGame(page);
  for (let i = 0; i < 3; i++) {
    const cur = await qa(page);
    if (cur.state !== "playing") break;
    await callQa(page, "teleport", cur.player.x, -100, cur.player.z);
    await waitQa(page, (x) => x.lives < cur.lives || x.state === "lost", 4000);
    await sleep(600);
  }
  const lost = await waitQa(page, (x) => x.state === "lost", 3000);
  await ctx.shot("p1-lost");
  await clickText(page, RETRY);
  let reset = await waitQa(page, (x) => x.state === "playing" || x.state === "title", 4000);
  if (reset.ok && reset.qa.state === "title") {
    await startGame(page);
    reset = await waitQa(page, (x) => x.state === "playing", 4000);
  }
  const rq = reset.qa;
  const clean = rq && rq.coins === 0 && rq.lives === 3 && rq.state === "playing";
  R.R10 = score(lost.ok && clean ? 1 : lost.ok ? 0.5 : 0, "auto", { lostReached: lost.ok, after: rq && { state: rq.state, coins: rq.coins, lives: rq.lives } });

  R.R13 = await probeMobile(ctx);
  R.R14 = { score: null, method: "perf", note: "see perf block" };
  return R;
}

async function probeMobile(ctx) {
  const m = await ctx.openMobile();
  if (!m) return manual("mobile context failed to open");
  const { page, cdp } = m;
  try {
    await waitQa(page, () => true, 20000);
    await clickText(page, START);
    await page.touchscreen.tap(195, 300).catch(() => {});
    const ok = await waitQa(page, (q) => q.state === "playing", 4000);
    if (!ok.ok) return score(0, "auto", { note: "could not start on mobile" });
    const q0 = await qa(page);
    await touchDrag(page, cdp, { x: 80, y: 700 }, { x: 80, y: 620 }, 1000);
    const q1 = await qa(page);
    const moved = distXZ(q0.player, q1.player);
    await ctx.shot("p1-mobile", page);
    await page.setViewportSize({ width: 844, height: 390 });
    await sleep(800);
    await ctx.shot("p1-mobile-landscape", page);
    return score(moved > 0.5 ? null : 0, moved > 0.5 ? "auto+vision" : "auto", { joystickMoved: moved, note: "HUD layout after rotate: vision" });
  } finally {
    await m.close();
  }
}

// Follow-up probes run on the F1..F3 snapshots (new requirements only; the
// base probes above are rerun for regressions).
export async function probeP1Followups(page, ctx, step) {
  await waitQa(page, () => true, 20000);
  await startGame(page);
  if (step === "F1") {
    const q = await qa(page);
    return { F1: score(q && typeof q.enemiesAlive === "number" ? (q.enemiesAlive >= 2 ? 1 : 0.5) : 0, "auto+manual", { enemiesAlive: q?.enemiesAlive, note: "stomp vs side hit: manual" }) };
  }
  if (step === "F2") {
    await page.keyboard.press("Escape");
    await sleep(600);
    await ctx.shot("p1-pause");
    const items = [/계속|resume|continue/i, /다시\s*시작|restart/i, /그래픽|품질|quality/i, /효과음|볼륨|volume/i];
    const seen = [];
    for (const re of items) seen.push(await visibleText(page, re));
    const n = seen.filter(Boolean).length;
    return { F2: score(n === 4 ? 1 : n >= 2 ? 0.5 : 0, "auto", { menuItemsVisible: n }) };
  }
  if (step === "F3") {
    const q = await qa(page);
    if (!q?.goal) return { F3: manual("no goal in __qa") };
    await callQa(page, "teleport", q.goal.x, q.goal.y + 0.2, q.goal.z);
    await sleep(2500);
    const after = await qa(page);
    await ctx.shot("p1-after-level1");
    const level2 = await visibleText(page, /레벨\s*2|level\s*2/i);
    return { F3: score(level2 || after?.state === "playing" ? null : 0, "auto+manual", { stateAfterGoal: after?.state, level2Text: level2 }) };
  }
  return {};
}
