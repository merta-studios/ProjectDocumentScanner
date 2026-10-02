/*
 * Ultra Scan - Buchkruemmung glaetten (UVDoc).
 * ============================================================================
 *
 * WARUM DIESE DATEI EXISTIERT
 * ---------------------------
 * Die Entzerrung in scanner.py zieht das Blatt an seinen vier Aussenkanten
 * gerade. Bei einer Buchseite, die sich zur Mitte hin woelbt, reicht das
 * nicht: der Text laeuft in der Mitte durch, die Zeilen sind gebogen - und
 * genau das meint "Perfekt Ultra ist das noch nicht". Bisher gab es dagegen
 * nur eine Polynom-Glaettung (scanner.flatten_curvature), die hoechstens
 * eine gleichmaessige Welle trifft.
 *
 * UVDoc (SIGGRAPH Asia 2023) sagt stattdessen ein 2D-Gitter voraus: fuer
 * jeden Punkt des flachgelegten Blattes, woher er im Foto kommt. Das ist
 * bei gebogenen Seiten deutlich treffsicherer und dabei klein (8 Mio.
 * Parameter, ~32 MB) und offline lauffaehig.
 *
 * WO DAS MODELL HERKOMMT (siehe models/HERKUNFT.md)
 * -------------------------------------------------
 *   UVDoc, Tanguy Magne et al., "UVDoc: Neural Grid-based Document
 *   Unwarping", SIGGRAPH Asia 2023.  https://github.com/tanguymagne/UVDoc
 *   Gewichte: best_model.pkl (Apache-2.0); hier als reines Gitter-Netz
 *   exportiert (der 3D-Kopf bleibt ungenutzt).
 *   Eingabe : 1 x 3 x 712 x 488 (Hoehe x Breite), RGB, 0..1
 *   Ausgabe : grid2d 1 x 2 x 45 x 31, Werte -1..1
 *             (Kanal 0 = x, Kanal 1 = y; Achse 1 = Hoehe, Achse 2 = Breite)
 *
 * WICHTIG - HIER WIRD NUR GERECHNET, NICHT ANGEWENDET.
 * Die Anwendung (Bildpunkte umrechnen) macht scan_wrapper.py mit OpenCV -
 * dort laeuft ohnehin die ganze Pipeline. Ueber die Worker-Grenze gehen
 * nur 45*31*2 Gleitkommazahlen (~11 KB).
 *
 * DAS TOR IST DABEL - UND ZWAR GEMESSEN
 * -------------------------------------
 * Auf einer schon geraden Seite kann UVDoc neue Wellen erzeugen (gemessen:
 * Zeilenkruemmung 0.48 px -> 1.08 px), auf einer gebogenen Buchseite
 * glaettet es stark (1.43 px -> 0.45 px). Deshalb entscheidet NICHT dieses
 * Modul, ob das Gitter angewendet wird, sondern scan_wrapper.py - es
 * vergleicht die Zeilenbiegung vorher/nachher und verwirft das Gitter,
 * wenn es nichts bringt.
 *
 * Laufzeitumgebung: ONNX Runtime Web (WebAssembly), selbst gehostet unter
 * vendor/onnxruntime-web-1.20.1/ - kein CDN, kein Build-Schritt.
 */
"use strict";

var ORT_PFAD = "vendor/onnxruntime-web-1.20.1/";
var MODELL_PFAD = "models/uvdoc-grid-712x488-int8.onnx";

var EW = 488;               // Modellbreite
var EH = 712;               // Modellhoehe
var GW = 31;                // Gitterbreite  (Ausgabe)
var GH = 45;                // Gitterhoehe   (Ausgabe)

var ort = null;
var sitzung = null;
var ladeFehler = null;
var ladeLauf = null;
var basisUeberschrieben = null;
var wasmUeberschrieben = null;

function modulBasis() {
  /* import.meta.url zeigt auf detect-uvdoc.js - das Verzeichnis daneben
   * ist der App-Ordner. Funktioniert auch im Unterpfad von GitHub Pages. */
  try { return new URL("./", import.meta.url).href; } catch (e) { return "./"; }
}

function basisPfad() { return basisUeberschrieben || modulBasis(); }

/* Nur fuer Tests (Node): Basis-URLs erzwingen. Im Browser nie noetig. */
function setzeBasis(assets, wasm) {
  basisUeberschrieben = assets || null;
  wasmUeberschrieben = wasm || null;
}

async function lade() {
  if (sitzung) { return sitzung; }
  if (ladeFehler) { throw ladeFehler; }
  if (ladeLauf) { return ladeLauf; }

  ladeLauf = (async function () {
    var basis = basisPfad();
    ort = await import(modulBasis() + ORT_PFAD + "ort.wasm.min.mjs");
    ort.env.wasm.wasmPaths = wasmUeberschrieben || (basis + ORT_PFAD);
    var kerne = 1;
    try {
      if (self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
        kerne = Math.min(4, Math.max(1, (self.navigator && navigator.hardwareConcurrency) || 1));
      }
    } catch (e) { kerne = 1; }
    ort.env.wasm.numThreads = kerne;
    ort.env.wasm.simd = true;
    ort.env.logLevel = "error";

    var antwort = await fetch(basis + MODELL_PFAD);
    if (!antwort.ok) { throw new Error("UVDoc nicht ladbar (" + antwort.status + ")"); }
    var bytes = new Uint8Array(await antwort.arrayBuffer());
    sitzung = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    return sitzung;
  })();

  try {
    return await ladeLauf;
  } catch (f) {
    ladeFehler = f;
    ladeLauf = null;
    throw f;
  }
}

function bereit() { return !!sitzung; }
function fehler() { return ladeFehler; }

/* ----------------------------------------------------------------------
 * Vorverarbeitung: RGBA -> 1 x 3 x 712 x 488 (RGB, 0..1)
 * --------------------------------------------------------------------
 * Wie in detect-nn.js wird in EINEM Durchgang flaechengemittelt (sonst
 * flimmern duenne Linien, und genau die tragen hier die Kruemmung).
 *
 * Querformate werden vorher gedreht: Das Netz wurde auf hochkant
 * fotografierte Dokumente trainiert; ein Querformat wird sonst gestaucht.
 * scan_wrapper.py dreht beim Anwenden nach derselben Regel zurueck -
 * beide Seiten muessen sich einig sein.
 */
function tensorBauen(rgba, breite, hoehe) {
  var quer = breite > hoehe;
  var sw = quer ? hoehe : breite;                 // Quellbreite im gedrehten Bild
  var sh = quer ? breite : hoehe;                 // Quellhoehe
  var n = EW * EH;
  var daten = new Float32Array(3 * n);
  var anz = new Float32Array(n);

  var xi = new Int32Array(sw), yi = new Int32Array(sh);
  var x, y;
  for (x = 0; x < sw; x++) { xi[x] = Math.min(EW - 1, (x * EW / sw) | 0); }
  for (y = 0; y < sh; y++) { yi[y] = Math.min(EH - 1, (y * EH / sh) | 0); }

  for (y = 0; y < sh; y++) {
    var ziel = yi[y] * EW;
    for (x = 0; x < sw; x++) {
      /* Gedreht wird wie numpy.rot90 in scan_wrapper.py:
       *   gedreht(y, x) = original(y_alt = x, x_alt = breite-1-y)
       * sw/sh sind Breite/Hoehe des GEDREHTEN Bildes, also ist
       * sh == breite und sw == hoehe. */
      var ox = quer ? (sh - 1 - y) : x;
      var oy = quer ? x : y;
      var p = (oy * breite + ox) * 4;
      var k = ziel + xi[x];
      daten[k] += rgba[p];            /* R */
      daten[n + k] += rgba[p + 1];    /* G */
      daten[2 * n + k] += rgba[p + 2];/* B */
      anz[k]++;
    }
  }
  for (var i = 0; i < n; i++) {
    var c = anz[i] || 1;
    daten[i] = daten[i] / c / 255;
    daten[n + i] = daten[n + i] / c / 255;
    daten[2 * n + i] = daten[2 * n + i] / c / 255;
  }
  return { daten: daten, quer: quer };
}

/* ----------------------------------------------------------------------
 * Auswertung: Gitter vorhersagen
 * --------------------------------------------------------------------
 * Rueckgabe: { gitter: Float32Array(2*45*31), quer: bool } oder null.
 * Das Gitter gehoert zum GEDREHTEN Bild (siehe tensorBauen).
 */
async function gitter(rgba, breite, hoehe) {
  if (!sitzung) { return null; }
  if (!rgba || breite < 16 || hoehe < 16) { return null; }
  var vor = tensorBauen(rgba, breite, hoehe);
  var tensor = new ort.Tensor("float32", vor.daten, [1, 3, EH, EW]);
  var aus = await sitzung.run({ image: tensor });
  /* Name aus dem Export - der Ausgabename "grid2d" ist Teil der
   * HERKUNFT-Dokumentation. Faellt er weg (anderer Export), wird die
   * erste 2-Kanal-Ausgabe genommen. */
  var g = aus.grid2d || null;
  if (!g) {
    var namen = Object.keys(aus);
    for (var i = 0; i < namen.length; i++) {
      var t = aus[namen[i]];
      if (t && t.dims && t.dims.length === 4 && t.dims[1] === 2) { g = t; break; }
    }
  }
  if (!g || !g.data || g.data.length !== 2 * GH * GW) {
    if (g && g.data && g.dims && g.dims[2] === GW && g.dims[3] === GH) {
      /* anderer Export mit vertauschten Gitterachsen (2 x 31 x 45) */
      var d = g.data, u = new Float32Array(2 * GH * GW);
      for (var c = 0; c < 2; c++) {
        for (var i2 = 0; i2 < GH; i2++) {
          for (var j2 = 0; j2 < GW; j2++) {
            u[c * GH * GW + i2 * GW + j2] = d[c * GW * GH + j2 * GH + i2];
          }
        }
      }
      return { gitter: u, quer: vor.quer };
    }
    return null;
  }
  return { gitter: g.data, quer: vor.quer };
}

export { lade, lade as laden, gitter, bereit, fehler, setzeBasis };
