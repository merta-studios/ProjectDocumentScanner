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
 * Nachrichten hinaus:
 *   { typ: "ki-status", bereit, meldung }
 *   { typ: "ki", folge, quad, konfidenz, dauer }
 *   { typ: "ki-standbild", marke, quad, konfidenz }
 */

import * as netz from "./detect-nn.js";

var laeuft = false;

function jetzt() {
  return (self.performance && performance.now) ? performance.now() : Date.now();
}

async function starten() {
  try {
    await netz.lade();
    postMessage({ typ: "ki-status", bereit: true });
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
      r = await netz.erkenne(new Uint8ClampedArray(n.rgba), n.breite, n.hoehe,
                             { rand: 0.12 });
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
    postMessage({
      typ: "ki-standbild", marke: n.marke,
      quad: erg ? erg.quad : null,
      konfidenz: erg ? erg.konfidenz : 0
    });
  }
};

starten();
