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
die Geometrie (Entzerren, Entdrehen, Zuschneiden) des eigentlichen Scans.

Seit der Erkennungs-Überarbeitung kommen zwei Dinge dazu:

1. **Ein neuronales Netz als zweite Meinung** (`detect-nn.js`, Modell
   `models/docaligner-lcnet100-heatmap-256.onnx`). Es findet die vier Ecken
   auch dann, wenn es gar keine sichtbaren Kanten gibt – weißes Blatt auf
   weißem Tisch, abgeschnittene Ecken, wildes Durcheinander im Hintergrund.
   Klassische Geometrie und Netz konkurrieren, das bessere Viereck gewinnt.
2. **Eine neue Scan-Veredelung** in `scan_wrapper.py`, die in Halbtönen
   arbeitet statt mit einer harten Schwarz-Weiß-Maske. Damit verschwinden
   keine Buchstaben, Bleistift und Fotos mehr.

Beides ist unten im Detail beschrieben. Woher Modell und Ideen stammen,
steht in [`models/HERKUNFT.md`](models/HERKUNFT.md) und im Abschnitt
„Herkunft“.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `scanner` | **Original-Pipeline – byte-identisch, wird nie verändert.** |
| `scan_wrapper.py` | Importiert `scanner` und ruft dessen Funktionen auf. Entscheidet zusätzlich, welche Geometrie-Schritte übernommen werden (siehe unten). |
| `detect.js` | Live-Erkennung des Dokument-Vierecks in reinem JavaScript. Nimmt zusätzlich fremde Viereck-Vorschläge als Kandidaten entgegen. |
| `detect-worker.js` | Winziger Worker, der `detect.js` lädt und jeden Sucher-Frame beantwortet. Reicht die KI-Vorschläge mit durch. |
| `detect-nn.js` | Das neuronale Eckennetz (DocAligner) über onnxruntime-web. |
| `nn-worker.js` | Eigener Worker nur für das Netz – es darf die Geometrie nie ausbremsen. |
| `models/` | Das ONNX-Modell (4,6 MB) samt Lizenz und Herkunftsnachweis. |
| `vendor/onnxruntime-web-1.20.1/` | ONNX-Laufzeit (WASM), selbst gehostet. |
| `worker.js` | Pyodide im Web Worker, lädt `scanner` unverändert ins virtuelle Dateisystem. |
| `app.js` | Oberfläche: Vollbildkamera, Live-Overlay, Auto-Auslöser, Scan-Liste, Teilen. |
| `pdf.js` | Eigener minimaler PDF-Erzeuger (JPEG-Seiten), lokal, ohne Bibliothek. |
| `app.css` | Liquid-Glass-Design, responsiv für iPhone und iPad (quer & hoch). |
| `sw.js` | Service Worker, cacht die ~44 MB Laufzeit (Pyodide + ONNX) für schnelle Folgestarts. |

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
* **Scan-Stil** (Pille unter dem Auslöser): Farbe, Graustufen oder
  Schwarz-Weiß. Die Auswahl bleibt gespeichert.
* **Kein Dokument erkannt** → nichts wird verarbeitet, es erscheint eine
  Meldung (entschieden im Wrapper, nicht in der Pipeline).
* **Scan-Liste**: scrollbar, weitere Scans hinzufügen, jeden Scan um 90°
  drehen, ab 2 Scans einzeln löschen.
* **Teilen**: als Bild oder als PDF (alle Scans als Seiten, A4, clientseitig
  erzeugt).

## Erkennung: zwei Verfahren, ein Sieger

Die alte Erkennung war rein geometrisch: Kanten finden, Linien finden,
Vierecke bilden, bewerten. Auf gestellten Testbildern ist das perfekt – auf
echten Handyfotos fällt es dort um, wo es **keine sichtbare Kante gibt**:
weißes Papier auf hellem Tisch, Blatt läuft aus dem Bild, Zettelchaos
drumherum.

Deshalb laufen jetzt **zwei unabhängige Verfahren** und das Ergebnis wird
nach *denselben* Maßstäben bewertet:

```
Sucherbild
   ├── detect.js      (Sobel → Hough → Linienpaare → Vierecke)   ~8 ms
   └── detect-nn.js   (DocAligner-Heatmap, 256×256, ONNX)        ~40 ms
            │
            └── beide Vorschläge gehen durch dieselbe Bewertung
                (Kantenstütze, Abdeckung, Polarität, Fläche)
                            │
                        bestes Viereck
```

**Warum nicht einfach dem Netz glauben?** Weil es sich irren kann und dann
sehr selbstbewusst irrt. Also bekommt das Netz nur einen *Bonus* in der
gemeinsamen Bewertung: `0.5 + 1.8 · Konfidenz²`. Quadratisch, nicht linear –
ein linearer Bonus hat in den Messungen ein gutes klassisches Viereck gegen
eine 0,46-Vermutung des Netzes verloren. Nur ab einer Konfidenz von 0,85
darf das Netz die klassische Notlösung ganz überspringen.

**Warum ein eigener Worker?** Das Netz braucht rund 40 ms, die Geometrie 8 ms.
Lägen beide im selben Worker, würde der Sucher auf das Netz warten. So läuft
das Netz nebenher (höchstens alle 60 ms ein Bild) und sein letztes Ergebnis
gilt 700 ms lang als Kandidat weiter.

**Beim Auslösen** läuft zusätzlich `erkenneGruendlich()`: dasselbe Netz,
aber das Bild wird zusätzlich mit 12 % und 26 % Rand ringsum probiert. Das
ist das Gegenmittel gegen die bekannte Schwäche solcher Netze – Ecken, die
außerhalb des Bildes liegen, kleben sonst am Bildrand fest.

Messergebnis auf 14 echten Handyfotos (`tools/bench_fusion.mjs`):
**14 von 14 erkannt**, davon 11 über das Netz und 3 über die Geometrie,
im Schnitt 47 ms. Die synthetische Suite bleibt unverändert bei 34/34.

## Veredelung: Halbtöne statt harter Maske

Das war der eigentliche Grund für „die Scans sehen furchtbar aus“.

Die Original-Pipeline hat am Ende `mode_hybrid()` benutzt: eine **harte
adaptive Schwelle** bestimmt, was Tinte ist, und diese Tinte wird auf
reinweißen Grund kopiert. Alles, was die Schwelle nicht erwischt, wird weiß.
In der Praxis heißt das:

* Löcher mitten in Buchstaben, abgerissene dünne Striche,
* helle Höfe um fette Überschriften,
* Bleistift, Raster und Fotos komplett verschwunden
  (ein Geldschein verlor das Porträt, ein Notizblock 93 % seiner Schrift),
* und das Ganze bei doppelter Auflösung, also doppelter Dateigröße.

Die neue Veredelung in `scan_wrapper.py` fasst kein Pixel hart an:

| Schritt | Was passiert | Warum |
|---|---|---|
| `beleuchtung_ausgleichen` | Lichtfeld aus einer 480-px-Verkleinerung schätzen (Closing + Median + Gauß), **ein** Verstärkungsfaktor für alle drei Kanäle, begrenzt auf ⅖ … 2,4 | Schatten und Handyblitz raus. Ein gemeinsamer Faktor, weil kanalweise Korrektur große farbige Flächen ausbleicht |
| `farbrauschen_daempfen` | In LAB nur `a` und `b` mit Median glätten | Handykameras rauschen in der Farbe. Die Helligkeit – und damit jeder Buchstabe – bleibt unangetastet |
| `tonwert_spreizen` | Weißpunkt **pro Kanal** auf der Papierfläche messen, Schwarzpunkt gemeinsam, weiche Schulter oben | Macht vergilbtes oder blaustichiges Papier neutral, ohne farbige Inhalte zu verfälschen |
| `lokaler_kontrast` | CLAHE auf dem L-Kanal, `clipLimit 1.3` | Holt blasse Bleistiftschrift hoch, ohne Rauschen hochzuziehen |
| `hintergrund_weissen` | Weicher Smoothstep-Übergang ab Grauwert 197, **nur** bei geringer Buntheit | Papier wird wirklich weiß – aber Bleistift, Marker und Stempel überleben |
| `schaerfen` | Unscharf maskieren, σ = 1,0, Stärke 0,6, Schwelle 4 | Kleiner Radius heißt: knackig ohne weiße Höfe |

Gearbeitet wird in der **nativen Größe** des entzerrten Bildes, nicht mehr
mit zweifacher Überabtastung. Das halbiert die Rechenzeit (im Schnitt
1,0 s → 0,4 s je Scan) und die Dateigröße.

### Drei Stile

Unter dem Auslöser sitzt eine kleine Pille; Antippen schaltet weiter:

* **Farbe** – der Normalfall, wie oben beschrieben.
* **Graustufen** – dasselbe, am Ende entsättigt.
* **Schwarz-Weiß** – klassischer Kopierer-Look über eine
  **Sauvola**-Schwelle (Sauvola & Pietikäinen 2000,
  `T = m · (1 + k · (s/R − 1))`, k = 0,22). Anders als eine globale
  Schwelle kommt sie mit Schatten zurecht. In Pyodide fehlt
  `cv2.ximgproc`, deshalb ist sie über Integralbilder selbst gerechnet.

Die Auswahl merkt sich die App (`localStorage`). `scan_wrapper.py` kennt
zusätzlich `veredelung="original"` – damit läuft exakt der alte Weg, falls
man vergleichen will. Die Datei `scanner` bleibt dabei unverändert.

Messergebnis auf denselben 14 Fotos (`tools/bench_veredelung.py`):
erhaltener Text im Mittel **70 % → 83 %**, Trennung Papier/Tinte
**113 → 137**, Rechenzeit **halbiert**. Die Extremfälle sind die
eigentliche Geschichte: Notizblock 7,8 % → 100 %, Geldschein 29 % → 92 %,
Diplomarbeit 35 % → 100 % erhaltener Text.

## Herkunft

Statt alles selbst zu erfinden, wurde zuerst geschaut, wie es gute Projekte
machen:

* **[Dropbox Engineering – „Fast and Accurate Document Detection for
  Scanning“](https://dropbox.tech/machine-learning/fast-and-accurate-document-detection-for-scanning)**
  – bestätigt den Aufbau: gelernte Kantenwahrscheinlichkeit statt Canny,
  Hough, dann *jedes* Viereck bewerten und das beste nehmen. Genau diese
  Bewertungsstruktur hat `detect.js` schon; ergänzt wurde die gelernte
  Komponente.
* **[DocsaidLab/DocAligner](https://github.com/DocsaidLab/DocAligner)**
  (Apache-2.0) – liefert das Eckennetz. Dort ist auch begründet, warum
  Heatmap-Regression der direkten Punkt-Regression überlegen ist.
* **[iostreamchik/docscan](https://github.com/iostreamchik/docscan)** –
  Vorbild für die Orchestrierung: klassische Verfahren zuerst, neuronales
  Netz als Rückfallebene, nicht umgekehrt.
* **[jhnbrd/OpDiScan](https://github.com/jhnbrd/OpDiScan)** (MIT) – nächster
  Verwandter: selbst gehostete PWA mit OpenCV.js.
* **[paperflow](https://www.chinglamlau.ca/writing/paperflow)** – praktische
  Hough-Verfeinerungen (ähnliche Linien gruppieren, jede Kante in ihrer
  eigenen Bildhälfte suchen).
* **Sauvola & Pietikäinen (2000)** – die Schwelle für den S/W-Stil.

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

### Echte Fotos

Die synthetische Suite war schon vorher bei 34/34 – sie taugt als
Regressionsschutz, nicht als Urteil. Gemessen wird deshalb zusätzlich auf
14 echten Handyfotos aus fremden Projekten. Die Bilder liegen nicht im
Repository (fremde Lizenzen, >70 MB), sondern werden geholt:

```bash
python3 tools/hole_echtfotos.py /tmp/echtfotos     # Fotos aus 4 Repos holen
python3 -m http.server 8080 &                      # Modell per HTTP bereitstellen
node    tools/bench_fusion.mjs /tmp/echtfotos      # Erkennung: klassisch / KI / beides
python3 tools/bench_veredelung.py /tmp/echtfotos   # Scan-Qualität alt gegen neu
```

`bench_fusion.mjs` lädt dieselben Dateien, die auch der Browser lädt –
onnxruntime-web läuft unter Node mit dem WASM-Backend. Einen Browser gibt es
in der Testumgebung nicht.

`bench_veredelung.py` schreibt Vorher/Nachher-Bilder nach
`<ordner>/vergleich/`. **Die Bilder sind das Urteil, nicht die Zahlen** –
eine harte Schwarz-Weiß-Schwelle kann in jeder Kennzahl gut dastehen und
trotzdem unlesbar sein.
