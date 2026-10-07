// Läuft in jeder Seite und jedem Frame. Hängt sich an <video>/<audio>, misst den Pegel
// per AudioWorklet und steuert playbackRate und Lautstärke.
(() => {
  if (globalThis.__ssContentLoaded) return;
  globalThis.__ssContentLoaded = true;

  const C = SS.DETECTOR;
  const MEDIA_EVENTS = [
    "loadstart",
    "play",
    "playing",
    "pause",
    "seeking",
    "seeked",
    "waiting",
    "ended",
    "emptied",
  ];
  const RATE_MIN = 0.25;
  const RATE_MAX = 16;
  const MIN_FADE_S = 0.005;
  const FADE_SEGMENTS = 16; // Kurve als Folge linearer Rampen – lässt sich jederzeit abbrechen
  const DELAY_SWITCH_S = 0.01; // Ausblenden um einen Wechsel der Verzögerung
  const SILENT_INPUT_MS = 5000; // so lange exakt 0 beim Abspielen → Warnung im Popup
  const MAINTENANCE_MS = 1000;
  const LINEAR = [0, 0, 1, 1];

  let state = { enabled: false, values: SS.clampValues(), rev: -1 };
  const controllers = new Map(); // HTMLMediaElement → MediaController
  const known = new Set(); // alle gesehenen Medienelemente
  const unsupported = new WeakSet();
  const directlyWatched = new WeakSet();
  let pendingSavedMs = 0;
  let maintenanceTimer = null;

  let ctx = null;
  let workletReady = null;
  const waitingForContext = new Set();

  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

  // ---------- AudioContext ----------

  function getContext() {
    if (!ctx) {
      ctx = new AudioContext();
      workletReady = ctx.audioWorklet.addModule(browser.runtime.getURL("volume-processor.js"));
      workletReady.catch((err) => console.warn("[Skip Silence] AudioWorklet nicht ladbar", err));
      ctx.addEventListener("statechange", () => {
        if (ctx.state === "running") connectWaiting();
      });
    }
    return ctx;
  }

  function connectWaiting() {
    const list = [...waitingForContext];
    waitingForContext.clear();
    for (const ctrl of list) ctrl.connect();
  }

  // Ohne Nutzergeste kann ein AudioContext "suspended" bleiben. Ein angehängtes Medium wäre
  // dann stumm – deshalb erst anhängen, wenn der Kontext läuft (statechange → connectWaiting).
  let gestureArmed = false;
  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    const fire = () => {
      document.removeEventListener("pointerdown", fire, true);
      document.removeEventListener("keydown", fire, true);
      gestureArmed = false;
      if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    };
    document.addEventListener("pointerdown", fire, true);
    document.addEventListener("keydown", fire, true);
  }

  /** true, wenn der Kontext läuft; sonst wird ein Start angestoßen. */
  function requestRunning() {
    const c = getContext();
    if (c.state === "running") return true;
    c.resume()
      .then(() => {
        if (c.state === "running") connectWaiting();
      })
      .catch(() => {});
    armGesture();
    return false;
  }

  // ---------- Audio-Graph ----------

  // createMediaElementSource geht nur einmal pro Element – Graph dauerhaft cachen.
  // Die Quelle wird als letzter Schritt erzeugt: Scheitert vorher etwas, bleibt das Element unberührt.
  const graphs = new WeakMap();
  function getGraph(el) {
    let graph = graphs.get(el);
    if (!graph) {
      graph = (async () => {
        let sourceCreated = false;
        try {
          const c = getContext();
          await workletReady;
          const worklet = new AudioWorkletNode(c, "volume-processor");
          const delay = c.createDelay(1);
          const gain = c.createGain();
          worklet.connect(delay);
          delay.connect(gain);
          gain.connect(c.destination);
          const source = c.createMediaElementSource(el);
          sourceCreated = true;
          source.connect(worklet);
          return { worklet, delay, gain };
        } catch (err) {
          // Erst nach createMediaElementSource ist das Element dauerhaft gebunden
          if (!sourceCreated) graphs.delete(el);
          throw err;
        }
      })();
      graphs.set(el, graph);
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

  // ---------- Steuerung pro Element ----------

  class MediaController {
    constructor(el) {
      this.el = el;
      this.graph = null;
      this.active = false; // eingeschaltet (evtl. wartend auf AudioContext)
      this.connected = false; // Messung läuft, Extension steuert Rate und Lautstärke
      this.attaching = false;
      this.detector = new SS.Detector(() => state.values);
      this.mediaState = mediaStateOf(el);
      this.ownRate = el.playbackRate;
      this.origRate = null;
      this.ramp = null;
      this.gainPlan = { t0: 0, from: 1, to: 1, dur: 0, bezier: LINEAR };
      this.delayOn = false;
      this.lastSample = null;
      this.zeroMs = 0;
      this.tainted = false;
      el.addEventListener("ratechange", () => this.onRateChange());
    }

    get values() {
      return state.values;
    }

    lookaheadOn() {
      return this.values.lookahead && this.values.muteSilence;
    }

    start() {
      if (this.active) return;
      this.active = true;
      this.connect();
    }

    connect() {
      if (!this.active || this.connected || this.attaching) return;
      if (!requestRunning()) {
        waitingForContext.add(this);
        return;
      }
      this.attachAndRun();
    }

    async attachAndRun() {
      this.attaching = true;
      try {
        this.graph = await getGraph(this.el);
      } catch (err) {
        console.warn("[Skip Silence] Audio-Analyse nicht möglich", err);
        return;
      } finally {
        this.attaching = false;
      }
      if (!this.active || this.connected) return;
      this.connected = true;
      this.origRate = this.el.playbackRate;
      this.mediaState = mediaStateOf(this.el);
      this.detector = new SS.Detector(() => state.values);
      this.ramp = null;
      this.zeroMs = 0;
      this.graph.worklet.port.onmessage = (e) => this.onRms(e.data);
      this.setGain(1, 0);
      this.setDelay(this.lookaheadOn(), 1);
      this.setRate(this.values.normalSpeed);
      this.graph.worklet.port.postMessage(true);
    }

    stop() {
      waitingForContext.delete(this);
      if (!this.active) return;
      this.active = false;
      const wasConnected = this.connected;
      this.connected = false;
      this.ramp = null;
      this.lastSample = null;
      if (!wasConnected) return;
      try {
        this.graph.worklet.port.postMessage(false);
        if (!this.setDelay(false, 1)) this.setGain(1, DELAY_SWITCH_S);
      } catch (err) {
        console.warn("[Skip Silence] Zurücksetzen der Audio-Kette fehlgeschlagen", err);
      } finally {
        this.setRate(this.origRate ?? 1, true);
      }
    }

    /** Werte haben sich geändert: Ziele anpassen, ohne laufende Übergänge hart abzubrechen. */
    refresh() {
      if (!this.connected) return;
      const v = this.values;
      const silent = this.detector.phase === "silence" && this.mediaState === "playing";
      const phaseRamp = silent ? v.rampIn : v.rampOut;
      const targetRate = silent ? v.silenceSpeed : v.normalSpeed;
      const targetGain = silent && v.muteSilence ? 0 : 1;

      const switched = this.setDelay(this.lookaheadOn(), targetGain);
      if (!switched && Math.abs(this.gainPlan.to - targetGain) > 1e-6) {
        this.setGain(targetGain, phaseRamp.durationMs / 1000, phaseRamp.bezier);
      }
      if (this.ramp) this.ramp.to = targetRate;
      else if (Math.abs(this.ownRate - targetRate) > 1e-4) this.startRamp(targetRate, phaseRamp);
    }

    onMediaEvent(type) {
      if (type === "play" || type === "playing") this.mediaState = "playing";
      else if (type === "seeking") this.mediaState = "seeking";
      else if (type === "waiting") this.mediaState = "waiting";
      else if (type === "seeked" || type === "loadstart") this.mediaState = mediaStateOf(this.el);
      else this.mediaState = "paused"; // pause, ended, emptied

      if (type === "loadstart" || type === "emptied") {
        // Neue Quelle im selben Element: ist sie fremd, liefert die Kette nur noch Stille
        this.tainted = graphs.has(this.el) && isUnsupported(this.el);
        this.zeroMs = 0;
      }

      if (this.mediaState !== "playing") {
        // Pause, Spulen, Puffern: sofort zurück auf Normal, damit danach garantiert Ton da ist
        this.ramp = null;
        if (this.connected) {
          this.setRate(this.values.normalSpeed);
          this.setGain(1, 0);
        }
      }
    }

    onRms({ rms, frames }) {
      if (!this.connected || !ctx) return;
      const v = this.values;
      const windowMs = (frames / ctx.sampleRate) * 1000;
      const levelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const playing = this.mediaState === "playing";
      const res = this.detector.update({ windowMs, levelDb, mediaState: this.mediaState });

      if (res.changed) this.onPhase(res);
      this.advanceRamp(windowMs);

      if (playing && res.phase === "silence") {
        pendingSavedMs += windowMs * Math.max(0, this.ownRate / v.normalSpeed - 1);
      }
      if (playing) this.zeroMs = rms === 0 ? this.zeroMs + windowMs : 0;
      this.lastSample = { ...res, playing };
    }

    onPhase(res) {
      const v = this.values;
      if (res.phase === "silence") {
        this.startRamp(v.silenceSpeed, v.rampIn);
        if (v.muteSilence) this.setGain(0, v.rampIn.durationMs / 1000, v.rampIn.bezier);
      } else if (res.instant) {
        this.ramp = null;
        this.setRate(v.normalSpeed);
        this.setGain(1, 0);
      } else {
        this.startRamp(v.normalSpeed, v.rampOut);
        const dur = v.rampOut.durationMs / 1000;
        if (v.muteSilence && this.lookaheadOn()) {
          // Einblenden so planen, dass es kurz vor dem verzögerten Ton fertig ist
          this.setGain(1, Math.min(dur, C.UNMUTE_LEAD_S), v.rampOut.bezier, C.LOOKAHEAD_S - C.UNMUTE_LEAD_S);
        } else if (this.gainPlan.to !== 1) {
          this.setGain(1, dur, v.rampOut.bezier);
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
      if (this.connected && Math.abs(this.el.playbackRate - this.ownRate) > 1e-3) {
        this.el.playbackRate = this.ownRate;
      }
    }

    /** Geplanter Lautstärkewert zur AudioContext-Zeit t (eigene Buchführung, kein Auslesen). */
    gainAt(t) {
      const p = this.gainPlan;
      if (t <= p.t0) return p.from;
      if (p.dur <= 0 || t >= p.t0 + p.dur) return p.to;
      return p.from + (p.to - p.from) * SS.bezierY(p.bezier, (t - p.t0) / p.dur);
    }

    /** Lautstärke ab jetzt (+delayS) über durS entlang der Kurve auf target bringen. */
    setGain(target, durS, bezier = LINEAR, delayS = 0) {
      if (!this.graph || !ctx) return;
      const g = this.graph.gain.gain;
      const now = ctx.currentTime;
      const from = clamp(this.gainAt(now), 0, 1);
      const t0 = now + delayS;
      const dur = durS > 0 ? Math.max(durS, MIN_FADE_S) : 0;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(from, now);
        if (dur === 0) {
          g.setValueAtTime(target, t0);
        } else {
          if (delayS > 0) g.setValueAtTime(from, t0);
          for (let i = 1; i <= FADE_SEGMENTS; i++) {
            const y = SS.bezierY(bezier, i / FADE_SEGMENTS);
            g.linearRampToValueAtTime(clamp(from + (target - from) * y, 0, 1), t0 + (dur * i) / FADE_SEGMENTS);
          }
        }
        this.gainPlan = { t0, from, to: target, dur, bezier };
      } catch (err) {
        console.warn("[Skip Silence] Lautstärke-Automation fehlgeschlagen", err);
        try {
          g.cancelScheduledValues(0);
          g.value = target;
        } catch {
          // nichts mehr zu retten
        }
        this.gainPlan = { t0: now, from: target, to: target, dur: 0, bezier: LINEAR };
      }
    }

    /**
     * Verzögerung (Lookahead) umschalten. Ein harter Sprung der Delay-Zeit würde Ton
     * wiederholen oder verschlucken – deshalb kurz ausblenden, umschalten, auf targetGain einblenden.
     * Liefert true, wenn umgeschaltet wurde.
     */
    setDelay(on, targetGain) {
      if (!this.graph || !ctx || on === this.delayOn) return false;
      this.delayOn = on;
      const g = this.graph.gain.gain;
      const d = this.graph.delay.delayTime;
      const now = ctx.currentTime;
      const from = clamp(this.gainAt(now), 0, 1);
      const S = DELAY_SWITCH_S;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(from, now);
        g.linearRampToValueAtTime(0, now + S);
        d.cancelScheduledValues(now);
        d.setValueAtTime(on ? C.LOOKAHEAD_S : 0, now + S);
        g.linearRampToValueAtTime(targetGain, now + 2 * S);
        this.gainPlan = { t0: now + S, from: 0, to: targetGain, dur: S, bezier: LINEAR };
      } catch (err) {
        console.warn("[Skip Silence] Umschalten der Verzögerung fehlgeschlagen", err);
        this.setGain(targetGain, 0);
      }
      return true;
    }
  }

  // ---------- Medien finden ----------

  function noteMedia(el) {
    if (known.has(el)) return;
    known.add(el);
    browser.runtime.sendMessage({ type: "registerFrame" }).catch(() => {});
  }

  function getController(el) {
    let ctrl = controllers.get(el);
    if (ctrl) return ctrl;
    if (!graphs.has(el) && isUnsupported(el)) {
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

  function handleMediaEvent(el, type) {
    noteMedia(el);
    if (!state.enabled) return;
    const ctrl = getController(el);
    if (!ctrl) return;
    if (type === "play" && ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    if (!ctrl.active && (type === "play" || type === "playing")) ctrl.start();
    ctrl.onMediaEvent(type);
  }

  // Media-Events blubbern nicht, laufen aber durch die Capture-Phase → ein Listener für das ganze Dokument
  function onDocumentMediaEvent(e) {
    if (e.target instanceof HTMLMediaElement) handleMediaEvent(e.target, e.type);
  }
  for (const type of MEDIA_EVENTS) document.addEventListener(type, onDocumentMediaEvent, true);

  // Elemente außerhalb des Dokument-Baums (Shadow DOM, new Audio()) direkt beobachten
  function onDirectMediaEvent(e) {
    const el = e.currentTarget;
    if (el.getRootNode() === document) return; // übernimmt der Dokument-Listener
    handleMediaEvent(el, e.type);
  }
  function watchDirectly(el) {
    if (directlyWatched.has(el)) return;
    directlyWatched.add(el);
    for (const type of MEDIA_EVENTS) el.addEventListener(type, onDirectMediaEvent);
  }

  // Firefox: play() der Seite beobachten, um auch Medien in Shadow-DOMs und ohne DOM zu finden
  function hookPagePlay() {
    const win = window.wrappedJSObject;
    if (!win || typeof exportFunction !== "function") return;
    try {
      const proto = win.HTMLMediaElement.prototype;
      const original = proto.play;
      exportFunction(
        function play(...args) {
          try {
            if (this instanceof HTMLMediaElement && this.getRootNode() !== document) {
              watchDirectly(this);
              noteMedia(this);
            }
          } catch {
            // Beobachtung darf die Wiedergabe nie verhindern
          }
          return original.apply(this, args);
        },
        proto,
        { defineAs: "play" },
      );
    } catch (err) {
      console.warn("[Skip Silence] play()-Beobachtung nicht möglich", err);
    }
  }
  hookPagePlay();

  /** Alle Medien im Dokument inkl. offener Shadow-Roots. */
  function findAllMedia() {
    const found = [...document.querySelectorAll("video, audio")];
    for (const host of document.querySelectorAll("*")) {
      if (!host.shadowRoot) continue;
      for (const el of host.shadowRoot.querySelectorAll("video, audio")) {
        watchDirectly(el);
        found.push(el);
      }
    }
    return found;
  }

  // ---------- Zustand, Wartung ----------

  function flushSaved() {
    if (pendingSavedMs < 50) return;
    const seconds = pendingSavedMs / 1000;
    pendingSavedMs = 0;
    browser.runtime.sendMessage({ type: "addSaved", seconds }).catch(() => {});
  }

  function maintenance() {
    flushSaved();
    prune();
  }

  function applyState(next) {
    if (!next || typeof next.rev !== "number" || next.rev < state.rev) return;
    const wasEnabled = state.enabled;
    state = { enabled: !!next.enabled, values: SS.clampValues(next.values), rev: next.rev };

    if (state.enabled && !wasEnabled) {
      if (!maintenanceTimer) maintenanceTimer = setInterval(maintenance, MAINTENANCE_MS);
      for (const el of [...findAllMedia(), ...known]) {
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
    for (const el of document.querySelectorAll("video, audio")) noteMedia(el);
    let best = null;
    let unsupportedCount = 0;
    let silentInputCount = 0;
    for (const el of known) {
      const ctrl = controllers.get(el);
      if (unsupported.has(el) || ctrl?.tainted || (!graphs.has(el) && isUnsupported(el))) unsupportedCount++;
      if (ctrl?.connected && ctrl.zeroMs >= SILENT_INPUT_MS) silentInputCount++;
      const s = ctrl?.lastSample;
      if (!s) continue;
      if (!best || (s.playing && !best.playing) || (s.playing === best.playing && s.levelDb > best.levelDb)) {
        best = s;
      }
    }
    return {
      mediaCount: known.size,
      unsupportedCount,
      silentInputCount,
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
