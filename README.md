# Skip Silence Vibe

Firefox-Extension, die Stille in Video und Audio erkennt und diese Stellen beschleunigt abspielt. Alle Einstellungen gelten **pro Tab**: Der Podcast in einem Tab läuft mit anderen Werten als der Vortrag im nächsten.

Das Projekt ist vibe-gecodet: Es entstand im Dialog mit [Claude Code](https://claude.com/claude-code). Jede Änderung lief durch automatische Tests in Firefox und durch mehrere unabhängige Review-Runden.

## Danke, Skip Silence

Dieses Projekt gäbe es nicht ohne [**Skip Silence**](https://github.com/vantezzen/skip-silence) von [vantezzen](https://github.com/vantezzen). Die Extension hat mir lange Zeit treue Dienste geleistet und unzählige Stunden Podcasts und Vorträge kürzer gemacht. Danke dafür!

Skip Silence Vibe ist ein Nachbau mit eigenen Erweiterungen, vor allem Einstellungen pro Tab, Modi und Übergangskurven. Der dynamische Schwellwert, die Hysterese und der Lookahead sind direkt vom Original inspiriert (MIT-Lizenz, siehe [NOTICE](NOTICE)). Wer eine ausgereifte Extension für Chrome und Firefox sucht, ist beim Original richtig:

- [Skip Silence für Firefox](https://addons.mozilla.org/firefox/addon/skip-silence/)
- [Skip Silence für Chrome](https://chrome.google.com/webstore/detail/skip-silence/fhdmkhbefcbhakffdihhceaklaigdllh)

## Funktionen

- **Pro Tab:** Jeder Tab hat eigene Werte. Ein neuer Tab startet mit dem Standard-Modus und ist ausgeschaltet. Navigierst du im selben Tab weiter, bleiben die Werte erhalten.
- **Modi:** Benannte Wertesätze. Einen Modus laden, einzelne Regler anpassen (das Popup zeigt dann „(geändert)“), mit *Speichern* übernehmen oder mit *Zurücksetzen* verwerfen. Der Modus mit ★ ist der Standard für neue Tabs.
- **Weiche Übergänge:** Für „Stille an“ und „Stille aus“ gibt es getrennt eine Dauer und eine Bézier-Kurve. Die Kurve wird im Editor gezogen oder als Preset gewählt.
- **Pause und Play:** Während Pause, Spulen und Puffern ist die Erkennung eingefroren. Nach Play ist sofort normale Geschwindigkeit und volle Lautstärke da. Die *Schonzeit* verhindert, dass ein ruhiger Anfang gleich übersprungen wird.
- **Dynamischer Schwellwert:** Der Schwellwert passt sich an das Grundrauschen der Aufnahme an: 15. Perzentil der letzten 10 s plus „Abstand zum Rauschen“, begrenzt auf −60 bis −20 dB.
- **Hysterese:** Stille endet erst, wenn der Pegel um diesen Wert über dem Schwellwert liegt. So springt der Zustand an der Grenze nicht hin und her.
- **Stille stummschalten** mit optionalem **Lookahead:** Der Ton wird um 60 ms verzögert, damit das Einblenden vor der ersten Silbe fertig ist.
- **Pegelanzeige** mit Schwellwert-Linie (gelb) und Hysterese-Linie (dünn) sowie die **gesparte Zeit** pro Tab.
- **Tastenkürzel** `Alt+Shift+S` schaltet den aktuellen Tab an oder aus. Änderbar unter `about:addons` → Zahnrad → *Tastenkombinationen für Erweiterungen verwalten*.

## Installation

### Fertige Version (dauerhaft)

Unter [Releases](../../releases) liegt eine von Mozilla signierte `.xpi`. Datei in ein Firefox-Fenster ziehen oder über `about:addons` → Zahnrad → *Add-on aus Datei installieren …* öffnen. Danach unter `about:addons` → *Berechtigungen* den Zugriff auf alle Websites erlauben.

### Zum Ausprobieren aus dem Quellcode (temporär)

1. `about:debugging#/runtime/this-firefox` öffnen
2. *Temporäres Add-on laden …* → `manifest.json` aus diesem Ordner wählen
3. Beim ersten Mal unter `about:addons` → Skip Silence → *Berechtigungen* den Zugriff auf alle Websites erlauben. Manifest V3 verlangt das.

Das Add-on verschwindet beim Neustart von Firefox. Alternativ lädt `npm start` (`web-ext run`) eine Firefox-Instanz mit installierter Extension, die bei Dateiänderungen automatisch neu lädt.

### Eigene Version signieren

Normales Firefox installiert nur signierte Extensions. Die Signatur ist kostenlos, das Add-on bleibt privat („unlisted“). Für eine eigene Version die `id` in `manifest.json` (`browser_specific_settings.gecko.id`) ändern:

1. API-Schlüssel unter <https://addons.mozilla.org/developers/addon/api/key/> anlegen
2. Signieren:

   ```bash
   npx web-ext sign --channel=unlisted --api-key=… --api-secret=… --ignore-files 'test/**' 'docs/**' 'reviews/**'
   ```

3. Die `.xpi` aus `web-ext-artifacts/` per Drag & Drop in Firefox ziehen

Alternativ: In Firefox Developer Edition oder Nightly unter `about:config` `xpinstall.signatures.required = false` setzen.

## Anpassen

| Was | Wo |
|---|---|
| Wertebereiche und Standardwerte der Regler | `lib/defaults.js` |
| Konstanten des dynamischen Schwellwerts, Lookahead-Zeit | `lib/detector.js` (`SS.DETECTOR`) |
| Logik Ton/Stille | `lib/detector.js` |
| Geschwindigkeit, Lautstärke, Übergänge | `content.js` (`MediaController`) |
| Tab-Zustände, Modi, Kürzel | `background.js` |
| Oberfläche | `popup/` |

Nach Änderungen das Add-on unter `about:debugging` mit *Neu laden* aktualisieren.

## Tests

```bash
npm install
npm test               # Unit-Tests: Logik und background.js (Node)
npm run test:browser   # Firefox: Content-Script-Szenarien, Popup, echte Extension (E2E)
npm run lint           # ESLint + web-ext lint
```

`npm run test:browser` braucht einmalig `npx playwright install firefox`. Die Test-WAVs werden mit `npm run fixture` neu erzeugt.

Alle Browser-Tests laufen lautlos. Der E2E-Test installiert die echte Extension temporär, öffnet über das Firefox-Remote-Debugging-Protokoll (`test/rdp.mjs`) ihre Popup-Seite und schaltet von dort ein. Die Testseite hat eine strenge Content-Security-Policy und enthält `<audio>` im DOM, im geschlossenen Shadow DOM und per `new Audio()`.

## Bekannte Grenzen

- **Medien von fremden Domains ohne CORS** werden nicht angehängt, weil Firefox ihren Ton sonst stummschalten würde. Das Popup zeigt dann „Medium nicht unterstützt (fremde Quelle)“. YouTube und die meisten Streaming-Seiten nutzen `blob:`-Quellen und funktionieren.
- Wechselt ein bereits angehängtes Element später auf eine fremde Quelle ohne CORS, oder leitet die eigene Domain auf ein fremdes CDN weiter, bleibt es stumm, bis die Seite neu geladen wird. Die Verbindung zur Audio-Kette lässt sich nicht lösen. Das Popup meldet dann „Medium nicht unterstützt“ bzw. nach 5 s „Kein Signal“.
- Medien in Shadow-DOMs und per `new Audio()` werden erkannt, wenn die Seite `play()` aufruft. Medien in offenen Shadow-DOMs findet zusätzlich eine Suche beim Einschalten und danach regelmäßig (frühestens alle 5 s, auf sehr großen Seiten seltener). Nicht erkannt werden Elemente in geschlossenen Shadow-DOMs, die ohne `play()`-Aufruf starten (`autoplay`-Attribut, eingebaute Bedienelemente).
- Klänge unter 5 s (Effekte, Klick-Sounds) werden absichtlich nicht angehängt.
- Stumme Medien (`muted`, Lautstärke 0, ohne Tonspur) werden nicht beschleunigt – ohne Ton gibt es nichts zu messen.
- Normalgeschwindigkeit 1,0 läuft intern mit 1,0001, also 0,01 % schneller (eine Sekunde auf knapp drei Stunden). Bei exakt 1,0 würde Firefox beim nächsten Beschleunigen kurz alten Ton wiederholen. Folgen: Der Ton läuft dauerhaft durch die Zeitstreckung von Firefox und kommt etwa 25 ms später als das Bild; Player der Seite können „1.0001x“ statt „Normal“ anzeigen.
- Schaltet man die Extension mitten im Ton aus und in einer Pause wieder ein, kann einmalig ein sehr leiser Rest alten Tons hörbar sein (bekannt, wird behoben).
- Nur Firefox. Für Chrome wären Anpassungen nötig (Service Worker, `chrome.*`-API, Erkennung in Shadow DOM).
- Der Lookahead verschiebt den Ton zusätzlich um 60 ms gegenüber dem Bild. Das liegt unter der Wahrnehmungsgrenze von etwa 125 ms.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
