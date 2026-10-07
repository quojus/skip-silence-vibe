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
  globalThis.__sent = [];
  globalThis.browser = {
    storage: { local: area(), session: area() },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        for (const fn of listeners) {
          const r = fn(structuredClone(msg), {});
          if (r !== undefined) return structuredClone(await r);
        }
        return undefined;
      },
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (tabId, msg) => {
        globalThis.__sent.push(structuredClone(msg));
        if (msg.type === "getLevel") {
          return { mediaCount: 1, unsupportedCount: 0, playing: true, levelDb: -28, thresholdDb: -46, phase: "sound" };
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
