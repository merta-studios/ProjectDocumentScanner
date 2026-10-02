/*
 * Misst die ERKENNUNG auf den schwierigen Szenen (weiss auf weiss, Stapel,
 * gebogene Buchseiten) - mit Soll-Ecken, also mit echtem Eckfehler.
 *
 *   python3 tools/testbilder_hart.py /tmp/hart
 *   python3 -m http.server 8080 &            (im Repository-Wurzelverzeichnis)
 *   node tools/bench_hart.mjs /tmp/hart
 *
 * Verglichen werden:
 *   klassisch  - nur detect.js
 *   docaligner - detect-nn.js (das bisherige KI-Modell) + detect.js
 *   docquad    - DocQuadNet-256 (neues Modell) + detect.js
 *
 * Ausgegeben wird je Szene der mittlere Eckfehler in Prozent der Diagonale
 * (nur bei Fund) und am Ende Fundrate + Fehler.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ordner = process.argv[2] || "/tmp/hart";
const basisURL = process.env.ULTRA_BASIS || "http://127.0.0.1:8080/";

globalThis.self = globalThis;
await import(path.join(wurzel, "detect.js"));
const E = globalThis.UltraErkennung;

const modus = process.argv[3] || "alle";      // klassisch | ki | alle

let nn = null, dq = null;
if (modus !== "klassisch") {
  nn = await import(path.join(wurzel, "detect-nn.js"));
  nn.setzeBasis(basisURL, path.join(wurzel, "vendor/onnxruntime-web-1.20.1/"));
  try { dq = await import(path.join(wurzel, "detect-docquad.js")); } catch (e) { dq = null; }
}

const faelle = JSON.parse(fs.readFileSync(path.join(ordner, "faelle.json"), "utf8"));

function ordne(q) {
  const mx = q.reduce((s, p) => s + p[0], 0) / 4, my = q.reduce((s, p) => s + p[1], 0) / 4;
  const s = q.slice().sort((a, b) =>
    Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx));
  let best = 0, bw = 1e18;
  for (let i = 0; i < 4; i++) { const v = s[i][0] + s[i][1]; if (v < bw) { bw = v; best = i; } }
  return [s[best % 4], s[(best + 1) % 4], s[(best + 2) % 4], s[(best + 3) % 4]];
}

function fehler(q, soll, diag) {
  const A = ordne(q), B = ordne(soll);
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(A[i][0] - B[i][0], A[i][1] - B[i][1]) / 4;
  return 100 * s / diag;
}

function iou(q, soll, breite, hoehe) {
  /* grobe Ueberdeckung: Anteil der Soll-Flaeche, der im Ist-Viereck liegt */
  const A = ordne(q);
  let drin = 0, gesamt = 0;
  const B = ordne(soll);
  for (let y = 2; y < hoehe; y += 5) {
    for (let x = 2; x < breite; x += 5) {
      let inB = true, inA = true, vzB = 0, vzA = 0;
      for (let i = 0; i < 4; i++) {
        const p1 = B[i], p2 = B[(i + 1) % 4];
        let s = (p2[0] - p1[0]) * (y - p1[1]) - (p2[1] - p1[1]) * (x - p1[0]);
        s = s > 0 ? 1 : (s < 0 ? -1 : 0);
        if (s) { if (!vzB) vzB = s; else if (s !== vzB) inB = false; }
        const a1 = A[i], a2 = A[(i + 1) % 4];
        let t = (a2[0] - a1[0]) * (y - a1[1]) - (a2[1] - a1[1]) * (x - a1[0]);
        t = t > 0 ? 1 : (t < 0 ? -1 : 0);
        if (t) { if (!vzA) vzA = t; else if (t !== vzA) inA = false; }
      }
      if (inB) { gesamt++; if (inA) drin++; }
    }
  }
  return gesamt ? drin / gesamt : 0;
}

function laden(name, breite, hoehe) {
  const roh = fs.readFileSync(path.join(ordner, name + ".rgba"));
  return new Uint8ClampedArray(roh.buffer, roh.byteOffset, roh.length);
}

if (nn) {
  process.stdout.write("lade DocAligner ... ");
  await nn.lade().catch(() => {});
  console.log(nn.bereit() ? "ok" : "FEHLER");
}
if (dq) {
  process.stdout.write("lade DocQuadNet ... ");
  try { await dq.lade(); console.log(dq.bereit() ? "ok" : "FEHLER"); }
  catch (e) { console.log("FEHLER", e.message); }
}

const OPT = { arbeitsKante: 288, minFlaeche: 0.03 };

const zahler = {};
for (const m of ["klassisch", "docaligner", "docquad"]) zahler[m] = { fund: 0, fehler: 0, n: 0, ms: 0 };

console.log("");
console.log("Szene                        klassisch        docaligner       docquad");
console.log("                             F   Fehler% IoU   F   Fehler% IoU   F   Fehler% IoU");
console.log("-".repeat(88));

for (const f of faelle) {
  const rgba = laden(f.name, f.breite, f.hoehe);
  const diag = Math.hypot(f.breite, f.hoehe);
  const opt = Object.assign({}, OPT, { feinKante: Math.min(1100, Math.max(f.breite, f.hoehe)) });
  const zeile = [];

  /* 1. nur klassisch */
  let t0 = Date.now();
  let r = E.erkenne(rgba, f.breite, f.hoehe, opt);
  zahler.klassisch.ms += Date.now() - t0;
  zeile.push(["klassisch", r]);

  /* 2. DocAligner + klassisch */
  if (nn && nn.bereit()) {
    const ki = await nn.erkenneGruendlich(rgba, f.breite, f.hoehe).catch(() => null);
    t0 = Date.now();
    r = E.erkenne(rgba, f.breite, f.hoehe, Object.assign({}, opt,
      { kandidaten: ki ? [{ quad: ki.quad, konfidenz: ki.konfidenz }] : [] }));
    zahler.docaligner.ms += Date.now() - t0;
    zeile.push(["docaligner", r]);
  } else {
    zeile.push(["docaligner", null]);
  }

  /* 3. DocQuadNet + klassisch */
  if (dq && dq.bereit()) {
    const kq = await dq.erkenne(rgba, f.breite, f.hoehe, { rand: 0 }).catch(() => null);
    t0 = Date.now();
    r = E.erkenne(rgba, f.breite, f.hoehe, Object.assign({}, opt,
      { kandidaten: kq ? [{ quad: kq.quad, konfidenz: kq.konfidenz }] : [] }));
    zahler.docquad.ms += Date.now() - t0;
    zeile.push(["docquad", r]);
  } else {
    zeile.push(["docquad", null]);
  }

  let aus = f.name.padEnd(28);
  for (const [name, res] of zeile) {
    if (!name.startsWith(modus === "klassisch" ? "klassisch" : "")) { /* egal */ }
    if (res) {
      const e = fehler(res.quad, f.ecken, diag);
      const ov = iou(res.quad, f.ecken, f.breite, f.hoehe);
      zahler[name].fund++; zahler[name].fehler += e; zahler[name].n++;
      aus += "1 " + e.toFixed(1).padStart(8) + " " + ov.toFixed(2).padStart(5) + "  ";
    } else {
      aus += "- " + "".padStart(8) + " " + "".padStart(5) + "  ";
    }
  }
  console.log(aus);
}

console.log("-".repeat(88));
for (const name of Object.keys(zahler)) {
  const z = zahler[name];
  console.log(name.padEnd(12) + " Fund " + (100 * z.fund / faelle.length).toFixed(0) + " %" +
    "   mittlerer Fehler " + (z.n ? (z.fehler / z.n).toFixed(2) : "-") + " %" +
    "   " + (z.ms / faelle.length).toFixed(0) + " ms/Bild");
}
