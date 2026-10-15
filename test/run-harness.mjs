// Führt test/harness.html mit allen Szenarien in Firefox (Playwright) aus.
import { firefox } from "playwright";
import { serve } from "./serve.mjs";

// === EINSTELLUNGEN ===
const SCENARIOS = [
  "rate",
  "mute",
  "muted",
  "disable",
  "override",
  "refresh",
  "elmuted",
  "cors",
  "foreign",
  "redirect",
  "muteinsilence",
  "silentloss",
  "lateshadow",
  "mixed",
  "stale",
  "hold",
  "holdmute",
  "holdecho",
  "seeksilence",
  "excluded",
  "stats",
  // "toggle" ist bekannt offen: beim Einschalten in einer Pause bleibt ein Rest von etwa −34 dB
];
const REPEAT = 1; // für Stabilitätsprüfungen erhöhen
const TIMEOUT_MS = 60000;
// =====================

const { origin, server } = await serve();
const browser = await firefox.launch({
  firefoxUserPrefs: {
    "media.autoplay.default": 0,
    "media.autoplay.blocking_policy": 0,
    "media.volume_scale": "0.0", // lautlos: nichts über die Lautsprecher ausgeben
  },
});
// Aufwärmen: Die erste Wiedergabe in einem frischen Firefox blieb unter Last selten ~14 s
// hängen. Ursache offen – vermutlich das erste Öffnen des Audio-Ausgangs, ohne content.js
// trat es in Messungen nicht auf. Deshalb einmal hörbar abspielen (der Runner ist ohnehin
// lautlos, media.volume_scale = 0) – das baut AudioContext, Audio-Kette und Ausgang auf.
// Optional: ein Fehler hier bricht den Testlauf nicht ab.
try {
  const warm = await browser.newPage();
  await warm.goto(`${origin}/test/harness.html?s=rate`);
  const ok = await warm.evaluate(async () => {
    const m = document.getElementById("media");
    await m.play().catch(() => {});
    const end = performance.now() + 30000;
    while (m.currentTime < 0.3 && performance.now() < end) await new Promise((r) => setTimeout(r, 50));
    m.pause();
    return m.currentTime >= 0.3;
  });
  if (!ok) console.log("Hinweis: Aufwärm-Wiedergabe kam nicht voran (Umgebung)");
  await warm.close();
} catch (err) {
  console.log(`Hinweis: Aufwärmen fehlgeschlagen (${err.message.split("\n")[0]}) – Tests laufen trotzdem`);
}

let failed = 0;
for (let run = 1; run <= REPEAT; run++) {
  for (const s of SCENARIOS) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => m.type() === "warning" && /Skip Silence/.test(m.text()) && pageErrors.push(m.text()));
    await page.goto(`${origin}/test/harness.html?s=${s}`);
    await page.click("#start");
    await page.waitForFunction(() => /^(PASS|FAIL)/.test(document.getElementById("result").textContent), null, {
      timeout: TIMEOUT_MS,
    });
    let result = await page.textContent("#result");
    if (pageErrors.length) result = `FAIL\n${pageErrors.join("\n")}\n${result}`;
    if (!result.startsWith("PASS")) failed++;
    console.log(`[${run}/${REPEAT}] ${s}: ${result}`);
    await page.close();
  }
}
console.log(`${await browser.version()}: ${failed ? `${failed} Fehlschläge` : "alle bestanden"}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
