/*
 * Ultra Scan - KI-Worker.
 *
 * Laeuft als MODUL-Worker (type: "module"), weil ONNX Runtime Web als
 * ES-Modul ausgeliefert wird. Er macht genau eine Sache: aus einem Bild
 * die vier Dokument-Ecken schaetzen (detect-nn.js) und zurueckmelden.
 *
 * Warum ein EIGENER Worker neben detect-worker.js?
 * Eine Netz-Auswertung dauert rund 100-200 ms. Laege sie im selben Worker
 * wie die geometrische Erkennung, wuerde der Sucher-Rahmen genauso lange
 * stehenbleiben - also wieder das Ruckeln, das es frueher mit Python gab.
 * So laeuft die schnelle Geometrie (ca. 10-30 ms) weiter mit voller
 * Bildrate, und das Netz liefert parallel alle paar Frames ein frisches,
 * verlaessliches Viereck dazu.
 *
 * Nachrichten herein:
 *   { typ: "start" }                              -> Modell laden
 *   { typ: "live", rgba, breite, hoehe, folge }   -> schnelle Schaetzung
 *   { typ: "standbild", marke, rgba, breite, hoehe } -> gruendlich
 *   { typ: "uvdoc", marke, rgba, breite, hoehe }  -> Kruemmungs-Gitter
 * Nachrichten hinaus:
 *   { typ: "ki-status", bereit, meldung }
 *   { typ: "ki", folge, quad, konfidenz, dauer }
 *   { typ: "ki-standbild", marke, quad, konfidenz, gitter }
 *   { typ: "uvdoc", marke, gitter } | { typ: "uvdoc-status", bereit, meldung }
 *
 * Das Kruemmungs-Gitter (detect-uvdoc.js, UVDoc) gehoert zur selben Sache
 * wie die Ecken und laeuft deshalb im selben Worker: Beim gruendlichen
 * Standbild wird es gleich mitgerechnet (ein Hin- und Her spart eine
 * Anfrage), und beim Auslösen im Sucher gibt es einen eigenen Auftrag.
 * Faellt es aus (Modell nicht ladbar, alter Browser), arbeitet die App
 * unveraendert weiter - die Glaettung ist eine Verbesserung, kein Muss.
 */

import * as netz from "./detect-nn.js";
import * as uv from "./detect-uvdoc.js";

var laeuft = false;
var uvBereit = false;
var uvFehler = null;
var uvLaeuft = null;

function jetzt() {
  return (self.performance && performance.now) ? performance.now() : Date.now();
}

/* UVDoc im Hintergrund laden - die 8 MB duerfen den ersten Scan nicht
 * aufhalten. Bis es da ist, wird einfach ohne Glaettung gescannt. */
function uvLaden() {
  if (uvLaeuft) { return uvLaeuft; }
  uvLaeuft = (async function () {
    try {
      await uv.lade();
      uvBereit = true;
      postMessage({ typ: "uvdoc-status", bereit: true });
    } catch (f) {
      uvBereit = false;
      uvFehler = (f && f.message) ? f.message : String(f);
      postMessage({ typ: "uvdoc-status", bereit: false, meldung: uvFehler });
    }
  })();
  return uvLaeuft;
}

function uvGitter(rgba, breite, hoehe) {
  return uvLaden().then(function () {
    if (!uvBereit) { return null; }
    return uv.gitter(rgba, breite, hoehe).catch(function () { return null; });
  });
}

async function starten() {
  try {
    await netz.lade();
    postMessage({ typ: "ki-status", bereit: true });
    /* Kruemmungs-Modell gleich im Hintergrund nachladen. */
    setTimeout(uvLaden, 1500);
  } catch (f) {
    postMessage({
      typ: "ki-status", bereit: false,
      meldung: (f && f.message) ? f.message : String(f)
    });
  }
}

self.onmessage = async function (e) {
  var n = e.data;
  if (!n) { return; }

  if (n.typ === "start") { starten(); return; }

  if (n.typ === "live") {
    if (laeuft || !netz.bereit()) {
      postMessage({ typ: "ki", folge: n.folge, quad: null, konfidenz: 0, uebersprungen: true });
      return;
    }
    laeuft = true;
    var t0 = jetzt();
    var r = null;
    try {
      /* erkenneLive() probiert bei schwachem Ergebnis sofort eine zweite
       * Rand-Reserve - damit findet das Netz auch Blaetter, die ueber den
       * Sucherrand laufen, und solche auf weissem Untergrund. Kosten
       * entstehen nur, wenn die erste Runde unsicher war. */
      r = await netz.erkenneLive(new Uint8ClampedArray(n.rgba), n.breite, n.hoehe);
    } catch (f) { r = null; }
    laeuft = false;
    postMessage({
      typ: "ki", folge: n.folge,
      quad: r ? r.quad : null,
      konfidenz: r ? r.konfidenz : 0,
      dauer: jetzt() - t0
    });
    return;
  }

  if (n.typ === "standbild") {
    var erg = null;
    try {
      await netz.lade();
      erg = await netz.erkenneGruendlich(new Uint8ClampedArray(n.rgba),
                                         n.breite, n.hoehe);
    } catch (f2) { erg = null; }
    var g = null;
    try {
      var gu = await uvGitter(new Uint8ClampedArray(n.rgba), n.breite, n.hoehe);
      g = gu ? gu.gitter : null;
    } catch (f3) { g = null; }
    postMessage({
      typ: "ki-standbild", marke: n.marke,
      quad: erg ? erg.quad : null,
      konfidenz: erg ? erg.konfidenz : 0,
      gitter: g
    }, g ? [g.buffer] : []);
    return;
  }

  if (n.typ === "uvdoc") {
    var r2 = null;
    try {
      r2 = await uvGitter(new Uint8ClampedArray(n.rgba), n.breite, n.hoehe);
    } catch (f4) { r2 = null; }
    postMessage({
      typ: "uvdoc", marke: n.marke,
      gitter: r2 ? r2.gitter : null
    }, (r2 && r2.gitter) ? [r2.gitter.buffer] : []);
  }
};

starten();
