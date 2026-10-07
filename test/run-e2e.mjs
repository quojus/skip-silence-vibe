// Ende-zu-Ende-Test: echte Extension in Firefox, Seite mit strenger CSP.
// Prüft für <audio> im DOM, im geschlossenen Shadow DOM und new Audio(), dass Stille beschleunigt wird.
import { firefox } from "playwright";
import { withExtension } from "playwright-webextext";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { serve } from "./serve.mjs";
import { connectRdp } from "./rdp.mjs";

// === EINSTELLUNGEN ===
const EXTENSION_ID = "skip-silence-eigen@falk.local";
const PLAYERS = ["dom", "shadow", "detached"];
const TIMEOUT_MS = 30000;
// =====================

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const root = fileURLToPath(new URL("..", import.meta.url));
const profile = mkdtempSync(join(tmpdir(), "ss-e2e-"));
const port = await freePort();
const { origin, server } = await serve();
const context = await withExtension(firefox, root).launchPersistentContext(profile, {
  args: ["--start-debugger-server", String(port)],
  firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 },
});

const errors = [];
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`Seitenfehler: ${e.message}`));
page.on("console", (m) => /Skip Silence/.test(m.text()) && errors.push(`Konsole: ${m.text()}`));
await page.goto(`${origin}/test/e2e.html`);

const rdp = await connectRdp(port);
const background = await rdp.backgroundOf(EXTENSION_ID);

// Im Background der Extension: alle Tabs einschalten (ohne "tabs"-Berechtigung ist keine
// Suche per URL möglich; Tabs ohne Content-Script lehnen die Nachricht einfach ab)
const reached = await background(`async () => {
  const tabs = await browser.tabs.query({});
  const results = await Promise.allSettled(tabs.map((t) => browser.tabs.sendMessage(t.id, {
    type: "applyState",
    state: { enabled: true, rev: 1000, values: SS.clampValues() },
  })));
  return results.filter((r) => r.status === "fulfilled").length;
}`);
if (reached < 1) errors.push("Kein Content-Script erreichbar (Host-Berechtigung?)");

for (const name of PLAYERS) {
  const result = await page.evaluate(
    async ([player, timeoutMs]) => {
      const el = window.__players[player]();
      const samples = [];
      const timer = setInterval(() => samples.push([el.currentTime, el.playbackRate]), 20);
      el.currentTime = 0;
      await el.play();
      const end = performance.now() + timeoutMs;
      while (el.currentTime < 2.4 && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
      el.pause();
      clearInterval(timer);
      const silence = samples.filter(([t]) => t >= 1.3 && t < 1.98).map(([, r]) => r);
      const tone = samples.filter(([t]) => t >= 2.25 && t < 2.4).map(([, r]) => r);
      return { maxSilence: Math.max(...silence), maxTone: Math.max(...tone) };
    },
    [name, TIMEOUT_MS],
  );
  const ok = result.maxSilence > 2 && result.maxTone <= 1.05;
  console.log(`${ok ? "✔" : "✖"} ${name}: Stille bis ${result.maxSilence.toFixed(2)}x, Ton danach ${result.maxTone.toFixed(2)}x`);
  if (!ok) errors.push(`${name}: Stille nicht beschleunigt oder Ton nicht normal`);
}

const level = await background(`async () => {
  const tabs = await browser.tabs.query({});
  const results = await Promise.allSettled(
    tabs.map((t) => browser.tabs.sendMessage(t.id, { type: "getLevel" }, { frameId: 0 })),
  );
  return results.map((r) => r.value).find((v) => v && v.mediaCount > 0) ?? null;
}`);
console.log(`getLevel: ${JSON.stringify(level)}`);
// DOM + Shadow DOM bleiben bekannt; das pausierte new Audio() (nicht im DOM) wird aufgeräumt
if (!level || level.mediaCount !== 2) errors.push(`Pegelabfrage: ${level?.mediaCount} statt 2 Medien`);

rdp.close();
await context.close();
server.close();
rmSync(profile, { recursive: true, force: true });
if (errors.length) {
  console.error(`\nFAIL\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${context.browser()?.version() ?? "Firefox"}: PASS`);
