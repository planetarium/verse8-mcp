// P2 (top-down arena survival) requirement probes — design doc §4.2 / §5.2.
import { callQa, clickText, distXZ, hold, isVec, manual, qa, score, sleep, touchDrag, visibleText, waitQa } from "./lib.mjs";

const START = /^\s*(시작|start|play)\s*$/i;
const RETRY = /다시\s*하기|retry|restart|play again/i;
const P2_KEYS = ["state", "wave", "score", "hp", "enemiesAlive", "projectilesAlive", "player"];

async function startGame(page) {
  const clicked = await clickText(page, START);
  const r = await waitQa(page, (q) => q.state === "playing", 5000);
  return { clicked, ...r };
}

export async function probeP2(page, ctx) {
  const R = {};
  const loaded = await waitQa(page, () => true, 20000);
  const q0 = loaded.qa;
  const missing = q0 ? P2_KEYS.filter((k) => !(k in q0)) : P2_KEYS;
  R.R12 = score(!q0 ? 0 : missing.length === 0 && isVec(q0.player) ? 1 : 0.5, "auto", { present: !!q0, missing });
  const fns = { setInvincible: q0?.setInvincible === "fn", skipToWave: q0?.skipToWave === "fn" };
  R.R13 = score(fns.setInvincible && fns.skipToWave ? 1 : fns.setInvincible || fns.skipToWave ? 0.5 : 0, "auto", fns);
  const hook = !!q0 && isVec(q0.player);

  await ctx.shot("p2-title");
  const titleState = q0?.state;
  const s = await startGame(page);
  R.R9 = hook
    ? score(titleState === "title" && s.ok ? 1 : s.ok || s.clicked ? 0.5 : 0, "auto", { titleState, clicked: s.clicked })
    : score(s.clicked ? null : 0, s.clicked ? "vision/manual" : "auto", { clicked: s.clicked });
  if (!hook) {
    await ctx.shot("p2-after-start");
    for (const k of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10"]) R[k] = manual("no usable __qa hook");
    return R;
  }
  if (fns.setInvincible) await callQa(page, "setInvincible", true);
  await sleep(500);
  await ctx.shot("p2-playing");

  // R2 move + fire rate. Fire rate comes from audio starts and the
  // projectile count while the mouse is held.
  const a = await qa(page);
  await hold(page, "w", 1000);
  const b = await qa(page);
  const moved = distXZ(a.player, b.player);
  const vp = ctx.viewport;
  await page.mouse.move(vp.width * 0.75, vp.height * 0.5);
  const audio0 = await page.evaluate(() => window.__eval.audioStarts.length);
  await page.mouse.down();
  let maxProj = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    const q = await qa(page);
    maxProj = Math.max(maxProj, q?.projectilesAlive ?? 0);
    await sleep(50);
  }
  await page.mouse.up();
  const shotsPerSec = ((await page.evaluate(() => window.__eval.audioStarts.length)) - audio0) / 2;
  R.R2 = score(moved > 1 && maxProj > 0 ? (shotsPerSec >= 6 && shotsPerSec <= 10 ? 1 : 0.5) : moved > 1 || maxProj > 0 ? 0.5 : 0, "auto", {
    moved,
    maxProjectiles: maxProj,
    audioStartsPerSec: shotsPerSec,
    note: "fire rate inferred from shot sounds; bullets blocked by walls: manual",
  });
  R.R1 = manual("camera angle, square arena, 6 pillars: screenshot");
  R.R3 = manual("two enemy types and their behaviour: video");
  R.R5 = manual("hit flash, knockback, debris: video");
  R.R6 = manual("damage vignette, i-frames, heal drops: video");
  R.R7 = manual("HUD: screenshot");

  // R4: wave 5 can hold 40+ live enemies.
  let maxAlive = 0;
  let wave5 = false;
  if (fns.skipToWave) {
    await callQa(page, "skipToWave", 5);
    const t1 = Date.now();
    while (Date.now() - t1 < 12000) {
      const q = await qa(page);
      maxAlive = Math.max(maxAlive, q?.enemiesAlive ?? 0);
      if (q?.wave === 5) wave5 = true;
      await sleep(200);
    }
    await ctx.shot("p2-wave5");
  }
  R.R4 = fns.skipToWave ? score(wave5 && maxAlive >= 40 ? 1 : wave5 ? 0.5 : 0, "auto", { wave5, maxEnemiesAlive: maxAlive }) : manual("skipToWave missing");

  // R8: with invincibility off, standing still must end in game over.
  let lostOk = false;
  let resetQ = null;
  if (fns.setInvincible) {
    await callQa(page, "setInvincible", false);
    lostOk = (await waitQa(page, (q) => q.state === "lost", 60000, 250)).ok;
    await sleep(500);
    await ctx.shot("p2-lost");
    const retry = await visibleText(page, RETRY);
    await clickText(page, RETRY);
    let r = await waitQa(page, (q) => q.state === "playing" || q.state === "title", 4000);
    if (r.ok && r.qa.state === "title") r = await startGame(page);
    resetQ = r.qa;
    R.R8 = score(lostOk && retry && resetQ?.hp === 100 && resetQ?.wave === 1 ? 1 : lostOk ? 0.5 : 0, "auto", {
      lostReached: lostOk,
      retryVisible: retry,
      after: resetQ && { state: resetQ.state, hp: resetQ.hp, wave: resetQ.wave, score: resetQ.score },
      note: "victory screen: manual",
    });
  } else R.R8 = manual("setInvincible missing — cannot force the end states");

  R.R10 = await probeMobile(ctx);
  R.R11 = { score: null, method: "perf", note: "see perf block" };
  return R;
}

async function probeMobile(ctx) {
  const m = await ctx.openMobile();
  if (!m) return manual("mobile context failed to open");
  const { page, cdp } = m;
  try {
    await waitQa(page, () => true, 20000);
    await clickText(page, START);
    const ok = await waitQa(page, (q) => q.state === "playing", 4000);
    if (!ok.ok) return score(0, "auto", { note: "could not start on mobile" });
    await callQa(page, "setInvincible", true);
    const q0 = await qa(page);
    await touchDrag(page, cdp, { x: 80, y: 700 }, { x: 80, y: 620 }, 1000);
    const q1 = await qa(page);
    await ctx.shot("p2-mobile", page);
    const moved = distXZ(q0.player, q1.player);
    return score(moved > 0.5 ? null : 0, moved > 0.5 ? "auto+vision" : "auto", { joystickMoved: moved, note: "right aim/fire stick: manual" });
  } finally {
    await m.close();
  }
}

export async function probeP2Followups(page, ctx, step) {
  await waitQa(page, () => true, 20000);
  if (step === "F3") {
    await ctx.shot("p2-title-maps");
    return { F3: manual("second arena selectable on the title screen: screenshot p2-title-maps") };
  }
  await startGame(page);
  await callQa(page, "setInvincible", true);
  if (step === "F1") {
    await callQa(page, "skipToWave", 6);
    const r = await waitQa(page, (q) => q.wave === 6 && q.enemiesAlive >= 1, 8000);
    await sleep(1000);
    await ctx.shot("p2-boss");
    return { F1: score(r.ok ? null : 0, r.ok ? "auto+vision" : "auto", { wave6: r.ok, note: "boss HP bar and 3-way shots: vision" }) };
  }
  if (step === "F2") {
    await page.keyboard.press("Escape");
    await sleep(600);
    await ctx.shot("p2-pause");
    const items = [/계속|resume|continue/i, /다시\s*시작|restart/i, /그래픽|품질|quality/i, /효과음|볼륨|volume/i];
    let n = 0;
    for (const re of items) if (await visibleText(page, re)) n++;
    return { F2: score(n === 4 ? 1 : n >= 2 ? 0.5 : 0, "auto", { menuItemsVisible: n }) };
  }
  return {};
}
