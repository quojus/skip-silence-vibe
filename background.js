// Hält die Einstellungen pro Tab (storage.session) und die Modi (storage.local).
// Alle Änderungen laufen seriell über eine Warteschlange.
(() => {
  const TAB_PREFIX = "tab:";
  const MAX_FRAMES = 50;
  const MAX_SAVED_PER_MSG_S = 3600;
  const BADGE_COLOR = "#3d8b5f";

  let queue = Promise.resolve();
  function run(fn) {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }

  function fail(code) {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  // ---------- Modi ----------

  let storeCache = null;

  async function loadStore() {
    if (storeCache) return storeCache;
    const data = await browser.storage.local.get(["modes", "defaultModeId"]);
    const modes = data.modes && typeof data.modes === "object" ? data.modes : null;
    if (modes && Object.keys(modes).length > 0) {
      const defaultModeId = modes[data.defaultModeId] ? data.defaultModeId : Object.keys(modes)[0];
      storeCache = { modes, defaultModeId };
      if (defaultModeId !== data.defaultModeId) await browser.storage.local.set(storeCache);
    } else {
      storeCache = SS.createInitialStore();
      await browser.storage.local.set(storeCache);
    }
    return storeCache;
  }

  async function putStore(store) {
    storeCache = store;
    await browser.storage.local.set(store);
  }

  // ---------- Tab-Zustände ----------

  const keyOf = (tabId) => TAB_PREFIX + tabId;

  async function getTab(tabId) {
    const key = keyOf(tabId);
    const data = await browser.storage.session.get(key);
    if (data[key]) return data[key];
    const store = await loadStore();
    const tab = {
      enabled: false,
      modeId: store.defaultModeId,
      values: SS.clampValues(store.modes[store.defaultModeId].values),
      savedSeconds: 0,
      frames: [],
      rev: 0,
    };
    await browser.storage.session.set({ [key]: tab });
    return tab;
  }

  /** Speichert den Zustand. Mit push=true bekommen alle Frames des Tabs die neuen Werte. */
  async function putTab(tabId, tab, push) {
    if (push) tab.rev += 1;
    await browser.storage.session.set({ [keyOf(tabId)]: tab });
    if (push) {
      browser.tabs
        .sendMessage(tabId, {
          type: "applyState",
          state: { enabled: tab.enabled, values: tab.values, rev: tab.rev },
        })
        .catch(() => {});
      updateBadge(tabId, tab);
    }
  }

  function updateBadge(tabId, tab) {
    browser.action.setBadgeText({ tabId, text: tab.enabled ? "ON" : "" }).catch(() => {});
    browser.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
  }

  async function popupState(tabId) {
    const [tab, store] = await Promise.all([getTab(tabId), loadStore()]);
    return { ok: true, tab, modes: store.modes, defaultModeId: store.defaultModeId };
  }

  function requireTabId(msg) {
    if (!Number.isInteger(msg.tabId)) throw fail("bad-tab");
    return msg.tabId;
  }

  // ---------- Nachrichten ----------

  const contentHandlers = {
    async getTabState(msg, tabId) {
      const tab = await getTab(tabId);
      return { enabled: tab.enabled, values: tab.values, rev: tab.rev };
    },
    async registerFrame(msg, tabId, frameId) {
      const tab = await getTab(tabId);
      if (!tab.frames.includes(frameId)) {
        tab.frames = [...tab.frames, frameId].slice(-MAX_FRAMES);
        await putTab(tabId, tab, false);
      }
      return { ok: true };
    },
    async hold(msg, tabId) {
      // Spul-Taste an alle Frames des Tabs weitergeben (auch iframes ohne Fokus)
      browser.tabs.sendMessage(tabId, { type: "hold", on: !!msg.on }).catch(() => {});
      return { ok: true };
    },
    async addSaved(msg, tabId) {
      const s = Number(msg.seconds);
      if (!Number.isFinite(s) || s <= 0) return { ok: true };
      const tab = await getTab(tabId);
      tab.savedSeconds += Math.min(s, MAX_SAVED_PER_MSG_S);
      await putTab(tabId, tab, false);
      return { ok: true };
    },
  };

  const popupHandlers = {
    async getPopupState(msg) {
      return popupState(requireTabId(msg));
    },
    async dropFrames(msg) {
      const tabId = requireTabId(msg);
      const drop = new Set(Array.isArray(msg.frameIds) ? msg.frameIds : []);
      drop.delete(0);
      const tab = await getTab(tabId);
      const frames = tab.frames.filter((f) => !drop.has(f));
      if (frames.length !== tab.frames.length) {
        tab.frames = frames;
        await putTab(tabId, tab, false);
      }
      return { ok: true };
    },
    async setEnabled(msg) {
      const tabId = requireTabId(msg);
      const tab = await getTab(tabId);
      tab.enabled = !!msg.enabled;
      await putTab(tabId, tab, true);
      return popupState(tabId);
    },
    async setValues(msg) {
      const tabId = requireTabId(msg);
      const tab = await getTab(tabId);
      tab.values = SS.clampValues(msg.values);
      await putTab(tabId, tab, true);
      return popupState(tabId);
    },
    async loadMode(msg) {
      const tabId = requireTabId(msg);
      const store = await loadStore();
      const mode = store.modes[msg.modeId];
      if (!mode) throw fail("unknown-mode");
      const tab = await getTab(tabId);
      tab.modeId = msg.modeId;
      tab.values = SS.clampValues(mode.values);
      await putTab(tabId, tab, true);
      return popupState(tabId);
    },
    async saveMode(msg) {
      const tabId = requireTabId(msg);
      const tab = await getTab(tabId);
      if (!tab.modeId) throw fail("no-mode");
      await putStore(SS.saveMode(await loadStore(), tab.modeId, tab.values));
      return popupState(tabId);
    },
    async saveModeAs(msg) {
      const tabId = requireTabId(msg);
      const tab = await getTab(tabId);
      const { store, id } = SS.saveModeAs(await loadStore(), msg.name, tab.values);
      await putStore(store);
      tab.modeId = id;
      await putTab(tabId, tab, false);
      return popupState(tabId);
    },
    async resetToMode(msg) {
      const tabId = requireTabId(msg);
      const tab = await getTab(tabId);
      const store = await loadStore();
      if (!tab.modeId || !store.modes[tab.modeId]) throw fail("no-mode");
      tab.values = SS.clampValues(store.modes[tab.modeId].values);
      await putTab(tabId, tab, true);
      return popupState(tabId);
    },
    async setDefaultMode(msg) {
      await putStore(SS.setDefaultMode(await loadStore(), msg.modeId));
      return popupState(requireTabId(msg));
    },
    async deleteMode(msg) {
      await putStore(SS.deleteMode(await loadStore(), msg.modeId));
      // Tabs mit diesem Modus behalten ihre Werte, verlieren aber die Zuordnung
      const all = await browser.storage.session.get(null);
      const updates = {};
      for (const [key, tab] of Object.entries(all)) {
        if (key.startsWith(TAB_PREFIX) && tab.modeId === msg.modeId) {
          updates[key] = { ...tab, modeId: null };
        }
      }
      if (Object.keys(updates).length) await browser.storage.session.set(updates);
      return popupState(requireTabId(msg));
    },
  };

  function isExtensionPage(sender) {
    return typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL(""));
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg.type !== "string") return undefined;

    if (Object.hasOwn(contentHandlers, msg.type)) {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) return undefined;
      return run(() => contentHandlers[msg.type](msg, tabId, sender.frameId ?? 0));
    }

    if (Object.hasOwn(popupHandlers, msg.type)) {
      // Nur aus Extension-Seiten (Popup), nie aus Content-Scripts in Webseiten
      if (!isExtensionPage(sender)) return undefined;
      return run(() => popupHandlers[msg.type](msg)).catch((err) => ({
        ok: false,
        error: err.code || String(err.message || err),
      }));
    }
    return undefined;
  });

  // ---------- Tabs, Kürzel ----------

  browser.tabs.onRemoved.addListener((tabId) => {
    run(() => browser.storage.session.remove(keyOf(tabId)));
  });

  // Firefox setzt tab-spezifische Badges bei Navigation zurück.
  // Veraltete Frame-IDs entfernt das Popup per dropFrames (ein Zurücksetzen hier
  // könnte die Anmeldung der neuen Seite überholen).
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "loading") return;
    run(async () => {
      const data = await browser.storage.session.get(keyOf(tabId));
      if (data[keyOf(tabId)]) updateBadge(tabId, data[keyOf(tabId)]);
    });
  });

  browser.commands.onCommand.addListener((command) => {
    if (command !== "toggle-tab") return;
    browser.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      if (!active) return;
      run(async () => {
        const tab = await getTab(active.id);
        tab.enabled = !tab.enabled;
        await putTab(active.id, tab, true);
      });
    });
  });
})();
