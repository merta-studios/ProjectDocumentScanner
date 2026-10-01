#!/usr/bin/env python3
"""Vergleicht die ALTE und die NEUE Scan-Veredelung auf echten Fotos.

Die alte Pipeline (``scanner.mode_hybrid``) hat eine harte Tintenmaske auf
reinweissen Grund kopiert. Alles, was die Schwelle nicht erwischt hat,
wurde weiss: Loecher in Buchstaben, abgerissene duenne Striche, Bleistift
und Fotos komplett verschwunden. Die neue Veredelung in ``scan_wrapper.py``
arbeitet stattdessen in Halbtoenen.

Dieses Skript macht den Unterschied messbar UND sichtbar:

  Tinte     Anteil dunkler Pixel - bricht er ein, ist Text verloren gegangen
  Loecher   helle Inseln innerhalb von Buchstaben (euler-aehnlich gezaehlt)
  Papier    Anteil wirklich weisser Flaeche (hoeher = sauberer Scan)
  Kontrast  Standardabweichung in Textzeilen (hoeher = knackiger)

Aufruf (Server fuer tools/bench_fusion.mjs muss vorher gelaufen sein,
damit fusion.json existiert):

  python3 tools/hole_echtfotos.py /tmp/echtfotos
  node    tools/bench_fusion.mjs /tmp/echtfotos
  python3 tools/bench_veredelung.py /tmp/echtfotos

Schreibt Vorher/Nachher-Bilder nach <ordner>/vergleich/.
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("OpenCV fehlt. Zum Beispiel:  python3 -m venv /tmp/venv && "
             "/tmp/venv/bin/pip install opencv-python-headless")

WURZEL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def lade_wrapper():
    """scan_wrapper importieren - "scanner" hat keine .py-Endung.

    Die Datei "scanner" bleibt im Repository unveraendert; hier wird sie
    nur in einem temporaeren Ordner unter dem importierbaren Namen
    scanner.py gespiegelt. Genau dasselbe macht worker.js im Browser mit
    dem virtuellen Pyodide-Dateisystem.
    """
    tmp = tempfile.mkdtemp(prefix="ultrascan-")
    shutil.copy(os.path.join(WURZEL, "scanner"), os.path.join(tmp, "scanner.py"))
    shutil.copy(os.path.join(WURZEL, "scan_wrapper.py"),
                os.path.join(tmp, "scan_wrapper.py"))
    sys.path.insert(0, tmp)
    import scan_wrapper
    return scan_wrapper


def referenz_tinte(roh_bgr, kante=900):
    """Wo steht im UNbearbeiteten Ausschnitt ueberhaupt Tinte?

    Das ist der Massstab: Alles, was hier dunkel ist, muss im fertigen
    Scan noch zu sehen sein.

    Wichtig ist, WIE gemessen wird. Eine adaptive Schwelle waere unfair -
    die alte Pipeline benutzt selbst eine adaptive Schwelle und wuerde
    dafuer belohnt, dass sie dieselben Artefakte erzeugt. Stattdessen
    wird hier geschaetzt, wie hell das Papier an jeder Stelle WAERE, und
    Tinte ist, was deutlich dunkler ist. Das entspricht dem, was ein
    Mensch sieht - und ist von beiden Pipelines unabhaengig.
    """
    g = cv2.cvtColor(roh_bgr, cv2.COLOR_BGR2GRAY)
    f = kante / float(max(g.shape[:2]))
    if f < 1.0:
        g = cv2.resize(g, (max(1, round(g.shape[1] * f)),
                           max(1, round(g.shape[0] * f))),
                       interpolation=cv2.INTER_AREA)
    k = max(9, (min(g.shape[:2]) // 12) | 1)
    papier = cv2.morphologyEx(g, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    papier = cv2.medianBlur(papier, min(k, 99) | 1).astype(np.float32)
    maske = (g.astype(np.float32) < papier * 0.72).astype(np.uint8)
    maske = cv2.morphologyEx(maske, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    # Nur der KERN zaehlt. Am Rand jedes Buchstabens liegt ein weicher
    # Uebergang; wer den mitzaehlt, belohnt fettes Ausmalen.
    kern = cv2.erode(maske, np.ones((3, 3), np.uint8))
    if np.count_nonzero(kern) > 0.15 * np.count_nonzero(maske):
        maske = kern
    return maske > 0


def masse(bgr, tinte_soll):
    """Drei ehrliche Kennzahlen - genau das, was der Nutzer beurteilt.

    erhalten  Anteil der urspruenglichen Tinte, der im Ergebnis noch
              dunkel ist. Das ist die Zahl, um die es geht: die alte
              Pipeline hat Text weggeworfen.
    papier    mittlere Helligkeit dort, wo KEINE Tinte war (255 = perfekt
              sauberes Papier).
    trennung  Abstand Papier <-> Tinte in Graustufen (hoeher = knackiger).
    """
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    if g.shape[:2] != tinte_soll.shape[:2]:
        g = cv2.resize(g, (tinte_soll.shape[1], tinte_soll.shape[0]),
                       interpolation=cv2.INTER_AREA)
    hintergrund = ~tinte_soll
    if not tinte_soll.any():
        return 1.0, float(g.mean()), 0.0
    papier = float(g[hintergrund].mean()) if hintergrund.any() else 255.0
    # "Noch da" heisst: deutlich dunkler als das Papier ringsum. Eine
    # feste Schwelle wuerde reines Schwarz bevorzugen, obwohl ein
    # sauberes Grau genauso gut lesbar ist.
    erhalten = float((g[tinte_soll] < papier - 55.0).mean())
    trennung = papier - float(g[tinte_soll].mean())
    return erhalten, papier, trennung


def tafel(alt, neu, name, ziel):
    """Vorher/Nachher nebeneinander, gleich hoch skaliert."""
    H = 1000
    a = cv2.resize(alt, (max(1, int(H * alt.shape[1] / alt.shape[0])), H))
    n = cv2.resize(neu, (max(1, int(H * neu.shape[1] / neu.shape[0])), H))
    kopf = np.zeros((50, a.shape[1] + n.shape[1] + 12, 3), np.uint8)
    cv2.putText(kopf, "VORHER (alt)", (10, 36), 0, 1.0, (80, 80, 255), 2)
    cv2.putText(kopf, "NACHHER (neu)", (a.shape[1] + 22, 36), 0, 1.0, (80, 255, 80), 2)
    steg = np.full((H, 12, 3), 30, np.uint8)
    bild = np.vstack([kopf, np.hstack([a, steg, n])])
    cv2.imwrite(os.path.join(ziel, name + ".jpg"), bild,
                [cv2.IMWRITE_JPEG_QUALITY, 86])


def main():
    ordner = sys.argv[1] if len(sys.argv) > 1 else "/tmp/echtfotos"
    faelle = json.load(open(os.path.join(ordner, "faelle.json")))
    pfad_quads = os.path.join(ordner, "fusion.json")
    quads = json.load(open(pfad_quads)) if os.path.exists(pfad_quads) else {}
    if not quads:
        print("Hinweis: keine fusion.json - die Pipeline sucht selbst. "
              "Fuer den fairen Vergleich vorher tools/bench_fusion.mjs laufen lassen.")

    sw = lade_wrapper()
    ziel = os.path.join(ordner, "vergleich")
    os.makedirs(ziel, exist_ok=True)

    kopf = ("Foto                     Text erhalten    Papierweiss     "
            "Trennung      ms alt/neu")
    print(kopf)
    print("-" * len(kopf))

    summe = np.zeros(6)
    anzahl = 0
    for f in faelle:
        bild = cv2.imread(os.path.join(ordner, f["name"] + ".png"))
        if bild is None:
            continue
        hinweis = (quads.get(f["name"]) or {}).get("quad")

        roh, _ = sw.scan_bgr(bild, hinweis=hinweis, veredelung="roh")
        if roh is None:
            print(f["name"].ljust(24), "kein Dokument")
            continue
        soll = referenz_tinte(roh)

        t0 = time.time()
        alt, _ = sw.scan_bgr(bild, hinweis=hinweis, veredelung="original")
        ms_alt = (time.time() - t0) * 1000.0
        t0 = time.time()
        neu, _ = sw.scan_bgr(bild, hinweis=hinweis, veredelung="farbe")
        ms_neu = (time.time() - t0) * 1000.0
        if alt is None or neu is None:
            print(f["name"].ljust(24), "kein Dokument")
            continue

        ma, mn = masse(alt, soll), masse(neu, soll)
        tafel(alt, neu, f["name"], ziel)
        summe += np.array([ma[0], mn[0], ma[1], mn[1], ma[2], mn[2]])
        anzahl += 1

        print("%-24s %5.1f%% -> %5.1f%%   %5.1f -> %5.1f   %5.1f -> %5.1f   %4.0f/%4.0f"
              % (f["name"], ma[0] * 100, mn[0] * 100, ma[1], mn[1],
                 ma[2], mn[2], ms_alt, ms_neu))

    if anzahl:
        m = summe / anzahl
        print("-" * len(kopf))
        print("%-24s %5.1f%% -> %5.1f%%   %5.1f -> %5.1f   %5.1f -> %5.1f"
              % ("MITTEL", m[0] * 100, m[1] * 100, m[2], m[3], m[4], m[5]))
        print("")
        print("\"Text erhalten\" ist die entscheidende Zahl: Wie viel von der")
        print("Tinte des Originals steht noch im fertigen Scan?")
        print("")
        print("Die Zahlen sind ein Hinweis, kein Urteil. Eine harte Schwarz-Weiss-")
        print("Schwelle kann hier gut aussehen und trotzdem unlesbar sein, weil sie")
        print("Buchstaben zu Kloetzen verschmiert. Entscheidend sind die Bilder:")
        print(ziel)


if __name__ == "__main__":
    main()
