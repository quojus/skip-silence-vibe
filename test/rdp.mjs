// Minimaler Client für das Firefox Remote Debugging Protocol (Pakete "länge:json").
// Wird im E2E-Test genutzt, um Code in Seiten der echten Extension (Background, Popup) auszuführen.
import net from "node:net";

const EVENT_TYPES = new Set([
  "evaluationResult",
  "tabNavigated",
  "frameUpdate",
  "resource-available-form",
  "target-available-form",
  "target-destroyed-form",
]);

export async function connectRdp(port) {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  let buf = Buffer.alloc(0);
  const packets = [];
  const waiting = [];

  function dispatch(p) {
    const i = waiting.findIndex((w) => w.match(p));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(p);
    else packets.push(p);
  }

  sock.on("data", (data) => {
    buf = Buffer.concat([buf, data]);
    for (;;) {
      const sep = buf.indexOf(":");
      if (sep < 0) return;
      const len = parseInt(buf.subarray(0, sep).toString(), 10);
      if (buf.length < sep + 1 + len) return;
      dispatch(JSON.parse(buf.subarray(sep + 1, sep + 1 + len).toString()));
      buf = buf.subarray(sep + 1 + len);
    }
  });

  function next(match, timeoutMs = 10000) {
    const i = packets.findIndex(match);
    if (i >= 0) return Promise.resolve(packets.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { match, resolve };
      waiting.push(entry);
      setTimeout(() => {
        const j = waiting.indexOf(entry);
        if (j >= 0) {
          waiting.splice(j, 1);
          reject(new Error("RDP: Zeitüberschreitung"));
        }
      }, timeoutMs);
    });
  }

  async function request(to, type, extra = {}) {
    const s = JSON.stringify({ to, type, ...extra });
    sock.write(`${Buffer.byteLength(s)}:${s}`);
    const reply = await next((p) => p.from === to && !EVENT_TYPES.has(p.type));
    if (reply.error) throw new Error(`RDP ${type}: ${reply.error} ${reply.message ?? ""}`);
    return reply;
  }

  await next((p) => p.from === "root");

  /**
   * Verbindet sich mit einer Extension. pageOf(muster) liefert eine Funktion, die JS in der
   * Extension-Seite auswertet, deren URL auf das Muster passt (Background, Popup-Tab, …).
   */
  async function extension(addonId) {
    const { addons } = await request("root", "listAddons");
    const addon = addons.find((a) => a.id === addonId);
    if (!addon) throw new Error(`Extension ${addonId} nicht installiert`);
    const { actor: watcher } = await request(addon.actor, "getWatcher");
    await request(watcher, "watchTargets", { targetType: "frame" });

    async function pageOf(urlPattern) {
      const ev = await next((p) => p.type === "target-available-form" && p.from === watcher && urlPattern.test(p.target?.url ?? ""));
      return evaluator(ev.target.consoleActor);
    }
    return { pageOf };
  }

  function evaluator(consoleActor) {
    async function evaluate(text) {
      const { resultID } = await request(consoleActor, "evaluateJSAsync", { text });
      const res = await next((p) => p.type === "evaluationResult" && p.resultID === resultID);
      if (res.hasException) throw new Error(`Extension: ${JSON.stringify(res.exceptionMessage)}`);
      return res.result;
    }

    return async (asyncFnSource, timeoutMs = 10000) => {
      const key = `__e2e${Math.random().toString(36).slice(2)}`;
      await evaluate(
        `(${asyncFnSource})().then((r) => { globalThis.${key} = JSON.stringify({ ok: r }); },` +
          ` (e) => { globalThis.${key} = JSON.stringify({ err: String(e) }); }); 0`,
      );
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const r = await evaluate(`globalThis.${key} ?? ""`);
        if (typeof r === "string" && r) {
          const parsed = JSON.parse(r);
          if ("err" in parsed) throw new Error(`Extension: ${parsed.err}`);
          return parsed.ok;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Extension: keine Antwort");
    };
  }

  return { extension, close: () => sock.destroy() };
}
