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
  // Normalgeschwindigkeit 1 setzt die Extension intern als 1,0001 (siehe RATE_ONE in content.js)
  const isNormal = (rate) => Math.abs(rate - 1) < 0.001;

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
    if (!isNormal(media.playbackRate)) errors.push(`Nach Pause Rate ${media.playbackRate} statt 1`);

    await sleep(500);
    const played = once("play");
    await media.play();
    await played;
    await sleep(0);
    if (!isNormal(media.playbackRate)) errors.push(`Direkt nach Play Rate ${media.playbackRate} statt 1`);
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
    if (!isNormal(media.playbackRate)) errors.push(`Fremde Rate nicht überschrieben (${media.playbackRate})`);
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
    const l = await level();
    if (!l.muted) errors.push("Pegelabfrage meldet das stumme Element nicht als stumm");
    if (l.phase !== "sound") errors.push(`Stummes Element mit Phase ${l.phase}`);
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
    if (!l.foreign) errors.push("Angezeigtes Element nicht als fremd gemeldet (Popup zeigte „Stille“)");
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

  // Stummes Element und hörbares Element in digitaler Stille melden beide −100 dB:
  // die Anzeige muss das hörbare (messbare) Element wählen
  async function mixed(errors) {
    const silent = document.createElement("audio");
    silent.src = "fixtures/ton_pause.wav";
    silent.muted = true;
    silent.loop = true;
    document.body.append(silent);
    await silent.play();
    await sleep(300);
    // Hörbares Element erst nach dem stummen anlegen: bei Gleichstand gewinnt sonst das zuerst bekannte
    const audible = document.createElement("audio");
    audible.src = "fixtures/ton_nullstille.wav";
    document.body.append(audible);
    await audible.play();
    if (!(await waitUntil(() => audible.currentTime > 1.3 && audible.currentTime < 1.9, 4000))) errors.push("Stille nicht erreicht");
    const l = await level();
    if (l.muted) errors.push("Anzeige wählt das stumme statt des hörbaren Elements");
    if (l.levelDb > -99) errors.push(`Erwartet digitale Stille, gemessen ${l.levelDb} dB`);
    audible.pause();
    silent.pause();
  }

  // Digitale Stille (exakt 0) muss beim Beschleunigen still bleiben: kein alter Ton aus dem
  // Puffer der Zeitstreckung (tritt in Firefox auf, wenn die Rate zwischendurch exakt 1,0 war)
  async function stale(errors) {
    media.src = "fixtures/ton_nullstille.wav";
    const rec = recorder();
    await media.play();
    await waitUntil(() => media.ended || media.currentTime >= 7.9, 15000);
    rec.stop();
    for (const k of [1, 3, 5, 7]) {
      const loud = between(rec.samples, k + 0.15, k + 0.95).filter((s) => s.db > -60);
      if (loud.length) errors.push(`Alter Ton in der Stille ${k}–${k + 1} s: ${loud.map((s) => `${s.t.toFixed(2)} s ${s.db.toFixed(1)} dB`).join(", ")}`);
    }
    const fast = between(rec.samples, 1.3, 1.95).some((s) => s.rate > 2);
    if (!fast) errors.push("Stille nicht beschleunigt (Test ohne Aussage)");
  }

  // Im Ton aus, in der Stille wieder ein: Beim Wechsel von exakt 1,0 auf 1,0001 darf kein
  // alter Ton aus dem Puffer der Zeitstreckung hörbar werden
  async function toggle(errors) {
    media.src = "fixtures/ton_nullstille.wav";
    const rec = recorder();
    await media.play();
    await waitUntil(() => media.currentTime >= 0.6, 3000);
    globalThis.__harnessSend({ type: "applyState", state: { enabled: false, rev: 1, values: globalThis.__values() } });
    await waitUntil(() => media.currentTime >= 1.35, 3000);
    const t0 = media.currentTime;
    send(2, {});
    await sleep(450);
    rec.stop();
    media.pause();
    const loud = between(rec.samples, t0 + 0.02, Math.min(t0 + 0.45, 1.98)).filter((s) => s.db > -60);
    if (loud.length) errors.push(`Alter Ton nach Einschalten: ${loud.map((s) => `${s.t.toFixed(2)} s ${s.db.toFixed(1)} dB`).join(", ")}`);
  }

  // Spul-Taste: halten = Stille-Geschwindigkeit, loslassen = normal. Nicht in Eingabefeldern,
  // nicht mit falschen Modifiern, Loslassen auch bei Fokusverlust.
  async function hold(errors) {
    // Negativ-Prüfungen nur im Ton: in der Stille beschleunigt die Erkennung ohnehin
    const toTone = async () => {
      // Kein Warten auf „seeked“: Firefox lässt es gelegentlich aus – Position abfragen, ggf. wiederholen
      for (let i = 0; i < 3; i++) {
        media.currentTime = 0.1;
        if (await waitUntil(() => media.currentTime < 0.5 && !media.seeking, 1000)) break;
      }
      await sleep(150);
    };
    const key = (type, o = {}, target = document.body) => {
      const e = new KeyboardEvent(type, { code: "KeyH", key: "h", bubbles: true, composed: true, cancelable: true, ...o });
      target.dispatchEvent(e);
      return e;
    };
    await media.play();
    await waitUntil(() => media.currentTime >= 0.2, 2000);
    const down = key("keydown");
    if (!down.defaultPrevented) errors.push("Seite bekommt die Spul-Taste trotzdem");
    if (!(await waitUntil(() => media.playbackRate > 2, 600))) errors.push(`Halten im Ton nicht beschleunigt (${media.playbackRate}x)`);
    key("keydown", { repeat: true });
    key("keyup");
    if (!(await waitUntil(() => isNormal(media.playbackRate), 400))) errors.push(`Loslassen nicht normal (${media.playbackRate}x)`);

    await toTone();
    key("keydown", { shiftKey: true });
    await sleep(300);
    if (!isNormal(media.playbackRate)) errors.push("Taste mit Shift löst trotzdem aus");
    key("keyup", { shiftKey: true });

    await toTone();
    const input = document.createElement("input");
    document.body.append(input);
    key("keydown", {}, input);
    await sleep(300);
    if (!isNormal(media.playbackRate)) errors.push("Taste im Eingabefeld löst aus");
    key("keyup", {}, input);
    input.remove();

    // Eingabefeld in einem offenen Shadow DOM
    const host = document.createElement("div");
    document.body.append(host);
    const shadowInput = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(shadowInput);
    shadowInput.focus();
    await toTone();
    key("keydown", {}, shadowInput);
    await sleep(300);
    if (!isNormal(media.playbackRate)) errors.push("Taste im Shadow-DOM-Eingabefeld löst aus");
    key("keyup", {}, shadowInput);
    host.remove();

    key("keydown");
    if (!(await waitUntil(() => media.playbackRate > 2, 600))) errors.push("Zweites Halten nicht beschleunigt");
    window.dispatchEvent(new Event("blur"));
    if (!(await waitUntil(() => isNormal(media.playbackRate), 400))) errors.push("Fokusverlust lässt die Taste nicht los");

    // Wiederholung nach Loslassen eines Modifiers geht nicht an die Seite
    key("keydown");
    const repeat = key("keydown", { repeat: true, shiftKey: true });
    if (!repeat.defaultPrevented) errors.push("Wiederholung der gehaltenen Taste erreicht die Seite");

    // Pause und Play bei gehaltener Taste: danach greift sie wieder
    media.pause();
    await sleep(100);
    if (!isNormal(media.playbackRate)) errors.push(`Pause bei gehaltener Taste nicht normal (${media.playbackRate}x)`);
    await toTone();
    await media.play();
    if (!(await waitUntil(() => media.playbackRate > 2, 800))) errors.push("Nach Play bei gehaltener Taste nicht wieder schnell");
    key("keyup");
    await toTone();
    if (!(await waitUntil(() => isNormal(media.playbackRate), 400))) errors.push("Loslassen nach Play nicht normal");

    // Ohne Testschalter: künstliche (nicht vertrauenswürdige) Ereignisse werden ignoriert
    globalThis.__ssTestAllowUntrusted = false;
    await toTone();
    key("keydown");
    await sleep(300);
    if (!isNormal(media.playbackRate)) errors.push("Künstliches Tastenereignis löst die Spul-Taste aus");
    key("keyup");
    globalThis.__ssTestAllowUntrusted = true;
    media.pause();
  }

  // Spul-Taste mit Stummschalten und Lookahead: stumm beim Halten, nach dem Loslassen im Ton
  // wieder hörbar; Loslassen in der Stille bleibt schnell (die Erkennung sagt dort Stille).
  // Jede Prüfung hat ein festes Zeitfenster – wird es verfehlt, ist das ein Fehler, kein Überspringen.
  async function holdmute(errors) {
    const key = (type) =>
      document.body.dispatchEvent(new KeyboardEvent(type, { code: "KeyH", bubbles: true, composed: true, cancelable: true }));
    const seekTo = async (t) => {
      for (let i = 0; i < 3; i++) {
        media.currentTime = t;
        if (await waitUntil(() => Math.abs(media.currentTime - t) < 0.3 && !media.seeking, 1000)) break;
      }
    };
    await seekTo(0.05);
    await media.play();
    await sleep(150);

    // A: Halten im Ton → stumm; Loslassen noch im Ton → wieder hörbar
    key("keydown");
    if (!(await waitUntil(() => globalThis.__outDb() < -90, 800))) errors.push("Halten mit Stummschalten nicht stumm");
    key("keyup");
    const releasedAt = media.currentTime;
    // Einblenden mit Lookahead ist nach ~60–100 ms fertig; länger warten liefe in die Stille ab 1 s
    await sleep(150);
    const checkAt = media.currentTime;
    const db = globalThis.__outDb();
    if (checkAt >= 0.97) errors.push(`Zeitfenster „Loslassen im Ton“ verfehlt (losgelassen ${releasedAt.toFixed(2)} s, geprüft ${checkAt.toFixed(2)} s)`);
    else if (db < -30) errors.push(`Nach Loslassen im Ton stumm (${db.toFixed(1)} dB bei ${checkAt.toFixed(2)} s)`);

    // B: in der Stille (automatisch schnell) kurz halten und loslassen → bleibt schnell
    await seekTo(1.2);
    if (!(await waitUntil(() => media.playbackRate > 2, 1200))) errors.push("Stille ab 1,2 s nicht beschleunigt");
    key("keydown");
    await sleep(50);
    key("keyup");
    await sleep(60);
    const t = media.currentTime;
    if (t >= 1.98) errors.push(`Zeitfenster „Loslassen in der Stille“ verfehlt (${t.toFixed(2)} s)`);
    else if (media.playbackRate < 2) errors.push(`Loslassen in der Stille wurde langsam (${media.playbackRate}x bei ${t.toFixed(2)} s)`);
    media.pause();
  }

  // Stummschalten mitten in der Stille, danach Regler ändern: bleibt normal schnell.
  // Prüft das Verhalten von außen. Doppelt abgesichert: refresh() startet keinen Übergang,
  // und onRms setzt ein stummes Element beim nächsten Messwert ohnehin zurück – fällt eine
  // der beiden Prüfungen weg, bleibt das Ergebnis gleich und dieser Test grün.
  async function muteinsilence(errors) {
    await media.play();
    if (!(await waitUntil(() => media.currentTime > 1 && media.playbackRate > 2, 4000))) errors.push("Stille nicht beschleunigt");
    media.muted = true;
    await sleep(100);
    send(1, { silenceSpeed: 5 });
    await sleep(300);
    if (media.playbackRate > 1.05) errors.push(`Stummes Element nach Regleränderung mit ${media.playbackRate}x`);
    media.pause();
  }

  // Ton geht ohne Ereignis verloren (die Seite fängt volumechange ab): Messung erkennt es selbst
  async function silentloss(errors) {
    window.addEventListener("volumechange", (e) => e.stopImmediatePropagation(), true);
    await media.play();
    if (!(await waitUntil(() => media.currentTime > 1 && media.playbackRate > 2, 4000))) errors.push("Stille nicht beschleunigt");
    media.muted = true;
    const normal = await waitUntil(() => media.playbackRate <= 1.05, 500);
    if (!normal) errors.push(`Ohne Ereignis stumm geschaltet, weiter mit ${media.playbackRate}x`);
    media.pause();
  }

  // Später eingefügtes Element im offenen Shadow DOM mit autoplay (ohne play()-Aufruf):
  // nur die regelmäßige Suche kann es finden
  async function lateshadow(errors) {
    const host = document.createElement("div");
    document.body.append(host);
    const audio = document.createElement("audio");
    audio.src = "fixtures/ton_pause.wav";
    audio.loop = true;
    audio.autoplay = true;
    host.attachShadow({ mode: "open" }).append(audio);
    const found = await waitUntil(() => audio.playbackRate > 2, 12000);
    if (!found) errors.push("Shadow-Element mit autoplay nie beschleunigt");
    audio.pause();
  }

  const SCENARIOS = {
    rate,
    mute,
    muted,
    disable,
    override,
    refresh,
    elmuted,
    cors,
    foreign,
    redirect,
    muteinsilence,
    silentloss,
    lateshadow,
    mixed,
    stale,
    toggle,
    hold,
    holdmute,
  };

  document.getElementById("start").addEventListener("click", async () => {
    out.textContent = "läuft …";
    const errors = [];
    try {
      if (media) media.currentTime = 0;
      await SCENARIOS[globalThis.__scenario](errors);
    } catch (e) {
      errors.push(String(e));
    }
    out.textContent = errors.length ? `FAIL\n${errors.join("\n")}` : "PASS";
  });
})();
