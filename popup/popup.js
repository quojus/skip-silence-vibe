// Popup: Einstellungen des aktuellen Tabs, Modi, Pegelanzeige.
(() => {
  const DEBOUNCE_MS = 50;
  const LEVEL_POLL_MS = 66; // ~15 Hz
  const STATE_POLL_MS = 1000;
  const METER_MIN_DB = -80;
  const METER_MAX_DB = 0;

  const ERRORS = {
    "empty-name": "Bitte einen Namen eingeben.",
    "duplicate-name": "Diesen Namen gibt es schon.",
    "last-mode": "Der letzte Modus kann nicht gelöscht werden.",
    "unknown-mode": "Modus nicht gefunden.",
    "no-mode": "Kein Modus geladen.",
  };

  const $ = (id) => document.getElementById(id);
  const de = (v, digits) =>
    v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

  const SLIDERS = [
    { key: "normalSpeed", label: "Normalgeschwindigkeit", fmt: (v) => `${de(v, 2)}x` },
    { key: "silenceSpeed", label: "Stille-Geschwindigkeit", fmt: (v) => `${de(v, 1)}x` },
    { toggle: "dynamicThreshold", label: "Dynamischer Schwellwert" },
    {
      key: "thresholdDb",
      label: "Schwellwert",
      fmt: (v) => `${de(v, 0)} dB`,
      hint: (v) => (v.dynamicThreshold ? "nur Startwert" : ""),
    },
    {
      key: "dynMarginDb",
      label: "Abstand zum Rauschen",
      fmt: (v) => `${de(v, 1)} dB`,
      disabled: (v) => !v.dynamicThreshold,
    },
    { key: "hysteresisDb", label: "Hysterese", fmt: (v) => `${de(v, 1)} dB` },
    { key: "minSilenceMs", label: "Mindestdauer Stille", fmt: (v) => `${de(v, 0)} ms` },
    { key: "graceMs", label: "Schonzeit nach Play", fmt: (v) => `${de(v, 0)} ms` },
    { toggle: "muteSilence", label: "Stille stummschalten" },
    { toggle: "lookahead", label: "Lookahead (60 ms)", disabled: (v) => !v.muteSilence },
  ];

  const RAMPS = [
    { key: "rampIn", el: "rampIn", limit: "rampInDuration" },
    { key: "rampOut", el: "rampOut", limit: "rampOutDuration" },
  ];

  let tabId = null;
  let tab = null;
  let modes = {};
  let defaultModeId = null;
  let values = SS.clampValues();
  let sendTimer = null;
  const controls = {}; // key → {input, value, wrap, hint}
  const ramps = {}; // key → {duration, durationValue, preset, editor}

  // ---------- Kommunikation ----------

  async function call(msg) {
    const res = await browser.runtime.sendMessage({ ...msg, tabId });
    if (res && res.ok === false) throw Object.assign(new Error(res.error), { code: res.error });
    return res;
  }

  function showError(err) {
    const box = $("msg");
    box.textContent = ERRORS[err.code] || `Fehler: ${err.code || err.message}`;
    box.classList.remove("hidden");
  }

  function clearError() {
    $("msg").classList.add("hidden");
  }

  /** Popup-Zustand übernehmen. Lokale Werte nur ersetzen, wenn withValues gesetzt ist. */
  function applyPopupState(res, withValues) {
    tab = res.tab;
    modes = res.modes;
    defaultModeId = res.defaultModeId;
    if (withValues) values = SS.clampValues(tab.values);
    render();
  }

  function scheduleSend() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(flushValues, DEBOUNCE_MS);
  }

  async function flushValues() {
    if (sendTimer === null) return;
    clearTimeout(sendTimer);
    sendTimer = null;
    try {
      const res = await call({ type: "setValues", values });
      applyPopupState(res, false);
    } catch (err) {
      showError(err);
    }
  }

  async function action(msg, withValues) {
    clearError();
    await flushValues();
    try {
      applyPopupState(await call(msg), withValues);
      return true;
    } catch (err) {
      showError(err);
      return false;
    }
  }

  function setValue(path, v) {
    if (path.length === 1) values[path[0]] = v;
    else values[path[0]][path[1]] = v;
    values = SS.clampValues(values);
    render();
    scheduleSend();
  }

  // ---------- Aufbau ----------

  function buildSliders() {
    const root = $("sliders");
    for (const s of SLIDERS) {
      const wrap = document.createElement("div");
      if (s.toggle) {
        wrap.className = "control toggle";
        const label = document.createElement("label");
        label.className = "switch-row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.addEventListener("change", () => setValue([s.toggle], input.checked));
        const sw = document.createElement("span");
        sw.className = "switch";
        const text = document.createElement("span");
        text.textContent = s.label;
        label.append(input, sw, text);
        wrap.append(label);
        controls[s.toggle] = { input, wrap, spec: s };
      } else {
        const lim = SS.LIMITS[s.key];
        wrap.className = "control";
        const label = document.createElement("label");
        label.textContent = s.label;
        const hint = document.createElement("span");
        hint.className = "hint";
        label.append(hint);
        const value = document.createElement("span");
        value.className = "value";
        const input = document.createElement("input");
        input.type = "range";
        input.min = lim.min;
        input.max = lim.max;
        input.step = lim.step;
        input.setAttribute("aria-label", s.label);
        input.addEventListener("input", () => setValue([s.key], Number(input.value)));
        wrap.append(label, value, input);
        controls[s.key] = { input, value, wrap, hint, spec: s };
      }
      root.append(wrap);
    }
  }

  function presetOf(ramp) {
    if (ramp.durationMs === 0) return "sofort";
    for (const [name, b] of Object.entries(SS.BEZIER_PRESETS)) {
      if (SS.valuesEqual(b, ramp.bezier)) return name;
    }
    return "custom";
  }

  function buildRamps() {
    for (const r of RAMPS) {
      const box = $(r.el);
      const lim = SS.LIMITS[r.limit];

      const durWrap = document.createElement("div");
      durWrap.className = "control";
      const durLabel = document.createElement("label");
      durLabel.textContent = "Dauer";
      const durationValue = document.createElement("span");
      durationValue.className = "value";
      const duration = document.createElement("input");
      duration.type = "range";
      duration.min = lim.min;
      duration.max = lim.max;
      duration.step = lim.step;
      duration.setAttribute("aria-label", `Dauer ${r.key}`);
      duration.addEventListener("input", () => setValue([r.key, "durationMs"], Number(duration.value)));
      durWrap.append(durLabel, durationValue, duration);

      const presetRow = document.createElement("div");
      presetRow.className = "row";
      presetRow.style.marginTop = "6px";
      const presetLabel = document.createElement("span");
      presetLabel.textContent = "Kurve";
      const preset = document.createElement("select");
      for (const [val, text] of [
        ["sofort", "sofort"],
        ["linear", "linear"],
        ["ease-in", "ease-in"],
        ["ease-out", "ease-out"],
        ["ease-in-out", "ease-in-out"],
        ["custom", "benutzerdefiniert"],
      ]) {
        const o = document.createElement("option");
        o.value = val;
        o.textContent = text;
        preset.append(o);
      }
      preset.addEventListener("change", () => {
        const ramp = values[r.key];
        if (preset.value === "sofort") {
          ramp.durationMs = 0;
        } else {
          if (ramp.durationMs === 0) ramp.durationMs = SS.DEFAULT_VALUES[r.key].durationMs;
          if (SS.BEZIER_PRESETS[preset.value]) ramp.bezier = [...SS.BEZIER_PRESETS[preset.value]];
        }
        values = SS.clampValues(values);
        ramps[r.key].editor.setBezier(values[r.key].bezier);
        render();
        scheduleSend();
      });
      presetRow.append(presetLabel, preset);

      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", `Kurve ${r.key}`);
      box.append(durWrap, presetRow, canvas);

      const editor = new CurveEditor(canvas, (b) => {
        // Bei „sofort“ hätte die Kurve keine Wirkung – Ziehen aktiviert wieder eine Dauer
        if (values[r.key].durationMs === 0) values[r.key].durationMs = SS.DEFAULT_VALUES[r.key].durationMs;
        setValue([r.key, "bezier"], b);
      });
      ramps[r.key] = { duration, durationValue, preset, editor };
    }
  }

  // ---------- Darstellung ----------

  function formatSaved(sec) {
    const s = Math.round(sec);
    if (s < 60) return `${s} s gespart`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s gespart`;
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min gespart`;
  }

  function render() {
    if (!tab) return;
    $("enabled").checked = tab.enabled;
    $("saved").textContent = formatSaved(tab.savedSeconds);

    for (const s of SLIDERS) {
      const c = controls[s.toggle || s.key];
      const disabled = s.disabled ? s.disabled(values) : false;
      c.wrap.classList.toggle("disabled", disabled);
      c.input.disabled = disabled;
      if (s.toggle) {
        c.input.checked = values[s.toggle];
      } else {
        if (document.activeElement !== c.input) c.input.value = values[s.key];
        c.value.textContent = s.fmt(values[s.key]);
        c.hint.textContent = s.hint ? s.hint(values) : "";
      }
    }

    for (const r of RAMPS) {
      const ui = ramps[r.key];
      const ramp = values[r.key];
      if (document.activeElement !== ui.duration) ui.duration.value = ramp.durationMs;
      ui.durationValue.textContent = `${de(ramp.durationMs, 0)} ms`;
      const preset = presetOf(ramp);
      // „benutzerdefiniert“ ist nur eine Anzeige für gezogene Kurven, keine Auswahl
      ui.preset.querySelector('option[value="custom"]').disabled = preset !== "custom";
      ui.preset.value = preset;
      if (!ui.editor.dragging && !SS.valuesEqual(ui.editor.getBezier(), ramp.bezier)) {
        ui.editor.setBezier(ramp.bezier);
      }
    }

    renderModes();
  }

  let modeOptionsKey = "";
  function renderModes() {
    const select = $("mode");
    const mode = modes[tab.modeId];
    const list = SS.sortedModes({ modes });
    // Nur neu aufbauen, wenn sich etwas geändert hat – sonst schließt sich ein offenes Dropdown
    const key = JSON.stringify([!mode, defaultModeId, list]);
    if (key !== modeOptionsKey) {
      modeOptionsKey = key;
      select.textContent = "";
      if (!mode) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "– Kein Modus –";
        select.append(o);
      }
      for (const { id, name } of list) {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = id === defaultModeId ? `${name} ★` : name;
        select.append(o);
      }
    }
    select.value = mode ? tab.modeId : "";
    const changed = mode ? !SS.valuesEqual(values, SS.clampValues(mode.values)) : false;
    $("modeStatus").textContent = changed ? "(geändert)" : "";
    $("btnSave").disabled = !mode || !changed;
    $("btnReset").disabled = !mode || !changed;
    $("btnDefault").disabled = !mode || tab.modeId === defaultModeId;
    $("btnDelete").disabled = !mode || Object.keys(modes).length <= 1;
  }

  function renderLevel(info) {
    const fill = $("meterFill");
    const thr = $("meterThr");
    const hyst = $("meterHyst");
    const status = $("meterStatus");
    const vals = $("meterValues");
    const pct = (db) =>
      `${(Math.min(1, Math.max(0, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB))) * 100).toFixed(1)}%`;

    const hasSample = info.best && info.best.levelDb !== null;
    if (!hasSample) {
      fill.style.width = "0";
      thr.style.display = hyst.style.display = "none";
      vals.textContent = "";
    }

    if (!info.reachable) status.textContent = "Auf dieser Seite nicht verfügbar";
    else if (info.mediaCount === 0) status.textContent = "Kein Medium gefunden";
    else if (!hasSample && info.unsupported > 0) status.textContent = "Medium nicht unterstützt (fremde Quelle)";
    else if (!tab.enabled) status.textContent = "Aus – zum Messen einschalten";
    else if (!hasSample) status.textContent = "Warte auf Wiedergabe …";
    if (!hasSample) return;

    const b = info.best;
    fill.style.width = pct(b.levelDb);
    fill.classList.toggle("silence", b.phase === "silence");
    thr.style.display = hyst.style.display = "block";
    thr.style.left = pct(b.thresholdDb);
    hyst.style.left = pct(b.thresholdDb + values.hysteresisDb);
    // Nur für das angezeigte Element – ein anderes, normal laufendes Element soll nicht gestört werden
    if (b.foreign) status.textContent = "Medium nicht unterstützt (fremde Quelle)";
    else if (b.muted && b.playing) status.textContent = "Stumm – keine Messung";
    else if (b.silentInput) status.textContent = "Kein Signal – Quelle evtl. nicht unterstützt";
    else status.textContent = !b.playing ? "Pausiert" : b.phase === "silence" ? "Stille" : "Ton";
    vals.textContent = `${de(b.levelDb, 0)} dB · Schwelle ${de(b.thresholdDb, 0)} dB`;
  }

  // ---------- Pegel abfragen ----------

  let levelBusy = false;
  async function pollLevel() {
    if (levelBusy || !tab) return;
    levelBusy = true;
    try {
      const frames = [...new Set([0, ...(tab.frames || [])])];
      const results = await Promise.allSettled(
        frames.map((frameId) => browser.tabs.sendMessage(tabId, { type: "getLevel" }, { frameId })),
      );
      const info = { reachable: false, mediaCount: 0, unsupported: 0, best: null };
      const dead = frames.filter((f, i) => f !== 0 && results[i].status === "rejected");
      if (dead.length) call({ type: "dropFrames", frameIds: dead }).catch(() => {});
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value) continue;
        const v = r.value;
        info.reachable = true;
        info.mediaCount += v.mediaCount;
        info.unsupported += v.unsupportedCount;
        if (v.levelDb === null) continue;
        const b = info.best;
        if (!b || (v.playing && !b.playing) || (v.playing === b.playing && v.levelDb > b.levelDb)) {
          info.best = v;
        }
      }
      renderLevel(info);
    } finally {
      levelBusy = false;
    }
  }

  async function pollState() {
    if (sendTimer !== null) return;
    try {
      const res = await call({ type: "getPopupState" });
      applyPopupState(res, false);
    } catch {
      // Popup wird gerade geschlossen
    }
  }

  // ---------- Ereignisse ----------

  function wireEvents() {
    $("enabled").addEventListener("change", (e) => action({ type: "setEnabled", enabled: e.target.checked }, false));
    $("mode").addEventListener("change", (e) => {
      if (e.target.value) action({ type: "loadMode", modeId: e.target.value }, true);
    });
    $("btnSave").addEventListener("click", () => action({ type: "saveMode" }, false));
    $("btnReset").addEventListener("click", () => action({ type: "resetToMode" }, true));
    $("btnMore").addEventListener("click", () => $("moreMenu").classList.toggle("hidden"));
    $("btnDefault").addEventListener("click", async () => {
      if (await action({ type: "setDefaultMode", modeId: tab.modeId }, false)) $("moreMenu").classList.add("hidden");
    });

    $("btnSaveAs").addEventListener("click", () => {
      $("saveAsForm").classList.remove("hidden");
      $("saveAsName").value = "";
      $("saveAsName").focus();
    });
    $("saveAsCancel").addEventListener("click", () => $("saveAsForm").classList.add("hidden"));
    $("saveAsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (await action({ type: "saveModeAs", name: $("saveAsName").value }, false)) {
        $("saveAsForm").classList.add("hidden");
      }
    });

    $("btnDelete").addEventListener("click", () => {
      const mode = modes[tab.modeId];
      if (!mode) return;
      $("deleteText").textContent = `„${mode.name}“ löschen?`;
      $("deleteConfirm").classList.remove("hidden");
    });
    $("deleteNo").addEventListener("click", () => $("deleteConfirm").classList.add("hidden"));
    $("deleteYes").addEventListener("click", async () => {
      $("deleteConfirm").classList.add("hidden");
      $("moreMenu").classList.add("hidden");
      await action({ type: "deleteMode", modeId: tab.modeId }, false);
    });

    window.addEventListener("pagehide", () => {
      if (sendTimer !== null) flushValues();
    });
  }

  // ---------- Start ----------

  async function init() {
    buildSliders();
    buildRamps();
    wireEvents();
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!active) return;
    tabId = active.id;
    try {
      applyPopupState(await call({ type: "getPopupState" }), true);
    } catch (err) {
      showError(err);
      return;
    }
    setInterval(pollLevel, LEVEL_POLL_MS);
    setInterval(pollState, STATE_POLL_MS);
    pollLevel();
  }

  init();
})();
