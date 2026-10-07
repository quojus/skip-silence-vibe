// Testet Popup + background.js in Firefox mit simulierter WebExtension-API.
import { readFileSync, mkdirSync } from "node:fs";
import { firefox } from "playwright";
import { serve } from "./serve.mjs";

// === EINSTELLUNGEN ===
const SCREENSHOT = "test/output/popup.png";
// =====================

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const init = ["test/popup-stub.js", "lib/defaults.js", "lib/modes.js", "background.js"].map(read).join("\n;\n");

const errors = [];
const check = (cond, text) => {
  if (!cond) errors.push(text);
  console.log(`${cond ? "✔" : "✖"} ${text}`);
};

const browser = await firefox.launch({ firefoxUserPrefs: { "media.volume_scale": "0.0" } });
const page = await browser.newPage({ viewport: { width: 384, height: 1100 } });
page.on("console", (m) => m.type() === "error" && errors.push(`Konsole: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`Seitenfehler: ${e.message}`));
await page.addInitScript(init);
const { origin, server } = await serve();
await page.goto(`${origin}/popup/popup.html`);
await page.waitForFunction(() => document.getElementById("mode").options.length > 0);

const lastApply = () =>
  page.evaluate(() => globalThis.__sent.filter((m) => m.type === "applyState").at(-1)?.state);
const setRange = (label, value) =>
  page.evaluate(
    ([l, v]) => {
      const input = document.querySelector(`input[aria-label="${l}"]`);
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [label, value],
  );
const settle = () => page.waitForTimeout(250);

check((await page.textContent("#mode")).includes("Standard ★"), "Standard-Modus vorhanden und markiert");

await page.click("header .switch-row");
await settle();
check((await lastApply())?.enabled === true, "Einschalten sendet enabled=true an den Tab");

await setRange("Normalgeschwindigkeit", "1.5");
await settle();
check((await lastApply())?.values.normalSpeed === 1.5, "Regler sendet neuen Wert");
check((await page.textContent("#modeStatus")) === "(geändert)", "Status zeigt (geändert)");
check(!(await page.isDisabled("#btnSave")), "Speichern ist aktiv");

await page.click("#btnSaveAs");
await page.fill("#saveAsName", "Podcast");
await page.click("#saveAsForm button[type=submit]");
await settle();
const podcastId = await page.inputValue("#mode");
check((await page.textContent("#mode")).includes("Podcast"), "Modus Podcast angelegt und geladen");
check((await page.textContent("#modeStatus")) === "", "Nach Speichern unter kein (geändert)");

await page.click("#btnSaveAs");
await page.fill("#saveAsName", "podcast");
await page.click("#saveAsForm button[type=submit]");
await settle();
check((await page.textContent("#msg")).includes("gibt es schon"), "Doppelter Name wird abgelehnt");
await page.click("#saveAsCancel");

const standardId = await page.evaluate(
  () => [...document.getElementById("mode").options].find((o) => o.textContent.startsWith("Standard")).value,
);
await page.selectOption("#mode", standardId);
await settle();
check((await lastApply())?.values.normalSpeed === 1, "Standard laden setzt Basiswerte");

await page.selectOption("#mode", podcastId);
await settle();
check((await lastApply())?.values.normalSpeed === 1.5, "Podcast laden setzt gespeicherte Werte");

await setRange("Normalgeschwindigkeit", "2");
await settle();
await page.click("#btnReset");
await settle();
check((await lastApply())?.values.normalSpeed === 1.5, "Zurücksetzen holt Moduswerte zurück");

await setRange("Normalgeschwindigkeit", "1.25");
await settle();
await page.click("#btnSave");
await settle();
await page.selectOption("#mode", standardId);
await settle();
await page.selectOption("#mode", podcastId);
await settle();
check((await lastApply())?.values.normalSpeed === 1.25, "Speichern überschreibt den Modus");

const presetSelect = page.locator("#rampIn select");
await presetSelect.selectOption("ease-in");
await settle();
check(
  JSON.stringify((await lastApply())?.values.rampIn.bezier) === "[0.42,0,1,1]",
  "Preset ease-in setzt Kurve",
);

const canvas = page.locator("#rampIn canvas");
const box = await canvas.boundingBox();
const p1 = await page.evaluate(() => {
  const r = document.querySelector("#rampIn canvas").getBoundingClientRect();
  const w = r.width;
  const h = r.height;
  return [r.left + 10 + 0.42 * (w - 20), r.top + h - ((0 + 0.5) / 2) * h];
});
await page.mouse.move(p1[0], p1[1]);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2, { steps: 5 });
await page.mouse.up();
await settle();
check((await presetSelect.inputValue()) === "custom", "Ziehen am Punkt → benutzerdefiniert");
const dragged = (await lastApply())?.values.rampIn.bezier;
check(dragged && dragged[0] < 0.42 && dragged[1] > 0.5, `Gezogener Punkt übernommen (${dragged})`);

await page.locator("#rampOut select").selectOption("sofort");
await settle();
check((await lastApply())?.values.rampOut.durationMs === 0, "Preset sofort setzt Dauer 0");

await page.click("#btnMore");
await page.click("#btnDefault");
await settle();
check((await page.textContent("#mode")).includes("Podcast ★"), "Podcast als Standard markiert");

await page.click("#btnMore");
await page.click("#btnDelete");
await page.click("#deleteYes");
await settle();
const optionTexts = await page.evaluate(() => [...document.getElementById("mode").options].map((o) => o.textContent));
check(!optionTexts.some((t) => t.includes("Podcast")), "Podcast gelöscht");
check(optionTexts.includes("– Kein Modus –"), "Tab zeigt danach „Kein Modus“");
check(optionTexts.includes("Standard ★"), "Standard ist wieder Standard-Modus");

await page.waitForTimeout(300);
check((await page.textContent("#meterStatus")) === "Ton", "Pegelanzeige zeigt Ton");

const statusFor = async (override) => {
  await page.evaluate((o) => (globalThis.__levelOverride = o), override);
  await page.waitForTimeout(250);
  return page.textContent("#meterStatus");
};
check((await statusFor({ phase: "silence" })) === "Stille", "Pegelanzeige zeigt Stille");
check(
  (await statusFor({ foreign: true, levelDb: -100 })) === "Medium nicht unterstützt (fremde Quelle)",
  "Fremde Quelle wird als nicht unterstützt gemeldet",
);
check((await statusFor({ muted: true, levelDb: -100 })) === "Stumm – keine Messung", "Stummes Medium wird als stumm gemeldet");
check(
  (await statusFor({ silentInput: true, levelDb: -100 })) === "Kein Signal – Quelle evtl. nicht unterstützt",
  "Dauerhaft 0 wird als „Kein Signal“ gemeldet",
);
check((await statusFor({ playing: false })) === "Pausiert", "Pausiertes Medium wird als pausiert gemeldet");
await statusFor({});

mkdirSync(new URL("test/output/", root), { recursive: true });
await page.screenshot({ path: SCREENSHOT, fullPage: true });
await browser.close();
server.close();

if (errors.length) {
  console.error(`\nFAIL\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("\nPASS");
