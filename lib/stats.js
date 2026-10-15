// Statistik: abgespielte Zeit getrennt nach Ton (Normalgeschwindigkeit) und Stille.
// „Echt“ ist die vergangene Zeit, „Medium“ die abgespielte Medienzeit. Gespart = Medium − echt.
(() => {
  const SS = (globalThis.SS = globalThis.SS || {});

  const TIME_KEYS = ["normalRealS", "normalMediaS", "silenceRealS", "silenceMediaS"];
  const MAX_REAL_PER_MSG_S = 3600; // mehr kann zwischen zwei Meldungen nicht vergehen
  const MAX_RATE = 16; // Firefox-Grenze für playbackRate
  const MAX_SILENCES_PER_MSG = 10000;

  SS.emptyStats = () => ({ normalRealS: 0, normalMediaS: 0, silenceRealS: 0, silenceMediaS: 0, silences: 0 });

  const num = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

  /** Meldung eines Content-Scripts prüfen und begrenzen. */
  SS.cleanStatsDelta = function cleanStatsDelta(d) {
    const out = SS.emptyStats();
    if (!d || typeof d !== "object") return out;
    out.normalRealS = Math.min(num(d.normalRealS), MAX_REAL_PER_MSG_S);
    out.silenceRealS = Math.min(num(d.silenceRealS), MAX_REAL_PER_MSG_S);
    out.normalMediaS = Math.min(num(d.normalMediaS), out.normalRealS * MAX_RATE);
    out.silenceMediaS = Math.min(num(d.silenceMediaS), out.silenceRealS * MAX_RATE);
    out.silences = Math.min(Math.floor(num(d.silences)), MAX_SILENCES_PER_MSG);
    return out;
  };

  SS.isEmptyStats = (s) => TIME_KEYS.every((k) => s[k] === 0) && s.silences === 0;

  /** Summe zweier Statistiken; fehlende oder ungültige Felder zählen als 0. */
  SS.addStats = function addStats(a, b) {
    const out = SS.emptyStats();
    for (const k of [...TIME_KEYS, "silences"]) out[k] = num(a?.[k]) + num(b?.[k]);
    return out;
  };

  /** Abgeleitete Werte für die Anzeige. */
  SS.statsSummary = function statsSummary(s) {
    const savedNormal = s.normalMediaS - s.normalRealS;
    const savedSilence = s.silenceMediaS - s.silenceRealS;
    return {
      savedNormal,
      savedSilence,
      savedTotal: savedNormal + savedSilence,
      mediaS: s.normalMediaS + s.silenceMediaS,
      realS: s.normalRealS + s.silenceRealS,
      silences: s.silences,
    };
  };

  if (typeof module !== "undefined") module.exports = SS;
})();
