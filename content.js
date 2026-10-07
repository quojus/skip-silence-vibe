// Läuft in jeder Seite und jedem Frame. Hängt sich an <video>/<audio>, misst den Pegel
// per AudioWorklet und steuert playbackRate und Lautstärke.
(() => {
  if (globalThis.__ssContentLoaded) return;
  globalThis.__ssContentLoaded = true;

  const C = SS.DETECTOR;
  const MEDIA_EVENTS = ["play", "playing", "pause", "seeking", "seeked", "waiting", "ended", "emptied"];
  const RATE_MIN = 0.25;
  const RATE_MAX = 16;
  const MIN_FADE_S = 0.005;
  const FADE_POINTS = 64;
  const RESUME_TIMEOUT_MS = 300;

  let state = { enabled: false, values: SS.clampValues(), rev: -1 };
  const controllers = new Map(); // HTMLMediaElement → MediaController
  const known = new Set(); // alle gesehenen Medienelemente
  const unsupported = new WeakSet();
  let frameRegistered = false;
  let pendingSavedMs = 0;
  let flushTimer = null;

  let ctx = null;
  let workletReady = null;

  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getContext() {
    if (!ctx) {
      ctx = new AudioContext();
      workletReady = ctx.audioWorklet.addModule(browser.runtime.getURL("volume-processor.js"));
    }
    return ctx;
  }

  // Ein AudioContext ohne Nutzergeste kann "suspended" bleiben. Ein angehängtes Medium
  // wäre dann stumm – deshalb erst anhängen, wenn der Kontext läuft.
  const gestureWaiters = new Set();
  function onNextGesture(fn) {
    gestureWaiters.add(fn);
    if (gestureWaiters.size > 1) return;
    const fire = () => {
      document.removeEventListener("pointerdown", fire, true);
      document.removeEventListener("keydown", fire, true);
      const fns = [...gestureWaiters];
      gestureWaiters.clear();
      if (ctx) ctx.resume().catch(() => {});
      fns.forEach((f) => f());
    };
    document.addEventListener("pointerdown", fire, true);
    document.addEventListener("keydown", fire, true);
  }

  async function ensureRunning() {
    const c = getContext();
    if (c.state !== "running") {
      await Promise.race([c.resume().catch(() => {}), sleep(RESUME_TIMEOUT_MS)]);
    }
    return c.state === "running";
  }

  // createMediaElementSource geht nur einmal pro Element – Graph dauerhaft cachen
  const graphs = new WeakMap();
  function getGraph(el) {
    let graph = graphs.get(el);
    if (!graph) {
      graph = (async () => {
        const c = getContext();
        await workletReady;
        const source = c.createMediaElementSource(el);
        const worklet = new AudioWorkletNode(c, "volume-processor");
        const delay = c.createDelay(1);
        const gain = c.createGain();
        source.connect(worklet);
        worklet.connect(delay);
        delay.connect(gain);
        gain.connect(c.destination);
        return { worklet, delay, gain };
      })();
      graphs.set(el, graph);
      graph.catch(() => graphs.delete(el));
    }
    return graph;
  }

  /** Fremde Quelle ohne CORS: Firefox würde den Ton nach dem Anhängen stummschalten. */
  function isUnsupported(el) {
    const src = el.currentSrc || el.src;
    if (!src) return false;
    let url;
    try {
      url = new URL(src, location.href);
    } catch {
      return false;
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return false;
    if (url.origin === location.origin) return false;
    return el.crossOrigin === null;
  }

  function mediaStateOf(el) {
    if (el.paused || el.ended) return "paused";
    if (el.seeking) return "seeking";
    return "playing";
  }

  class MediaController {
    constructor(el) {
      this.el = el;
      this.graph = null;
      this.active = false;
      this.connected = false;
      this.detector = new SS.Detector(() => state.values);
      this.mediaState = mediaStateOf(el);
      this.ownRate = el.playbackRate;
      this.origRate = null;
      this.ramp = null;
      this.lastSample = null;
      el.addEventListener("ratechange", () => this.onRateChange());
    }

    get values() {
      return state.values;
    }

    lookaheadOn() {
      return this.values.lookahead && this.values.muteSilence;
    }

    async start() {
      if (this.active) return;
      this.active = true;
      this.origRate = this.el.playbackRate;
      this.mediaState = mediaStateOf(this.el);
      this.detector = new SS.Detector(() => state.values);
      this.setRate(this.values.normalSpeed);
      await this.connect();
    }

    async connect() {
      if (!this.active || this.connected) return;
      if (!(await ensureRunning())) {
        onNextGesture(() => this.connect());
        return;
      }
      try {
        await this.attach();
      } catch (err) {
        console.warn("[Skip Silence] Audio-Analyse nicht möglich", err);
        return;
      }
      if (!this.active || this.connected) return;
      this.connected = true;
      this.graph.delay.delayTime.value = this.lookaheadOn() ? C.LOOKAHEAD_S : 0;
      this.setGainNow(1);
      this.graph.worklet.port.postMessage(true);
    }

    async attach() {
      this.graph = await getGraph(this.el);
      this.graph.worklet.port.onmessage = (e) => this.onRms(e.data);
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      this.connected = false;
      this.ramp = null;
      this.lastSample = null;
      if (this.graph) {
        this.graph.worklet.port.postMessage(false);
        this.graph.delay.delayTime.value = 0;
        this.setGainNow(1);
      }
      this.setRate(this.origRate ?? 1, true);
    }

    /** Werte haben sich geändert, während der Controller läuft. */
    refresh() {
      if (!this.active) return;
      const v = this.values;
      this.ramp = null;
      if (this.graph && this.connected) {
        this.graph.delay.delayTime.value = this.lookaheadOn() ? C.LOOKAHEAD_S : 0;
      }
      const silent = this.detector.phase === "silence" && this.mediaState === "playing";
      this.setRate(silent ? v.silenceSpeed : v.normalSpeed);
      this.setGainNow(silent && v.muteSilence ? 0 : 1);
    }

    onMediaEvent(type) {
      if (type === "play" || type === "playing") this.mediaState = "playing";
      else if (type === "seeking") this.mediaState = "seeking";
      else if (type === "waiting") this.mediaState = "waiting";
      else if (type === "seeked") this.mediaState = this.el.paused ? "paused" : "playing";
      else this.mediaState = "paused"; // pause, ended, emptied

      if (type === "pause" || type === "ended" || type === "emptied") {
        // Sofort zurück auf Normal, damit nach dem Play garantiert Ton da ist
        this.ramp = null;
        if (this.active) this.setRate(this.values.normalSpeed);
        this.setGainNow(1);
      }
    }

    onRms({ rms, frames }) {
      if (!this.active || !ctx) return;
      const v = this.values;
      const windowMs = (frames / ctx.sampleRate) * 1000;
      const levelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const res = this.detector.update({ windowMs, levelDb, mediaState: this.mediaState });

      if (res.changed) this.onPhase(res);
      this.advanceRamp(windowMs);

      const playing = this.mediaState === "playing";
      if (playing && res.phase === "silence") {
        pendingSavedMs += windowMs * Math.max(0, this.ownRate / v.normalSpeed - 1);
      }
      this.lastSample = { ...res, playing };
    }

    onPhase(res) {
      const v = this.values;
      if (res.phase === "silence") {
        this.startRamp(v.silenceSpeed, v.rampIn);
        if (v.muteSilence) this.fadeGain(0, v.rampIn.durationMs / 1000, v.rampIn.bezier, 0);
      } else if (res.instant) {
        this.ramp = null;
        this.setRate(v.normalSpeed);
        this.setGainNow(1);
      } else {
        this.startRamp(v.normalSpeed, v.rampOut);
        if (v.muteSilence) {
          const la = this.lookaheadOn();
          const dur = v.rampOut.durationMs / 1000;
          this.fadeGain(
            1,
            la ? Math.min(dur, C.UNMUTE_LEAD_S) : dur,
            v.rampOut.bezier,
            la ? C.LOOKAHEAD_S - C.UNMUTE_LEAD_S : 0,
          );
        }
      }
    }

    startRamp(to, ramp) {
      if (ramp.durationMs <= 0) {
        this.ramp = null;
        this.setRate(to);
        return;
      }
      this.ramp = { from: this.ownRate, to, elapsed: 0, duration: ramp.durationMs, bezier: ramp.bezier };
    }

    advanceRamp(windowMs) {
      const r = this.ramp;
      if (!r) return;
      r.elapsed += windowMs;
      const p = Math.min(1, r.elapsed / r.duration);
      this.setRate(r.from + (r.to - r.from) * SS.bezierY(r.bezier, p));
      if (p >= 1) this.ramp = null;
    }

    setRate(rate, force = false) {
      const r = clamp(rate, RATE_MIN, RATE_MAX);
      this.ownRate = r;
      if (force || Math.abs(this.el.playbackRate - r) > 1e-4) this.el.playbackRate = r;
    }

    onRateChange() {
      // Fremde Änderungen (z. B. Geschwindigkeitsmenü der Seite) überschreiben
      if (this.active && Math.abs(this.el.playbackRate - this.ownRate) > 1e-3) {
        this.el.playbackRate = this.ownRate;
      }
    }

    setGainNow(value) {
      if (!this.graph || !ctx) return;
      const g = this.graph.gain.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(value, ctx.currentTime);
    }

    fadeGain(target, durationS, bezier, delayS) {
      if (!this.graph || !ctx) return;
      const g = this.graph.gain.gain;
      const now = ctx.currentTime;
      const start = g.value;
      const ys = SS.sampleBezier(bezier, FADE_POINTS);
      const curve = ys.map((y) => clamp(start + (target - start) * y, 0, 1));
      curve[curve.length - 1] = target;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(start, now);
        g.setValueCurveAtTime(curve, now + delayS, Math.max(durationS, MIN_FADE_S));
      } catch {
        g.cancelScheduledValues(now);
        g.setTargetAtTime(target, now + delayS, Math.max(durationS, MIN_FADE_S) / 3);
      }
    }
  }

  function noteMedia(el) {
    known.add(el);
    if (!frameRegistered) {
      frameRegistered = true;
      browser.runtime.sendMessage({ type: "registerFrame" }).catch(() => {});
    }
  }

  function getController(el) {
    let ctrl = controllers.get(el);
    if (ctrl) return ctrl;
    if (isUnsupported(el)) {
      unsupported.add(el);
      return null;
    }
    unsupported.delete(el);
    ctrl = new MediaController(el);
    controllers.set(el, ctrl);
    return ctrl;
  }

  function prune() {
    for (const el of known) {
      if (el.isConnected || !el.paused) continue;
      known.delete(el);
      const ctrl = controllers.get(el);
      if (ctrl) ctrl.stop();
      controllers.delete(el);
    }
  }

  function onDocumentMediaEvent(e) {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement)) return;
    noteMedia(el);
    if (!state.enabled) return;
    const ctrl = getController(el);
    if (!ctrl) return;
    if (e.type === "play" && ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    if (!ctrl.active && (e.type === "play" || e.type === "playing")) ctrl.start();
    ctrl.onMediaEvent(e.type);
  }

  for (const type of MEDIA_EVENTS) document.addEventListener(type, onDocumentMediaEvent, true);

  function flushSaved() {
    if (pendingSavedMs < 50) return;
    const seconds = pendingSavedMs / 1000;
    pendingSavedMs = 0;
    browser.runtime.sendMessage({ type: "addSaved", seconds }).catch(() => {});
  }

  function applyState(next) {
    if (!next || typeof next.rev !== "number" || next.rev < state.rev) return;
    const wasEnabled = state.enabled;
    state = { enabled: !!next.enabled, values: SS.clampValues(next.values), rev: next.rev };

    if (state.enabled && !wasEnabled) {
      if (!flushTimer) flushTimer = setInterval(flushSaved, 1000);
      for (const el of document.querySelectorAll("video, audio")) {
        noteMedia(el);
        if (el.paused) continue;
        const ctrl = getController(el);
        if (ctrl) ctrl.start();
      }
    } else if (!state.enabled && wasEnabled) {
      for (const ctrl of controllers.values()) ctrl.stop();
      flushSaved();
    } else if (state.enabled) {
      for (const ctrl of controllers.values()) ctrl.refresh();
    }
  }

  function levelInfo() {
    prune();
    for (const el of document.querySelectorAll("video, audio")) known.add(el);
    let best = null;
    let unsupportedCount = 0;
    for (const el of known) {
      if (unsupported.has(el) || (state.enabled && !controllers.has(el) && isUnsupported(el))) {
        unsupportedCount++;
      }
      const s = controllers.get(el)?.lastSample;
      if (!s) continue;
      if (!best || (s.playing && !best.playing) || (s.playing === best.playing && s.levelDb > best.levelDb)) {
        best = s;
      }
    }
    return {
      mediaCount: known.size,
      unsupportedCount,
      playing: best ? best.playing : false,
      levelDb: best ? best.levelDb : null,
      thresholdDb: best ? best.thresholdDb : null,
      phase: best ? best.phase : null,
    };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return undefined;
    if (msg.type === "applyState") applyState(msg.state);
    else if (msg.type === "getLevel") return Promise.resolve(levelInfo());
    return undefined;
  });

  browser.runtime
    .sendMessage({ type: "getTabState" })
    .then(applyState)
    .catch(() => {});
})();
