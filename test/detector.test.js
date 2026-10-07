const test = require("node:test");
const assert = require("node:assert/strict");
const SS = require("../lib/detector.js");
require("../lib/defaults.js");

const W = 20;
function make(over = {}) {
  const values = { ...SS.DEFAULT_VALUES, dynamicThreshold: false, graceMs: 0, ...over };
  const d = new SS.Detector(() => values);
  return { d, values, feed(db, n = 1, state = "playing") {
    let r; for (let i = 0; i < n; i++) r = d.update({ windowMs: W, levelDb: db, mediaState: state }); return r; } };
}

test("erstes playing ist instant Ton", () => {
  const { feed } = make();
  const r = feed(-20);
  assert.equal(r.phase, "sound"); assert.equal(r.changed, true); assert.equal(r.instant, true);
});
test("Stille erst nach minSilenceMs", () => {
  const { feed } = make({ minSilenceMs: 200 });
  feed(-20);
  assert.equal(feed(-70, 9).phase, "sound");
  const r = feed(-70);
  assert.equal(r.phase, "silence"); assert.equal(r.changed, true); assert.equal(r.instant, false);
});
test("Ton kommt sofort zurück", () => {
  const { feed } = make();
  feed(-20); feed(-70, 20);
  const r = feed(-20);
  assert.equal(r.phase, "sound"); assert.equal(r.changed, true); assert.equal(r.instant, false);
});
test("Hysterese verhindert Flattern", () => {
  const { feed } = make({ thresholdDb: -40, hysteresisDb: 3 });
  feed(-20); feed(-50, 20);
  assert.equal(feed(-39).phase, "silence");
  assert.equal(feed(-36.5).phase, "sound");
});
test("kurzer lauter Wert setzt Zähler zurück", () => {
  const { feed } = make({ minSilenceMs: 200 });
  feed(-20); feed(-70, 8); feed(-20); 
  assert.equal(feed(-70, 8).phase, "sound");
});
test("Pause friert ein, Play ist instant Ton", () => {
  const { feed } = make();
  feed(-20); feed(-70, 20);
  const p = feed(-Infinity, 50, "paused");
  assert.equal(p.phase, "silence"); assert.equal(p.changed, false);
  const r = feed(-70);
  assert.equal(r.phase, "sound"); assert.equal(r.instant, true);
});
test("Seeking und Waiting wie Pause", () => {
  for (const s of ["seeking", "waiting"]) {
    const { feed } = make();
    feed(-20); feed(-70, 5); feed(-70, 30, s);
    assert.equal(feed(-70, 5).phase, "sound");
  }
});
test("Schonzeit unterdrückt Stille", () => {
  const { feed } = make({ graceMs: 300, minSilenceMs: 100 });
  feed(-70);
  assert.equal(feed(-70, 14).phase, "sound");
  assert.equal(feed(-70, 5).phase, "silence");
});
test("dynamisch: Warmup nutzt manuellen Wert", () => {
  const { feed } = make({ dynamicThreshold: true, thresholdDb: -40 });
  assert.equal(feed(-30, 10).thresholdDb, -40);
});
test("dynamisch: Perzentil + Abstand", () => {
  const { feed } = make({ dynamicThreshold: true, dynMarginDb: 3 });
  let r;
  for (let i = 0; i < 100; i++) r = feed(i % 2 ? -20 : -50);
  feed(-20, 30);
  r = feed(-20);
  assert.equal(r.thresholdDb, -47);
});
test("dynamisch: Grenzen und -Infinity ignoriert", () => {
  const { feed } = make({ dynamicThreshold: true, dynMarginDb: 0 });
  feed(-90, 100); feed(-Infinity, 100);
  assert.equal(feed(-90, 30).thresholdDb, -60);
  const h = make({ dynamicThreshold: true, dynMarginDb: 0 });
  h.feed(-5, 100);
  assert.equal(h.feed(-5, 30).thresholdDb, -20);
});
test("dynamisch: kein Lernen während Pause", () => {
  const { feed } = make({ dynamicThreshold: true, dynMarginDb: 0, thresholdDb: -40 });
  feed(-90, 500, "paused");
  assert.equal(feed(-30).thresholdDb, -40);
});
