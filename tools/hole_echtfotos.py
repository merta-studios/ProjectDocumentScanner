#!/usr/bin/env python3
"""Holt die 14 ECHTEN Handyfotos, auf denen Erkennung und Scan gemessen werden.

Warum nicht im Repository?
--------------------------
Die Bilder gehoeren anderen Projekten (jeweils eigene Lizenz) und sind
zusammen ueber 70 MB gross. Statt sie mitzuschleppen, holt dieses Skript
sie bei Bedarf aus den Original-Repositories und legt sie in einem
Arbeitsordner ab. Damit bleibt das Repository klein und die Herkunft
jedes Bildes nachvollziehbar.

Die synthetische Suite (tools/testbilder.py) bleibt der schnelle
Regressionsschutz - diese echten Fotos sind der Realitaetstest.

Aufruf:
  python3 tools/hole_echtfotos.py [zielordner]      (Standard: /tmp/echtfotos)

Danach:
  node tools/bench_fusion.mjs /tmp/echtfotos
  python3 tools/bench_veredelung.py /tmp/echtfotos
"""
import json
import os
import shutil
import subprocess
import sys

try:
    import cv2
except ImportError:
    sys.exit("OpenCV fehlt. Zum Beispiel:  python3 -m venv /tmp/venv && "
             "/tmp/venv/bin/pip install opencv-python-headless")

# Quelle -> Dateien. Alle Repositories sind oeffentlich und werden flach
# geklont (--depth 1), damit es schnell geht.
QUELLEN = [
    {
        "repo": "https://github.com/andrewdcampbell/OpenCV-Document-Scanner.git",
        "lizenz": "MIT",
        "unterordner": "sample_images",
        "dateien": ["cell_pic.jpg", "chart.JPG", "desk.JPG", "dollar_bill.JPG",
                    "math_cheat_sheet.JPG", "notepad.JPG", "receipt.jpg",
                    "tax.jpeg"],
    },
    {
        "repo": "https://github.com/mzucker/page_dewarp.git",
        "lizenz": "MIT",
        "unterordner": "example_input",
        "dateien": ["boston_cooking_a.jpg", "linguistics_thesis_a.jpg"],
    },
    {
        "repo": "https://github.com/ColonelParrot/jscanify.git",
        "lizenz": "MIT",
        "unterordner": "docs/images/test",
        "dateien": ["test.png", "test2.png", "test10.jpg"],
    },
    {
        "repo": "https://github.com/DocsaidLab/DocAligner.git",
        "lizenz": "Apache-2.0",
        "unterordner": "docs",
        "dateien": ["run_test_card.jpg"],
    },
]

# Reihenfolge = Nummerierung in faelle.json (damit Messwerte vergleichbar
# bleiben, auch wenn spaeter Quellen dazukommen).
REIHENFOLGE = ["boston_cooking_a.jpg", "cell_pic.jpg", "chart.JPG", "desk.JPG",
               "dollar_bill.JPG", "linguistics_thesis_a.jpg",
               "math_cheat_sheet.JPG", "notepad.JPG", "receipt.jpg",
               "run_test_card.jpg", "tax.jpeg", "test.png", "test2.png",
               "test10.jpg"]

MAX_KANTE = 1280     # wie in app.js heruntergerechnet: realistische Groesse


def finde(ordner, name):
    """Datei im Klon suchen - Unterordner wandern zwischen Versionen."""
    for wurzel, _, dateien in os.walk(ordner):
        for d in dateien:
            if d.lower() == name.lower():
                return os.path.join(wurzel, d)
    return None


def main():
    ziel = sys.argv[1] if len(sys.argv) > 1 else "/tmp/echtfotos"
    roh = os.path.join(ziel, "_roh")
    os.makedirs(roh, exist_ok=True)

    for q in QUELLEN:
        kurz = q["repo"].rstrip("/").split("/")[-1].replace(".git", "")
        klon = os.path.join(roh, kurz)
        if not os.path.isdir(klon):
            print("klone", kurz, "...")
            r = subprocess.run(["git", "clone", "--depth", "1", q["repo"], klon],
                               capture_output=True, text=True)
            if r.returncode != 0:
                print("  FEHLER:", r.stderr.strip().splitlines()[-1:])
                continue
        for name in q["dateien"]:
            pfad = finde(klon, name)
            if pfad:
                shutil.copy(pfad, os.path.join(roh, name))
            else:
                print("  fehlt:", name)

    meta = []
    for i, name in enumerate(REIHENFOLGE):
        pfad = os.path.join(roh, name)
        bild = cv2.imread(pfad)
        if bild is None:
            print("uebersprungen:", name)
            continue
        h, w = bild.shape[:2]
        f = MAX_KANTE / float(max(h, w))
        if f < 1.0:
            bild = cv2.resize(bild, (round(w * f), round(h * f)),
                              interpolation=cv2.INTER_AREA)
        h, w = bild.shape[:2]
        basis = "%02d_%s" % (i, os.path.splitext(name)[0])
        cv2.imwrite(os.path.join(ziel, basis + ".png"), bild)
        # Rohpuffer fuer die JavaScript-Tests (dort gibt es keinen Decoder).
        cv2.cvtColor(bild, cv2.COLOR_BGR2RGBA).tofile(
            os.path.join(ziel, basis + ".rgba"))
        meta.append({"name": basis, "breite": w, "hoehe": h})

    with open(os.path.join(ziel, "faelle.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print("%d Fotos in %s" % (len(meta), ziel))


if __name__ == "__main__":
    main()
