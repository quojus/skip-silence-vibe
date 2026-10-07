const test = require("node:test");
const assert = require("node:assert/strict");
const SS = require("../lib/defaults.js");

test("leere Eingabe liefert Standardwerte", () => {
  assert.deepEqual(SS.clampValues(undefined), SS.DEFAULT_VALUES);
  assert.deepEqual(SS.clampValues({}), SS.DEFAULT_VALUES);
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
