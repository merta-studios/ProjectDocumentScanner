/*
 * Ultra Scan - Hintergrunddienst.
 *
 * Laedt Pyodide (Python als WebAssembly) + NumPy + OpenCV und fuehrt die
 * ORIGINAL-Pipeline (Datei "scanner" im Repo, unveraendert) ueber die
 * Wrapper-Datei scan_wrapper.py aus:
 *   - "live": nur scanner.find_rough_quad() auf einem Mini-Frame
 *   - "scan": kompletter Ultra Scan (Hybrid-Ergebnis)
 *
 * Alles liegt lokal unter vendor/pyodide-0.27.7/ - kein fremdes CDN.
 */
"use strict";

var PYODIDE_PFAD = "vendor/pyodide-0.27.7/";

/* Bekannte Dateigroessen (Bytes) fuer einen ehrlichen Ladebalken. */
var LADE_DATEIEN = {
  "pyodide.asm.js":    1255688,
  "pyodide.asm.wasm":  10105481,
  "python_stdlib.zip": 2360733,
  "pyodide-lock.json": 111490,
  "numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl": 3061694,
  "opencv_python-4.10.0.84-cp312-cp312-pyodide_2024_0_wasm32.whl": 11435963
};
var GESAMT_BYTES = 0;
Object.keys(LADE_DATEIEN).forEach(function (k) { GESAMT_BYTES += LADE_DATEIEN[k]; });
var geladenProDatei = {};

function fortschrittMelden() {
  var geladen = 0;
  Object.keys(geladenProDatei).forEach(function (k) { geladen += geladenProDatei[k]; });
  postMessage({ typ: "fortschritt", prozent: Math.min(99, Math.round(100 * geladen / GESAMT_BYTES)) });
}

/* fetch umwickeln, damit empfangene Bytes gezaehlt werden.
 *
 * WICHTIG: Wir geben IMMER die unveraenderte Original-Antwort zurueck und
 * zaehlen die Bytes nur an einer GEKLONTEN Kopie im Hintergrund mit.
 * Fruehere Version hat die Antwort als neu gebautes Response(stream, ...)
 * zurueckgegeben - das bricht WebAssembly.instantiateStreaming() fuer
 * pyodide.asm.wasm in Safari/iOS zuverlaessig (das MIME-/Streaming-Setup
 * eines nachgebauten Response-Objekts wird dort nicht erkannt). Pyodide
 * faengt diesen Fehler intern ab und haengt dann STUMM fuer immer in der
 * WASM-Instanziierung - die App blieb dadurch ewig bei "Wird geladen"
 * stehen, ganz ohne Fehlermeldung. Mit clone() bekommt instantiateStreaming
 * die echte Netzwerk-Antwort, der Ladebalken funktioniert trotzdem. */
var originalFetch = self.fetch.bind(self);
self.fetch = function (eingabe, optionen) {
  var url = (typeof eingabe === "string") ? eingabe : (eingabe && eingabe.url) || "";
  var dateiname = url.split("/").pop().split("?")[0];
  var bekannt = LADE_DATEIEN[dateiname];
  return originalFetch(eingabe, optionen).then(function (antwort) {
    if (!bekannt || !antwort.body || !antwort.ok) { return antwort; }
    geladenProDatei[dateiname] = 0;
    try {
      var klon = antwort.clone();
      var leser = klon.body.getReader();
      (function liesWeiter() {
        leser.read().then(function (stueck) {
          if (stueck.done) { return; }
          geladenProDatei[dateiname] += stueck.value.length;
          fortschrittMelden();
          liesWeiter();
        }).catch(function () { /* Fortschritt ist nur kosmetisch */ });
      })();
    } catch (f) { /* clone() fehlgeschlagen -> einfach ohne Fortschrittsanzeige weiter */ }
    return antwort;
  });
};

var pyodide = null;

function initialisieren() {
  postMessage({ typ: "fortschritt", prozent: 0 });
  try {
    importScripts(PYODIDE_PFAD + "pyodide.js");
  } catch (f) {
    postMessage({ typ: "fehler", text: "Ultra Scan konnte nicht starten. Bitte die Seite neu laden.", detail: String(f) });
    return Promise.reject(f);
  }
  return loadPyodide({ indexURL: PYODIDE_PFAD })
    .then(function (py) {
      pyodide = py;
      return pyodide.loadPackage(["numpy", "opencv-python"]);
    })
    .then(function () {
      postMessage({ typ: "fortschritt", prozent: 99 });
      /* Originaldatei "scanner" UNVERAENDERT laden und nur im virtuellen
       * Pyodide-Dateisystem unter dem importierbaren Namen scanner.py
       * ablegen. Die Datei im Repository bleibt byte-identisch. */
      return Promise.all([
        originalFetch("scanner").then(function (a) {
          if (!a.ok) { throw new Error("scanner: HTTP " + a.status); }
          return a.arrayBuffer();
        }),
        originalFetch("scan_wrapper.py").then(function (a) {
          if (!a.ok) { throw new Error("scan_wrapper.py: HTTP " + a.status); }
          return a.arrayBuffer();
        })
      ]);
    })
    .then(function (quellen) {
      pyodide.FS.writeFile("/home/pyodide/scanner.py", new Uint8Array(quellen[0]));
      pyodide.FS.writeFile("/home/pyodide/scan_wrapper.py", new Uint8Array(quellen[1]));
      pyodide.runPython("import json, scan_wrapper");
      postMessage({ typ: "bereit" });
    })
    .catch(function (f) {
      postMessage({ typ: "fehler", text: "Ultra Scan konnte nicht starten. Bitte die Seite neu laden.", detail: String(f) });
      throw f;
    });
}

var initPromise = initialisieren();
initPromise.catch(function () { /* bereits gemeldet */ });

/* --------------------------- Live-Erkennung --------------------------- */
function live(n) {
  var rgba = new Uint8Array(n.rgba);
  pyodide.globals.set("rgba_js", rgba);
  pyodide.globals.set("hoehe_js", n.hoehe);
  pyodide.globals.set("breite_js", n.breite);
  var proxy = pyodide.runPython(
    "import json, scan_wrapper\n" +
    "json.dumps(scan_wrapper.quad_aus_rgba(rgba_js.to_py(), hoehe_js, breite_js))\n"
  );
  pyodide.globals.delete("rgba_js");
  postMessage({ typ: "quad", quad: JSON.parse(proxy) });
}

/* ----------------------------- Vollscan ------------------------------- */
function scannen(n) {
  var rgba = new Uint8Array(n.rgba);
  pyodide.globals.set("rgba_js", rgba);
  pyodide.globals.set("hoehe_js", n.hoehe);
  pyodide.globals.set("breite_js", n.breite);
  var proxy = pyodide.runPython(
    "import json, scan_wrapper\n" +
    "_out, _h, _w, _info = scan_wrapper.scan_rgba_streng(rgba_js.to_py(), hoehe_js, breite_js)\n" +
    "(_out, _h, _w, json.dumps(_info))\n"
  );
  var ergebnis = proxy.toJs();
  proxy.destroy();
  pyodide.globals.delete("rgba_js");
  var info = JSON.parse(ergebnis[3]);
  if (!info.dokument_erkannt || !ergebnis[0]) {
    postMessage({ typ: "keindokument" });
    return;
  }
  var kopie = new Uint8Array(new Uint8Array(ergebnis[0]));
  postMessage({
    typ: "ergebnis",
    rgba: kopie.buffer,
    hoehe: ergebnis[1],
    breite: ergebnis[2],
    info: info
  }, [kopie.buffer]);
}

self.onmessage = function (e) {
  var n = e.data;
  if (n.typ !== "scan" && n.typ !== "live") { return; }
  initPromise.then(function () {
    try {
      if (n.typ === "live") { live(n); } else { scannen(n); }
    } catch (f) {
      if (n.typ === "live") {
        postMessage({ typ: "quad", quad: null });
      } else {
        postMessage({ typ: "fehler", text: "Der Scan hat nicht geklappt. Bitte noch einmal versuchen.", detail: String(f) });
      }
    }
  }).catch(function () { /* Init-Fehler wurde bereits gemeldet */ });
};
