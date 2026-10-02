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
function beleuchtungsFeldFuerKI(rgba, breite, hoehe) {
  // Schaetzt Beleuchtungsfeld fuer Schatten-Korrektur (weiss auf weiss)
  var dw = 32, dh = 32;
  var g = new Float32Array(dw * dh);
  var anz = new Float32Array(dw * dh);
  var xi = new Int32Array(breite), yi = new Int32Array(hoehe);
  for (var x = 0; x < breite; x++) { xi[x] = Math.min(dw - 1, (x * dw / breite) | 0); }
  for (var y = 0; y < hoehe; y++) { yi[y] = Math.min(dh - 1, (y * dh / hoehe) | 0); }
  for (var y = 0; y < hoehe; y++) {
    var zeile = y * breite * 4, ziel = yi[y] * dw;
    for (var x = 0; x < breite; x++) {
      var p = zeile + x * 4;
      var l = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) * 0.001;
      var k = ziel + xi[x];
      g[k] += l; anz[k]++;
    }
  }
  for (var i = 0; i < dw * dh; i++) { g[i] = anz[i] ? g[i] / anz[i] : 0; }
  // Box-Blur 2x
  var r = 2;
  var tmp = new Float32Array(dw * dh);
  for (var y = 0; y < dh; y++) {
    var z = y * dw, s = 0;
    for (var x = -r; x <= r; x++) { if (x >= 0 && x < dw) { s += g[z + x]; } }
    for (var x = 0; x < dw; x++) {
      tmp[z + x] = s / (2 * r + 1);
      var raus = x - r, rein = x + r + 1;
      if (raus >= 0) { s -= g[z + raus]; }
      if (rein < dw) { s += g[z + rein]; }
    }
  }
  var feld = new Float32Array(dw * dh);
  for (var x = 0; x < dw; x++) {
    var s2 = 0;
    for (var y = -r; y <= r; y++) { if (y >= 0 && y < dh) { s2 += tmp[y * dw + x]; } }
    for (var y = 0; y < dh; y++) {
      feld[y * dw + x] = s2 / (2 * r + 1);
      var ro = y - r, ri = y + r + 1;
      if (ro >= 0) { s2 -= tmp[ro * dw + x]; }
      if (ri < dh) { s2 += tmp[ri * dw + x]; }
    }
  }
  var sum = 0;
  for (var i = 0; i < dw * dh; i++) { sum += feld[i]; }
  var mittel = sum / (dw * dh) || 128;
  // Gewinn
  var gewinn = new Float32Array(dw * dh);
  var stdSum = 0;
  for (var i = 0; i < dw * dh; i++) {
    var d = feld[i] - mittel;
    stdSum += d * d;
  }
  var std = Math.sqrt(stdSum / (dw * dh));
  // Nur bei nennenswertem Schatten (std > 8) korrigieren
  if (std < 8) { return null; }
  for (var i = 0; i < dw * dh; i++) {
    var gv = mittel / Math.max(feld[i], 1);
    if (gv > 2.2) { gv = 2.2; } else if (gv < 0.55) { gv = 0.55; }
    gewinn[i] = gv;
  }
  return { gewinn: gewinn, dw: dw, dh: dh, xi: xi, yi: yi, std: std };
}

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

  // Beleuchtungsfeld fuer weiss-auf-weiss / Schatten
  var licht = null;
  try { licht = beleuchtungsFeldFuerKI(rgba, breite, hoehe); } catch (e) { licht = null; }

  for (y = 0; y < hoehe; y++) {
    var zeile = y * breite * 4, ziel = yi[y] * KANTE;
    for (x = 0; x < breite; x++) {
      var p = zeile + x * 4, k = ziel + xi[x];
      var r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      if (licht) {
        var lx = licht.xi[x], ly = licht.yi[y];
        var gv = licht.gewinn[ly * licht.dw + lx] || 1;
        r = Math.min(255, r * gv);
        g = Math.min(255, g * gv);
        b = Math.min(255, b * gv);
      }
      sumR[k] += r;
      sumG[k] += g;
      sumB[k] += b;
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
/* Mehr Raender fuer schwierige Faelle:
 * 0.08 = praezise wenn Blatt den Sucher fuellt
 * 0.60 = viel Kontext fuer weiss-auf-weiss / Stapel
 * Reihenfolge: erst die wahrscheinlichsten, dann exotische.
 * Messung: weiss auf weisser Decke braucht 0.45-0.60 fuer Schatten-Kontext,
 * Stapel braucht 0.30-0.45 um Nachbarblaetter zu sehen. */
var RAENDER = [0.12, 0.20, 0.30, 0.08, 0.45, 0.60];

async function erkenneGruendlich(rgba, breite, hoehe) {
  var best = null;
  var zweitBest = null;
  for (var i = 0; i < RAENDER.length; i++) {
    var r = null;
    try { r = await erkenne(rgba, breite, hoehe, { rand: RAENDER[i] }); } catch (e) { r = null; }
    if (r) {
      // Bevorzuge hoehere Konfidenz, aber bei aehnlicher Konfidenz das kleinere
      // Viereck wenn es deutlich kompakter ist (Top-Blatt vs Stapel)
      if (!best || r.konfidenz > best.konfidenz + 0.04) {
        if (best && best.konfidenz > 0.35) { zweitBest = best; }
        best = r;
      } else if (!best) {
        best = r;
      } else {
        // Aehnliche Konfidenz: wenn neues deutlich kleiner und plausibel, merke als Alternative
        var flBest = flaeche(best.quad), flNeu = flaeche(r.quad);
        if (flNeu < flBest * 0.85 && flNeu > flBest * 0.25 && r.konfidenz > 0.32) {
          if (!zweitBest || r.konfidenz > zweitBest.konfidenz) { zweitBest = r; }
        }
      }
    }
    if (best && best.konfidenz > 0.90) { break; }
  }
  // Falls best sehr gross (fast ganzes Bild) und zweitBest existiert mit
  // hoeherer Dichte / kleinerer Flaeche, nimm zweitBest fuer Stapel-Fall
  if (best && zweitBest) {
    var flB = flaeche(best.quad), flZ = flaeche(zweitBest.quad);
    if (flB > flZ * 1.18 && flZ < breite * hoehe * 0.88) {
      // Pruefe ob zweitBest komplett innerhalb best liegt (Stapel)
      var innen = 0;
      for (var k = 0; k < 4; k++) {
        var px = zweitBest.quad[k][0], py = zweitBest.quad[k][1];
        // einfache Bounding-Box Pruefung + Punkt-in-Poly fuer best
        if (px >= Math.min(best.quad[0][0], best.quad[1][0], best.quad[2][0], best.quad[3][0]) &&
            px <= Math.max(best.quad[0][0], best.quad[1][0], best.quad[2][0], best.quad[3][0]) &&
            py >= Math.min(best.quad[0][1], best.quad[1][1], best.quad[2][1], best.quad[3][1]) &&
            py <= Math.max(best.quad[0][1], best.quad[1][1], best.quad[2][1], best.quad[3][1])) {
          innen++;
        }
      }
      if (innen >= 3 && zweitBest.konfidenz >= 0.30) {
        // Top-Blatt wahrscheinlicher
        if (zweitBest.konfidenz > best.konfidenz * 0.65) {
          best = zweitBest;
        }
      }
    }
  }
  return best;
}

/* Live-Variante: drei Stufen, letzte nur bei sehr niedrigem Kontrast */
async function erkenneLive(rgba, breite, hoehe) {
  var r = null;
  try { r = await erkenne(rgba, breite, hoehe, { rand: 0.14 }); } catch (e) { r = null; }
  if (r && r.konfidenz >= 0.55) { return r; }
  var r2 = null;
  try { r2 = await erkenne(rgba, breite, hoehe, { rand: 0.28 }); } catch (e) { r2 = null; }
  var huerde = (r ? r.konfidenz : 0) + 0.10;
  if (r2 && r2.konfidenz > Math.max(0.50, huerde)) {
    if (r2.konfidenz >= 0.60) { return r2; }
    // Noch unsicher -> dritte Runde mit viel Kontext fuer weiss-auf-weiss
    var r3 = null;
    try { r3 = await erkenne(rgba, breite, hoehe, { rand: 0.45 }); } catch (e) { r3 = null; }
    if (r3 && r3.konfidenz > r2.konfidenz + 0.06) { return r3; }
    return r2;
  }
  if (r2 && !r) { return r2; }
  // Wenn beide schwach, versuche 0.45 direkt
  if ((!r || r.konfidenz < 0.40) && (!r2 || r2.konfidenz < 0.40)) {
    var r3b = null;
    try { r3b = await erkenne(rgba, breite, hoehe, { rand: 0.45 }); } catch (e) { r3b = null; }
    if (r3b && r3b.konfidenz > Math.max(r ? r.konfidenz : 0, r2 ? r2.konfidenz : 0)) { return r3b; }
  }
  return r || r2;
}

function bereit() { return !!sitzung; }
function fehler() { return ladeFehler; }

export { lade, erkenne, erkenneGruendlich, erkenneLive, bereit, fehler, setzeBasis, tensorBauen, eckeAusKarte };
