const test = require("node:test");
const assert = require("node:assert/strict");
const SS = require("../lib/sites.js");

test("Domain aus Eingabe oder URL, ohne www und Großbuchstaben", () => {
  assert.equal(SS.normalizeHost("Zoom.us"), "zoom.us");
  assert.equal(SS.normalizeHost("  https://www.YouTube.com/watch?v=1 "), "youtube.com");
  assert.equal(SS.normalizeHost("example.org."), "example.org");
  assert.equal(SS.normalizeHost("localhost:8080/x"), "localhost");
  assert.equal(SS.normalizeHost("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(SS.normalizeHost("192.168.2.135:3000"), "192.168.2.135");
});

test("Ungültige Eingaben werden abgelehnt", () => {
  for (const bad of ["", "   ", "ftp://example.org", "file:///etc", "a b.de", "moz-extension://abc", "3", "10.1", "intranet", null, 42]) {
    assert.equal(SS.normalizeHost(bad), null, String(bad));
  }
});

test("Domain gilt auch für Subdomains, aber nicht für ähnliche Namen", () => {
  const list = ["zoom.us", "example.org"];
  assert.ok(SS.hostExcluded("zoom.us", list));
  assert.ok(SS.hostExcluded("www.zoom.us", list));
  assert.ok(SS.hostExcluded("us02web.ZOOM.us.", list));
  assert.ok(!SS.hostExcluded("notzoom.us", list));
  assert.ok(!SS.hostExcluded("zoom.us.evil.com", list));
  assert.ok(!SS.hostExcluded("", list));
  assert.ok(!SS.hostExcluded("zoom.us", undefined));
});

test("Hostname nur für http(s)", () => {
  assert.equal(SS.hostOfUrl("https://Www.Example.org/a"), "www.example.org");
  assert.equal(SS.hostOfUrl("about:blank"), null);
  assert.equal(SS.hostOfUrl(null), null);
});

test("Gespeicherte Liste wird bereinigt", () => {
  assert.deepEqual(SS.cleanExcluded(["b.de", "www.B.de", "x y", 3, "a.de"]), ["a.de", "b.de"]);
  assert.deepEqual(SS.cleanExcluded("a.de"), []);
});
