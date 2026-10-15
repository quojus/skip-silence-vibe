// Simulierte WebExtension-API: Popup und echtes background.js laufen in derselben Seite.
(() => {
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
    };
  }
  const listeners = [];
  const noopEvent = { addListener() {} };
  // Nachricht wie von einem Content-Script im Tab 1 schicken (z. B. Statistik)
  globalThis.__contentSend = async (msg) => {
    for (const fn of listeners) {
      const r = fn(structuredClone(msg), { tab: { id: 1, url: globalThis.__tabUrl }, frameId: 0, url: globalThis.__tabUrl });
      if (r !== undefined) return structuredClone(await r);
    }
    return undefined;
  };
  globalThis.__sent = [];
  globalThis.__levelOverride = {}; // Tests setzen hier z. B. { foreign: true }
  globalThis.__tabUrl = "https://www.example.org/video";
  globalThis.browser = {
    storage: { local: area(), session: area() },
    runtime: {
      getURL: (p) => `moz-extension://test/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        for (const fn of listeners) {
          const r = fn(structuredClone(msg), { url: "moz-extension://test/popup/popup.html" });
          if (r !== undefined) return structuredClone(await r);
        }
        return undefined;
      },
    },
    tabs: {
      query: async () => [{ id: 1 }],
      get: async (id) => ({ id, url: globalThis.__tabUrl }),
      sendMessage: async (tabId, msg) => {
        globalThis.__sent.push(structuredClone(msg));
        if (msg.type === "getLevel") {
          return {
            mediaCount: 1,
            unsupportedCount: 0,
            playing: true,
            levelDb: -28,
            thresholdDb: -46,
            phase: "sound",
            ...globalThis.__levelOverride,
          };
        }
        return undefined;
      },
      onRemoved: noopEvent,
      onUpdated: noopEvent,
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    commands: { onCommand: noopEvent },
  };
})();
