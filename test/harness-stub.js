// Ersetzt die WebExtension-API für den Integrationstest.
(() => {
  const listeners = [];
  globalThis.__harnessMessages = [];
  globalThis.browser = {
    runtime: {
      getURL: (p) => `/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        globalThis.__harnessMessages.push(msg);
        if (msg.type === "getTabState") {
          return {
            enabled: true,
            rev: 0,
            values: {
              ...globalThis.SS.DEFAULT_VALUES,
              dynamicThreshold: false,
              thresholdDb: -40,
              minSilenceMs: 200,
              graceMs: 300,
            },
          };
        }
        return { ok: true };
      },
    },
  };
  globalThis.__harnessSend = (msg) => listeners.map((fn) => fn(msg, {}));
})();
