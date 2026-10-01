/*
 * Prueft detect-worker.js in einer nachgebauten Worker-Umgebung (Node).
 * Es gibt im Testrechner keinen Browser, deshalb werden importScripts,
 * self und postMessage nachgebildet. Damit laesst sich wenigstens das
 * Nachrichten-Protokoll zwischen app.js und dem Worker absichern.
 *
 * Aufruf: node tools/test_worker.js [ordner]
 */
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var wurzel = path.join(__dirname, "..");
var ordner = process.argv[2] || "/tmp/ultrascan-tests";

var gesendet = [];
var sandkasten = {
  console: console,
  performance: { now: function () { return Date.now(); } },
  Uint8ClampedArray: Uint8ClampedArray,
  Float32Array: Float32Array,
  Int32Array: Int32Array,
  Uint8Array: Uint8Array,
  Math: Math,
  Date: Date,
  postMessage: function (n) { gesendet.push(n); },
  importScripts: function (datei) {
    vm.runInContext(fs.readFileSync(path.join(wurzel, datei), "utf8"),
                    kontext, { filename: datei });
  }
};
sandkasten.self = sandkasten;
var kontext = vm.createContext(sandkasten);
vm.runInContext(fs.readFileSync(path.join(wurzel, "detect-worker.js"), "utf8"),
                kontext, { filename: "detect-worker.js" });

function rohLesen(ordner, name) {
  var roh = fs.readFileSync(path.join(ordner, name + ".rgba"));
  return new Uint8ClampedArray(roh.buffer.slice(roh.byteOffset,
                                                roh.byteOffset + roh.length));
}

var szenen = JSON.parse(fs.readFileSync(path.join(ordner, "live.json"), "utf8"));
var fehler = 0, getestet = 0, mitQuad = 0;

/* --- Live-Nachrichten ---------------------------------------------- */
szenen.forEach(function (sz) {
  sz.frames.slice(0, 2).forEach(function (name) {
    var rgba = rohLesen(ordner, name);
    gesendet.length = 0;
    getestet++;
    sandkasten.self.onmessage({
      data: { typ: "live", rgba: rgba.buffer, breite: sz.breite,
              hoehe: sz.hoehe, folge: getestet }
    });
    var a = gesendet[0];
    if (!a || a.typ !== "quad" || a.folge !== getestet) {
      console.log("FEHLER: keine/falsche Antwort fuer " + name);
      fehler++;
      return;
    }
    if (typeof a.schaerfe !== "number" || typeof a.bewegung !== "number") {
      console.log("FEHLER: Masse fehlen bei " + name);
      fehler++;
    }
    if (a.quad) {
      mitQuad++;
      if (a.quad.length !== 4) {
        console.log("FEHLER: Quad hat " + a.quad.length + " Ecken");
        fehler++;
      }
    }
  });
});

/* --- Standbild-Nachricht ------------------------------------------- */
var gross = JSON.parse(fs.readFileSync(path.join(ordner, "faelle.json"), "utf8"))[0];
gesendet.length = 0;
sandkasten.self.onmessage({
  data: { typ: "standbild", rgba: rohLesen(ordner, gross.name).buffer,
          breite: gross.breite || 1280, hoehe: gross.hoehe || 960, marke: 77 }
});
var b = gesendet[0];
if (!b || b.typ !== "standbild" || b.marke !== 77 || !b.quad) {
  console.log("FEHLER: Standbild-Antwort unbrauchbar");
  fehler++;
}

/* --- Unbekannte Nachricht darf nicht abstuerzen --------------------- */
gesendet.length = 0;
sandkasten.self.onmessage({ data: { typ: "quatsch" } });
sandkasten.self.onmessage({ data: null });

console.log("Live-Nachrichten: " + getestet + ", davon mit Viereck " + mitQuad);
console.log("Standbild-Antwort: " + (b && b.quad ? "Viereck geliefert" : "fehlt"));
console.log(fehler === 0 ? "ALLES OK" : (fehler + " FEHLER"));
process.exit(fehler === 0 ? 0 : 1);
