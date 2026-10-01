/*
 * Web Worker: laedt Pyodide (Python als WebAssembly) + NumPy + OpenCV und
 * fuehrt die ORIGINAL-Pipeline (Datei "scanner" im Repo, unveraendert) ueber
 * die Wrapper-Datei scan_wrapper.py aus.
 *
 * Alles liegt lokal unter vendor/pyodide-0.27.7/ - kein fremdes CDN.
 */
"use strict";

var PYODIDE_PFAD = "vendor/pyodide-0.27.7/";

/* Bekannte Dateigroessen (Bytes, unkomprimiert) fuer den ehrlichen
 * Ladebalken. Der Fortschritt wird aus den tatsaechlich empfangenen
 * Bytes berechnet. */
var LADE_DATEIEN = {
  "pyodide.asm.js":    { groesse: 1255688,  text: "Python wird geladen \u2026" },
  "pyodide.asm.wasm":  { groesse: 10105481, text: "Python wird geladen \u2026" },
  "python_stdlib.zip": { groesse: 2360733,  text: "Python-Bibliothek wird geladen \u2026" },
  "pyodide-lock.json": { groesse: 111490,   text: "Paketliste wird geladen \u2026" },
  "numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl":
                       { groesse: 3061694,  text: "NumPy wird geladen \u2026" },
  "opencv_python-4.10.0.84-cp312-cp312-pyodide_2024_0_wasm32.whl":
                       { groesse: 11435963, text: "OpenCV wird geladen \u2026" }
};
var GESAMT_BYTES = 0;
Object.keys(LADE_DATEIEN).forEach(function (k) { GESAMT_BYTES += LADE_DATEIEN[k].groesse; });
var geladenProDatei = {};

function fortschrittMelden(text) {
  var geladen = 0;
  Object.keys(geladenProDatei).forEach(function (k) { geladen += geladenProDatei[k]; });
  var prozent = Math.min(99, Math.round(100 * geladen / GESAMT_BYTES));
  postMessage({ typ: "fortschritt", prozent: prozent, text: text });
}

/* fetch so umwickeln, dass empfangene Bytes gezaehlt werden */
var originalFetch = self.fetch.bind(self);
self.fetch = function (eingabe, optionen) {
  var url = (typeof eingabe === "string") ? eingabe : (eingabe && eingabe.url) || "";
  var dateiname = url.split("/").pop().split("?")[0];
  var info = LADE_DATEIEN[dateiname];
  return originalFetch(eingabe, optionen).then(function (antwort) {
    if (!info || !antwort.ok || !antwort.body ||
        typeof ReadableStream !== "function") { return antwort; }
    geladenProDatei[dateiname] = 0;
    fortschrittMelden(info.text);
    var leser = antwort.body.getReader();
    var strom = new ReadableStream({
      start: function (controller) {
        function pumpe() {
          return leser.read().then(function (r) {
            if (r.done) { controller.close(); return; }
            geladenProDatei[dateiname] += r.value.byteLength;
            fortschrittMelden(info.text);
            controller.enqueue(r.value);
            return pumpe();
          });
        }
        return pumpe().catch(function (f) { controller.error(f); });
      },
      cancel: function (grund) { return leser.cancel(grund); }
    });
    return new Response(strom, {
      status: antwort.status,
      statusText: antwort.statusText,
      headers: antwort.headers
    });
  });
};

var pyodide = null;

function initialisieren() {
  postMessage({ typ: "fortschritt", prozent: 0, text: "Python wird geladen \u2026" });
  try {
    importScripts(PYODIDE_PFAD + "pyodide.js");
  } catch (f) {
    postMessage({ typ: "fehler", text: "Die Python-Laufzeit konnte nicht geladen werden. " +
      "Bitte Internetverbindung pr\u00fcfen und die Seite neu laden.", detail: String(f) });
    return Promise.reject(f);
  }
  return loadPyodide({ indexURL: PYODIDE_PFAD })
    .then(function (py) {
      pyodide = py;
      return pyodide.loadPackage(["numpy", "opencv-python"]);
    })
    .then(function () {
      postMessage({ typ: "fortschritt", prozent: 99, text: "Scan-Pipeline wird vorbereitet \u2026" });
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
      pyodide.runPython("import scan_wrapper");   // Import-Test + Warmup
      postMessage({ typ: "bereit" });
    })
    .catch(function (f) {
      postMessage({ typ: "fehler", text: "Der Scanner konnte nicht gestartet werden. " +
        "Bitte Internetverbindung pr\u00fcfen und die Seite neu laden.", detail: String(f) });
      throw f;
    });
}

var initPromise = initialisieren();
initPromise.catch(function () { /* bereits an die Oberflaeche gemeldet */ });

function scannen(nachricht) {
  var rgba = new Uint8Array(nachricht.rgba);
  pyodide.globals.set("rgba_js", rgba);
  pyodide.globals.set("hoehe_js", nachricht.hoehe);
  pyodide.globals.set("breite_js", nachricht.breite);
  var proxy = pyodide.runPython(
    "import json\n" +
    "import scan_wrapper\n" +
    "_out, _h, _w, _info = scan_wrapper.scan_rgba(rgba_js.to_py(), hoehe_js, breite_js)\n" +
    "(_out, _h, _w, json.dumps(_info))\n"
  );
  var ergebnis = proxy.toJs();
  proxy.destroy();
  pyodide.globals.delete("rgba_js");
  var ausgabe = new Uint8Array(ergebnis[0]);          // Kopie aus dem WASM-Speicher
  var kopie = new Uint8Array(ausgabe);                 // eigener ArrayBuffer
  postMessage({
    typ: "ergebnis",
    rgba: kopie.buffer,
    hoehe: ergebnis[1],
    breite: ergebnis[2],
    info: JSON.parse(ergebnis[3])
  }, [kopie.buffer]);
}

self.onmessage = function (ereignis) {
  var n = ereignis.data;
  if (n.typ === "scan") {
    initPromise.then(function () {
      try {
        scannen(n);
      } catch (f) {
        postMessage({ typ: "fehler", scanFehler: true,
          text: "Beim Scannen ist ein Fehler aufgetreten. Bitte mit einem anderen Foto erneut versuchen.",
          detail: String(f) });
      }
    }).catch(function () { /* Init-Fehler wurde bereits gemeldet */ });
  }
};
