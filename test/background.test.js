// Testet background.js direkt in Node mit einer simulierten WebExtension-API.
const test = require("node:test");
const assert = require("node:assert/strict");

function area() {
  let data = {};
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = typeof keys === "string" ? [keys] : keys;
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      data = { ...data, ...structuredClone(obj) };
    },
    async remove(key) {
      delete data[key];
    },
    dump: () => data,
  };
}

const events = () => {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.forEach((fn) => fn(...a)) };
};

const sent = [];
const badges = {};
const registered = []; // onMessage-Listener von background.js
let activeTabId = 7;
const tabUrls = {}; // tabId → URL der Seite (Standard: example.org)
const browser = {
  storage: { local: area(), session: area() },
  runtime: {
    getURL: (p) => `moz-extension://abc/${p}`,
    onMessage: { addListener: (fn) => registered.push(fn) },
  },
  tabs: {
    sendMessage: async (tabId, msg) => {
      sent.push({ tabId, msg: structuredClone(msg) });
    },
    query: async () => [{ id: activeTabId }],
    get: async (id) => ({ id, url: tabUrls[id] ?? "https://example.org/" }),
    onRemoved: events(),
    onUpdated: events(),
  },
  action: {
    setBadgeText: async ({ tabId, text }) => {
      badges[tabId] = text;
    },
    setBadgeBackgroundColor: async () => {},
  },
  commands: { onCommand: events() },
};
globalThis.browser = browser;
require("../lib/defaults.js");
require("../lib/modes.js");
require("../lib/sites.js");
require("../lib/stats.js");
require("../background.js");
const SS = globalThis.SS;

const POPUP = { url: "moz-extension://abc/popup/popup.html" };
const content = (tabId, frameId = 0, url = "https://example.org/") => ({
  tab: { id: tabId, url: tabUrls[tabId] ?? "https://example.org/" },
  frameId,
  url,
});
const send = async (msg, sender) => await registered[0](msg, sender);
const popup = (msg) => send(msg, POPUP);
const flush = () => new Promise((r) => setTimeout(r, 0));

test("Listener ist registriert", () => {
  assert.equal(registered.length, 1);
});

test("getTabState legt Zustand aus Standard-Modus an", async () => {
  const s = await send({ type: "getTabState" }, content(1));
  assert.equal(s.enabled, false);
  assert.equal(s.rev, 0);
  assert.deepEqual(s.values, SS.DEFAULT_VALUES);
});

test("Popup-Nachrichten aus Webseiten werden ignoriert", async () => {
  assert.equal(registered[0]({ type: "setEnabled", tabId: 1, enabled: true }, content(1)), undefined);
  assert.equal(registered[0]({ type: "getPopupState", tabId: 1 }, { url: "https://evil.example/" }), undefined);
  const s = await send({ type: "getTabState" }, content(1));
  assert.equal(s.enabled, false);
});

test("Content-Nachrichten ohne Tab werden ignoriert", () => {
  assert.equal(registered[0]({ type: "getTabState" }, POPUP), undefined);
});

test("setEnabled erhöht rev, schickt applyState und setzt Badge", async () => {
  sent.length = 0;
  const res = await popup({ type: "setEnabled", tabId: 1, enabled: true });
  assert.equal(res.ok, true);
  assert.equal(res.tab.enabled, true);
  assert.equal(res.tab.rev, 1);
  const apply = sent.find((m) => m.tabId === 1 && m.msg.type === "applyState");
  assert.equal(apply.msg.state.enabled, true);
  assert.equal(apply.msg.state.rev, 1);
  await flush();
  assert.equal(badges[1], "ON");
});

test("setValues prüft Werte und hält die Reihenfolge ein", async () => {
  sent.length = 0;
  const a = popup({ type: "setValues", tabId: 1, values: { ...SS.DEFAULT_VALUES, normalSpeed: 1.5 } });
  const b = popup({ type: "setValues", tabId: 1, values: { ...SS.DEFAULT_VALUES, normalSpeed: 99 } });
  await Promise.all([a, b]);
  const applies = sent.filter((m) => m.msg.type === "applyState").map((m) => m.msg.state);
  assert.deepEqual(
    applies.map((s) => [s.rev, s.values.normalSpeed]),
    [
      [2, 1.5],
      [3, 3],
    ],
  );
});

test("registerFrame, addStats und dropFrames", async () => {
  await send({ type: "registerFrame" }, content(1, 5));
  await send({ type: "registerFrame" }, content(1, 5));
  await send({ type: "registerFrame" }, content(1, 9));
  const delta = { normalRealS: 10, normalMediaS: 15, silenceRealS: 2, silenceMediaS: 6, silences: 1 };
  await send({ type: "addStats", stats: delta }, content(1));
  await send({ type: "addStats", stats: { normalRealS: -4, silences: "x" } }, content(1));
  await send({ type: "addStats", stats: { silenceRealS: 1e9 } }, content(1));
  await send({ type: "addStats", stats: delta }, content(2));
  let st = await popup({ type: "getPopupState", tabId: 1 });
  assert.deepEqual(st.tab.frames, [5, 9]);
  assert.deepEqual(st.tab.stats, { ...delta, silenceRealS: 2 + 3600 });
  assert.deepEqual(st.totalStats, { ...delta, normalRealS: 20, normalMediaS: 30, silenceRealS: 4 + 3600, silenceMediaS: 12, silences: 2 });
  assert.deepEqual(browser.storage.local.dump().stats, st.totalStats, "Insgesamt wird dauerhaft gespeichert");
  assert.ok(st.statsSince > 0);
  await popup({ type: "dropFrames", tabId: 1, frameIds: [5, 0] });
  st = await popup({ type: "getPopupState", tabId: 1 });
  assert.deepEqual(st.tab.frames, [9]);
});

test("Modi: speichern unter, in anderem Tab laden, löschen", async () => {
  await popup({ type: "setValues", tabId: 1, values: { ...SS.DEFAULT_VALUES, silenceSpeed: 5 } });
  const r = await popup({ type: "saveModeAs", tabId: 1, name: "Podcast" });
  const podcastId = r.tab.modeId;
  assert.equal(r.modes[podcastId].values.silenceSpeed, 5);

  const dup = await popup({ type: "saveModeAs", tabId: 1, name: "podcast" });
  assert.deepEqual(dup, { ok: false, error: "duplicate-name" });

  const other = await popup({ type: "loadMode", tabId: 2, modeId: podcastId });
  assert.equal(other.tab.values.silenceSpeed, 5);
  assert.equal(other.tab.enabled, false);

  await popup({ type: "deleteMode", tabId: 1, modeId: podcastId });
  const t1 = await popup({ type: "getPopupState", tabId: 1 });
  const t2 = await popup({ type: "getPopupState", tabId: 2 });
  assert.equal(t1.tab.modeId, null);
  assert.equal(t2.tab.modeId, null);
  assert.equal(t2.tab.values.silenceSpeed, 5);
  assert.equal(t1.modes[podcastId], undefined);

  const noMode = await popup({ type: "saveMode", tabId: 1 });
  assert.deepEqual(noMode, { ok: false, error: "no-mode" });
});

test("Neuer Tab startet mit neuem Standard-Modus, ausgeschaltet", async () => {
  await popup({ type: "setValues", tabId: 1, values: { ...SS.DEFAULT_VALUES, normalSpeed: 1.75 } });
  const r = await popup({ type: "saveModeAs", tabId: 1, name: "Schnell" });
  await popup({ type: "setDefaultMode", tabId: 1, modeId: r.tab.modeId });
  const s = await send({ type: "getTabState" }, content(3));
  assert.equal(s.enabled, false);
  assert.equal(s.values.normalSpeed, 1.75);
});

test("Schnellwahl: Modus einschalten, angepasste Werte bleiben beim selben Modus", async () => {
  const base = await popup({ type: "getPopupState", tabId: 10 });
  const r = await popup({ type: "saveModeAs", tabId: 10, name: "Vortrag" });
  const vortrag = r.tab.modeId;
  assert.ok(r.quickModeIds.includes(vortrag), "Neuer Modus steht in der Schnellwahl");

  sent.length = 0;
  let res = await popup({ type: "activateMode", tabId: 10, modeId: base.defaultModeId });
  assert.equal(res.tab.enabled, true);
  assert.equal(res.tab.modeId, base.defaultModeId);
  assert.equal(sent.at(-1).msg.state.enabled, true);

  await popup({ type: "setValues", tabId: 10, values: { ...res.tab.values, silenceSpeed: 7 } });
  res = await popup({ type: "activateMode", tabId: 10, modeId: base.defaultModeId });
  assert.equal(res.tab.values.silenceSpeed, 7, "Gleicher Modus: Anpassung bleibt");
  res = await popup({ type: "activateMode", tabId: 10, modeId: vortrag });
  assert.equal(res.tab.modeId, vortrag);
  assert.equal(res.tab.values.silenceSpeed, SS.DEFAULT_VALUES.silenceSpeed, "Anderer Modus: dessen Werte");

  res = await popup({ type: "setEnabled", tabId: 10, enabled: false });
  assert.equal(res.tab.enabled, false);
  assert.deepEqual(await popup({ type: "activateMode", tabId: 10, modeId: "weg" }), { ok: false, error: "unknown-mode" });
});

test("Ausgeschlossene Seiten: Tab und Frames bekommen den Ausschluss mit", async () => {
  tabUrls[11] = "https://us02web.zoom.us/j/1";
  await popup({ type: "activateMode", tabId: 11, modeId: (await popup({ type: "getPopupState", tabId: 11 })).defaultModeId });
  let st = await popup({ type: "getPopupState", tabId: 11 });
  assert.equal(st.host, "us02web.zoom.us");
  assert.equal(st.excluded, false);

  sent.length = 0;
  st = await popup({ type: "excludeHost", tabId: 11, host: "https://www.Zoom.us/" });
  assert.deepEqual(st.excludedHosts, ["zoom.us"]);
  assert.equal(st.excluded, true);
  assert.equal(st.tab.enabled, true, "Der Tab bleibt an – die Seite ist nur ausgeschlossen");
  const push = sent.find((m) => m.tabId === 11 && m.msg.type === "applyState");
  assert.equal(push.msg.state.topExcluded, true);
  assert.deepEqual(push.msg.state.excludedHosts, ["zoom.us"]);
  assert.ok(sent.some((m) => m.tabId === 1 && m.msg.type === "applyState" && !m.msg.state.topExcluded), "Andere Tabs bekommen die Liste");
  await flush();
  assert.equal(badges[11], "", "Kein ON-Badge auf ausgeschlossener Seite");

  // Content-Script: Hauptframe mit eigener URL, iframe über die Tab-URL
  let cs = await send({ type: "getTabState" }, content(11, 0, "https://zoom.us/"));
  assert.equal(cs.topExcluded, true);
  cs = await send({ type: "getTabState" }, content(1, 3, "https://zoom.us/embed"));
  assert.equal(cs.topExcluded, false, "Fremdes iframe: der Frame prüft seine Domain selbst");
  assert.deepEqual(cs.excludedHosts, ["zoom.us"]);

  assert.deepEqual(await popup({ type: "excludeHost", tabId: 11, host: "kein host" }), { ok: false, error: "bad-host" });
  st = await popup({ type: "includeHost", tabId: 11, host: "zoom.us" });
  assert.deepEqual(st.excludedHosts, []);
  assert.equal(st.excluded, false);
  assert.deepEqual(browser.storage.local.dump().excludedHosts, []);
});

test("Spul-Taste wird an alle Frames des Tabs weitergegeben", async () => {
  sent.length = 0;
  await send({ type: "hold", on: true }, content(1, 5));
  await send({ type: "hold", on: false }, content(1, 5));
  assert.deepEqual(
    sent.map((m) => [m.tabId, m.msg.type, m.msg.on]),
    [
      [1, "hold", true],
      [1, "hold", false],
    ],
  );
});

test("Tastenkürzel schaltet den aktiven Tab um", async () => {
  activeTabId = 4;
  browser.commands.onCommand.fire("toggle-tab");
  await new Promise((r) => setTimeout(r, 20));
  let s = await send({ type: "getTabState" }, content(4));
  assert.equal(s.enabled, true);
  browser.commands.onCommand.fire("toggle-tab");
  await new Promise((r) => setTimeout(r, 20));
  s = await send({ type: "getTabState" }, content(4));
  assert.equal(s.enabled, false);
});

test("Schließen des Tabs löscht den Zustand", async () => {
  await send({ type: "getTabState" }, content(6));
  assert.ok("tab:6" in browser.storage.session.dump());
  browser.tabs.onRemoved.fire(6);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!("tab:6" in browser.storage.session.dump()));
});
