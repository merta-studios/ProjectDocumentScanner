/*
 * Misst die ERKENNUNG auf echten Handyfotos - klassisch, KI und beides
 * zusammen. Das ist der Test, der die eigentliche Verbesserung belegt:
 * die synthetische Suite (tools/bench_detect.js) war schon vorher 34/34,
 * auf echten Fotos lag die alte Erkennung dagegen regelmaessig daneben.
 *
 * Es gibt in dieser Umgebung keinen Browser. onnxruntime-web laeuft hier
 * deshalb unter Node mit dem WASM-Backend - dieselbe Datei, die auch der
 * Browser laedt. Das Modell wird ueber HTTP geholt, also muss ein
 * statischer Server laufen:
 *
 *   python3 -m http.server 8080        (im Repository-Wurzelverzeichnis)
 *   node tools/bench_fusion.mjs /tmp/echtfotos
 *
 * Die Fotos holt tools/hole_echtfotos.py.
 *
 * Ergebnis: Tabelle je Foto + fusion.json mit den gefundenen Vierecken,
 * die tools/bench_veredelung.py danach weiterverwendet.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const wurzel = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ordner = process.argv[2] || "/tmp/echtfotos";
const basisURL = process.env.ULTRA_BASIS || "http://127.0.0.1:8080/";

/* detect.js ist ein klassisches Worker-Skript und erwartet "self". */
globalThis.self = globalThis;
await import(path.join(wurzel, "detect.js"));
const nn = await import(path.join(wurzel, "detect-nn.js"));
nn.setzeBasis(basisURL, path.join(wurzel, "vendor/onnxruntime-web-1.20.1/"));

const E = globalThis.UltraErkennung;
const faelle = JSON.parse(fs.readFileSync(path.join(ordner, "faelle.json"), "utf8"));

console.log("lade Modell ...");
const geladen = await nn.lade();
if (!geladen) {
  console.error("Modell nicht geladen:", nn.fehler());
  console.error("Laeuft der Server?  python3 -m http.server 8080");
  process.exit(1);
}

function laden(name, breite, hoehe) {
  const roh = fs.readFileSync(path.join(ordner, name + ".rgba"));
  if (roh.length !== breite * hoehe * 4) {
    throw new Error(name + ": Rohpuffer passt nicht zur Groesse");
  }
  return new Uint8ClampedArray(roh.buffer, roh.byteOffset, roh.length);
}

const OPTIONEN = {
  arbeitsKante: 288,
  minFlaeche: 0.045
};

const ergebnis = {};
let nurKlassisch = 0, nurKI = 0, fusion = 0, keiner = 0;
let summeMs = 0;

console.log("");
console.log("Foto                      klassisch   KI      Fusion -> Quelle    ms");
console.log("-".repeat(78));

for (const f of faelle) {
  const rgba = laden(f.name, f.breite, f.hoehe);
  const opt = Object.assign({}, OPTIONEN, {
    feinKante: Math.min(1100, Math.max(f.breite, f.hoehe))
  });

  /* 1. rein klassisch */
  const klassisch = E.erkenne(rgba, f.breite, f.hoehe, opt);

  /* 2. rein KI (mit Randreserve, falls Ecken aus dem Bild laufen) */
  const ki = await nn.erkenneGruendlich(rgba, f.breite, f.hoehe);

  /* 3. beides zusammen - so macht es die App */
  const t0 = Date.now();
  const beides = E.erkenne(rgba, f.breite, f.hoehe, Object.assign({}, opt, {
    kandidaten: ki ? [{ quad: ki.quad, konfidenz: ki.konfidenz }] : []
  }));
  const ms = Date.now() - t0;
  summeMs += ms;

  if (beides) {
    ergebnis[f.name] = { quad: beides.quad, konf: beides.konfidenz, quelle: beides.quelle };
    if (beides.quelle === "ki") { nurKI++; } else { nurKlassisch++; }
    fusion++;
  } else {
    ergebnis[f.name] = { quad: null, konf: 0, quelle: "-" };
    keiner++;
  }

  console.log(
    f.name.padEnd(24) +
    (klassisch ? klassisch.konfidenz.toFixed(2) : " -  ").padStart(9) +
    (ki ? ki.konfidenz.toFixed(2) : " -  ").padStart(8) +
    (beides ? beides.konfidenz.toFixed(2) : " -  ").padStart(10) +
    "   " + (beides ? beides.quelle : "-").padEnd(8) +
    String(ms).padStart(5)
  );
}

console.log("-".repeat(78));
console.log("erkannt: %d/%d   davon KI: %d, klassisch: %d   ohne Fund: %d   %d ms/Foto",
            fusion, faelle.length, nurKI, nurKlassisch, keiner,
            Math.round(summeMs / faelle.length));

const ziel = path.join(ordner, "fusion.json");
fs.writeFileSync(ziel, JSON.stringify(ergebnis, null, 1));
console.log("Vierecke geschrieben:", ziel);

if (keiner > 0) { process.exitCode = 1; }
