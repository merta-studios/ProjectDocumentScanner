/*
 * Live-Messung MIT KI - genauso, wie die App im Sucher arbeitet.
 *
 * tools/bench_live.js misst nur die reine Geometrie (detect.js). In der App
 * kommt aber regelmaessig ein Viereck des Netzes dazu (nn-worker.js ->
 * detect.js als zusaetzlicher Kandidat). Dieses Werkzeug bildet genau
 * diesen Ablauf nach:
 *
 *   - Geometrie auf JEDEM Frame (detect.js, wie detect-worker.js)
 *   - Netz hoechstens alle 60 ms, sein Ergebnis gilt 700 ms lang
 *   - das Netz sieht dieselben kleinen Sucher-Frames (320 px, JPEG-Rauschen)
 *
 * Gemessen wird, was der Nutzer spuert: Fundrate, Eckfehler, Zittern.
 *
 *   python3 tools/testbilder_hart.py /tmp/hart
 *   python3 -m http.server 8080 &        (im Repository-Wurzelverzeichnis)
 *   node tools/bench_live_ki.mjs /tmp/hart
 *   node tools/bench_live_ki.mjs /tmp/hart ohne     (ohne KI, zum Vergleich)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ordner = process.argv[2] || "/tmp/hart";
const basisURL = process.env.ULTRA_BASIS || "http://127.0.0.1:8080/";
const MIT_KI = process.argv[3] !== "ohne";

globalThis.self = globalThis;
await import(path.join(wurzel, "detect.js"));
const E = globalThis.UltraErkennung;
const nn = await import(path.join(wurzel, "detect-nn.js"));
if (MIT_KI) {
  nn.setzeBasis(basisURL, path.join(wurzel, "vendor/onnxruntime-web-1.20.1/"));
  await nn.lade();
}

const szenen = JSON.parse(fs.readFileSync(path.join(ordner, "live.json"), "utf8"));

function ordne(q) {
  const mx = q.reduce((s, p) => s + p[0], 0) / 4, my = q.reduce((s, p) => s + p[1], 0) / 4;
  const s = q.slice().sort((a, b) =>
    Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx));
  let best = 0, bw = 1e18;
  for (let i = 0; i < 4; i++) { const v = s[i][0] + s[i][1]; if (v < bw) { bw = v; best = i; } }
  return [s[best % 4], s[(best + 1) % 4], s[(best + 2) % 4], s[(best + 3) % 4]];
}

let gFund = 0, gFrames = 0, gFehler = 0, gZitter = 0, gSzenen = 0, gKiAnteil = 0;
let gFehlerOhneKi = 0;

console.log("Szene                 Fund   Fehler%  Zittern%   KI-Anteil");
for (const sz of szenen) {
  const diag = Math.hypot(sz.breite, sz.hoehe);
  const quads = [], quadsOhne = [];
  let fund = 0, fund2 = 0, kiN = 0;
  let kiLetzte = null;                  // { quad, konf, zeit }
  let letzteKiAnfrage = -1e9, simZeit = 0;
  for (const name of sz.frames) {
    const roh = fs.readFileSync(path.join(ordner, name + ".rgba"));
    const rgba = new Uint8ClampedArray(roh.buffer, roh.byteOffset, roh.length);
    simZeit += 30;                      // ein Frame je ~30 ms
    const hinweis = (kiLetzte && simZeit - kiLetzte.zeit < 700) ? kiLetzte : null;

    const r = E.erkenne(rgba, sz.breite, sz.hoehe, {
      arbeitsKante: 224, feinKante: Math.max(sz.breite, sz.hoehe), minFlaeche: 0.05,
      kandidaten: hinweis ? [{ quad: hinweis.quad, konfidenz: hinweis.konf }] : []
    });
    gFrames++;
    if (r) { fund++; gFund++; quads.push(ordne(r.quad)); if (r.quelle === "ki") { kiN++; } }

    if (MIT_KI) {
      const r2 = E.erkenne(rgba, sz.breite, sz.hoehe, {
        arbeitsKante: 224, feinKante: Math.max(sz.breite, sz.hoehe), minFlaeche: 0.05
      });
      if (r2) { fund2++; quadsOhne.push(ordne(r2.quad)); }
    }

    /* Das Netz laeuft in der App parallel in einem eigenen Worker. Hier
     * wird es nacheinander gerechnet; seine Laufzeit kommt auf die
     * Simulationsuhr, damit der 60-ms-Takt stimmt. */
    if (MIT_KI && nn.bereit() && simZeit - letzteKiAnfrage > 60) {
      letzteKiAnfrage = simZeit;
      const t1 = process.hrtime.bigint();
      let kres = null;
      try { kres = await nn.erkenneLive(rgba, sz.breite, sz.hoehe); } catch (e) { kres = null; }
      simZeit += Number(process.hrtime.bigint() - t1) / 1e6;
      kiLetzte = kres ? { quad: kres.quad, konf: kres.konfidenz, zeit: simZeit } : null;
    }
  }

  function auswerten(liste) {
    if (!liste.length) { return { fehler: 0, zitter: 0 }; }
    const soll = ordne(sz.ecken);
    let fehler = 0, zitter = 0;
    liste.forEach(function (q) {
      let d = 0;
      for (let i = 0; i < 4; i++) { d += Math.hypot(q[i][0] - soll[i][0], q[i][1] - soll[i][1]) / 4; }
      fehler += d / liste.length;
    });
    for (let i = 0; i < 4; i++) {
      let mx = 0, my = 0;
      for (let k = 0; k < liste.length; k++) { mx += liste[k][i][0] / liste.length; my += liste[k][i][1] / liste.length; }
      let v = 0;
      for (let k = 0; k < liste.length; k++) {
        v += (Math.pow(liste[k][i][0] - mx, 2) + Math.pow(liste[k][i][1] - my, 2)) / liste.length;
      }
      zitter += Math.sqrt(v) / 4;
    }
    return { fehler: 100 * fehler / diag, zitter: 100 * zitter / diag };
  }

  const a = auswerten(quads);
  const o = auswerten(quadsOhne);
  gFehler += a.fehler; gZitter += a.zitter; gSzenen++;
  gKiAnteil += fund ? kiN / fund : 0;
  gFehlerOhneKi += MIT_KI ? (fund2 ? o.fehler : 0) : 0;
  console.log(sz.name.padEnd(21) + " " + (fund + "/" + sz.frames.length).padEnd(6) +
    " " + a.fehler.toFixed(2).padStart(8) + " " + a.zitter.toFixed(2).padStart(9) +
    " " + (fund ? (100 * kiN / fund).toFixed(0) + " %" : "-").padStart(10) +
    (MIT_KI ? "     ohne KI " + (fund2 ? o.fehler.toFixed(2) : "-") + " %" : ""));
}
console.log("--------------------------------------------------------------------");
console.log("Fundrate " + (100 * gFund / gFrames).toFixed(0) + " %   " +
  "mittlerer Fehler " + (gFehler / gSzenen).toFixed(2) + " %   " +
  "mittleres Zittern " + (gZitter / gSzenen).toFixed(2) + " %   " +
  "KI-Anteil " + (100 * gKiAnteil / gSzenen).toFixed(0) + " %" +
  (MIT_KI ? "   (ohne KI: " + (gFehlerOhneKi / gSzenen).toFixed(2) + " %)" : ""));
