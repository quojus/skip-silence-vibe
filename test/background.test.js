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
require("../background.js");
const SS = globalThis.SS;

const POPUP = { url: "moz-extension://abc/popup/popup.html" };
const content = (tabId, frameId = 0) => ({ tab: { id: tabId }, frameId, url: "https://example.org/" });
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

test("registerFrame, addSaved und dropFrames", async () => {
  await send({ type: "registerFrame" }, content(1, 5));
  await send({ type: "registerFrame" }, content(1, 5));
  await send({ type: "registerFrame" }, content(1, 9));
  await send({ type: "addSaved", seconds: 2.5 }, content(1));
  await send({ type: "addSaved", seconds: -4 }, content(1));
  await send({ type: "addSaved", seconds: "x" }, content(1));
  await send({ type: "addSaved", seconds: 1e9 }, content(1));
  let st = await popup({ type: "getPopupState", tabId: 1 });
  assert.deepEqual(st.tab.frames, [5, 9]);
  assert.equal(st.tab.savedSeconds, 2.5 + 3600);
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
