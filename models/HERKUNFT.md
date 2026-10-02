# Herkunft des KI-Modells

## `docaligner-lcnet100-heatmap-256.onnx` (4,6 MB)

| | |
|---|---|
| **Projekt** | [DocsaidLab/DocAligner](https://github.com/DocsaidLab/DocAligner) |
| **Lizenz** | Apache-2.0 (siehe `LICENSE-Apache-2.0.txt` in diesem Ordner) |
| **Architektur** | PP-LCNet-100 Backbone + BiFPN-Neck + Heatmap-Kopf |
| **Aufgabe** | Die vier Ecken eines Dokuments in einem Foto finden |
| **Eingang** | `img`, `float32[1, 3, 256, 256]`, **BGR**, Werte `0 … 1` (also `/255`) |
| **Ausgang** | `heatmap`, `float32[1, 4, 128, 128]`, Kanaele in der Reihenfolge **OL, OR, UR, UL** |

Die Datei stammt aus dem Android-Projekt
[iostreamchik/docscan](https://github.com/iostreamchik/docscan), das das
DocAligner-Modell bereits nach ONNX exportiert mitliefert. Der direkte
Download bei Google Drive bzw. Hugging Face war aus dieser Umgebung nicht
erreichbar - deshalb der Umweg ueber den Git-Klon.

## Warum Heatmap und nicht Punkt-Regression?

DocAligner hat beide Varianten ausprobiert und die Punkt-Regression
verworfen: Wenn das Netz die Koordinaten direkt ausgibt, wird der Fehler
beim Hochrechnen von 256 px auf die Originalaufloesung mitskaliert - aus
einem Pixel Abweichung werden schnell 5 bis 10 Pixel. Die Heatmap-Variante
gibt stattdessen pro Ecke eine Wahrscheinlichkeitskarte aus; der
Schwerpunkt des hellsten Flecks laesst sich **subpixelgenau** bestimmen.
Genau das macht `detect-nn.js`: Argmax suchen, dann in einem Fenster von
±9 px den intensitaetsgewichteten Schwerpunkt bilden.

## Bekannte Grenzen (vom Projekt selbst dokumentiert)

* Liegt eine Ecke **ausserhalb** des Bildes, rutscht sie an den Rand.
  Gegenmittel in `detect-nn.js`: `erkenneGruendlich()` probiert das Bild
  zusaetzlich mit 12 % und 26 % Rand ringsum und rechnet den Rand danach
  wieder heraus.
* Sind **mehrere Dokumente** im Bild, koennen Ecken verschiedener
  Dokumente vermischt werden. Gegenmittel: Das Ergebnis muss die
  Plausibilitaetspruefung bestehen (konvex, Flaeche >= 4 %, Seitenverhaeltnis)
  und konkurriert in `detect.js` mit den klassisch gefundenen Vierecken.

## Laufzeit

Ausgefuehrt wird das Modell mit **onnxruntime-web 1.20.1** (MIT), ebenfalls
selbst gehostet unter `vendor/onnxruntime-web-1.20.1/`. Kein CDN, kein
Build-Schritt - passt zur Architektur der App.

## `uvdoc-grid-712x488-int8.onnx` (8,1 MB)

| | |
|---|---|
| **Projekt** | [tanguymagne/UVDoc](https://github.com/tanguymagne/UVDoc) - "UVDoc: Neural Grid-based Document Unwarping", SIGGRAPH Asia 2023 |
| **Lizenz** | MIT (Copyright (c) 2023 Tanguy MAGNE) |
| **Gewichte** | `model/best_model.pkl` aus dem Projekt-Repository (UVDocnet, 8 Mio. Parameter) |
| **Aufgabe** | Fuer jedes Dokumentfoto das Gitter vorhersagen, das die gebogene Seite flachlegt (Buchseiten, gewoelbte Blaetter) |
| **Eingang** | `image`, `float32[1, 3, 712, 488]` (Hoehe x Breite), **RGB**, Werte `0 … 1` |
| **Ausgang** | `grid2d`, `float32[1, 2, 45, 31]` mit Werten in `-1 … 1` (Kanal 0 = x, Kanal 1 = y; Achse 1 gehoert zur Hoehe, Achse 2 zur Breite). `grid3d` (der 3D-Kopf) wird nicht benutzt. |

Der Export wurde in dieser Umgebung aus den Originalgewichten erzeugt
(`torch.onnx.export`, opset 17, feste Eingabegroesse 712x488; PyTorch 2.14
braucht dafuer `dynamo=False`). Die 32-MB-Fassung wurde anschliessend
dynamisch auf 8 Bit quantisiert:

```python
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("uvdoc-grid-712x488.onnx", "uvdoc-grid-712x488-int8.onnx",
                 weight_type=QuantType.QUInt8, op_types_to_quantize=["Conv", "MatMul"])
```

Nachgemessen: Die Gitterwerte weichen im Mittel um 0.003 und hoechstens um
0.05 (von 2.0 Wertebereich) von der 32-Bit-Fassung ab - deutlich weniger als
die Unterschiede, die allein durch das Skalieren des Eingabebildes
entstehen (max. 0.042). Im Browser laeuft die 8-Bit-Fassung zudem rund ein
Viertel schneller, weil weniger Daten durch WebAssembly wandern.
Die quantisierte Datei ist selbstenthalten - es gibt KEINE zusaetzliche
`.data`-Datei.

**Anwendung:** `detect-uvdoc.js` rechnet nur das Gitter aus (onnxruntime-web,
~1 Sekunde). Angewendet wird es in `scan_wrapper.py` mit OpenCV - und zwar
**nur, wenn es die Zeilen messbar gerader macht** (siehe Kommentar
"Buchkruemmung" in `scan_wrapper.py`). Auf einer bereits geraden Seite kann
UVDoc neue Wellen erzeugen; das Tor verwirft es dann.

**Grenzen (selbst gemessen):** Das Netz ist auf Fotos trainiert, die ein
Dokument formatfuellend zeigen. Bei kleinen Blaettern in grosser Umgebung
oder bei stark abweichendem Seitenverhaeltnis laesst die Qualitaet nach.
Deshalb wird es ueberhaupt nur auf bereits entzerrten Seiten geprueft und
bei fehlendem Gewinn verworfen.
