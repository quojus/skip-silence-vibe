// Ersetzt die WebExtension-API für den Integrationstest. Das Szenario kommt aus ?s=…
(() => {
  const SCENARIO_VALUES = {
    rate: { muteSilence: false },
    mute: { muteSilence: true, lookahead: true },
    muted: { muteSilence: true, lookahead: true },
    disable: { muteSilence: true, lookahead: true },
    override: { muteSilence: false },
    refresh: { muteSilence: false },
    elmuted: { muteSilence: false },
    cors: { muteSilence: false },
    foreign: { muteSilence: false },
    redirect: { muteSilence: false },
    muteinsilence: { muteSilence: false },
    silentloss: { muteSilence: false },
    lateshadow: { muteSilence: false },
  };
  const scenario = new URLSearchParams(location.search).get("s") || "rate";
  const listeners = [];
  globalThis.__scenario = scenario;
  globalThis.__harnessMessages = [];
  globalThis.__values = () => ({
    ...globalThis.SS.DEFAULT_VALUES,
    dynamicThreshold: false,
    thresholdDb: -40,
    minSilenceMs: 200,
    graceMs: 300,
    ...SCENARIO_VALUES[scenario],
  });
  globalThis.browser = {
    runtime: {
      getURL: (p) => `/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        globalThis.__harnessMessages.push(msg);
        if (msg.type === "getTabState") return { enabled: true, rev: 0, values: globalThis.__values() };
        return { ok: true };
      },
    },
  };
  globalThis.__harnessSend = (msg) => listeners.map((fn) => fn(msg, {}));

  // Ausgang der Extension mitschneiden: GainNode → destination wird auf einen Analyser
  // umgeleitet. Der Analyser misst den Pegel, die Lautsprecher bleiben still.
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && this instanceof GainNode) {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 2048;
      globalThis.__outAnalyser = analyser;
      return connect.call(this, analyser);
    }
    return connect.call(this, dest, ...rest);
  };
  globalThis.__outDb = () => {
    const a = globalThis.__outAnalyser;
    if (!a) return -Infinity;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    return 10 * Math.log10(sum / buf.length);
  };
})();
