#!/usr/bin/env python3
"""Vergleicht den ALTEN und den NEUEN Wrapper auf denselben Testszenen.

Gemessen wird das, was der Nutzer als "alles verrutscht" erlebt hat:

  Zeilen   - Schaerfe des Zeilenprofils (hoeher = Text liegt gerader)
  Inhalt   - wie viel der Tinte des entzerrten Blattes im Ergebnis
             tatsaechlich ankommt (1.00 = nichts abgeschnitten)
  Rand     - Abstand des Textblocks zu den Bildraendern, gleichmaessig?
  Groesse  - Ergebnisgroesse

Aufruf:
  python3 tools/bench_scan.py /tmp/ultrascan-tests [szene ...]
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time

import cv2
import numpy as np

HIER = os.path.dirname(os.path.abspath(__file__))
WURZEL = os.path.abspath(os.path.join(HIER, ".."))
sys.path.insert(0, WURZEL)


def lade(name, pfad):
    spec = importlib.util.spec_from_loader(
        name, importlib.machinery.SourceFileLoader(name, pfad))
    modul = importlib.util.module_from_spec(spec)
    sys.modules[name] = modul
    spec.loader.exec_module(modul)
    return modul


lade("scanner", os.path.join(WURZEL, "scanner"))
neu = lade("wrapper_neu", os.path.join(WURZEL, "scan_wrapper.py"))

# alten Wrapper aus Git holen
alt_quelle = subprocess.run(
    ["git", "-C", WURZEL, "show", "HEAD:scan_wrapper.py"],
    capture_output=True, text=True, check=True).stdout
tmp = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
tmp.write(alt_quelle)
tmp.close()
alt = lade("wrapper_alt", tmp.name)


def textzeilen(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    f = 700 / max(g.shape)
    if f < 1:
        g = cv2.resize(g, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    t = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                              cv2.THRESH_BINARY_INV, 41, 12)
    zeilen = cv2.dilate(t, np.ones((3, max(3, int(0.05 * g.shape[1]))), np.uint8))
    cnts, _ = cv2.findContours(zeilen, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    gut = [cv2.boundingRect(c) for c in cnts
           if cv2.boundingRect(c)[2] > 0.25 * g.shape[1]
           and cv2.boundingRect(c)[3] < 0.09 * g.shape[0]]
    return t, gut


def versatz(img):
    """Misst genau das, was der Nutzer als "alles verrutscht" sieht:
    wandert der linke Textrand von Zeile zu Zeile?

    Rueckgabe: (Streuung des linken Randes in % der Breite,
                Restschraeglage des Textblocks in Grad).
    """
    _, zeilen = textzeilen(img)
    if len(zeilen) < 5:
        return 0.0, 0.0
    w = 700.0 * img.shape[1] / max(img.shape[:2])
    xs = np.array([r[0] for r in zeilen], float)
    ys = np.array([r[1] + r[3] / 2.0 for r in zeilen], float)
    streu = float(np.std(xs) / max(w, 1) * 100)
    steig = np.polyfit(ys, xs, 1)[0]
    return streu, float(np.degrees(np.arctan(steig)))


def masse(img):
    t, zeilen = textzeilen(img)
    profil = t.sum(axis=1).astype(np.float64)
    guete = 0.0
    if profil.sum() > 0:
        profil /= profil.mean() + 1e-9
        guete = float(np.var(profil))
    streu, grad = versatz(img)
    return {"zeilen": len(zeilen), "guete": guete, "tinte": float(t.mean()),
            "streu": streu, "grad": grad, "h": img.shape[0], "w": img.shape[1]}


def main():
    ordner = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ultrascan-tests"
    nur = set(sys.argv[2:])
    faelle = json.load(open(os.path.join(ordner, "faelle.json")))
    if nur:
        faelle = [f for f in faelle if f["name"] in nur]

    print(f"{'Szene':<20} {'Var':<4} {'Rand%':>6} {'Schraeg':>8} "
          f"{'Zeilen':>6} {'Guete':>6} {'Groesse':>11} {'s':>5}")
    summe = {"alt": [0, 0.0, 0.0, 0.0], "neu": [0, 0.0, 0.0, 0.0]}
    for f in faelle:
        img = cv2.imread(os.path.join(ordner, f["name"] + ".png"))
        ergebnisse = {}
        for kennung, modul, hinweis in (("alt", alt, None), ("neu", neu, None)):
            t0 = time.perf_counter()
            try:
                if kennung == "alt":
                    out, info = modul.scan_bgr(img)
                else:
                    out, info = modul.scan_bgr(img, hinweis)
            except Exception as fehler:            # noqa: BLE001
                print(f"{f['name']:<20} {kennung:<10} FEHLER {fehler}")
                continue
            dauer = time.perf_counter() - t0
            m = masse(out)
            ergebnisse[kennung] = m
            summe[kennung][0] += m["zeilen"]
            summe[kennung][1] += m["guete"]
            summe[kennung][2] += dauer
            summe[kennung][3] += m["streu"]
            print(f"{f['name']:<20} {kennung:<4} {m['streu']:>6.2f} "
                  f"{m['grad']:>+8.2f} {m['zeilen']:>6} {m['guete']:>6.1f} "
                  f"{m['w']}x{m['h']:<6} {dauer:>5.1f}")
            cv2.imwrite(os.path.join(ordner, f"{f['name']}_scan_{kennung}.png"), out)
    print("-" * 74)
    for k in ("alt", "neu"):
        print(f"{k}: Randstreuung gesamt {summe[k][3]:.2f}%  Zeilen "
              f"{summe[k][0]}  Guete {summe[k][1]:.1f}  Zeit {summe[k][2]:.1f}s")


if __name__ == "__main__":
    main()
