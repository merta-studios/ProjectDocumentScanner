# Ultra Scan

Dokumentenscanner als reine Web-App: kein Build, kein Server, kein CDN.
Die komplette Bildverarbeitung ist die **unveränderte** Original-Pipeline aus
der Datei `scanner`, ausgeführt per Pyodide (Python + NumPy + OpenCV als
WebAssembly, selbst gehostet unter `vendor/pyodide-0.27.7/`).

## Aufbau

| Datei | Aufgabe |
|---|---|
| `scanner` | **Original-Pipeline – byte-identisch, wird nie verändert.** |
| `scan_wrapper.py` | Importiert `scanner` und ruft dessen Funktionen auf (Vollscan, Live-Viereck). Keine eigene Bildlogik. |
| `worker.js` | Pyodide im Web Worker, lädt `scanner` unverändert ins virtuelle Dateisystem. |
| `app.js` | Oberfläche: Vollbildkamera, Live-Overlay, Auto-Auslöser, Scan-Liste, Teilen. |
| `pdf.js` | Eigener minimaler PDF-Erzeuger (JPEG-Seiten), lokal, ohne Bibliothek. |
| `app.css` | Liquid-Glass-Design, responsiv für iPhone und iPad (quer & hoch). |
| `sw.js` | Service Worker, cacht die ~28 MB Laufzeit für schnelle Folgestarts. |

## Funktionen

* **Vollbild-Kamera** als Hauptscreen, Top-Bar mit Logo.
* **Live-Erkennung** ausschließlich über `scanner.find_rough_quad()` auf
  verkleinerten Frames (320 px); animiertes Viereck mit blau leuchtender
  Innenfläche.
* **Automatischer Auslöser**: löst erst aus, wenn das Viereck groß genug
  (≥ 17 % der Fläche), über mehrere Frames stabil und die Kamera ruhig ist
  (Frame-Differenz-Messung). Danach läuft der komplette Ultra Scan.
* **Pinch-to-Zoom**: nutzt die native Kamera-Zoom-API, wo vorhanden
  (Android/Chrome). iOS/Safari kennt sie nicht → digitaler Zoom per
  Transform, und das aufgenommene Bild wird exakt auf den sichtbaren
  Ausschnitt zugeschnitten.
* **Bildquellen**: Zwischenablage, Foto, Datei. Hinweis: iOS gibt
  `navigator.clipboard.read()` nur eingeschränkt frei – als Fallback gibt es
  eine klare Meldung und zusätzlich funktioniert „Einsetzen“ direkt auf der
  Seite (`paste`-Event).
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
