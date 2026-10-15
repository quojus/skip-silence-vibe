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

// ---------- Schnellwahl ----------

function storeWith(names) {
  let s = SS.createInitialStore();
  const ids = { Standard: s.defaultModeId };
  for (const n of names) {
    const r = SS.saveModeAs(s, n, V());
    s = r.store;
    ids[n] = r.id;
  }
  return { s, ids };
}

test("Schnellwahl füllt freie Plätze alphabetisch auf, höchstens 4", () => {
  const { s, ids } = storeWith(["E", "B", "D", "C", "A"]);
  assert.deepEqual(SS.quickModeIds(s), [ids.A, ids.B, ids.C, ids.D]);
});

test("Benutzter Modus bleibt an seinem Platz, neuer ersetzt den ältesten", () => {
  const { s: s0, ids } = storeWith(["A", "B", "C", "D", "E"]);
  let s = SS.touchQuickSlot(s0, ids.C, 10); // Plätze A B C D, C benutzt
  assert.deepEqual(SS.quickModeIds(s), [ids.A, ids.B, ids.C, ids.D]);
  s = SS.touchQuickSlot(s, ids.A, 20);
  s = SS.touchQuickSlot(s, ids.D, 30);
  s = SS.touchQuickSlot(s, ids.B, 40);
  s = SS.touchQuickSlot(s, ids.E, 50); // ersetzt C (am längsten nicht benutzt)
  assert.deepEqual(SS.quickModeIds(s), [ids.A, ids.B, ids.E, ids.D]);
  s = SS.touchQuickSlot(s, ids.Standard, 60); // ersetzt A
  assert.deepEqual(SS.quickModeIds(s), [ids.Standard, ids.B, ids.E, ids.D]);
  code(() => SS.touchQuickSlot(s, "x", 70), "unknown-mode");
});

test("Löschen entfernt den Modus aus der Schnellwahl, andere bleiben stehen", () => {
  const { s: s0, ids } = storeWith(["A", "B", "C", "D", "E"]);
  let s = SS.touchQuickSlot(s0, ids.E, 10); // ersetzt A (alle anderen ungenutzt)
  assert.deepEqual(SS.quickModeIds(s), [ids.E, ids.B, ids.C, ids.D]);
  s = SS.deleteMode(s, ids.B);
  assert.deepEqual(SS.quickModeIds(s), [ids.E, ids.C, ids.D, ids.A]);
});

test("Kaputte gespeicherte Plätze werden bereinigt", () => {
  const { s, ids } = storeWith(["A"]);
  const dirty = { ...s, quickSlots: [null, { id: "weg" }, { id: ids.A, used: "x" }, { id: ids.A, used: 5 }] };
  assert.deepEqual(SS.cleanSlots(dirty), [{ id: ids.A, used: 0 }]);
});
