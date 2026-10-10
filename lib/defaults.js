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
    // Spul-Taste: solange gehalten, gilt die Stelle als Stille. code = KeyboardEvent.code
    holdKey: Object.freeze({ enabled: false, code: "", ctrl: false, alt: false, shift: false, meta: false }),
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

  // KeyboardEvent.code ist z. B. "KeyF", "Period", "F2", "Numpad5" – nur Buchstaben und Ziffern
  const KEY_CODE = /^[A-Za-z0-9]{1,32}$/;
  // Reine Modifier-Tasten taugen nicht als Spul-Taste
  const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

  function holdKey(value, fallback) {
    const v = value && typeof value === "object" ? value : {};
    const code = typeof v.code === "string" && KEY_CODE.test(v.code) && !MODIFIER_CODES.test(v.code) ? v.code : "";
    return {
      enabled: bool(v.enabled, fallback.enabled) && code !== "",
      code,
      ctrl: bool(v.ctrl, false),
      alt: bool(v.alt, false),
      shift: bool(v.shift, false),
      // Cmd/Meta nie: macOS meldet bei gehaltenem Cmd das Loslassen der Taste oft nicht
      meta: false,
    };
  }

  /** Passt ein Tastatur-Ereignis zur eingestellten Spul-Taste (inkl. exakter Modifier)? */
  SS.matchesHoldKey = function matchesHoldKey(hk, e) {
    return (
      hk.enabled &&
      e.code === hk.code &&
      e.ctrlKey === hk.ctrl &&
      e.altKey === hk.alt &&
      e.shiftKey === hk.shift &&
      e.metaKey === hk.meta
    );
  };

  /** Anzeige wie „Strg+Alt+Punkt“ – code ohne Präfixe Key/Digit. */
  SS.holdKeyLabel = function holdKeyLabel(hk) {
    if (!hk.code) return "keine";
    const names = { Period: ".", Comma: ",", Minus: "-", Equal: "=", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`", BracketLeft: "[", BracketRight: "]", Space: "Leertaste", IntlBackslash: "<" };
    const key = names[hk.code] ?? hk.code.replace(/^Key/, "").replace(/^Digit/, "");
    return [hk.ctrl && "Strg", hk.alt && "Alt", hk.shift && "Shift", key].filter(Boolean).join("+");
  };

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
      holdKey: holdKey(v.holdKey, d.holdKey),
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
