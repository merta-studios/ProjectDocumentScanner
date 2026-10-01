/*
 * Live-Messung fuer detect.js: pro Szene mehrere echte Sucher-Frames
 * (320 px, Rauschen, JPEG, Handzittern).
 *
 * Gemessen wird, was der Nutzer spuert:
 *   - Fundrate     : wie oft ueberhaupt ein Viereck kommt
 *   - Fehler       : Abweichung von den Soll-Ecken (% der Diagonale)
 *   - ZITTERN      : wie weit die Ecken von Frame zu Frame springen,
 *                    obwohl sich fast nichts bewegt. Genau das loeste
 *                    frueher dauernd "Ruhig halten" aus.
 *   - ms           : Rechenzeit pro Frame
 *
 *   node tools/bench_live.js /tmp/ultrascan-tests [arbeitsKante]
 */
"use strict";
var fs = require("fs");
var path = require("path");
global.self = global;
require(path.join(__dirname, "..", "detect.js"));

var ordner = process.argv[2] || "/tmp/ultrascan-tests";
var arbeitsKante = Number(process.argv[3] || 224);
var szenen = JSON.parse(fs.readFileSync(path.join(ordner, "live.json"), "utf8"));

function ordne(q) {
  var mx = 0, my = 0, i;
  for (i = 0; i < 4; i++) { mx += q[i][0] / 4; my += q[i][1] / 4; }
  var s = q.slice().sort(function (a, b) {
    return Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx);
  });
  var best = 0, bw = 1e18;
  for (i = 0; i < 4; i++) { var v = s[i][0] + s[i][1]; if (v < bw) { bw = v; best = i; } }
  return [s[best % 4], s[(best + 1) % 4], s[(best + 2) % 4], s[(best + 3) % 4]];
}
function pad(s, n) { s = String(s); while (s.length < n) { s += " "; } return s; }

var gFund = 0, gFrames = 0, gFehler = 0, gZitter = 0, gZeit = 0, gSzenen = 0;
console.log("Szene                 Fund   Fehler%  Zittern%  ms");
szenen.forEach(function (sz) {
  var diag = Math.hypot(sz.breite, sz.hoehe);
  var quads = [], zeit = 0, fund = 0;
  sz.frames.forEach(function (name) {
    var roh = fs.readFileSync(path.join(ordner, name + ".rgba"));
    var rgba = new Uint8ClampedArray(roh.buffer, roh.byteOffset, roh.length);
    var t0 = process.hrtime.bigint();
    var r = global.UltraErkennung.erkenne(rgba, sz.breite, sz.hoehe,
      { arbeitsKante: arbeitsKante, feinKante: Number(process.argv[4] || arbeitsKante) });
    zeit += Number(process.hrtime.bigint() - t0) / 1e6;
    gFrames++;
    if (r) { fund++; gFund++; quads.push(ordne(r.quad)); }
  });
  var fehler = 0, zitter = 0;
  if (quads.length) {
    var soll = ordne(sz.ecken), i, k;
    quads.forEach(function (q) {
      var d = 0;
      for (i = 0; i < 4; i++) { d += Math.hypot(q[i][0] - soll[i][0], q[i][1] - soll[i][1]) / 4; }
      fehler += d / quads.length;
    });
    /* Zittern: mittlere Standardabweichung der Ecken ueber die Frames */
    for (i = 0; i < 4; i++) {
      var mx = 0, my = 0;
      for (k = 0; k < quads.length; k++) { mx += quads[k][i][0] / quads.length; my += quads[k][i][1] / quads.length; }
      var v = 0;
      for (k = 0; k < quads.length; k++) {
        v += (Math.pow(quads[k][i][0] - mx, 2) + Math.pow(quads[k][i][1] - my, 2)) / quads.length;
      }
      zitter += Math.sqrt(v) / 4;
    }
  }
  gFehler += 100 * fehler / diag; gZitter += 100 * zitter / diag;
  gZeit += zeit / sz.frames.length; gSzenen++;
  console.log(pad(sz.name, 21) + " " + pad(fund + "/" + sz.frames.length, 6) +
    " " + pad((100 * fehler / diag).toFixed(2), 8) +
    " " + pad((100 * zitter / diag).toFixed(2), 9) +
    " " + (zeit / sz.frames.length).toFixed(1));
});
console.log("--------------------------------------------------------------");
console.log("Fundrate " + (100 * gFund / gFrames).toFixed(0) + " %   " +
  "mittlerer Fehler " + (gFehler / gSzenen).toFixed(2) + " %   " +
  "mittleres Zittern " + (gZitter / gSzenen).toFixed(2) + " %   " +
  (gZeit / gSzenen).toFixed(1) + " ms/Frame");
