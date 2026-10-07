// Führt test/harness.html in Firefox (Playwright) aus.
import { firefox } from "playwright";
import { serve } from "./serve.mjs";

// === EINSTELLUNGEN ===
const TIMEOUT_MS = 30000;
// =====================

const browser = await firefox.launch({
  firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 },
});
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.error("[Seite]", m.text()));
const { origin, server } = await serve();
await page.goto(`${origin}/test/harness.html`);
await page.click("#start");
await page.waitForFunction(
  () => /^(PASS|FAIL)/.test(document.getElementById("result").textContent),
  null,
  { timeout: TIMEOUT_MS },
);
const result = await page.textContent("#result");
console.log(`${await browser.version()}: ${result}`);
await browser.close();
server.close();
process.exit(result.startsWith("PASS") ? 0 : 1);
