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
  firefoxUserPrefs: {
    "media.autoplay.default": 0,
    "media.autoplay.blocking_policy": 0,
    "media.volume_scale": "0.0", // lautlos: nichts über die Lautsprecher ausgeben
  },
});

const errors = [];
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`Seitenfehler: ${e.message}`));
page.on("console", (m) => /Skip Silence/.test(m.text()) && errors.push(`Konsole: ${m.text()}`));
await page.goto(`${origin}/test/e2e.html`);

const rdp = await connectRdp(port);
const ext = await rdp.extension(EXTENSION_ID);
const background = await ext.pageOf(/_generated_background_page|background/);

// Einschalten auf dem echten Weg: Die Extension öffnet ihre Popup-Seite in einem Tab,
// von dort geht setEnabled an den Background (wie beim Klick im Popup).
await page.bringToFront();
const testTabId = await background(`async () => (await browser.tabs.query({ active: true, currentWindow: true }))[0].id`);
const popupTarget = ext.pageOf(/popup\/popup\.html/);
await background(`async () => {
  await browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html"), active: false });
  return true;
}`);
const popup = await popupTarget;
const enabled = await popup(`async () => {
  const res = await browser.runtime.sendMessage({ type: "setEnabled", tabId: ${testTabId}, enabled: true });
  return Boolean(res && res.ok && res.tab.enabled);
}`);
if (!enabled) errors.push("setEnabled über die Popup-Seite fehlgeschlagen");
await page.bringToFront();
await page.waitForTimeout(300);

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

// Spul-Taste mit echtem Tastendruck: einschalten über die Popup-Seite, im Ton halten
await popup(`async () => {
  const st = await browser.runtime.sendMessage({ type: "getPopupState", tabId: ${testTabId} });
  const values = { ...st.tab.values, holdKey: { enabled: true, code: "KeyH" } };
  await browser.runtime.sendMessage({ type: "setValues", tabId: ${testTabId}, values });
  return true;
}`);
await page.waitForTimeout(200);
await page.evaluate(async () => {
  const el = window.__players.dom();
  el.currentTime = 0;
  await el.play();
});
await page.waitForFunction(() => window.__players.dom().currentTime >= 0.15);
await page.keyboard.down("h");
const heldFast = await page
  .waitForFunction(() => window.__players.dom().playbackRate > 2, null, { timeout: 1500 })
  .then(() => true, () => false);
const heldAt = await page.evaluate(() => window.__players.dom().currentTime);
await page.keyboard.up("h");
const released = await page
  .waitForFunction(() => Math.abs(window.__players.dom().playbackRate - 1) < 0.001, null, { timeout: 1000 })
  .then(() => true, () => false);
await page.evaluate(() => window.__players.dom().pause());
console.log(`${heldFast && released ? "✔" : "✖"} Spul-Taste: halten ${heldFast ? "schnell" : "nicht schnell"} (bei ${heldAt.toFixed(2)} s), loslassen ${released ? "normal" : "nicht normal"}`);
if (!heldFast || !released) errors.push("Spul-Taste wirkt mit echter Extension nicht");
if (heldAt >= 1) errors.push("Spul-Taste erst in der Stille geprüft – Test ohne Aussage");

const level = await popup(`async () => browser.tabs.sendMessage(${testTabId}, { type: "getLevel" }, { frameId: 0 })`);
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
