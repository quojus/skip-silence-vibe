// Läuft in jeder Seite und jedem Frame. Hängt sich an <video>/<audio>, misst den Pegel
// per AudioWorklet und steuert playbackRate und Lautstärke.
(() => {
  if (globalThis.__ssContentLoaded) return;
  globalThis.__ssContentLoaded = true;

  const C = SS.DETECTOR;
  const MEDIA_EVENTS = [
    "loadstart",
    "volumechange",
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
  // Bei exakt 1,0 umgeht Firefox seine Zeitstreckung, deren Puffer dabei gefüllt bleibt.
  // Die nächste Beschleunigung spielt dann erst 20–45 ms alten, schon gehörten Ton ab.
  // 1,0001 hält die Zeitstreckung aktiv (0,01 % schneller, nicht hörbar).
  const RATE_ONE = 1.0001;
  // Wechselt die Rate doch einmal von exakt 1,0 weg (Einschalten), wird der alte Puffer
  // so lange stummgeschaltet (gemessen 20–50 ms, mit Reserve).
  const STALE_MASK_S = 0.07;
  const MIN_FADE_S = 0.005;
  const FADE_SEGMENTS = 16; // Kurve als Folge linearer Rampen – lässt sich jederzeit abbrechen
  const DELAY_SWITCH_S = 0.01; // Ausblenden um einen Wechsel der Verzögerung
  const SILENT_INPUT_MS = 5000; // so lange exakt 0 beim Abspielen → Warnung im Popup
  const MIN_MEDIA_S = 5; // kürzere Klänge (Effekte, Klick-Sounds) bekommen keine Audio-Kette
  const MAINTENANCE_MS = 1000;
  const SHADOW_SCAN_MIN_MS = 5000; // frühestens so oft in Shadow Roots suchen …
  const SHADOW_SCAN_BUDGET = 0.001; // … und höchstens 0,1 % der Hauptthread-Zeit dafür
  const LINEAR = [0, 0, 1, 1];

  let state = { enabled: false, values: SS.clampValues(), rev: -1 };
  let holdActive = false; // Spul-Taste gerade gehalten (in irgendeinem Frame des Tabs)
  const controllers = new Map(); // HTMLMediaElement → MediaController
  const known = new Set(); // gesehene Medienelemente (wird regelmäßig aufgeräumt)
  const directlyWatched = new WeakSet();
  const rateWatched = new WeakSet();
  let pendingSavedMs = 0;
  let maintenanceTimer = null;
  let nextShadowScan = 0;

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
          // Geplanter Lautstärkeverlauf und Lookahead-Zustand gehören zur Kette, nicht zum
          // Controller – so stimmen sie auch, wenn ein neuer Controller die Kette übernimmt
          return { worklet, delay, gain, gainPts: [{ t: 0, v: 1 }], delayOn: false };
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

  /** Ist das Element überhaupt hörbar? Stumm, Lautstärke 0 oder ohne Tonspur liefern nur Nullen. */
  function audible(el) {
    return !el.muted && el.volume > 0 && el.mozHasAudio !== false;
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
      this.lastSample = null;
      this.zeroMs = 0;
      this.holding = false; // Spul-Taste wirkt gerade auf dieses Element
      this.foreign = false; // angehängt, aber Quelle inzwischen fremd → Kette liefert nur Nullen
      watchRate(el);
    }

    get values() {
      return state.values;
    }

    lookaheadOn() {
      return this.values.lookahead && this.values.muteSilence;
    }

    /** Liefert die Kette echte Messwerte? (nicht stumm, Tonspur vorhanden, Quelle nicht fremd) */
    measurable() {
      return audible(this.el) && !this.foreign;
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
      this.foreign = isUnsupported(this.el);
      this.graph.worklet.port.onmessage = (e) => this.onRms(e.data);
      if (!this.setDelay(this.lookaheadOn(), 1) && this.gainTarget !== 1) this.setGain(1, DELAY_SWITCH_S);
      const fromExactOne = this.el.playbackRate === 1;
      this.setRate(this.values.normalSpeed);
      // Von exakt 1,0 auf 1,0001 (oder schneller): Firefox gibt zuerst alten Ton aus dem
      // Puffer der Zeitstreckung aus – kurz ausblenden
      if (fromExactOne && this.ownRate !== 1) this.maskStale();
      this.graph.worklet.port.postMessage(true);
    }

    stop() {
      waitingForContext.delete(this);
      if (!this.active) return;
      this.active = false;
      const wasConnected = this.connected;
      this.connected = false;
      this.ramp = null;
      this.holding = false;
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
      // measurable(): ein stummes Element nie beschleunigen. onRms setzt es zusätzlich beim
      // nächsten Messwert zurück – diese Prüfung verhindert, dass überhaupt ein Übergang startet.
      const silent =
        (this.holding || (this.detector.phase === "silence" && this.measurable())) && this.mediaState === "playing";
      const phaseRamp = silent ? v.rampIn : v.rampOut;
      const targetRate = silent ? v.silenceSpeed : v.normalSpeed;
      const targetGain = silent && v.muteSilence ? 0 : 1;

      const switched = this.setDelay(this.lookaheadOn(), targetGain);
      if (!switched && Math.abs(this.gainTarget - targetGain) > 1e-6) {
        this.setGain(targetGain, phaseRamp.durationMs / 1000, phaseRamp.bezier);
      }
      const r = this.ramp;
      if (r && Math.abs(r.to - targetRate) > 1e-4) {
        // Laufender Übergang: ab dem Ist-Wert mit der Restdauer weiter – nur das Ziel ist neu.
        // (Nur r.to zu ändern, würde um den schon zurückgelegten Kurvenanteil springen.)
        const rest = Math.max(1, r.duration - r.elapsed);
        this.ramp = { from: this.ownRate, to: targetRate, elapsed: 0, duration: rest, bezier: r.bezier };
      } else if (!r && Math.abs(this.ownRate - targetRate) > 1e-4) {
        this.startRamp(targetRate, phaseRamp);
      }
    }

    onMediaEvent(type) {
      if (type === "volumechange") {
        // Stumm geschaltet: nichts mehr messbar → wie Pause sofort zurück auf Normal
        if (!audible(this.el)) this.resetOutput();
        return;
      }
      if (type === "play" || type === "playing") this.mediaState = "playing";
      else if (type === "seeking") this.mediaState = "seeking";
      else if (type === "waiting") this.mediaState = "waiting";
      else if (type === "seeked" || type === "loadstart") this.mediaState = mediaStateOf(this.el);
      else this.mediaState = "paused"; // pause, ended, emptied

      if (type === "loadstart" || type === "emptied") {
        this.zeroMs = 0;
        this.foreign = isUnsupported(this.el);
      }
      if (this.mediaState !== "playing") {
        // Den Detektor sofort informieren: Bei einem Sprung in gepufferte Daten kommen seeking,
        // waiting, seeked und playing in derselben Millisekunde – zwischen zwei Messwerten.
        // Ohne diese Meldung bliebe er in „Stille“, ohne Schonzeit und ohne neuen Übergang.
        this.detector.update({ windowMs: 0, levelDb: -Infinity, mediaState: this.mediaState });
        // Pause, Spulen, Puffern: sofort zurück auf Normal, damit danach garantiert Ton da ist
        this.resetOutput();
      }
    }

    /** Zurück zum Ton: Geschwindigkeit über rampOut, Lautstärke passend zum Lookahead einblenden. */
    backToSound() {
      const v = this.values;
      this.startRamp(v.normalSpeed, v.rampOut);
      const dur = v.rampOut.durationMs / 1000;
      if (v.muteSilence && this.lookaheadOn()) {
        // Einblenden so planen, dass es kurz vor dem verzögerten Ton fertig ist
        this.setGain(1, Math.min(dur, C.UNMUTE_LEAD_S), v.rampOut.bezier, C.LOOKAHEAD_S - C.UNMUTE_LEAD_S);
      } else if (this.gainTarget !== 1) {
        this.setGain(1, dur, v.rampOut.bezier);
      }
    }

    /** Spul-Taste: solange gehalten, gilt die Stelle als Stille (gleiche Kurven, ggf. stumm). */
    applyHold() {
      if (!this.connected) return;
      const v = this.values;
      if (holdActive && this.mediaState === "playing") {
        if (this.holding) return;
        this.holding = true;
        this.startRamp(v.silenceSpeed, v.rampIn);
        if (v.muteSilence) this.setGain(0, v.rampIn.durationMs / 1000, v.rampIn.bezier);
      } else if (this.holding) {
        this.holding = false;
        // Loslassen: zurück zu dem, was die automatische Erkennung gerade sagt
        const silent = this.detector.phase === "silence" && this.mediaState === "playing" && this.measurable();
        if (!silent) this.backToSound();
      }
    }

    resetOutput() {
      this.ramp = null;
      this.holding = false; // bei erneutem Play greift die noch gehaltene Taste wieder
      if (this.connected) {
        this.setRate(this.values.normalSpeed);
        this.setGain(1, 0);
      }
    }

    onRms({ rms, frames }) {
      if (!this.connected || !ctx) return;
      const v = this.values;
      const windowMs = (frames / ctx.sampleRate) * 1000;
      const levelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const hearable = this.measurable();
      const playing = this.mediaState === "playing";
      // Stumme oder fremde Medien liefern nur Nullen – für den Detektor zählen sie wie pausiert
      const mediaState = playing && !hearable ? "muted" : this.mediaState;
      const res = this.detector.update({ windowMs, levelDb, mediaState });

      this.applyHold();
      if (this.holding) {
        // Spul-Taste: Stille erzwungen, die automatische Erkennung läuft nur im Hintergrund mit
        this.advanceRamp(windowMs);
        const rate = this.ownRate === RATE_ONE ? 1 : this.ownRate;
        pendingSavedMs += windowMs * Math.max(0, rate / v.normalSpeed - 1);
      } else if (playing && !hearable) {
        // Ton ohne Ereignis verloren (z. B. Tonspur weg): laufende Beschleunigung beenden
        if (this.ramp || Math.abs(this.ownRate - v.normalSpeed) > 1e-3 || this.gainTarget !== 1) this.resetOutput();
      } else {
        if (res.changed) this.onPhase(res);
        this.advanceRamp(windowMs);
        if (playing && res.phase === "silence") {
          const rate = this.ownRate === RATE_ONE ? 1 : this.ownRate;
          pendingSavedMs += windowMs * Math.max(0, rate / v.normalSpeed - 1);
        }
      }
      // Nur bei messbarem Ton zählen; stumm oder fremd heißt: neu anfangen
      if (!hearable) this.zeroMs = 0;
      else if (playing) this.zeroMs = rms === 0 ? this.zeroMs + windowMs : 0;
      this.lastSample = {
        ...res,
        phase: this.holding ? "silence" : hearable ? res.phase : "sound",
        playing,
        foreign: this.foreign,
        muted: !audible(this.el),
        silentInput: this.zeroMs >= SILENT_INPUT_MS,
      };
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
        this.backToSound();
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

    /** force: exakt diesen Wert setzen (nur beim Ausschalten, um die Ausgangsrate herzustellen). */
    setRate(rate, force = false) {
      let r = clamp(rate, RATE_MIN, RATE_MAX);
      if (!force && r === 1) r = RATE_ONE;
      this.ownRate = r;
      if (force || Math.abs(this.el.playbackRate - r) > 1e-6) this.el.playbackRate = r;
    }

    onRateChange() {
      // Fremde Änderungen (z. B. Geschwindigkeitsmenü der Seite) überschreiben
      if (this.connected && Math.abs(this.el.playbackRate - this.ownRate) > 1e-6) {
        this.el.playbackRate = this.ownRate;
      }
    }

    // ----- Lautstärke: eigene Buchführung über exakt die geplanten Punkte -----
    // gainPts ist der geplante Verlauf als Punktfolge {t, v}: zwischen zwei Punkten linear
    // (linearRampToValueAtTime), zwei Punkte mit gleichem t sind ein Sprung (setValueAtTime).
    // So kennt der Controller den echten Ist-Wert, ohne gain.value auszulesen.

    gainAt(t) {
      const pts = this.graph ? this.graph.gainPts : [{ t: 0, v: 1 }];
      let i = -1;
      for (let k = 0; k < pts.length; k++) if (pts[k].t <= t) i = k;
      if (i < 0) return pts[0].v;
      const a = pts[i];
      const b = pts[i + 1];
      if (!b) return a.v;
      return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    }

    get gainTarget() {
      return this.graph ? this.graph.gainPts.at(-1).v : 1;
    }

    /** Plant den Verlauf ab jetzt neu: pts[0] ist {t: now, v: Ist-Wert}. */
    planGain(pts) {
      const g = this.graph.gain.gain;
      g.cancelScheduledValues(pts[0].t);
      g.setValueAtTime(pts[0].v, pts[0].t);
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].t <= pts[i - 1].t) g.setValueAtTime(pts[i].v, pts[i].t);
        else g.linearRampToValueAtTime(pts[i].v, pts[i].t);
      }
      this.graph.gainPts = pts;
    }

    /** Lautstärke ab jetzt (+delayS) über durS entlang der Kurve auf target bringen. */
    setGain(target, durS, bezier = LINEAR, delayS = 0) {
      if (!this.graph || !ctx) return;
      const now = ctx.currentTime;
      const from = clamp(this.gainAt(now), 0, 1);
      const t0 = now + delayS;
      const dur = durS > 0 ? Math.max(durS, MIN_FADE_S) : 0;
      const pts = [{ t: now, v: from }];
      if (delayS > 0) pts.push({ t: t0, v: from });
      if (dur === 0) {
        pts.push({ t: t0, v: target });
      } else {
        for (let i = 1; i <= FADE_SEGMENTS; i++) {
          const y = SS.bezierY(bezier, i / FADE_SEGMENTS);
          pts.push({ t: t0 + (dur * i) / FADE_SEGMENTS, v: clamp(from + (target - from) * y, 0, 1) });
        }
      }
      try {
        this.planGain(pts);
      } catch (err) {
        console.warn("[Skip Silence] Lautstärke-Automation fehlgeschlagen", err);
        this.forceGain(target);
      }
    }

    /** Lautstärke für STALE_MASK_S auf 0 legen, ohne den übrigen geplanten Verlauf zu verlieren. */
    maskStale() {
      if (!this.graph || !ctx) return;
      const E = MIN_FADE_S;
      const now = ctx.currentTime;
      // Der alte Ton läuft durch die Verzögerung – die Maske liegt entsprechend später
      const start = now + (this.graph.delayOn ? C.LOOKAHEAD_S : 0);
      const end = start + STALE_MASK_S;
      const downFrom = Math.max(now, start - E);
      const dip = (t) => {
        if (t <= downFrom) return 1;
        if (t < start) return (start - t) / (start - downFrom);
        if (t <= end) return 0;
        if (t < end + E) return (t - end) / E;
        return 1;
      };
      const last = Math.max(this.graph.gainPts.at(-1).t, end + E);
      const times = new Set([now, downFrom, start, end, end + E]);
      for (let t = now; t < last; t += E) times.add(t);
      for (const p of this.graph.gainPts) if (p.t > now) times.add(p.t);
      const pts = [...times]
        .sort((a, b) => a - b)
        .map((t) => ({ t, v: clamp(Math.min(this.gainAt(t), dip(t)), 0, 1) }));
      try {
        this.planGain(pts);
      } catch (err) {
        console.warn("[Skip Silence] Ausblenden des alten Tons fehlgeschlagen", err);
      }
    }

    forceGain(value) {
      const g = this.graph.gain.gain;
      try {
        g.cancelScheduledValues(0);
        g.value = value;
      } catch {
        // nichts mehr zu retten
      }
      this.graph.gainPts = [{ t: 0, v: value }];
    }

    /**
     * Verzögerung (Lookahead) umschalten. Ein harter Sprung der Delay-Zeit würde Ton
     * wiederholen oder verschlucken – deshalb kurz ausblenden, umschalten, auf targetGain einblenden.
     * Liefert true, wenn umgeschaltet wurde.
     */
    setDelay(on, targetGain) {
      if (!this.graph || !ctx || on === this.graph.delayOn) return false;
      this.graph.delayOn = on;
      const d = this.graph.delay.delayTime;
      const now = ctx.currentTime;
      const S = DELAY_SWITCH_S;
      try {
        this.planGain([
          { t: now, v: clamp(this.gainAt(now), 0, 1) },
          { t: now + S, v: 0 },
          { t: now + 2 * S, v: targetGain },
        ]);
        d.cancelScheduledValues(now);
        d.setValueAtTime(on ? C.LOOKAHEAD_S : 0, now + S);
      } catch (err) {
        console.warn("[Skip Silence] Umschalten der Verzögerung fehlgeschlagen", err);
        this.forceGain(targetGain);
      }
      return true;
    }
  }

  // Ein ratechange-Listener pro Element (nicht pro Controller) – hält keinen alten Controller fest
  function watchRate(el) {
    if (rateWatched.has(el)) return;
    rateWatched.add(el);
    el.addEventListener("ratechange", () => controllers.get(el)?.onRateChange());
  }

  // ---------- Medien finden ----------

  function noteMedia(el) {
    if (known.has(el)) return;
    known.add(el);
    ensureMaintenance();
    browser.runtime.sendMessage({ type: "registerFrame" }).catch(() => {});
  }

  /** Kurze Klänge brauchen keine Stille-Erkennung – und ihre Kette wäre nie wieder lösbar. */
  function tooShort(el) {
    return Number.isFinite(el.duration) && el.duration < MIN_MEDIA_S;
  }

  function getController(el) {
    let ctrl = controllers.get(el);
    if (ctrl) return ctrl;
    if (!graphs.has(el) && isUnsupported(el)) return null;
    ctrl = new MediaController(el);
    controllers.set(el, ctrl);
    return ctrl;
  }

  /** Controller holen und starten, sobald Dauer und Quelle bekannt sind. */
  function startFor(el) {
    if (el.readyState < HTMLMediaElement.HAVE_METADATA || tooShort(el)) return null;
    const ctrl = getController(el);
    if (ctrl) ctrl.start();
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
    if (!state.enabled) {
      // Ausgeschaltet: nur Elemente im Dokument merken (für die Popup-Anzeige)
      if (el.isConnected) noteMedia(el);
      return;
    }
    noteMedia(el);
    if (type === "play" && ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    let ctrl = controllers.get(el);
    if (!ctrl?.active && (type === "play" || type === "playing") && !el.paused) ctrl = startFor(el);
    if (ctrl) ctrl.onMediaEvent(type);
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
      // play() hat keine Parameter. Ein Argument-Array des Content-Scripts dürfte die Seite
      // nicht lesen ("Permission denied") – deshalb das Original ohne Argumente aufrufen.
      exportFunction(
        function play() {
          try {
            // Nur Listener anhängen (WeakSet, nichts festhalten); gemerkt wird erst bei Bedarf
            if (this instanceof HTMLMediaElement && this.getRootNode() !== document) watchDirectly(this);
          } catch {
            // Beobachtung darf die Wiedergabe nie verhindern
          }
          return original.call(this);
        },
        proto,
        { defineAs: "play" },
      );
    } catch (err) {
      console.warn("[Skip Silence] play()-Beobachtung nicht möglich", err);
    }
  }
  hookPagePlay();

  /** Alle Medien im Dokument inkl. offener (auch verschachtelter) Shadow Roots. */
  function findAllMedia() {
    const found = [];
    const scan = (root, inShadow) => {
      for (const el of root.querySelectorAll("video, audio")) {
        if (inShadow) watchDirectly(el);
        found.push(el);
      }
      for (const host of root.querySelectorAll("*")) {
        if (host.shadowRoot) scan(host.shadowRoot, true);
      }
    };
    scan(document, false);
    return found;
  }

  /** Beim Einschalten und regelmäßig: laufende Medien finden und starten. */
  function startPlaying() {
    for (const el of [...findAllMedia(), ...known]) {
      noteMedia(el);
      if (!el.paused && !controllers.get(el)?.active) startFor(el);
    }
  }

  // ---------- Zustand, Wartung ----------

  function flushSaved() {
    if (pendingSavedMs < 50) return;
    const seconds = pendingSavedMs / 1000;
    pendingSavedMs = 0;
    browser.runtime.sendMessage({ type: "addSaved", seconds }).catch(() => {});
  }

  function ensureMaintenance() {
    if (!maintenanceTimer) maintenanceTimer = setInterval(maintenance, MAINTENANCE_MS);
  }

  function maintenance() {
    flushSaved();
    prune();
    // Suche in Shadow Roots: Abstand wächst mit ihrer Dauer, damit große Seiten nicht leiden
    if (state.enabled && performance.now() >= nextShadowScan) {
      const t0 = performance.now();
      startPlaying();
      const took = performance.now() - t0;
      nextShadowScan = performance.now() + Math.max(SHADOW_SCAN_MIN_MS, took / SHADOW_SCAN_BUDGET);
    }
  }

  function applyState(next) {
    if (!next || typeof next.rev !== "number" || next.rev < state.rev) return;
    const wasEnabled = state.enabled;
    state = { enabled: !!next.enabled, values: SS.clampValues(next.values), rev: next.rev };
    if (!state.values.holdKey.enabled) releaseKey();

    if (state.enabled && !wasEnabled) {
      ensureMaintenance();
      nextShadowScan = performance.now() + SHADOW_SCAN_MIN_MS;
      startPlaying();
    } else if (!state.enabled && wasEnabled) {
      releaseKey();
      for (const ctrl of controllers.values()) ctrl.stop();
      flushSaved();
    } else if (state.enabled) {
      for (const ctrl of controllers.values()) ctrl.refresh();
    }
  }

  // ---------- Spul-Taste ----------

  function setHold(on) {
    holdActive = on;
    for (const ctrl of controllers.values()) ctrl.applyHold();
  }

  let keyHeld = false; // Taste in diesem Frame gedrückt
  let heldCode = ""; // gedrückter Code – das Loslassen zählt auch, wenn die Taste inzwischen geändert wurde

  function announceHold(on) {
    setHold(on);
    // Alle anderen Frames des Tabs mitnehmen (Video im iframe, Fokus in der Seite)
    browser.runtime.sendMessage({ type: "hold", on }).catch(() => {});
  }

  function releaseKey() {
    if (!keyHeld) return;
    keyHeld = false;
    heldCode = "";
    announceHold(false);
  }

  /** Tief fokussiertes Element – auch in geschlossenen Shadow Roots (Firefox: openOrClosedShadowRoot). */
  function deepActiveElement() {
    let el = document.activeElement;
    for (let i = 0; el && i < 32; i++) {
      const root = el.openOrClosedShadowRoot ?? el.shadowRoot;
      if (!root || !root.activeElement) break;
      el = root.activeElement;
    }
    return el;
  }

  function editable(t) {
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ""));
  }

  function isEditable(e) {
    return editable(e.composedPath?.()[0] ?? e.target) || editable(deepActiveElement());
  }

  // Nur echte Tastendrücke: Seitenskripte (auch fremde iframes) dürfen die Spul-Taste nicht
  // auslösen. Der Harness lädt content.js als Seitenskript und schaltet das gezielt ab –
  // im echten Content-Script ist diese Variable für Seiten nicht erreichbar.
  const trusted = (e) => e.isTrusted || globalThis.__ssTestAllowUntrusted === true;

  window.addEventListener(
    "keydown",
    (e) => {
      if (!trusted(e) || !state.enabled) return;
      // Wiederholung der gehaltenen Taste immer abfangen – auch wenn ein Modifier schon los ist
      if (keyHeld && e.code === heldCode) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!SS.matchesHoldKey(state.values.holdKey, e) || isEditable(e)) return;
      // Die Seite soll die Taste nicht zusätzlich verarbeiten (z. B. eigene Kürzel)
      e.preventDefault();
      e.stopImmediatePropagation();
      // Ein echter Tastendruck ist auch eine Nutzergeste: wartenden AudioContext starten
      if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
      if (keyHeld) return;
      keyHeld = true;
      heldCode = e.code;
      announceHold(true);
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      // Beim Loslassen zählt nur die Taste – Modifier dürfen schon vorher losgelassen sein
      if (!keyHeld || !trusted(e) || e.code !== heldCode) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      releaseKey();
    },
    true,
  );
  // Fokus weg (anderes Fenster, anderer Tab) oder Frame verschwindet: Loslassen käme nie an
  window.addEventListener("blur", releaseKey);
  window.addEventListener("pagehide", releaseKey);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseKey();
  });

  function levelInfo() {
    prune();
    for (const el of document.querySelectorAll("video, audio")) noteMedia(el);
    let best = null;
    let unsupportedCount = 0;
    for (const el of known) {
      const ctrl = controllers.get(el);
      // Mit Kette heißt fremde Quelle: Ton stumm. Ohne Kette: wird nicht angehängt.
      if (isUnsupported(el)) unsupportedCount++;
      const s = ctrl?.lastSample;
      if (!s) continue;
      if (SS.betterSample(s, best)) {
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
      silentInput: best ? best.silentInput : false,
      foreign: best ? best.foreign : false,
      muted: best ? best.muted : false,
    };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return undefined;
    if (msg.type === "applyState") applyState(msg.state);
    // Der haltende Frame kennt seinen Zustand selbst – ein verspätetes Echo des Backgrounds
    // (z. B. „los“ vom vorigen Druck) darf ihn nicht überschreiben
    else if (msg.type === "hold" && !keyHeld) setHold(!!msg.on);
    else if (msg.type === "getLevel") return Promise.resolve(levelInfo());
    return undefined;
  });

  browser.runtime
    .sendMessage({ type: "getTabState" })
    .then(applyState)
    .catch(() => {});
})();
