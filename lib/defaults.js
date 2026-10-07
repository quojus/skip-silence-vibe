// Wertebereiche, Standardwerte und Validierung der Einstellungen.
(() => {
  const SS = (globalThis.SS = globalThis.SS || {});

  SS.LIMITS = {
    normalSpeed: { min: 0.5, max: 3, step: 0.05 },
    silenceSpeed: { min: 1, max: 8, step: 0.1 },
    thresholdDb: { min: -80, max: -10, step: 1 },
    dynMarginDb: { min: 0, max: 12, step: 0.5 },
    hysteresisDb: { min: 0, max: 10, step: 0.5 },
    minSilenceMs: { min: 50, max: 1000, step: 10 },
    graceMs: { min: 0, max: 1000, step: 10 },
    rampInDuration: { min: 0, max: 1000, step: 10 },
    rampOutDuration: { min: 0, max: 500, step: 10 },
  };

  SS.BEZIER_PRESETS = {
    linear: [0, 0, 1, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
  };

  SS.BEZIER_Y_MIN = -0.5;
  SS.BEZIER_Y_MAX = 1.5;

  SS.DEFAULT_VALUES = Object.freeze({
    normalSpeed: 1,
    silenceSpeed: 3,
    dynamicThreshold: true,
    thresholdDb: -40,
    dynMarginDb: 3,
    hysteresisDb: 3,
    lookahead: true,
    minSilenceMs: 200,
    graceMs: 300,
    muteSilence: false,
    rampIn: Object.freeze({ durationMs: 200, bezier: Object.freeze([0.42, 0, 0.58, 1]) }),
    rampOut: Object.freeze({ durationMs: 50, bezier: Object.freeze([0, 0, 0.58, 1]) }),
  });

  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

  function num(value, fallback, limit) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return clamp(value, limit.min, limit.max);
  }

  function bool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function bezier(value, fallback) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
      return [...fallback];
    }
    const [x1, y1, x2, y2] = value;
    return [
      clamp(x1, 0, 1),
      clamp(y1, SS.BEZIER_Y_MIN, SS.BEZIER_Y_MAX),
      clamp(x2, 0, 1),
      clamp(y2, SS.BEZIER_Y_MIN, SS.BEZIER_Y_MAX),
    ];
  }

  function ramp(value, fallback, limit) {
    const v = value && typeof value === "object" ? value : {};
    return {
      durationMs: num(v.durationMs, fallback.durationMs, limit),
      bezier: bezier(v.bezier, fallback.bezier),
    };
  }

  /** Liefert eine geprüfte, tiefe Kopie. Ungültige Felder → Standardwert. */
  SS.clampValues = function clampValues(input) {
    const v = input && typeof input === "object" ? input : {};
    const d = SS.DEFAULT_VALUES;
    const L = SS.LIMITS;
    return {
      normalSpeed: num(v.normalSpeed, d.normalSpeed, L.normalSpeed),
      silenceSpeed: num(v.silenceSpeed, d.silenceSpeed, L.silenceSpeed),
      dynamicThreshold: bool(v.dynamicThreshold, d.dynamicThreshold),
      thresholdDb: num(v.thresholdDb, d.thresholdDb, L.thresholdDb),
      dynMarginDb: num(v.dynMarginDb, d.dynMarginDb, L.dynMarginDb),
      hysteresisDb: num(v.hysteresisDb, d.hysteresisDb, L.hysteresisDb),
      lookahead: bool(v.lookahead, d.lookahead),
      minSilenceMs: num(v.minSilenceMs, d.minSilenceMs, L.minSilenceMs),
      graceMs: num(v.graceMs, d.graceMs, L.graceMs),
      muteSilence: bool(v.muteSilence, d.muteSilence),
      rampIn: ramp(v.rampIn, d.rampIn, L.rampInDuration),
      rampOut: ramp(v.rampOut, d.rampOut, L.rampOutDuration),
    };
  };

  SS.cloneValues = (values) => structuredClone(values);

  /**
   * Welches Element zeigt die Pegelanzeige? true, wenn Messwert a vor b kommt:
   * spielend vor pausiert, messbar (nicht stumm, Quelle nicht fremd) vor nicht messbar,
   * dann der höhere Pegel. Gemeinsam genutzt von Content-Script und Popup.
   */
  SS.betterSample = function betterSample(a, b) {
    if (!b) return true;
    if (a.playing !== b.playing) return a.playing;
    const ma = !a.muted && !a.foreign;
    const mb = !b.muted && !b.foreign;
    if (ma !== mb) return ma;
    return a.levelDb > b.levelDb;
  };

  if (typeof module !== "undefined") module.exports = SS;
})();
