# Ultra Scan

Dokumentenscanner als reine Web-App: kein Build, kein Server, kein CDN.
Die komplette Bildverarbeitung ist die **unveränderte** Original-Pipeline aus
der Datei `scanner`, ausgeführt per Pyodide (Python + NumPy + OpenCV als
WebAssembly, selbst gehostet unter `vendor/pyodide-0.27.7/`).

Die **Live-Erkennung im Sucher** läuft seit der Überarbeitung nicht mehr über
Python, sondern in reinem JavaScript (`detect.js`). Grund: über Pyodide waren
nur ~5 Bilder je Sekunde möglich, das Viereck zitterte und sprang. `detect.js`
schafft dieselbe Aufgabe in rund 8 ms je Bild. Die Datei `scanner` selbst
bleibt davon unberührt und weiterhin byte-identisch – sie macht nach wie vor
den eigentlichen Scan.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `scanner` | **Original-Pipeline – byte-identisch, wird nie verändert.** |
| `scan_wrapper.py` | Importiert `scanner` und ruft dessen Funktionen auf. Entscheidet zusätzlich, welche Geometrie-Schritte übernommen werden (siehe unten). |
| `detect.js` | Live-Erkennung des Dokument-Vierecks in reinem JavaScript. |
| `detect-worker.js` | Winziger Worker, der `detect.js` lädt und jeden Sucher-Frame beantwortet. |
| `worker.js` | Pyodide im Web Worker, lädt `scanner` unverändert ins virtuelle Dateisystem. |
| `app.js` | Oberfläche: Vollbildkamera, Live-Overlay, Auto-Auslöser, Scan-Liste, Teilen. |
| `pdf.js` | Eigener minimaler PDF-Erzeuger (JPEG-Seiten), lokal, ohne Bibliothek. |
| `app.css` | Liquid-Glass-Design, responsiv für iPhone und iPad (quer & hoch). |
| `sw.js` | Service Worker, cacht die ~28 MB Laufzeit für schnelle Folgestarts. |

## Funktionen

* **Vollbild-Kamera** als Hauptscreen, Top-Bar mit Logo.
* **Live-Erkennung** über `detect.js` (Sobel → Hough → Kantenpaare →
  Bewertung jedes Vierecks nach Kantenstütze, Kontrast-Polarität und
  Stufen-Test). Läuft im eigenen Worker mit voller Bildrate; animiertes
  Viereck mit blau leuchtender Innenfläche, adaptiv geglättet (kleine
  Abweichungen stark gedämpft, schnelle Schwenks ohne Nachziehen).
* **Automatischer Auslöser**: statt harter „alles-oder-nichts“-Prüfung je
  Bild gibt es einen **Bereitschaftsring**, der sich füllt, solange das Bild
  passt, und nur langsam wieder leert. Beurteilt wird ein Zeitfenster von
  420 ms: *Zittern* (Abweichung der Ecken von ihrer mittleren Lage),
  *Wandergeschwindigkeit*, belichtungsnormierte *Bewegung* und die
  *Schärfe* (Laplace-Varianz). Kurzes Wackeln kostet dadurch etwas
  Bereitschaft, aber keinen Neustart – Handhalten und iPad funktionieren.
* **Pinch-to-Zoom**: nutzt die native Kamera-Zoom-API, wo vorhanden
  (Android/Chrome). iOS/Safari kennt sie nicht → digitaler Zoom per
  Transform, und das aufgenommene Bild wird exakt auf den sichtbaren
  Ausschnitt zugeschnitten.
* **Bildquellen**: Zwischenablage, Foto, Datei. Hinweis: iOS gibt
  `navigator.clipboard.read()` nur eingeschränkt frei – als Fallback gibt es
  eine klare Meldung und zusätzlich funktioniert „Einsetzen“ direkt auf der
  Seite (`paste`-Event).
* **Viereck-Übergabe**: beim Auslösen wird das live erkannte Viereck in
  Aufnahme-Koordinaten umgerechnet und an die Pipeline mitgegeben. Sie sucht
  das Blatt dann nicht erneut, sondern zieht mit `scanner.refine_edges()` nur
  noch die Kanten im großen Bild nach. Der Scan sitzt damit genau dort, wo
  der Rahmen im Sucher stand.
* **Geprüfte Geometrie** (`scan_wrapper.py`, Original-Pipeline unverändert):
  Buchfalz-Schnitt, Wellen-Glättung, Drehung und Scherung werden *gemessen*
  und nur übernommen, wenn der Text dadurch nachweislich gerader wird. Der
  Falz darf nur in einer echten Textlücke geschnitten werden (ein
  Schattenstreifen quer über einer Seite ist kein Falz). Drehung und
  Scherung laufen auf einer **mitwachsenden Leinwand**, damit keine Ecke aus
  dem Bild fällt. Gedreht wird **vor** der Wellen-Glättung, sonst hält diese
  eine schräge Seite für eine Krümmung und verzieht den Text.
* **Kein Dokument erkannt** → nichts wird verarbeitet, es erscheint eine
  Meldung (entschieden im Wrapper, nicht in der Pipeline).
* **Scan-Liste**: scrollbar, weitere Scans hinzufügen, jeden Scan um 90°
  drehen, ab 2 Scans einzeln löschen.
* **Teilen**: als Bild oder als PDF (alle Scans als Seiten, A4, clientseitig
  erzeugt).

## Hosting

GitHub Pages, „Deploy from a branch“, `main`, `/ root`.
Die App liegt in einem Unterpfad (`/ProjectDocumentScanner/`) – alle Pfade
sind relativ, Service-Worker-Scope und Manifest (`start_url: "./"`,
`scope: "./"`) funktionieren dort. `netlify.toml` bleibt für später liegen.

## Lokal testen

```bash
python3 -m http.server 8080
# http://localhost:8080/  (Kamera braucht https oder localhost)
```

## Prüfwerkzeuge

Die Testbilder werden erzeugt, nicht eingecheckt:

```bash
python3 tools/testbilder.py /tmp/ultrascan-tests   # 34 Szenen + Live-Frames
node   tools/bench_live.js  /tmp/ultrascan-tests   # Live-Erkennung (Zittern!)
node   tools/bench_detect.js /tmp/ultrascan-tests  # Erkennung in voller Größe
node   tools/test_worker.js /tmp/ultrascan-tests   # Nachrichten des Workers
python3 tools/bench_scan.py /tmp/ultrascan-tests   # Scan alt gegen neu
```

`tools/bench_scan.py` vergleicht den aktuellen Wrapper mit dem Stand aus
`git HEAD` und misst, wie stark der linke Textrand von Zeile zu Zeile
wandert – also genau das, was als „alles verrutscht“ auffällt.
