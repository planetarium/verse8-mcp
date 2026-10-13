// Injected with page.addInitScript before any game code runs. Engine-agnostic:
// it only wraps browser APIs, so every arm carries the same instrumentation.
(() => {
  const E = (window.__eval = {
    gl: null,
    frames: [], // [t, drawCalls, vertices] per animation frame
    drawCalls: 0,
    vertices: 0,
    audioStarts: [],
    errors: [],
    recording: false,
  });

  const countDraw = (count, instances) => {
    E.drawCalls++;
    E.vertices += (count || 0) * (instances || 1);
  };
  for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    const p = Ctx.prototype;
    const wrap = (name, fn) => {
      const orig = p[name];
      if (!orig) return;
      p[name] = function (...a) {
        fn(a);
        return orig.apply(this, a);
      };
    };
    wrap("drawArrays", (a) => countDraw(a[2], 1));
    wrap("drawElements", (a) => countDraw(a[1], 1));
    wrap("drawArraysInstanced", (a) => countDraw(a[2], a[3]));
    wrap("drawElementsInstanced", (a) => countDraw(a[1], a[4]));
  }
  // Record which GPU the page actually got — SwiftShader means FPS is noise.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGetContext.call(this, type, ...rest);
    if (ctx && !E.gl && /webgl/.test(String(type))) {
      try {
        const ext = ctx.getExtension("WEBGL_debug_renderer_info");
        E.gl = {
          type,
          vendor: ext ? ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL) : ctx.getParameter(ctx.VENDOR),
          renderer: ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER),
        };
      } catch {
        E.gl = { type, vendor: "?", renderer: "?" };
      }
    }
    return ctx;
  };

  const audio = (kind) => E.audioStarts.push({ t: performance.now(), kind });
  if (window.AudioScheduledSourceNode) {
    const orig = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...a) {
      audio(this.constructor && this.constructor.name);
      return orig.apply(this, a);
    };
  }
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    audio("HTMLMediaElement");
    return origPlay.apply(this, a);
  };

  // Automated pages cannot take a real pointer lock (WrongDocumentError), which
  // would count as a game exception and freeze mouse-look cameras. Grant it
  // virtually; mouse moves still carry movementX/Y.
  let locked = null;
  Object.defineProperty(Document.prototype, "pointerLockElement", { configurable: true, get: () => locked });
  Element.prototype.requestPointerLock = function () {
    locked = this;
    setTimeout(() => document.dispatchEvent(new Event("pointerlockchange")), 0);
    return Promise.resolve();
  };
  Document.prototype.exitPointerLock = function () {
    locked = null;
    setTimeout(() => document.dispatchEvent(new Event("pointerlockchange")), 0);
  };
  E.pointerLockShim = true;

  window.addEventListener("error", (e) => E.errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => E.errors.push(String(e.reason)));

  // Our own rAF loop measures frame pacing and per-frame draw totals.
  const tick = (t) => {
    if (E.recording) E.frames.push([t, E.drawCalls, E.vertices]);
    E.drawCalls = 0;
    E.vertices = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  E.start = () => {
    E.frames = [];
    E.recording = true;
  };
  E.stop = () => {
    E.recording = false;
    const f = E.frames;
    const dt = [];
    for (let i = 1; i < f.length; i++) dt.push(f[i][0] - f[i - 1][0]);
    const sorted = [...dt].sort((a, b) => a - b);
    const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
    const worst1 = sorted.slice(Math.floor(sorted.length * 0.99));
    const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const draws = f.map((x) => x[1]).sort((a, b) => a - b);
    const verts = f.map((x) => x[2]).sort((a, b) => a - b);
    const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
    return {
      frames: f.length,
      fpsMedian: q(0.5) ? 1000 / q(0.5) : null,
      fps1pctLow: worst1.length ? 1000 / mean(worst1) : null,
      frameTimeP95: q(0.95),
      drawCallsMedian: med(draws),
      drawCallsMax: draws.length ? draws[draws.length - 1] : null,
      verticesMedian: med(verts),
    };
  };
})();
