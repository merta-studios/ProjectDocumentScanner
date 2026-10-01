#!/usr/bin/env python3
"""Live-Messung fuer die ALTE Erkennung (scanner.find_rough_quad) auf
denselben Sucher-Frames wie tools/bench_live.js.

Aufruf:  python3 tools/bench_live_scanner.py /tmp/ultrascan-tests
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import time

import cv2
import numpy as np

HIER = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_loader(
    "scanner", importlib.machinery.SourceFileLoader(
        "scanner", os.path.join(HIER, "..", "scanner")))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


def ordne(q):
    q = np.asarray(q, np.float64)
    mitte = q.mean(axis=0)
    idx = np.argsort(np.arctan2(q[:, 1] - mitte[1], q[:, 0] - mitte[0]))
    q = q[idx]
    return np.roll(q, -int(np.argmin(q.sum(axis=1))), axis=0)


def main():
    ordner = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ultrascan-tests"
    szenen = json.load(open(os.path.join(ordner, "live.json")))
    gf = gframes = 0
    gfehler = gzitter = gzeit = 0.0
    print("Szene                 Fund   Fehler%  Zittern%  ms")
    for sz in szenen:
        diag = float(np.hypot(sz["breite"], sz["hoehe"]))
        quads, zeit, fund = [], 0.0, 0
        for name in sz["frames"]:
            img = cv2.imread(os.path.join(ordner, name + ".png"))
            t0 = time.perf_counter()
            q = scanner.find_rough_quad(img)
            zeit += (time.perf_counter() - t0) * 1000
            gframes += 1
            if q is not None:
                fund += 1
                gf += 1
                quads.append(ordne(q))
        fehler = zitter = 0.0
        if quads:
            soll = ordne(sz["ecken"])
            fehler = float(np.mean([np.linalg.norm(q - soll, axis=1).mean()
                                    for q in quads]))
            stapel = np.array(quads)
            zitter = float(np.mean(np.sqrt(
                ((stapel - stapel.mean(axis=0)) ** 2).sum(axis=2).mean(axis=0))))
        gfehler += 100 * fehler / diag
        gzitter += 100 * zitter / diag
        gzeit += zeit / len(sz["frames"])
        print(f"{sz['name']:<21} {fund}/{len(sz['frames'])}   "
              f"{100 * fehler / diag:7.2f} {100 * zitter / diag:9.2f} "
              f"{zeit / len(sz['frames']):6.1f}")
    n = len(szenen)
    print("-" * 62)
    print(f"Fundrate {100 * gf / gframes:.0f} %   mittlerer Fehler "
          f"{gfehler / n:.2f} %   mittleres Zittern {gzitter / n:.2f} %   "
          f"{gzeit / n:.1f} ms/Frame")


if __name__ == "__main__":
    main()
