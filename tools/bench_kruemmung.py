#!/usr/bin/env python3
"""Prueft das Kruemmungs-Tor (UVDoc) auf echten Fotos.

Die Frage, die dieses Werkzeug beantwortet: Macht UVDoc eine Seite
gerader - oder erfindet es Wellen, wo keine waren?

Gemessen wird die Sagitta der Textzeilen (Median ueber alle erkannten
Zeilen, in Pixel bei 700 px Bildbreite) auf der ENTZERRTEN Seite - mit
und ohne Gitter. Genau diese Messung entscheidet auch in der App
(scan_wrapper._uvdoc_lohnt).

Erwartung an den Ordner:
    <ordner>/quads.json     { "name": [[x,y], [x,y], [x,y], [x,y]], ... }
    <ordner>/<name>.png     das Foto (Viereck in dessen Bildkoordinaten)

Das Gitter wird mit onnxruntime gerechnet (wie im Browser mit
onnxruntime-web). Fehlt onnxruntime, kann ein vorberechnetes Gitter
mitgegeben werden:

    python3 tools/bench_kruemmung.py /tmp/rohtest
    python3 tools/bench_kruemmung.py /tmp/rohtest --gitter gitter.json

Die Zahlen sind das eine - das Urteil faellt beim Ansehen der Bilder in
<ordner>/kruemmung_<name>_ohne.png und _mit.png.
"""
import argparse
import importlib.machinery
import importlib.util
import json
import os
import sys

import cv2
import numpy as np

WURZEL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, WURZEL)


def lade(name, pfad):
    """Die Original-Pipeline heisst "scanner" (ohne .py) - wie in Pyodide
    wird sie unter dem importierbaren Namen geladen."""
    spec = importlib.util.spec_from_loader(
        name, importlib.machinery.SourceFileLoader(name, pfad))
    modul = importlib.util.module_from_spec(spec)
    sys.modules[name] = modul
    spec.loader.exec_module(modul)
    return modul


lade("scanner", os.path.join(WURZEL, "scanner"))
import scan_wrapper as SW                                    # noqa: E402

MODELL = os.path.join(WURZEL, "models", "uvdoc-grid-712x488-int8.onnx")


def gitter_rechnen(img):
    """Vorhersage wie detect-uvdoc.js (gleiche Dreh- und Skalierregeln)."""
    import onnxruntime as ort
    sitzung = ort.InferenceSession(MODELL, providers=["CPUExecutionProvider"])
    h, w = img.shape[:2]
    quer = w > h
    tmp = np.ascontiguousarray(np.rot90(img)) if quer else img
    rgb = cv2.cvtColor(tmp, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    eingang = cv2.resize(rgb, (488, 712)).transpose(2, 0, 1)[None]
    return sitzung.run(None, {"image": eingang})[0][0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ordner")
    ap.add_argument("--gitter", help="JSON {name: [[...]]} statt onnxruntime")
    args = ap.parse_args()

    quads = json.load(open(os.path.join(args.ordner, "quads.json"),
                           encoding="utf-8"))
    fertige = json.load(open(args.gitter, encoding="utf-8")) if args.gitter else {}

    print("%-24s %8s %8s   %s" % ("Bild", "ohne", "mit", "Entscheidung"))
    print("-" * 66)
    angewandt = 0
    for name, quad in sorted(quads.items()):
        pfad = os.path.join(args.ordner, name + ".png")
        img = cv2.imread(pfad)
        if img is None:
            print("%-24s  fehlt" % name)
            continue
        g = fertige.get(name)
        if g is None:
            g = gitter_rechnen(img)
        q = np.asarray(quad, np.float64)
        klein = SW._klein(img, 900)
        qk = SW._ordne_robust(q * (klein.shape[1] / img.shape[1]))
        ohne = SW.entzerren(klein, qk)
        mit = SW.entzerren(SW._uvdoc_gitter_anwenden(klein, g), qk)
        a, b = SW._kruemmung(ohne), SW._kruemmung(mit)
        lohnt, _, _ = SW._uvdoc_lohnt(img, q, g)
        if lohnt:
            angewandt += 1
        print("%-24s %8.2f %8.2f   %s" % (
            name, a, b,
            "angewendet" if lohnt else ("schon gerade" if a <= 0.45 else "verworfen")))
        cv2.imwrite(os.path.join(args.ordner, "kruemmung_%s_ohne.png" % name), ohne)
        cv2.imwrite(os.path.join(args.ordner, "kruemmung_%s_mit.png" % name), mit)
    print("-" * 66)
    print("%d von %d Fotos geglaettet" % (angewandt, len(quads)))


if __name__ == "__main__":
    main()
