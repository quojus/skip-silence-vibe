// Spielt die Test-WAV ab und prüft playbackRate an den Ton/Stille-Grenzen (Medienzeit).
(() => {
  const media = document.getElementById("media");
  const out = document.getElementById("result");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const once = (type) => new Promise((r) => media.addEventListener(type, r, { once: true }));

  async function waitUntil(cond, timeoutMs) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      if (cond()) return true;
      await sleep(10);
    }
    return false;
  }

  async function run() {
    const errors = [];
    const samples = [];
    const timer = setInterval(() => samples.push({ t: media.currentTime, rate: media.playbackRate }), 20);

    media.currentTime = 0;
    await media.play();

    // 1 + 2: Stille 1–2 s beschleunigt, Ton ab 2 s wieder normal
    await waitUntil(() => media.currentTime >= 2.6, 6000);
    const inSilence = samples.filter((s) => s.t >= 1.3 && s.t < 1.98);
    if (!inSilence.some((s) => s.rate > 2)) {
      errors.push(`Stille 1,3–2 s nicht beschleunigt (max ${Math.max(...inSilence.map((s) => s.rate))})`);
    }
    const afterTone = samples.filter((s) => s.t >= 2.3 && s.t < 2.6);
    if (afterTone.some((s) => s.rate > 1.05)) {
      errors.push(`Ton ab 2 s nicht normal (max ${Math.max(...afterTone.map((s) => s.rate))})`);
    }

    // 3: In der nächsten Stille (3–4 s) pausieren, wenn beschleunigt
    const fast = await waitUntil(() => media.currentTime > 3 && media.playbackRate > 2, 4000);
    if (!fast) errors.push("Stille 3–4 s nicht beschleunigt");
    const paused = once("pause");
    media.pause();
    await paused;
    await sleep(0);
    if (media.playbackRate !== 1) errors.push(`Nach Pause Rate ${media.playbackRate} statt 1`);

    await sleep(500);
    const played = once("play");
    await media.play();
    await played;
    await sleep(0);
    if (media.playbackRate !== 1) errors.push(`Direkt nach Play Rate ${media.playbackRate} statt 1`);

    // Schonzeit 300 ms: obwohl Stille, bleibt die Rate normal
    const graceSamples = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 250) {
      graceSamples.push(media.playbackRate);
      await sleep(10);
    }
    if (graceSamples.some((r) => r > 1.05)) errors.push("Schonzeit nach Play nicht eingehalten");

    // Danach wird die restliche Stille wieder beschleunigt
    const fastAgain = await waitUntil(() => media.playbackRate > 2, 1500);
    if (!fastAgain && media.currentTime < 3.95) errors.push("Nach Schonzeit keine Beschleunigung");

    media.pause();
    clearInterval(timer);

    const saved = globalThis.__harnessMessages.filter((m) => m.type === "addSaved");
    window.__samples = samples;
    out.textContent = errors.length
      ? `FAIL\n${errors.join("\n")}`
      : `PASS (${samples.length} Messpunkte, ${saved.length} addSaved-Meldungen)`;
  }

  document.getElementById("start").addEventListener("click", () => {
    out.textContent = "läuft …";
    run().catch((e) => (out.textContent = `FAIL\n${e}`));
  });
})();
