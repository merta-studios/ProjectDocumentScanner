/*
 * Ultra Scan - Erkennungs-Worker.
 *
 * Laedt NUR detect.js (ein paar Kilobyte, kein Python) und beantwortet
 * jeden Sucher-Frame sofort. Dadurch laeuft die Live-Erkennung mit der
 * Bildrate der Kamera statt mit 5 Bildern pro Sekunde wie frueher ueber
 * Pyodide - und der Hauptthread bleibt frei fuer die Darstellung.
 *
 * Nachrichten:
 *   { typ: "live",    rgba, breite, hoehe, folge }   -> { typ: "quad", ... }
 *   { typ: "standbild", rgba, breite, hoehe }        -> { typ: "standbild", ... }
 */
"use strict";

importScripts("detect.js");

/* Arbeitsaufloesungen: live schnell, Standbild genau. */
var LIVE_ARBEIT = 224;
var FOTO_ARBEIT = 288;
var FOTO_FEIN   = 1100;

self.onmessage = function (e) {
  var n = e.data;
  if (!n) { return; }

  if (n.typ === "live") {
    var rgba = new Uint8ClampedArray(n.rgba);
    var t0 = (self.performance && performance.now) ? performance.now() : 0;
    var r = null;
    try {
      r = self.UltraErkennung.erkenne(rgba, n.breite, n.hoehe, {
        arbeitsKante: LIVE_ARBEIT,
        feinKante: Math.max(n.breite, n.hoehe),
        minFlaeche: 0.05,
        masse: true
      });
    } catch (f) { r = null; }
    var masse = self.UltraErkennung.masse || { schaerfe: 0, bewegung: -1 };
    postMessage({
      typ: "quad",
      folge: n.folge,
      quad: r ? r.quad : null,
      konfidenz: r ? r.konfidenz : 0,
      flaeche: r ? r.flaeche : 0,
      randZahl: r ? r.randZahl : 0,
      schaerfe: masse.schaerfe,
      bewegung: masse.bewegung,
      dauer: t0 ? (performance.now() - t0) : 0
    });
    return;
  }

  if (n.typ === "standbild") {
    var bild = new Uint8ClampedArray(n.rgba);
    var erg = null;
    try {
      erg = self.UltraErkennung.erkenne(bild, n.breite, n.hoehe, {
        arbeitsKante: FOTO_ARBEIT,
        feinKante: Math.min(FOTO_FEIN, Math.max(n.breite, n.hoehe)),
        minFlaeche: 0.045
      });
    } catch (f2) { erg = null; }
    postMessage({
      typ: "standbild",
      marke: n.marke,
      quad: erg ? erg.quad : null,
      konfidenz: erg ? erg.konfidenz : 0,
      flaeche: erg ? erg.flaeche : 0
    });
  }
};
