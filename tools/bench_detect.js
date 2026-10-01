/*
 * Misst detect.js gegen die synthetischen Testszenen aus tools/testbilder.py.
 *
 *   python3 tools/testbilder.py /tmp/ultrascan-tests
 *   node tools/bench_detect.js /tmp/ultrascan-tests
 *
 * Ausgegeben wird je Szene der mittlere Eckfehler in Prozent der
 * Bilddiagonale (< 1.5 % = sehr gut, < 3 % = brauchbar) und die Laufzeit.
 */
"use strict";
var fs = require("fs");
var path = require("path");

global.self = global;
require(path.join(__dirname, "..", "detect.js"));

var ordner = process.argv[2] || "/tmp/ultrascan-tests";
var faelle = JSON.parse(fs.readFileSync(path.join(ordner, "faelle.json"), "utf8"));
var arbeitsKante = Number(process.argv[3] || 256);

function ordne(q) {
  var mx = 0, my = 0, i;
  for (i = 0; i < 4; i++) { mx += q[i][0] / 4; my += q[i][1] / 4; }
  var s = q.slice().sort(function (a, b) {
    return Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx);
  });
  var best = 0, bw = 1e18;
  for (i = 0; i < 4; i++) {
    var v = s[i][0] + s[i][1];
    if (v < bw) { bw = v; best = i; }
  }
  return [s[best % 4], s[(best + 1) % 4], s[(best + 2) % 4], s[(best + 3) % 4]];
}

function fehler(a, b, diag) {
  var A = ordne(a), B = ordne(b), summe = 0, max = 0;
  for (var i = 0; i < 4; i++) {
    var d = Math.hypot(A[i][0] - B[i][0], A[i][1] - B[i][1]);
    summe += d; if (d > max) { max = d; }
  }
  return { mittel: 100 * (summe / 4) / diag, max: 100 * max / diag };
}

var gesamt = 0, treffer = 0, zeitSumme = 0, schlimmste = 0;
console.log("Szene                 Treffer  Fehler%   max%   Konf  ms   Quelle");
faelle.forEach(function (f) {
  var roh = fs.readFileSync(path.join(ordner, f.name + ".rgba"));
  var rgba = new Uint8ClampedArray(roh.buffer, roh.byteOffset, roh.length);
  var diag = Math.hypot(f.breite, f.hoehe);
  var t0 = process.hrtime.bigint();
  var r = global.UltraErkennung.erkenne(rgba, f.breite, f.hoehe,
    { arbeitsKante: arbeitsKante });
  var ms = Number(process.hrtime.bigint() - t0) / 1e6;
  zeitSumme += ms;
  gesamt++;
  if (!r) {
    console.log(pad(f.name, 21) + " NEIN        -      -      -  " +
                ms.toFixed(1));
    return;
  }
  var e = fehler(r.quad, f.ecken, diag);
  if (e.mittel < 2.0) { treffer++; }
  if (e.mittel > schlimmste) { schlimmste = e.mittel; }
  console.log(pad(f.name, 21) + " " + (e.mittel < 2.0 ? "JA " : "weit") +
    "   " + pad(e.mittel.toFixed(2), 7) + " " + pad(e.max.toFixed(2), 6) +
    " " + pad(r.konfidenz.toFixed(2), 5) + " " + pad(ms.toFixed(1), 5) +
    " " + r.quelle + (r.randZahl ? " rand:" + r.randZahl : ""));
});
console.log("--------------------------------------------------------------");
console.log("Treffer (Fehler < 2 % der Diagonale): " + treffer + " / " + gesamt +
  "   schlechtester Fehler: " + schlimmste.toFixed(2) + " %" +
  "   Zeit/Bild: " + (zeitSumme / gesamt).toFixed(1) + " ms");

function pad(s, n) { s = String(s); while (s.length < n) { s += " "; } return s; }
