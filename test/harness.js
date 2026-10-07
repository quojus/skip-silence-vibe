// Spielt eine Test-WAV ab und prüft Geschwindigkeit und Ausgangspegel (Zeiten = Medienzeit).
(() => {
  const media = document.getElementById("media");
  const out = document.getElementById("result");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const once = (type) => new Promise((r) => media.addEventListener(type, r, { once: true }));
  const max = (xs) => Math.max(...xs);
  const min = (xs) => Math.min(...xs);

  async function waitUntil(cond, timeoutMs) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      if (cond()) return true;
      await sleep(10);
    }
    return false;
  }

  function recorder() {
    const samples = [];
    const timer = setInterval(
      () => samples.push({ t: media.currentTime, rate: media.playbackRate, db: globalThis.__outDb() }),
      20,
    );
    return { samples, stop: () => clearInterval(timer) };
  }

  const between = (samples, a, b) => samples.filter((s) => s.t >= a && s.t < b);

  // 1 s Ton / 1 s Stille: Beschleunigung, Rückkehr, Pause/Play, Schonzeit
  async function rate(errors) {
    const rec = recorder();
    await media.play();
    await waitUntil(() => media.currentTime >= 2.6, 8000);
    const inSilence = between(rec.samples, 1.3, 1.98);
    if (!inSilence.some((s) => s.rate > 2)) errors.push(`Stille 1,3–2 s nicht beschleunigt (max ${max(inSilence.map((s) => s.rate))})`);
    const afterTone = between(rec.samples, 2.3, 2.6);
    if (afterTone.some((s) => s.rate > 1.05)) errors.push(`Ton ab 2 s nicht normal (max ${max(afterTone.map((s) => s.rate))})`);

    if (!(await waitUntil(() => media.currentTime > 3 && media.playbackRate > 2, 4000))) errors.push("Stille 3–4 s nicht beschleunigt");
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
    const t0 = performance.now();
    const grace = [];
    while (performance.now() - t0 < 250) {
      grace.push(media.playbackRate);
      await sleep(10);
    }
    if (grace.some((r) => r > 1.05)) errors.push("Schonzeit nach Play nicht eingehalten");
    if (!(await waitUntil(() => media.playbackRate > 2, 1500)) && media.currentTime < 3.95) errors.push("Nach Schonzeit keine Beschleunigung");
    rec.stop();
  }

  // 0,8 s Ton / 0,35 s Stille: Der Ton kehrt zurück, während das Ausblenden noch läuft.
  // Das Einblenden muss die laufende Kurve sauber ablösen – der Ton darf nie stumm bleiben.
  async function mute(errors) {
    const rec = recorder();
    await media.play();
    await waitUntil(() => media.ended || media.currentTime >= 7.9, 15000);
    rec.stop();
    const period = 1.15;
    for (let k = 1; k < 7; k++) {
      const start = k * period;
      const pause = between(rec.samples, start - 0.35, start + 0.05).map((s) => s.rate);
      if (!pause.some((r) => r > 1.2)) errors.push(`Pause vor ${start.toFixed(2)} s nicht erkannt (Test ohne Aussage)`);
      const tone = between(rec.samples, start + 0.2, start + 0.75).map((s) => s.db);
      if (tone.length && min(tone) < -30) errors.push(`Ton ab ${start.toFixed(2)} s stumm (min ${min(tone).toFixed(1)} dB)`);
    }
  }

  // 1 s Stille wird vollständig stummgeschaltet
  async function muted(errors) {
    await media.play();
    if (!(await waitUntil(() => media.currentTime > 1 && media.playbackRate > 2, 4000))) errors.push("Stille nicht beschleunigt");
    if (!(await waitUntil(() => globalThis.__outDb() < -90, 1000))) errors.push("Stille wurde nicht stummgeschaltet");
    await waitUntil(() => media.currentTime >= 2.3, 3000);
    const db = globalThis.__outDb();
    if (db < -30) errors.push(`Ton nach der Stille stumm (${db.toFixed(1)} dB)`);
    media.pause();
  }

  // Ausschalten mitten im Ausblenden: Rate und Ton kommen sofort zurück
  async function disable(errors) {
    await media.play();
    if (!(await waitUntil(() => media.currentTime > 1 && media.playbackRate > 1.1, 4000))) errors.push("Stille nicht erkannt");
    globalThis.__harnessSend({ type: "applyState", state: { enabled: false, rev: 1, values: globalThis.__values() } });
    await sleep(30);
    if (media.playbackRate !== 1) errors.push(`Nach Ausschalten Rate ${media.playbackRate} statt 1`);
    await waitUntil(() => media.currentTime >= 2.3, 3000);
    const db = globalThis.__outDb();
    if (db < -30) errors.push(`Nach Ausschalten im Ton stumm (${db.toFixed(1)} dB)`);
    media.playbackRate = 1.5;
    await sleep(50);
    if (media.playbackRate !== 1.5) errors.push("Ausgeschaltet: Geschwindigkeit der Seite wird weiter überschrieben");
    media.pause();
  }

  // Fremde Geschwindigkeit wird überschrieben; Spulen aus der Stille in Ton → sofort normal
  async function override(errors) {
    await media.play();
    await waitUntil(() => media.currentTime >= 0.3, 2000);
    media.playbackRate = 2;
    await sleep(50);
    if (media.playbackRate !== 1) errors.push(`Fremde Rate nicht überschrieben (${media.playbackRate})`);
    if (!(await waitUntil(() => media.currentTime > 1 && media.playbackRate > 2, 4000))) errors.push("Stille nicht beschleunigt");
    const seeked = once("seeked");
    media.currentTime = 4.2;
    await seeked;
    await sleep(0);
    if (media.playbackRate > 1.05) errors.push(`Nach Spulen Rate ${media.playbackRate} statt 1`);
    await sleep(300);
    const db = globalThis.__outDb();
    if (db < -30) errors.push(`Nach Spulen in den Ton stumm (${db.toFixed(1)} dB)`);
    media.pause();
  }

  const SCENARIOS = { rate, mute, muted, disable, override };

  document.getElementById("start").addEventListener("click", async () => {
    out.textContent = "läuft …";
    const errors = [];
    try {
      media.currentTime = 0;
      await SCENARIOS[globalThis.__scenario](errors);
    } catch (e) {
      errors.push(String(e));
    }
    out.textContent = errors.length ? `FAIL\n${errors.join("\n")}` : "PASS";
  });
})();
