#!/usr/bin/env python3
"""Vergleichsmessung: die ALTE Erkennung (scanner.find_rough_quad) auf
denselben Testszenen wie tools/bench_detect.js.

Aufruf:  python3 tools/bench_scanner.py /tmp/ultrascan-tests
"""
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
    start = int(np.argmin(q.sum(axis=1)))
    return np.roll(q, -start, axis=0)


def fehler(a, b, diag):
    A, B = ordne(a), ordne(b)
    d = np.linalg.norm(A - B, axis=1)
    return 100 * d.mean() / diag, 100 * d.max() / diag


def main():
    ordner = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ultrascan-tests"
    faelle = json.load(open(os.path.join(ordner, "faelle.json")))
    treffer = 0
    nichts = 0
    zeit = 0.0
    print("Szene                 Treffer  Fehler%   max%    ms")
    for f in faelle:
        img = cv2.imread(os.path.join(ordner, f["name"] + ".png"))
        diag = float(np.hypot(f["breite"], f["hoehe"]))
        t0 = time.perf_counter()
        quad = scanner.find_rough_quad(img)
        if quad is not None:
            quad = scanner.refine_edges(img, quad)
        ms = (time.perf_counter() - t0) * 1000
        zeit += ms
        if quad is None:
            nichts += 1
            print(f"{f['name']:<21} NEIN        -      -   {ms:6.1f}")
            continue
        m, mx = fehler(quad, f["ecken"], diag)
        if m < 2.0:
            treffer += 1
        print(f"{f['name']:<21} {'JA ' if m < 2.0 else 'weit'}  "
              f"{m:7.2f} {mx:6.2f} {ms:7.1f}")
    print("-" * 62)
    print(f"Treffer: {treffer} / {len(faelle)}   nichts gefunden: {nichts}   "
          f"Zeit/Bild: {zeit / len(faelle):.0f} ms")


if __name__ == "__main__":
    main()
