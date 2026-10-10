const test = require("node:test");
const assert = require("node:assert/strict");
const SS = require("../lib/defaults.js");

test("leere Eingabe liefert Standardwerte", () => {
  assert.deepEqual(SS.clampValues(undefined), SS.DEFAULT_VALUES);
  assert.deepEqual(SS.clampValues({}), SS.DEFAULT_VALUES);
});
test("betterSample: spielend, dann messbar, dann lauter", () => {
  const base = { playing: true, muted: false, foreign: false, levelDb: -100 };
  assert.equal(SS.betterSample(base, null), true);
  assert.equal(SS.betterSample({ ...base, playing: false, levelDb: 0 }, base), false);
  assert.equal(SS.betterSample(base, { ...base, muted: true }), true);
  assert.equal(SS.betterSample({ ...base, muted: true }, base), false);
  assert.equal(SS.betterSample(base, { ...base, foreign: true, levelDb: -10 }), true);
  assert.equal(SS.betterSample({ ...base, levelDb: -20 }, { ...base, levelDb: -30 }), true);
  assert.equal(SS.betterSample({ ...base, levelDb: -30 }, { ...base, levelDb: -20 }), false);
});

test("Spul-Taste: Standard aus, Validierung, Anzeige", () => {
  assert.deepEqual(SS.clampValues({}).holdKey, { enabled: false, code: "", ctrl: false, alt: false, shift: false, meta: false });
  const ok = SS.clampValues({ holdKey: { enabled: true, code: "Period", shift: true } }).holdKey;
  assert.equal(ok.enabled, true);
  assert.equal(ok.shift, true);
  assert.equal(SS.holdKeyLabel(ok), "Shift+.");
  assert.equal(SS.holdKeyLabel({ code: "KeyF", ctrl: true, alt: false, shift: false, meta: false }), "Strg+F");
  // ungültiger Code oder reine Modifier-Taste → keine Taste, aus
  for (const code of ["<script>", "ShiftLeft", "Control", "", 5]) {
    const hk = SS.clampValues({ holdKey: { enabled: true, code } }).holdKey;
    assert.equal(hk.enabled, false, String(code));
    assert.equal(hk.code, "", String(code));
  }
});

test("Spul-Taste: Ereignis passt nur mit exakten Modifiern", () => {
  const hk = SS.clampValues({ holdKey: { enabled: true, code: "KeyF", ctrl: true } }).holdKey;
  const ev = (o) => ({ code: "KeyF", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(SS.matchesHoldKey(hk, ev({ ctrlKey: true })), true);
  assert.equal(SS.matchesHoldKey(hk, ev({})), false);
  assert.equal(SS.matchesHoldKey(hk, ev({ ctrlKey: true, shiftKey: true })), false);
  assert.equal(SS.matchesHoldKey({ ...hk, enabled: false }, ev({ ctrlKey: true })), false);
});

test("Ergebnis ist eine unabhängige Kopie", () => {
  const v = SS.clampValues({});
  v.rampIn.bezier[0] = 0.9;
  v.normalSpeed = 2;
  assert.equal(SS.DEFAULT_VALUES.rampIn.bezier[0], 0.42);
  assert.equal(SS.DEFAULT_VALUES.normalSpeed, 1);
});
test("Zahlen werden begrenzt", () => {
  const v = SS.clampValues({ normalSpeed: 99, silenceSpeed: 0, thresholdDb: -200 });
  assert.equal(v.normalSpeed, 3);
  assert.equal(v.silenceSpeed, 1);
  assert.equal(v.thresholdDb, -80);
});
test("ungültige Typen fallen auf Standard", () => {
  const v = SS.clampValues({ normalSpeed: "x", muteSilence: "ja", graceMs: NaN });
  assert.equal(v.normalSpeed, 1);
  assert.equal(v.muteSilence, false);
  assert.equal(v.graceMs, 300);
});
test("Bézier wird geprüft und begrenzt", () => {
  const v = SS.clampValues({ rampIn: { durationMs: 5000, bezier: [2, 3, -1, -2] } });
  assert.deepEqual(v.rampIn.bezier, [1, 1.5, 0, -0.5]);
  assert.equal(v.rampIn.durationMs, 1000);
  const w = SS.clampValues({ rampOut: { bezier: [1, 2] } });
  assert.deepEqual(w.rampOut.bezier, [0, 0, 0.58, 1]);
});
