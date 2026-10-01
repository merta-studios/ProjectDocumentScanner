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
