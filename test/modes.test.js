const test = require("node:test");
const assert = require("node:assert/strict");
require("../lib/defaults.js");
const SS = require("../lib/modes.js");
const V = () => SS.cloneValues(SS.DEFAULT_VALUES);
const code = (fn, c) => assert.throws(fn, (e) => e.code === c);

test("Initialer Store hat Standard-Modus", () => {
  const s = SS.createInitialStore();
  assert.equal(s.modes[s.defaultModeId].name, "Standard");
});
test("Speichern unter legt neuen Modus an", () => {
  const s0 = SS.createInitialStore();
  const { store, id } = SS.saveModeAs(s0, " Podcast ", { ...V(), silenceSpeed: 5 });
  assert.equal(store.modes[id].name, "Podcast");
  assert.equal(store.modes[id].values.silenceSpeed, 5);
  assert.equal(Object.keys(s0.modes).length, 1);
});
test("leere und doppelte Namen abgelehnt", () => {
  const s = SS.createInitialStore();
  code(() => SS.saveModeAs(s, "  ", V()), "empty-name");
  code(() => SS.saveModeAs(s, "standard", V()), "duplicate-name");
});
test("Speichern überschreibt Werte", () => {
  const s = SS.createInitialStore();
  const t = SS.saveMode(s, s.defaultModeId, { ...V(), normalSpeed: 1.5 });
  assert.equal(t.modes[s.defaultModeId].values.normalSpeed, 1.5);
  assert.equal(s.modes[s.defaultModeId].values.normalSpeed, 1);
  code(() => SS.saveMode(s, "x", V()), "unknown-mode");
});
test("Löschen: letzter Modus verboten, Standard wandert", () => {
  const s = SS.createInitialStore();
  code(() => SS.deleteMode(s, s.defaultModeId), "last-mode");
  const { store, id } = SS.saveModeAs(s, "Hörbuch", V());
  const t = SS.deleteMode(store, s.defaultModeId);
  assert.equal(t.defaultModeId, id);
  assert.equal(t.modes[s.defaultModeId], undefined);
});
test("Standard setzen", () => {
  const { store, id } = SS.saveModeAs(SS.createInitialStore(), "A", V());
  assert.equal(SS.setDefaultMode(store, id).defaultModeId, id);
});
test("valuesEqual vergleicht tief", () => {
  assert.ok(SS.valuesEqual(V(), V()));
  const b = V(); b.rampIn.bezier[1] = 0.1;
  assert.ok(!SS.valuesEqual(V(), b));
});
