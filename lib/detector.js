// Zustandsmaschine Ton/Stille für ein Medienelement – ohne DOM, rein rechnerisch.
// Dynamischer Schwellwert und Hysterese nach dem Vorbild von vantezzen/skip-silence (MIT).
(() => {
  const SS = (globalThis.SS = globalThis.SS || {});

  SS.DETECTOR = Object.freeze({
    DYN_WINDOW_S: 10, // Länge des Pegel-Verlaufs für das Grundrauschen
    DYN_RECALC_MS: 500, // Neuberechnung des dynamischen Schwellwerts
    DYN_WARMUP_S: 1, // Verlauf nötig, bevor der dynamische Wert gilt
    DYN_PERCENTILE: 0.15, // Perzentil = Grundrauschen
    DYN_MIN_DB: -60,
    DYN_MAX_DB: -20,
    LOOKAHEAD_S: 0.06, // Audio-Verzögerung bei Lookahead
    UNMUTE_LEAD_S: 0.04, // Einblenden beginnt so viel früher
    MIN_DB: -100, // Anzeigewert für digitale Stille
  });

  const C = SS.DETECTOR;

  class Detector {
    constructor(getValues) {
      this.getValues = getValues;
      this.phase = "sound";
      this.lastMediaState = "paused";
      this.silentMs = 0;
      this.graceLeft = 0;
      this.history = [];
      this.dynDb = undefined;
      this.sinceRecalcMs = 0;
      this.lastDynamic = undefined;
    }

    update({ windowMs, levelDb, mediaState }) {
      const v = this.getValues();

      if (v.dynamicThreshold !== this.lastDynamic) {
        this.lastDynamic = v.dynamicThreshold;
        this.history = [];
        this.dynDb = undefined;
      }

      const wasPlaying = this.lastMediaState === "playing";
      this.lastMediaState = mediaState;

      // 1. Nicht spielend: einfrieren, nichts lernen
      if (mediaState !== "playing") {
        this.silentMs = 0;
        return this.result(false, false, levelDb, v);
      }

      // 2. Start der Wiedergabe: sofort Ton, Schonzeit beginnt
      if (!wasPlaying) {
        this.phase = "sound";
        this.silentMs = 0;
        this.graceLeft = v.graceMs;
        return this.result(true, true, levelDb, v);
      }

      if (v.dynamicThreshold) this.learn(levelDb, windowMs);
      const threshold = this.threshold(v);

      // 3. Schonzeit: keine Stille-Erkennung
      if (this.graceLeft > 0) {
        this.graceLeft -= windowMs;
        if (this.graceLeft > 0) {
          this.silentMs = 0;
          return this.result(false, false, levelDb, v);
        }
      }

      // 4.–6. Hysterese und Mindestdauer
      if (this.phase === "silence") {
        if (levelDb > threshold + v.hysteresisDb) {
          this.phase = "sound";
          this.silentMs = 0;
          return this.result(true, false, levelDb, v);
        }
        return this.result(false, false, levelDb, v);
      }

      if (levelDb < threshold) {
        this.silentMs += windowMs;
        if (this.silentMs >= v.minSilenceMs) {
          this.phase = "silence";
          return this.result(true, false, levelDb, v);
        }
      } else {
        this.silentMs = 0;
      }
      return this.result(false, false, levelDb, v);
    }

    learn(levelDb, windowMs) {
      if (Number.isFinite(levelDb)) {
        this.history.push(levelDb);
        const max = Math.ceil((C.DYN_WINDOW_S * 1000) / windowMs);
        if (this.history.length > max) this.history.splice(0, this.history.length - max);
      }
      this.sinceRecalcMs += windowMs;
      const warm = this.history.length >= Math.ceil((C.DYN_WARMUP_S * 1000) / windowMs);
      if (warm && (this.dynDb === undefined || this.sinceRecalcMs >= C.DYN_RECALC_MS)) {
        this.sinceRecalcMs = 0;
        const sorted = [...this.history].sort((a, b) => a - b);
        const floor = sorted[Math.floor(sorted.length * C.DYN_PERCENTILE)];
        const margin = this.getValues().dynMarginDb;
        this.dynDb = Math.min(C.DYN_MAX_DB, Math.max(C.DYN_MIN_DB, floor + margin));
      }
    }

    threshold(v) {
      if (v.dynamicThreshold && this.dynDb !== undefined) return this.dynDb;
      return v.thresholdDb;
    }

    result(changed, instant, levelDb, v) {
      return {
        phase: this.phase,
        changed,
        instant,
        thresholdDb: this.threshold(v),
        levelDb: Math.max(C.MIN_DB, levelDb),
      };
    }
  }

  SS.Detector = Detector;

  if (typeof module !== "undefined") module.exports = SS;
})();
