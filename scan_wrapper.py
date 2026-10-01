"""
Wrapper fuer das Ultra-Scan System (Datei "scanner" im Repo).

WICHTIG: Diese Datei VERAENDERT NICHTS an der Original-Pipeline.
Sie importiert das Original-Modul nur und ruft dessen Funktionen in exakt
der Reihenfolge auf, die der Hauptlauf scan() in der Originaldatei vorsieht.
Einziger Unterschied: statt Datei-Ein-/Ausgabe (imread/imwrite) und dem
Vergleichsbild gibt sie das fertige Hybrid-Ergebnis als NumPy-Array zurueck
- so, wie es die Web-App (Pyodide im Browser) braucht.

Die Originaldatei heisst "scanner" (ohne .py). Im Browser wird sie von der
Web-App unveraendert als scanner.py in das virtuelle Pyodide-Dateisystem
kopiert, damit sie importierbar ist. Die Datei im Repository bleibt
byte-identisch.
"""
import numpy as np
import cv2

import scanner  # die Original-Pipeline, unveraendert


def scan_bgr(src):
    """Kompletter Hauptlauf der Original-Pipeline auf einem BGR-Bild.

    Entspricht Schritt fuer Schritt scanner.scan(), nur ohne Datei-I/O und
    ohne das Vergleichsbild. Rueckgabe: (hybrid_bgr, info_dict).
    info_dict enthaelt u.a. "dokument_erkannt" (bool) und "meldungen" (Liste
    deutscher Statuszeilen fuer die Oberflaeche).
    """
    meldungen = []
    info = {"dokument_erkannt": False, "meldungen": meldungen}

    rough = scanner.find_rough_quad(src)
    refined = scanner.refine_edges(src, rough) if rough is not None else None
    info["dokument_erkannt"] = rough is not None
    if rough is None:
        meldungen.append("Kein Dokument-Viereck erkannt - das ganze Bild "
                         "wird verarbeitet.")

    warped = scanner.warp(src, refined if refined is not None else rough) \
        if rough is not None else src.copy()

    warped, bars = scanner.crop_black_bars(warped)
    if sum(bars):
        meldungen.append("Schwarze Balken erkannt und entfernt.")

    warped, gx_ = scanner.crop_book_gutter(warped)
    if gx_ >= 0:
        meldungen.append("Buchfalz erkannt - rechte Seite abgeschnitten.")

    warped, curve_amp = scanner.flatten_curvature(warped)
    if curve_amp:
        meldungen.append("Wellen-Glaettung: Kruemmung bis "
                         f"{curve_amp:.1f}px begradigt.")

    if gx_ >= 0:   # nur Buchseiten: Raender begradigen + Stauchung ausgleichen
        warped, mdev = scanner.dewarp_book_margins(warped)
        if mdev:
            meldungen.append("Rand-Entzerrung: Textraender um bis zu "
                             f"{mdev:.1f}px begradigt.")
        warped, sfac = scanner.decompress_book_x(warped)
        if sfac > 1.0:
            meldungen.append("Falz-Entstauchung: Buchstaben bis Faktor "
                             f"{sfac:.2f} verbreitert.")
        warped, lcut = scanner.balance_left_margin(warped)
        if lcut:
            meldungen.append(f"Linker Leerrand um {lcut}px gekuerzt.")

    # Drehung + Scherung MESSEN, dann in EINER Matrix anwenden
    # (identisch zum Original-Hauptlauf)
    Hh, Ww = warped.shape[:2]
    angle = scanner.deskew_by_text(warped)
    Mrot = cv2.getRotationMatrix2D((Ww / 2, Hh / 2), angle, 1.0) if angle \
        else np.array([[1, 0, 0], [0, 1, 0]], np.float64)
    probe = cv2.warpAffine(warped, Mrot, (Ww, Hh),
                           flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REPLICATE) if angle else warped
    shear = scanner.shear_level_lines(probe)
    if angle or shear:
        Msh = np.array([[1, 0, 0], [-shear, 1, shear * Ww / 2]], np.float64)
        A = (np.vstack([Msh, [0, 0, 1]]) @ np.vstack([Mrot, [0, 0, 1]]))[:2]
        warped = cv2.warpAffine(warped, A, (Ww, Hh), flags=cv2.INTER_CUBIC,
                                borderMode=cv2.BORDER_REPLICATE)
        meldungen.append(f"Begradigung: Drehung {angle:+.1f} Grad, "
                         f"Scherung {shear:+.4f}.")

    bw = scanner.mode_bw_smart(warped, book=(gx_ >= 0))
    clean0 = scanner.auto_clean(warped)
    hybrid = scanner.mode_hybrid(clean0, bw, scale=2, orig=warped)

    return hybrid, info


def scan_rgba(rgba_flat, hoehe, breite):
    """Einstiegspunkt fuer die Web-App (Pyodide).

    Nimmt flache RGBA-Bytes (so liefert sie ein <canvas> im Browser),
    laesst die komplette Original-Pipeline laufen und gibt
    (rgba_bytes, hoehe, breite, info_dict) des Hybrid-Scans zurueck.
    """
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    hybrid, info = scan_bgr(bgr)
    out = cv2.cvtColor(hybrid, cv2.COLOR_BGR2RGBA)
    h, w = out.shape[:2]
    return out.tobytes(), h, w, info
