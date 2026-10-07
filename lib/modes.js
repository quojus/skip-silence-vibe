// Modi: benannte Wertesätze. Alle Funktionen sind rein und liefern neue Objekte.
(() => {
  const SS = (globalThis.SS = globalThis.SS || {});

  function fail(code) {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  const copy = (store) => structuredClone(store);

  SS.newId = () => globalThis.crypto.randomUUID();

  SS.createInitialStore = function createInitialStore() {
    const id = SS.newId();
    return {
      modes: { [id]: { name: "Standard", values: SS.clampValues(SS.DEFAULT_VALUES) } },
      defaultModeId: id,
    };
  };

  SS.sortedModes = function sortedModes(store) {
    return Object.entries(store.modes)
      .map(([id, m]) => ({ id, name: m.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  };

  SS.saveModeAs = function saveModeAs(store, name, values) {
    const clean = String(name ?? "").trim();
    if (!clean) throw fail("empty-name");
    const lower = clean.toLocaleLowerCase("de");
    if (Object.values(store.modes).some((m) => m.name.toLocaleLowerCase("de") === lower)) {
      throw fail("duplicate-name");
    }
    const next = copy(store);
    const id = SS.newId();
    next.modes[id] = { name: clean, values: SS.clampValues(values) };
    return { store: next, id };
  };

  SS.saveMode = function saveMode(store, id, values) {
    if (!store.modes[id]) throw fail("unknown-mode");
    const next = copy(store);
    next.modes[id].values = SS.clampValues(values);
    return next;
  };

  SS.deleteMode = function deleteMode(store, id) {
    if (!store.modes[id]) throw fail("unknown-mode");
    if (Object.keys(store.modes).length <= 1) throw fail("last-mode");
    const next = copy(store);
    delete next.modes[id];
    if (next.defaultModeId === id) next.defaultModeId = SS.sortedModes(next)[0].id;
    return next;
  };

  SS.setDefaultMode = function setDefaultMode(store, id) {
    if (!store.modes[id]) throw fail("unknown-mode");
    const next = copy(store);
    next.defaultModeId = id;
    return next;
  };

  SS.valuesEqual = function valuesEqual(a, b) {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
    if (Array.isArray(a) || Array.isArray(b)) {
      return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((x, i) => valuesEqual(x, b[i]))
      );
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) if (!valuesEqual(a[k], b[k])) return false;
      return true;
    }
    return a === b;
  };

  if (typeof module !== "undefined") module.exports = SS;
})();
