"""
Wrapper fuer das Ultra-Scan System (Datei "scanner" im Repo).

WICHTIG: Diese Datei VERAENDERT NICHTS an der Original-Pipeline.
Sie importiert das Original-Modul nur und ruft dessen Funktionen auf.
Einziger Unterschied zum Original-Hauptlauf scan(): statt Datei-Ein-/Ausgabe
(imread/imwrite) und dem Vergleichsbild gibt sie das fertige Hybrid-Ergebnis
als NumPy-Array zurueck - so, wie es die Web-App (Pyodide im Browser)
braucht.

Zusaetzlich - und das ist der Unterschied zu frueher - entscheidet dieser
Wrapper BEWUSSTER, welche der geometrischen Korrekturschritte wirklich
angewendet werden:

  * Jeder Schritt, der Bildinhalt verschiebt (Buchfalz-Schnitt,
    Wellen-Glaettung, Drehung/Scherung), wird GEMESSEN und nur behalten,
    wenn er das Ergebnis nachweislich verbessert. Sonst wird er verworfen.
  * Drehung und Scherung werden auf eine VERGROESSERTE Leinwand gerechnet.
    Vorher wurde in die gleiche Bildgroesse gedreht - dabei rutschten die
    Ecken aus dem Bild, Inhalt ging verloren und die Raender verschmierten.
  * Das Dokument-Viereck darf von aussen (Live-Erkennung in detect.js)
    mitgegeben werden. Es wird dann nur noch mit scanner.refine_edges()
    nachgezogen. Dadurch sitzt der Scan genau auf dem Rahmen, den der
    Nutzer im Sucher gesehen hat.

Die Originaldatei heisst "scanner" (ohne .py). Im Browser wird sie von der
Web-App unveraendert als scanner.py in das virtuelle Pyodide-Dateisystem
kopiert, damit sie importierbar ist. Die Datei im Repository bleibt
byte-identisch.
"""
import numpy as np
import cv2

import scanner  # die Original-Pipeline, unveraendert


# ===========================================================================
# Hilfsmittel: Messen statt Hoffen
# ===========================================================================
def _klein(img, kante=700):
    h, w = img.shape[:2]
    f = kante / max(h, w)
    if f >= 1.0:
        return img
    return cv2.resize(img, (max(1, int(w * f)), max(1, int(h * f))),
                      interpolation=cv2.INTER_AREA)


def _textmaske(img):
    g = cv2.cvtColor(_klein(img), cv2.COLOR_BGR2GRAY)
    return cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, 41, 12)


def zeilen_guete(img):
    """Wie sauber liegen die Textzeilen waagerecht?

    Mass: Schaerfe des Zeilen-Profils (Summe je Bildzeile). Liegen die
    Zeilen exakt waagerecht, ist das Profil ein Kamm mit tiefen Taelern ->
    hohe Varianz. Sind sie schief oder gewellt, verschmieren die Taeler.
    Normiert auf die Tintenmenge, damit sich Bilder vergleichen lassen.
    """
    txt = _textmaske(img)
    profil = txt.sum(axis=1).astype(np.float64)
    if profil.sum() < 1e-6:
        return 0.0
    profil /= profil.mean() + 1e-9
    return float(np.var(profil))


def tintenmaske(img, kante=700):
    """Textmaske, die auf Schatten und Beleuchtung NICHT reagiert.

    Ein senkrechter Black-Hat findet nur dunkle Strukturen, die kuerzer
    sind als ein paar Zeilenhoehen. Ein durchgehender dunkler Streifen
    (Falz-Schatten, Tischkante) erzeugt damit keine Tinte - genau das
    hatte frueher den Falz-Schnitt in die Irre gefuehrt.
    """
    g = cv2.cvtColor(_klein(img, kante), cv2.COLOR_BGR2GRAY)
    k = max(9, (int(round(g.shape[0] * 0.035)) | 1))
    bh = cv2.morphologyEx(g, cv2.MORPH_BLACKHAT, np.ones((k, 1), np.uint8))
    return (bh > 18).astype(np.uint8)


def tinte(img):
    return float(tintenmaske(img).mean())


def falz_echt(warped, gx):
    """Darf an Spalte gx geschnitten werden?

    Ein echter Buchfalz liegt in einer LUECKE zwischen zwei Textbloecken:
    links endet die Seite mit ihrem Rand, dann kommt das dunkle Tal.
    Ein Schatten quer ueber einer einzelnen Seite liegt dagegen mitten im
    Text - dort darf nie geschnitten werden, sonst fehlt das halbe Blatt
    ("alles verrutscht").
    """
    br = warped.shape[1]
    if gx <= 0 or gx >= br:
        return False, "Falz-Spalte unbrauchbar."
    if (br - gx) / float(br) > 0.45:
        return False, "Falz-Verdacht verworfen - haette fast das halbe Blatt gekostet."

    t = tintenmaske(warped)
    H, W = t.shape
    sgx = int(round(gx * W / float(br)))
    spalten = cv2.GaussianBlur((t.sum(axis=0) / float(H)).astype(np.float32)
                               .reshape(1, -1), (0, 0), 2).ravel()
    mitte = float(np.median(spalten[int(0.05 * W):int(0.95 * W)]))
    if mitte < 1e-4:
        return False, "Falz-Verdacht verworfen - zu wenig Text zum Pruefen."
    a = max(0, sgx - int(0.02 * W))
    b = min(W, sgx + int(0.02 * W) + 1)
    luecke = float(spalten[a:b].mean()) / mitte
    if luecke > 0.10:
        return False, "Falz-Verdacht verworfen - dort steht Text, kein Falz."
    return True, "Buchfalz erkannt - angeschnittene Nachbarseite entfernt."


# ===========================================================================
# Viereck: Hinweis von aussen pruefen und nachziehen
# ===========================================================================
def _ordne_robust(p):
    """Ecken im Uhrzeigersinn ab oben links.

    scanner.order_pts() sortiert ueber Summe/Differenz der Koordinaten -
    das ist bei stark gedrehten Blaettern (> 45 Grad) nicht eindeutig.
    Hier wird nach Winkel um den Schwerpunkt sortiert; das stimmt immer.
    """
    p = np.asarray(p, dtype=np.float64).reshape(4, 2)
    mitte = p.mean(axis=0)
    winkel = np.arctan2(p[:, 1] - mitte[1], p[:, 0] - mitte[0])
    p = p[np.argsort(winkel)]
    start = int(np.argmin(p.sum(axis=1)))
    return np.roll(p, -start, axis=0)


def _flaeche(p):
    p = np.asarray(p, dtype=np.float64).reshape(4, 2)
    return float(abs(cv2.contourArea(p.astype(np.float32))))


def _quad_plausibel(quad, h, w):
    if quad is None:
        return False
    q = np.asarray(quad, dtype=np.float64)
    if q.shape != (4, 2) or not np.all(np.isfinite(q)):
        return False
    rand = 0.06 * float(np.hypot(w, h))
    if q[:, 0].min() < -rand or q[:, 0].max() > w + rand:
        return False
    if q[:, 1].min() < -rand or q[:, 1].max() > h + rand:
        return False
    if _flaeche(_ordne_robust(q)) < 0.04 * w * h:
        return False
    o = _ordne_robust(q)
    for i in range(4):
        a, b = o[i], o[(i + 1) % 4]
        if np.linalg.norm(b - a) < 0.05 * min(w, h):
            return False
    return True


def viereck_bestimmen(src, hinweis=None):
    """Liefert (quad, quelle). quad ist None, wenn nichts gefunden wurde."""
    h, w = src.shape[:2]
    if hinweis is not None and _quad_plausibel(hinweis, h, w):
        grob = _ordne_robust(hinweis)
        fein = scanner.refine_edges(src, grob)
        if fein is not None and _quad_plausibel(fein, h, w):
            # Das Nachziehen darf die Ecken nur korrigieren, nicht verlegen.
            weg = np.linalg.norm(_ordne_robust(fein) - grob, axis=1).max()
            if weg < 0.07 * float(np.hypot(w, h)):
                return _ordne_robust(fein), "hinweis+refine"
        return grob, "hinweis"

    grob = scanner.find_rough_quad(src)
    if grob is None:
        return None, "nichts"
    fein = scanner.refine_edges(src, grob)
    if fein is not None and _quad_plausibel(fein, h, w):
        return _ordne_robust(fein), "pipeline+refine"
    return _ordne_robust(grob), "pipeline"


def _warp_robust(img, quad):
    """Perspektiv-Entzerrung exakt nach scanner.warp() - nur mit der
    robusten Eckreihenfolge. Wird ausschliesslich dann benutzt, wenn
    scanner.order_pts() eine andere (falsche) Reihenfolge liefern wuerde,
    also bei stark gedrehten Blaettern."""
    tl, tr, br, bl = _ordne_robust(quad)
    W = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    H = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    W, H = max(W, 8), max(H, 8)
    M = cv2.getPerspectiveTransform(
        np.array([tl, tr, br, bl], np.float32),
        np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32))
    out = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC)
    ix, iy = int(0.006 * W), int(0.006 * H)
    return out[iy:H - iy, ix:W - ix]


def entzerren(src, quad):
    """scanner.warp(), wenn dessen Eckreihenfolge stimmt - sonst robust."""
    if quad is None:
        return src.copy()
    eigen = _ordne_robust(quad)
    original = scanner.order_pts(np.asarray(quad, dtype=np.float64))
    if np.allclose(np.asarray(original, dtype=np.float64), eigen, atol=1.0):
        return scanner.warp(src, np.asarray(quad, dtype=np.float64))
    return _warp_robust(src, quad)


# ===========================================================================
# Drehung + Scherung auf VERGROESSERTER Leinwand (nichts faellt raus)
# ===========================================================================
def _affin_gross(img, A, grenze=1.35):
    """Wendet eine 2x3-Matrix an und VERGROESSERT dabei die Leinwand, bis
    alle vier Ecken hineinpassen.

    Genau hier lag der Hauptgrund fuer "alles verrutscht": frueher wurde
    in die unveraenderte Bildgroesse gedreht - die Ecken des Blattes
    fielen heraus, der Rest schmierte ueber den Rand (BORDER_REPLICATE).
    """
    Hh, Ww = img.shape[:2]
    ecken = np.array([[0, 0], [Ww, 0], [Ww, Hh], [0, Hh]], np.float64)
    neu = (A[:, :2] @ ecken.T).T + A[:, 2]
    x0, y0 = neu.min(axis=0)
    x1, y1 = neu.max(axis=0)
    Wn = int(np.ceil(min(x1 - x0, Ww * grenze)))
    Hn = int(np.ceil(min(y1 - y0, Hh * grenze)))
    A2 = A.copy()
    A2[0, 2] -= x0
    A2[1, 2] -= y0
    return cv2.warpAffine(img, A2, (max(Wn, 8), max(Hn, 8)),
                          flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_REPLICATE)


def drehen(warped):
    """Rein starre Drehung (Original-Messung scanner.deskew_by_text).

    Laeuft VOR der Wellen-Glaettung: eine schraege Seite ist sonst fuer
    flatten_curvature eine "Kruemmung", die es mit einem Polynom
    wegrechnet - das verzieht die Buchstaben, statt das Blatt zu drehen.
    """
    winkel = scanner.deskew_by_text(warped)
    if not winkel:
        return warped, 0.0, False
    Hh, Ww = warped.shape[:2]
    M = cv2.getRotationMatrix2D((Ww / 2.0, Hh / 2.0), winkel, 1.0)
    return _affin_gross(warped, M), float(winkel), True


def scheren(warped):
    """Rest-Scherung (Original-Messung scanner.shear_level_lines),
    begrenzt und ebenfalls auf wachsender Leinwand."""
    scherung = float(np.clip(scanner.shear_level_lines(warped), -0.035, 0.035))
    if not scherung:
        return warped, 0.0, False
    Ww = warped.shape[1]
    M = np.array([[1, 0, 0], [-scherung, 1, scherung * Ww / 2.0]], np.float64)
    return _affin_gross(warped, M), scherung, True


# ===========================================================================
# Hauptlauf
# ===========================================================================
def scan_bgr(src, hinweis=None, streng=False):
    """Kompletter Hauptlauf der Original-Pipeline auf einem BGR-Bild.

    Rueckgabe: (hybrid_bgr, info_dict). info_dict enthaelt
    "dokument_erkannt" (bool) und "meldungen" (deutsche Statuszeilen).
    Mit streng=True wird nichts verarbeitet, wenn kein Dokument gefunden
    wurde (die App zeigt dann eine Meldung).
    """
    meldungen = []
    info = {"dokument_erkannt": False, "meldungen": meldungen}

    quad, quelle = viereck_bestimmen(src, hinweis)
    info["dokument_erkannt"] = quad is not None
    info["quad_quelle"] = quelle
    if quad is None:
        if streng:
            return None, info
        meldungen.append("Kein Dokument-Viereck erkannt - das ganze Bild "
                         "wird verarbeitet.")
    else:
        info["quad"] = [[float(a), float(b)] for a, b in quad]

    warped = entzerren(src, quad)

    # ---- schwarze Balken (Smartboard-Fotos) - nur plausible Schnitte
    vorher = warped.shape[0] * warped.shape[1]
    kandidat, bars = scanner.crop_black_bars(warped)
    if sum(bars):
        if kandidat.size and kandidat.shape[0] * kandidat.shape[1] > 0.45 * vorher:
            warped = kandidat
            meldungen.append("Schwarze Balken erkannt und entfernt.")
        else:
            meldungen.append("Balken-Schnitt verworfen (haette zu viel "
                             "abgeschnitten).")

    # ---- Buchfalz: nur schneiden, wenn wirklich nur ein Streifen weggeht
    gx_ = -1
    kandidat, gx = scanner.crop_book_gutter(warped)
    if gx >= 0:
        erlaubt, grund = falz_echt(warped, gx)
        if erlaubt and kandidat.size:
            warped = kandidat
            gx_ = gx
        meldungen.append(grund)

    # ---- Drehung ZUERST: sonst haelt die Wellen-Glaettung eine schraege
    #      Seite fuer eine Kruemmung und verzieht den Text.
    vor = zeilen_guete(warped)
    kandidat, winkel, gemacht = drehen(warped)
    if gemacht:
        if zeilen_guete(kandidat) >= vor * 0.99:
            warped = kandidat
            meldungen.append(f"Blatt um {winkel:+.1f} Grad gerade gedreht.")
        else:
            meldungen.append("Drehung verworfen (haette den Text schiefer "
                             "gemacht).")

    # ---- Wellen-Glaettung: nur behalten, wenn die Zeilen gerader werden
    vor = zeilen_guete(warped)
    kandidat, curve_amp = scanner.flatten_curvature(warped)
    if curve_amp:
        if zeilen_guete(kandidat) >= vor * 1.02:
            warped = kandidat
            meldungen.append("Wellen-Glaettung: Kruemmung bis "
                             f"{curve_amp:.1f}px begradigt.")
        else:
            meldungen.append("Wellen-Glaettung verworfen (haette den Text "
                             "verzogen).")

    if gx_ >= 0:   # nur Buchseiten: Raender begradigen + Stauchung ausgleichen
        vor = zeilen_guete(warped)
        kandidat, mdev = scanner.dewarp_book_margins(warped)
        if mdev and zeilen_guete(kandidat) >= vor * 0.99:
            warped = kandidat
            meldungen.append("Rand-Entzerrung: Textraender um bis zu "
                             f"{mdev:.1f}px begradigt.")
        kandidat, sfac = scanner.decompress_book_x(warped)
        if sfac > 1.0:
            warped = kandidat
            meldungen.append("Falz-Entstauchung: Buchstaben bis Faktor "
                             f"{sfac:.2f} verbreitert.")
        kandidat, lcut = scanner.balance_left_margin(warped)
        if lcut and kandidat.shape[1] > 0.6 * warped.shape[1]:
            warped = kandidat
            meldungen.append(f"Linker Leerrand um {lcut}px gekuerzt.")

    # ---- Rest-Scherung zum Schluss
    vor = zeilen_guete(warped)
    kandidat, scherung, gemacht = scheren(warped)
    if gemacht:
        if zeilen_guete(kandidat) >= vor * 1.01:
            warped = kandidat
            meldungen.append(f"Scherung {scherung:+.4f} ausgeglichen.")
        else:
            meldungen.append("Scherung verworfen (haette den Text verzerrt).")

    bw = scanner.mode_bw_smart(warped, book=(gx_ >= 0))
    clean0 = scanner.auto_clean(warped)
    hybrid = scanner.mode_hybrid(clean0, bw, scale=2, orig=warped)

    return hybrid, info


def scan_rgba(rgba_flat, hoehe, breite, quad=None):
    """Einstiegspunkt fuer die Web-App (Pyodide)."""
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    hybrid, info = scan_bgr(bgr, quad)
    out = cv2.cvtColor(hybrid, cv2.COLOR_BGR2RGBA)
    h, w = out.shape[:2]
    return out.tobytes(), h, w, info


# ---------------------------------------------------------------------------
# Zusaetze fuer die Web-App "Ultra Scan"
# ---------------------------------------------------------------------------
def quad_aus_rgba(rgba_flat, hoehe, breite):
    """Live-Erkennung ueber die Original-Pipeline.

    Wird von der App nicht mehr benutzt (die Live-Erkennung laeuft in
    detect.js direkt im Browser und ist dort um ein Vielfaches schneller
    und ruhiger). Bleibt als Rueckfallebene / fuer Tests erhalten.
    """
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    quad = scanner.find_rough_quad(bgr)
    if quad is None:
        return None
    pts = scanner.order_pts(quad)
    return [[float(p[0]), float(p[1])] for p in pts]


def scan_rgba_streng(rgba_flat, hoehe, breite, quad=None):
    """Wie scan_rgba(), bricht aber ab, wenn kein Dokument erkannt wurde.

    Mit mitgegebenem Viereck (Live-Erkennung) gilt das Dokument als
    erkannt, sobald das Viereck plausibel ist - dann meldet die App nicht
    mehr faelschlich "Kein Dokument gefunden", obwohl im Sucher der Rahmen
    sauber auf dem Blatt lag.
    """
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    hybrid, info = scan_bgr(bgr, quad, streng=True)
    if hybrid is None:
        return None, 0, 0, info
    out = cv2.cvtColor(hybrid, cv2.COLOR_BGR2RGBA)
    h, w = out.shape[:2]
    return out.tobytes(), h, w, info
