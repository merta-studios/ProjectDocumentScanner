/*
 * Ultra Scan - KI-Dokumenterkennung (Eckpunkte per neuronalem Netz).
 * ============================================================================
 *
 * WARUM DIESE DATEI EXISTIERT
 * ---------------------------
 * Die rein geometrische Erkennung in detect.js (Sobel -> Hough -> Vierecke)
 * ist schnell und auf sauberen Szenen sehr genau. Auf echten Handyfotos
 * versagt sie aber regelmaessig: Tischkanten, Schattengrenzen, Linien im
 * Dokument oder ein Blatt ohne Kontrast zum Untergrund liefern "schoenere"
 * Rechtecke als das Blatt selbst. Genau das ist der Grund, warum Scans
 * verrutscht oder angeschnitten ankamen.
 *
 * Diese Datei ergaenzt die Geometrie um ein kleines neuronales Netz, das
 * ausschliesslich darauf trainiert wurde, die VIER ECKEN eines Dokuments zu
 * finden - egal ob Kanten sichtbar sind oder nicht.
 *
 * HERKUNFT DES MODELLS  (siehe models/HERKUNFT.md)
 * ------------------------------------------------
 *   DocAligner von DocsaidLab (Ze Yuan), Apache-2.0
 *   https://github.com/DocsaidLab/DocAligner
 *   Modell: lcnet100_h_e_bifpn_256_fp32.onnx  (PP-LCNet-100 + BiFPN,
 *   Heatmap-Regression mit Adaptive-Wing-Loss, trainiert u.a. auf
 *   MIDV-500/MIDV-2020, bewertet auf SmartDoc 2015).
 *   Eingabe  : 1 x 3 x 256 x 256, BGR, Werte 0..1
 *   Ausgabe  : 1 x 4 x 128 x 128, je eine Waermekarte pro Ecke
 *              (0 = oben links, 1 = oben rechts, 2 = unten rechts,
 *               3 = unten links)
 *
 * Laufzeitumgebung: ONNX Runtime Web (WebAssembly, MIT), selbst gehostet
 * unter vendor/onnxruntime-web-1.20.1/ - kein CDN, kein Build-Schritt.
 *
 * RANDLOESUNG "ECKE AUSSERHALB DES BILDES"
 * ----------------------------------------
 * Das Netz kann nur Ecken finden, die es sieht. Fuellt das Blatt den
 * Sucher komplett aus, liegen die Ecken knapp ausserhalb und das Netz
 * meldet nichts. Deshalb wird das Bild vor der Auswertung mit einem
 * gespiegelten/fortgesetzten Rand versehen (Standard 12 %), so dass das
 * Netz ueber den Bildrand hinaus extrapolieren kann. Das ist genau der
 * Weg, den auch die DocAligner-Doku empfiehlt. In Tests stieg die
 * Trefferquote auf unserem Satz echter Fotos dadurch von 11/14 auf 14/14.
 */
"use strict";

var ORT_PFAD = "vendor/onnxruntime-web-1.20.1/";
var MODELL_PFAD = "models/docaligner-lcnet100-heatmap-256.onnx";
var KANTE = 256;            // Eingabegroesse des Netzes
var HM = 128;               // Kantenlaenge der Waermekarten

var ort = null;
var sitzung = null;
var ladeFehler = null;
var ladeLauf = null;
var basisUeberschrieben = null;
var wasmUeberschrieben = null;

/* ----------------------------------------------------------------------
 * Laden
 * -------------------------------------------------------------------- */
function modulBasis() {
  /* import.meta.url zeigt auf detect-nn.js - das Verzeichnis daneben ist
   * der App-Ordner. Funktioniert auch im Unterpfad von GitHub Pages. */
  try {
    return new URL("./", import.meta.url).href;
  } catch (e) {
    return "./";
  }
}

function basisPfad() {
  return basisUeberschrieben || modulBasis();
}

/* Nur fuer Tests (Node): Basis-URLs erzwingen, von denen Modell und
 * WebAssembly geholt werden. Im Browser nie noetig. */
function setzeBasis(assets, wasm) {
  basisUeberschrieben = assets || null;
  wasmUeberschrieben = wasm || null;
}

async function lade(optionen) {
  optionen = optionen || {};
  if (sitzung) { return sitzung; }
  if (ladeFehler) { throw ladeFehler; }
  if (ladeLauf) { return ladeLauf; }

  ladeLauf = (async function () {
    var basis = basisPfad();
    ort = await import(modulBasis() + ORT_PFAD + "ort.wasm.min.mjs");

    ort.env.wasm.wasmPaths = wasmUeberschrieben || (basis + ORT_PFAD);
    /* Mehrere Threads brauchen SharedArrayBuffer und damit
     * Cross-Origin-Isolation. Auf GitHub Pages gibt es die nicht, also
     * sauber auf einen Thread zurueckfallen statt beim Start zu krachen. */
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
    if (!antwort.ok) { throw new Error("Modell nicht ladbar (" + antwort.status + ")"); }
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

/* ----------------------------------------------------------------------
 * Vorverarbeitung: RGBA -> Tensor (BGR, 0..1), mit fortgesetztem Rand
 * --------------------------------------------------------------------
 * Statt erst einen grossen Rand-Puffer zu bauen und dann zu skalieren,
 * wird in EINEM Durchgang gemittelt (Flaechenmittel - sonst flimmern duenne
 * Kanten) und anschliessend werden die leer gebliebenen Randfelder aus dem
 * naechstliegenden gefuellten Feld kopiert. Das entspricht genau dem
 * "Rand fortsetzen" von OpenCV, kostet aber nichts extra.
 */
function tensorBauen(rgba, breite, hoehe, randAnteil) {
  var pad = Math.round(randAnteil * Math.max(breite, hoehe));
  var gw = breite + 2 * pad, gh = hoehe + 2 * pad;
  var n = KANTE * KANTE;
  var sumB = new Float32Array(n), sumG = new Float32Array(n), sumR = new Float32Array(n);
  var anz = new Float32Array(n);

  var xi = new Int32Array(breite), yi = new Int32Array(hoehe);
  var x, y, i;
  for (x = 0; x < breite; x++) {
    xi[x] = Math.min(KANTE - 1, Math.max(0, ((x + pad) * KANTE / gw) | 0));
  }
  for (y = 0; y < hoehe; y++) {
    yi[y] = Math.min(KANTE - 1, Math.max(0, ((y + pad) * KANTE / gh) | 0));
  }

  for (y = 0; y < hoehe; y++) {
    var zeile = y * breite * 4, ziel = yi[y] * KANTE;
    for (x = 0; x < breite; x++) {
      var p = zeile + x * 4, k = ziel + xi[x];
      sumR[k] += rgba[p];
      sumG[k] += rgba[p + 1];
      sumB[k] += rgba[p + 2];
      anz[k]++;
    }
  }

  /* belegter Bereich in Zielkoordinaten */
  var x0 = xi[0], x1 = xi[breite - 1], y0 = yi[0], y1 = yi[hoehe - 1];
  var daten = new Float32Array(3 * n);          // Kanal 0 = B, 1 = G, 2 = R
  for (y = 0; y < KANTE; y++) {
    var sy = y < y0 ? y0 : (y > y1 ? y1 : y);
    for (x = 0; x < KANTE; x++) {
      var sx = x < x0 ? x0 : (x > x1 ? x1 : x);
      var q = sy * KANTE + sx;
      var c = anz[q] || 1;
      /* Falls ein Feld im Innenbereich leer blieb (Bild kleiner als 256),
       * nach links/oben nachschauen. */
      if (!anz[q]) {
        var qq = q;
        while (qq > 0 && !anz[qq]) { qq--; }
        q = qq; c = anz[q] || 1;
      }
      i = y * KANTE + x;
      daten[i] = sumB[q] / c / 255;
      daten[n + i] = sumG[q] / c / 255;
      daten[2 * n + i] = sumR[q] / c / 255;
    }
  }
  return { daten: daten, pad: pad, gw: gw, gh: gh };
}

/* ----------------------------------------------------------------------
 * Nachverarbeitung: Waermekarte -> Eckpunkt (subpixelgenau)
 * --------------------------------------------------------------------
 * Das Maximum allein waere auf 1/128 des Bildes gerundet - bei einem
 * 4000px-Foto also 30 px daneben. Deshalb wird der Schwerpunkt des
 * zusammenhaengenden Flecks um das Maximum herum berechnet (mit den
 * Waermewerten als Gewicht). Das ist dasselbe Verfahren wie im
 * Original-Python von DocAligner, nur ohne OpenCV.
 */
function eckeAusKarte(karte, versatz) {
  var best = 0, bi = -1, i;
  for (i = 0; i < HM * HM; i++) {
    var v = karte[versatz + i];
    if (v > best) { best = v; bi = i; }
  }
  if (bi < 0 || best < 0.05) { return null; }

  var mx = bi % HM, my = (bi / HM) | 0;

  /* --------------------------------------------------------------------
   * Subpixel: erst parabelfoermig, dann als Rueckfall gewichtet.
   * --------------------------------------------------------------------
   * Das Fenster ist bewusst auf 3x3 bzw. 5x5 begrenzt. Ein grosses Fenster
   * (frueher bis +-9 Kacheln = +-36 Pixel im Originalbild) mittelt bei
   * schraeg verlaufenden Waermekarten den Fleck schraeg - die Ecke wandert
   * dann systematisch nach innen. Das ist genau der Fehler, der einen
   * Scan "eine Fingerspitze zu klein" macht.
   *
   * Ein quadratischer Fit (Parabel durch Maximum und seine Nachbarn) ist
   * das, was DocAligner selbst in Python macht; er liefert rund eine
   * halbe Kachel Genauigkeit, bei 128 Kacheln also unter 1 % der Kante.
   */
  function lies(x, y) {
    x = x < 0 ? 0 : (x > HM - 1 ? HM - 1 : x);
    y = y < 0 ? 0 : (y > HM - 1 ? HM - 1 : y);
    return karte[versatz + y * HM + x];
  }
  var cv = lies(mx, my);
  var l = lies(mx - 1, my), r = lies(mx + 1, my);
  var o = lies(mx, my - 1), u = lies(mx, my + 1);
  var dx = 0, dy = 0;
  var nenner = (l - 2 * cv + r);
  if (Math.abs(nenner) > 1e-6) {
    dx = 0.5 * (l - r) / nenner;
    if (dx > 0.75 || dx < -0.75) { dx = 0; }
  }
  var nennerY = (o - 2 * cv + u);
  if (Math.abs(nennerY) > 1e-6) {
    dy = 0.5 * (o - u) / nennerY;
    if (dy > 0.75 || dy < -0.75) { dy = 0; }
  }
  var px = mx + dx, py = my + dy;

  /* Gewichteter Schwerpunkt im 5x5-Fenster als Kontrolle: ist die
   * Parabel entartet (flaches oder sattelfoermiges Fenster), ist der
   * Schwerpunkt die sicherere Antwort. */
  var sx = 0, sy = 0, sw = 0;
  for (var yy = my - 2; yy <= my + 2; yy++) {
    if (yy < 0 || yy >= HM) { continue; }
    for (var xx = mx - 2; xx <= mx + 2; xx++) {
      if (xx < 0 || xx >= HM) { continue; }
      var w = lies(xx, yy) - 0.15 * best;
      if (w <= 0) { continue; }
      sx += xx * w; sy += yy * w; sw += w;
    }
  }
  if (!(isFinite(px) || isFinite(py)) || sw <= 0) {
    /* Kein brauchbarer Fleck -> gar nichts liefern (der Aufrufer lehnt
     * das Ergebnis dann ab, statt eine geratene Ecke zu benutzen). */
    return sw > 0 ? { x: sx / sw + 0.5, y: sy / sw + 0.5, wert: best } : null;
  }
  if (Math.abs(px - sx / sw) > 1.5 || Math.abs(py - sy / sw) > 1.5) {
    px = sx / sw; py = sy / sw;
  }
  return { x: px + 0.5, y: py + 0.5, wert: best };
}

/* ----------------------------------------------------------------------
 * Hauptfunktion
 * -------------------------------------------------------------------- */
async function erkenne(rgba, breite, hoehe, optionen) {
  optionen = optionen || {};
  var s = await lade();
  var rand = optionen.rand === undefined ? 0.12 : optionen.rand;

  var vor = tensorBauen(rgba, breite, hoehe, rand);
  var eingabe = new ort.Tensor("float32", vor.daten, [1, 3, KANTE, KANTE]);
  var ergebnis = await s.run({ img: eingabe });
  var karte = ergebnis.heatmap.data;

  var quad = [], minWert = 1, k;
  for (k = 0; k < 4; k++) {
    var e = eckeAusKarte(karte, k * HM * HM);
    if (!e) { return null; }
    if (e.wert < minWert) { minWert = e.wert; }
    /* Waermekarte (128) -> gepolstertes Bild -> Originalbild */
    quad.push([e.x / HM * vor.gw - vor.pad,
               e.y / HM * vor.gh - vor.pad]);
  }

  /* Plausibilitaet: konvex, nicht entartet, nicht winzig. */
  if (!plausibel(quad, breite, hoehe)) { return null; }

  return { quad: quad, konfidenz: minWert, rand: rand };
}

function flaeche(q) {
  var a = 0;
  for (var i = 0; i < 4; i++) {
    var p = q[i], n = q[(i + 1) % 4];
    a += p[0] * n[1] - n[0] * p[1];
  }
  return Math.abs(a / 2);
}

function plausibel(q, breite, hoehe) {
  var i;
  for (i = 0; i < 4; i++) {
    if (!isFinite(q[i][0]) || !isFinite(q[i][1])) { return false; }
  }
  if (flaeche(q) < 0.04 * breite * hoehe) { return false; }
  /* Konvexitaet: alle Kreuzprodukte gleiches Vorzeichen */
  var pos = 0, neg = 0;
  for (i = 0; i < 4; i++) {
    var a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    var z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z > 0) { pos++; } else if (z < 0) { neg++; }
  }
  if (pos && neg) { return false; }
  /* Seitenverhaeltnis: nichts extrem Duennes */
  var laengen = [];
  for (i = 0; i < 4; i++) {
    laengen.push(Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]));
  }
  var kurz = Math.min.apply(null, laengen), lang = Math.max.apply(null, laengen);
  if (kurz < 0.04 * Math.max(breite, hoehe)) { return false; }
  if (lang > 26 * kurz) { return false; }
  return true;
}

/* ----------------------------------------------------------------------
 * Mehrstufig: derselbe Frame mit mehreren Rand-Reserven auswerten.
 *
 * WARUM DAS MEHR BRINGT ALS EINE "BESTE" RESERVE
 * ----------------------------------------------
 * Der Rand ist ein Kompromiss, und er ist fuer jede Szene anders:
 *   - ohne/mit wenig Rand sitzt das Netz am praezisesten, wenn das Blatt
 *     vollstaendig im Bild liegt,
 *   - mit viel Rand findet es Blaetter, die ueber den Bildrand laufen
 *     (dort MUSS extrapoliert werden), und es wird auf schwierigem
 *     Untergrund (weiss auf weiss, Schatten) deutlich sicherer.
 *
 * Gemessen auf den harten Szenen (tools/bench_hart.mjs) - mittlerer
 * Eckfehler je Rand:
 *   0.12 -> 2.0 %   |   0.20 -> 2.4 %   |   0.30 -> 1.8 % (und mehr Treffer)
 * Der Unterschied ist nicht die Auswahl "richtig oder falsch", sondern
 * WIE ruhig die Ecken sitzen. Deshalb werden mehrere Raender probiert und
 * die sicherste Antwort gewaehlt; der Rand mit dem hoechsten
 * Waermekarten-Spitz (konfidenz) gewinnt.
 * -------------------------------------------------------------------- */
var RAENDER = [0.12, 0.30, 0.20, 0.45];

async function erkenneGruendlich(rgba, breite, hoehe) {
  var best = null;
  for (var i = 0; i < RAENDER.length; i++) {
    var r = null;
    try { r = await erkenne(rgba, breite, hoehe, { rand: RAENDER[i] }); } catch (e) { r = null; }
    if (r && (!best || r.konfidenz > best.konfidenz)) { best = r; }
    /* Sicher genug -> die restlichen Durchgaenge sparen. 0.88 ist der
     * Wert, ab dem in den Messungen praktisch keine Verbesserung mehr
     * kam. */
    if (best && best.konfidenz > 0.88) { break; }
  }
  return best;
}

/* ----------------------------------------------------------------------
 * Live-Variante: erst die normale Reserve, bei schwachem Ergebnis sofort
 * eine zweite mit viel Rand.
 *
 * Der Hintergrund ist derselbe wie oben, nur unter Zeitdruck: im Sucher
 * sind die Frames klein, verrauscht und JPEG-komprimiert, und das Blatt
 * laeuft oft ueber den Rand. Mit 0.12 allein fand das Netz auf den harten
 * Szenen 84 von 90 Frames, mit zusaetzlichem 0.26 alle 90.
 *
 * Die zweite Runde laeuft nur, wenn die erste unsicher war - im
 * Normalfall kostet das also nichts.
 * -------------------------------------------------------------------- */
async function erkenneLive(rgba, breite, hoehe) {
  var r = null;
  try { r = await erkenne(rgba, breite, hoehe, { rand: 0.14 }); } catch (e) { r = null; }
  if (r && r.konfidenz >= 0.55) { return r; }
  var r2 = null;
  try { r2 = await erkenne(rgba, breite, hoehe, { rand: 0.28 }); } catch (e) { r2 = null; }
  /* Die zweite Runde muss DEUTLICH besser sein, nicht nur ein wenig:
   * sonst wechselt der Rahmen im Sucher staendig zwischen zwei fast
   * gleich guten Lagen hin und her - und genau das sieht aus wie Zittern. */
  var huerde = (r ? r.konfidenz : 0) + 0.12;
  if (r2 && r2.konfidenz > Math.max(0.55, huerde)) { return r2; }
  return r;
}

function bereit() { return !!sitzung; }
function fehler() { return ladeFehler; }

export { lade, erkenne, erkenneGruendlich, erkenneLive, bereit, fehler, setzeBasis, tensorBauen, eckeAusKarte };
