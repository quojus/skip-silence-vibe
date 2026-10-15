const test = require("node:test");
const assert = require("node:assert/strict");
const SS = require("../lib/stats.js");

test("Meldungen werden geprüft und begrenzt", () => {
  const d = SS.cleanStatsDelta({
    normalRealS: 10,
    normalMediaS: 15,
    silenceRealS: 1e9,
    silenceMediaS: Infinity,
    silences: 2.7,
  });
  assert.equal(d.normalRealS, 10);
  assert.equal(d.normalMediaS, 15);
  assert.equal(d.silenceRealS, 3600);
  assert.equal(d.silenceMediaS, 0);
  assert.equal(d.silences, 2);
  const capped = SS.cleanStatsDelta({ normalRealS: 1, normalMediaS: 100 });
  assert.equal(capped.normalMediaS, 16, "Medienzeit höchstens 16x die echte Zeit");
  assert.ok(SS.isEmptyStats(SS.cleanStatsDelta({ normalRealS: -5, silences: "x" })));
  assert.ok(SS.isEmptyStats(SS.cleanStatsDelta(null)));
});

test("Summe und Anzeige: gespart getrennt nach Ton und Stille", () => {
  const a = SS.addStats(undefined, { normalRealS: 100, normalMediaS: 150, silenceRealS: 10, silenceMediaS: 40, silences: 3 });
  const b = SS.addStats(a, { normalRealS: 20, normalMediaS: 10, silences: 1 });
  const s = SS.statsSummary(b);
  assert.equal(s.savedNormal, 160 - 120);
  assert.equal(s.savedSilence, 30);
  assert.equal(s.savedTotal, 70);
  assert.equal(s.mediaS, 200);
  assert.equal(s.realS, 130);
  assert.equal(s.silences, 4);
});

test("Langsamer als 1x ergibt negative Ersparnis", () => {
  const s = SS.statsSummary(SS.addStats(null, { normalRealS: 100, normalMediaS: 80 }));
  assert.equal(s.savedNormal, -20);
});
