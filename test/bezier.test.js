const test = require("node:test");
const assert = require("node:assert/strict");
const SS = require("../lib/bezier.js");
const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test("Endpunkte", () => {
  for (const b of [[0,0,1,1],[0.42,0,0.58,1],[0.1,1.5,0.9,-0.5]]) {
    near(SS.bezierY(b, 0), 0); near(SS.bezierY(b, 1), 1);
  }
});
test("linear ist Identität", () => { near(SS.bezierY([0,0,1,1], 0.3), 0.3); });
test("ease-in-out ist symmetrisch", () => {
  near(SS.bezierY([0.42,0,0.58,1], 0.5), 0.5);
  near(SS.bezierY([0.42,0,0.58,1], 0.25) + SS.bezierY([0.42,0,0.58,1], 0.75), 1);
});
test("ease-in bekannter Wert", () => { near(SS.bezierY([0.42,0,1,1], 0.5), 0.3153, 2e-3); });
test("t außerhalb wird begrenzt", () => { near(SS.bezierY([0,0,1,1], -1), 0); near(SS.bezierY([0,0,1,1], 2), 1); });
test("monotone Kurve bleibt monoton", () => {
  const s = SS.sampleBezier([0.42,0,0.58,1], 64);
  assert.equal(s.length, 64);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i-1] - 1e-9);
});
