// Testet Popup + background.js in Firefox mit simulierter WebExtension-API.
import { readFileSync, mkdirSync } from "node:fs";
import { firefox } from "playwright";
import { serve } from "./serve.mjs";

// === EINSTELLUNGEN ===
const SCREENSHOT = "test/output/popup.png";
// =====================

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const init = ["test/popup-stub.js", "lib/defaults.js", "lib/modes.js", "lib/sites.js", "lib/stats.js", "background.js"].map(read).join("\n;\n");

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

const quickNames = () => page.$$eval("#quick button", (bs) => bs.map((b) => b.textContent));
check(JSON.stringify(await quickNames()) === '["Standard","Aus"]', `Schnellwahl zeigt Standard und Aus (${await quickNames()})`);
check(await page.evaluate(() => document.getElementById("btnOff").classList.contains("active")), "Neuer Tab: Aus ist aktiv");
await page.click("#quick button.mode");
await settle();
check((await lastApply())?.enabled === true, "Klick auf Modus-Button schaltet den Tab ein");
check(await page.evaluate(() => document.querySelector("#quick button.mode").classList.contains("active")), "Modus-Button ist markiert");

await setRange("Normalgeschwindigkeit", "1.5");
await settle();
check((await lastApply())?.values.normalSpeed === 1.5, "Regler sendet neuen Wert");
check((await page.textContent("#modeStatus")) === "(geändert)", "Status zeigt (geändert)");
check((await quickNames())[0] === "Standard*", "Schnellwahl markiert angepasste Werte mit *");
check(!(await page.isDisabled("#btnSave")), "Speichern ist aktiv");

await page.click("#btnSaveAs");
await page.fill("#saveAsName", "Podcast");
await page.click("#saveAsForm button[type=submit]");
await settle();
const podcastId = await page.inputValue("#mode");
check((await page.textContent("#mode")).includes("Podcast"), "Modus Podcast angelegt und geladen");
check((await page.textContent("#modeStatus")) === "", "Nach Speichern unter kein (geändert)");
check(JSON.stringify(await quickNames()) === '["Standard","Podcast","Aus"]', `Neuer Modus erscheint in der Schnellwahl (${await quickNames()})`);

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

// Schnellwahl: Aus und wieder an
await page.click("#btnOff");
await settle();
check((await lastApply())?.enabled === false, "Aus schaltet den Tab aus");
check(await page.evaluate(() => document.getElementById("btnOff").classList.contains("active")), "Aus ist markiert");
await page.click("#quick button.mode");
await settle();
check((await lastApply())?.enabled === true, "Modus-Button schaltet wieder ein");

// Ausgeschlossene Seiten
check((await page.textContent("#btnExcludeHere")).includes("example.org"), "Button bietet die aktuelle Seite an (ohne www)");
await page.click("#btnExcludeHere");
await settle();
check((await lastApply())?.topExcluded === true, "Ausschließen meldet dem Tab den Ausschluss");
check(await page.isVisible("#excludedNote"), "Hinweis „ausgeschlossen“ sichtbar");
check((await page.textContent("#siteList")).includes("example.org"), "Seite steht in der Liste");
await page.click("#btnInclude");
await settle();
check((await lastApply())?.topExcluded === false, "Zulassen hebt den Ausschluss auf");
check(!(await page.isVisible("#excludedNote")), "Hinweis verschwindet");
await page.fill("#siteInput", "https://www.Zoom.us/j/1");
await page.click("#siteForm button[type=submit]");
await settle();
check((await page.textContent("#siteList")).includes("zoom.us"), "Domain per Eingabe hinzugefügt");
check((await page.inputValue("#siteInput")) === "", "Eingabefeld danach leer");
await page.fill("#siteInput", "kein host");
await page.click("#siteForm button[type=submit]");
await settle();
check((await page.textContent("#msg")).includes("Keine gültige Domain"), "Ungültige Domain wird abgelehnt");
await page.click('#siteList button[aria-label="zoom.us entfernen"]');
await settle();
check(!(await page.textContent("#siteList")).includes("zoom.us"), "× entfernt die Domain");

// Statistik
await page.evaluate(() =>
  globalThis.__contentSend({
    type: "addStats",
    stats: { normalRealS: 60, normalMediaS: 90, silenceRealS: 10, silenceMediaS: 40, silences: 3 },
  }),
);
check(!(await page.isVisible("#statsBox")), "Statistik ist zu Beginn eingeklappt");
await page.click("#btnStats");
await settle();
const statsRows = await page.$$eval("#statsBody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
const row = (label) => statsRows.find((r) => r[0] === label) || [];
check(row("Gespart: Normal-Speed")[1] === "30 s", `Gespart Normal (${row("Gespart: Normal-Speed")})`);
check(row("Gespart: Stille-Speed")[1] === "30 s", `Gespart Stille (${row("Gespart: Stille-Speed")})`);
check(row("Gespart gesamt")[2] === "1 min 0 s", `Gespart insgesamt (${row("Gespart gesamt")})`);
check(row("Medienzeit")[1] === "2 min 10 s", `Medienzeit (${row("Medienzeit")})`);
check(row("Echte Zeit")[1] === "1 min 10 s", `Echte Zeit (${row("Echte Zeit")})`);
check(row("Stillen übersprungen")[2] === "3", `Stillen (${row("Stillen übersprungen")})`);

// Spul-Taste festlegen: Klick, Taste drücken; Esc bricht ab; Schalter aus
await page.click("#holdCapture");
await page.keyboard.press("Escape");
await settle();
check((await page.textContent("#holdLabel")) === "keine", "Esc bricht das Festlegen ab");
await page.click("#holdEnabled + .switch");
check((await page.textContent("#holdCapture")).includes("Taste drücken"), "Einschalten ohne Taste fragt die Taste ab");
await page.keyboard.press("Control+j");
await settle();
let hk = (await lastApply())?.values.holdKey;
check(hk?.enabled === true && hk.code === "KeyJ" && hk.ctrl === true, `Spul-Taste Strg+J gespeichert (${JSON.stringify(hk)})`);
check((await page.textContent("#holdLabel")) === "Strg+J", "Anzeige Strg+J");
await page.click("#holdEnabled + .switch");
await settle();
hk = (await lastApply())?.values.holdKey;
check(hk?.enabled === false && hk.code === "KeyJ", "Ausschalten behält die Taste");

await page.click("#holdCapture");
await page.keyboard.press("Meta+k");
await settle();
check((await page.textContent("#msg")).includes("Cmd"), "Cmd-Kombination wird abgelehnt");
check((await page.textContent("#holdLabel")) === "Strg+J", "Abgelehnte Taste ändert nichts");
await page.click("#holdCapture");
await page.click("#btnSaveAs");
check(!(await page.textContent("#holdCapture")).includes("Taste drücken"), "Klick woanders beendet das Festlegen");
await page.keyboard.type("ab");
check((await page.inputValue("#saveAsName")) === "ab", "Tippen landet im Namensfeld, nicht als Spul-Taste");
await page.click("#saveAsCancel");

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
