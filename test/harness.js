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


  const send = (rev, extra) =>
    globalThis.__harnessSend({ type: "applyState", state: { enabled: true, rev, values: { ...globalThis.__values(), ...extra } } });
  const level = async () => (await Promise.all(globalThis.__harnessSend({ type: "getLevel" })))[0];
  const crossOrigin = (path) => `http://localhost:${location.port}/test/${path}`;

  // Werte ändern während eines laufenden Übergangs: Kurve läuft weiter, kein Sprung.
  // Danach Stummschalten/Lookahead mehrfach umschalten: kein Fehler, Ton bleibt hörbar.
  async function refresh(errors) {
    const rec = recorder();
    await media.play();
    const inRamp = await waitUntil(() => media.currentTime > 1 && media.playbackRate > 1.1 && media.playbackRate < 2, 4000);
    if (!inRamp) errors.push("Übergang in die Stille nicht gefunden");
    const from = rec.samples.length;
    send(1, { silenceSpeed: 5 });
    await sleep(400);
    const all = rec.samples.slice(Math.max(0, from - 1)).map((s) => s.rate);
    // Nur den Anstieg bis zum Maximum bewerten – danach folgt gewollt der schnelle Weg zurück auf 1x.
    // Ein harter Abbruch springt ohne Zwischenwert aufs Ziel; ein weicher Übergang steigt
    // monoton und hat Zwischenwerte (die Rate ändert sich nur pro Worklet-Paket, also stufig).
    const rise = all.slice(0, all.indexOf(max(all)) + 1);
    const between = new Set(rise.filter((r) => r > rise[0] + 0.05 && r < max(rise) - 0.05).map((r) => r.toFixed(2)));
    if (rise.some((r, i) => i > 0 && r < rise[i - 1] - 1e-6)) errors.push(`Übergang nicht monoton: ${rise.join(" ")}`);
    if (between.size < 1) errors.push(`Harter Sprung aufs neue Ziel: ${rise.map((r) => r.toFixed(2)).join(" ")}`);
    if (max(all) < 4.5) errors.push(`Neues Ziel 5x nicht erreicht (max ${max(all).toFixed(2)})`);
    for (let i = 0; i < 10; i++) {
      send(2 + i, { silenceSpeed: 5, muteSilence: i % 2 === 0, lookahead: true });
      await sleep(40);
    }
    await waitUntil(() => media.currentTime >= 2.4, 3000);
    const db = globalThis.__outDb();
    if (db < -30) errors.push(`Nach Umschalten im Ton stumm (${db.toFixed(1)} dB)`);
    rec.stop();
    media.pause();
  }

  // Stummgeschaltetes Element: keine Beschleunigung
  async function elmuted(errors) {
    const rec = recorder();
    media.muted = true;
    await media.play();
    await waitUntil(() => media.currentTime >= 2.5, 5000);
    rec.stop();
    media.pause();
    const r = max(rec.samples.map((s) => s.rate));
    if (r > 1.05) errors.push(`Stummes Element beschleunigt (${r.toFixed(2)}x)`);
  }

  // Fremde Quelle ohne CORS: nicht anhängen, Ton unverändert, im Popup als nicht unterstützt
  async function cors(errors) {
    media.src = crossOrigin("fixtures/ton_pause.wav");
    const rec = recorder();
    await media.play();
    await waitUntil(() => media.currentTime >= 1.8, 4000);
    rec.stop();
    if (max(rec.samples.map((s) => s.rate)) > 1.05) errors.push("Fremde Quelle wurde beschleunigt");
    if (globalThis.__outAnalyser) errors.push("Fremde Quelle wurde an die Audio-Kette gehängt");
    const l = await level();
    if (l.unsupportedCount !== 1) errors.push(`unsupportedCount ${l.unsupportedCount} statt 1`);
    media.pause();
  }

  // Angehängtes Element wechselt auf fremde Quelle: gemeldet, nicht als Dauer-Stille beschleunigt
  async function foreign(errors) {
    await media.play();
    if (!(await waitUntil(() => media.currentTime > 1 && media.playbackRate > 2, 4000))) errors.push("Stille nicht beschleunigt");
    media.pause();
    media.src = crossOrigin("fixtures/ton_pause.wav");
    await media.play();
    await sleep(1500);
    const l = await level();
    if (l.unsupportedCount !== 1) errors.push(`unsupportedCount ${l.unsupportedCount} statt 1`);
    if (media.playbackRate > 1.05) errors.push(`Fremde Quelle mit ${media.playbackRate}x`);
    media.pause();
  }

  // Eigene URL leitet auf fremdes CDN um: nicht erkennbar, aber nach 5 s Nullen → „Kein Signal“
  async function redirect(errors) {
    media.loop = true;
    media.src = "/redirect/test/fixtures/ton_pause.wav";
    await media.play();
    const warned = await (async () => {
      const end = performance.now() + 9000;
      while (performance.now() < end) {
        const l = await level();
        if (l.silentInput) return true;
        await sleep(250);
      }
      return false;
    })();
    if (!warned) errors.push("Keine Warnung „Kein Signal“ nach 9 s");
    media.pause();
  }

  const SCENARIOS = { rate, mute, muted, disable, override, refresh, elmuted, cors, foreign, redirect };

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
