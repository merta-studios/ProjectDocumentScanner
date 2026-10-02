"""
Wrapper fuer das Ultra-Scan System (Datei "scanner" im Repo).

WICHTIG: Diese Datei VERAENDERT NICHTS an der Original-Pipeline.
Sie importiert das Original-Modul nur und ruft dessen Funktionen auf.
Einziger Unterschied zum Original-Hauptlauf scan(): statt Datei-Ein-/Ausgabe
(imread/imwrite) und dem Vergleichsbild gibt sie das fertige Hybrid-Ergebnis
als NumPy-Array zurueck - so, wie es die Web-App (Pyodide im Browser)
braucht.

Verbesserungen V4 (2026):
- UVDoc mit align_corners=True fuer gerade Tabellenlinien (uvdoc-onnx)
- Tabellen-Erkennung schuetzt vor "Tabelle verrutscht"
- Buch-Entzerrung nur wenn wirklich Buch, nicht bei Tabelle
- Veredelung schont Tabellenlinien (höhere Schwelle, Linienschutz)
- Textur- und Saettigungs-basierte Erkennung fuer weiss-auf-weiss (siehe detect.js)
"""

import numpy as np
import cv2
import scanner

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
    txt = _textmaske(img)
    profil = txt.sum(axis=1).astype(np.float64)
    if profil.sum() < 1e-6:
        return 0.0
    profil /= profil.mean() + 1e-9
    return float(np.var(profil))

def tintenmaske(img, kante=700):
    g = cv2.cvtColor(_klein(img, kante), cv2.COLOR_BGR2GRAY)
    k = max(9, (int(round(g.shape[0] * 0.035)) | 1))
    bh = cv2.morphologyEx(g, cv2.MORPH_BLACKHAT, np.ones((k, 1), np.uint8))
    return (bh > 18).astype(np.uint8)

def tinte(img):
    return float(tintenmaske(img).mean())

def falz_echt(warped, gx):
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

def _ordne_robust(p):
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

def _winkel_grad(v):
    """Richtung einer Kante in Grad, auf [-90, 90) normiert."""
    a = float(np.degrees(np.arctan2(v[1], v[0])))
    while a >= 90.0:
        a -= 180.0
    while a < -90.0:
        a += 180.0
    return a

def _geometrie_stufe(img, name, quad=None):
    """Messbare Geometrie fuer Diagnose, nicht als Geradeheits-Ersatz.

    Die vier Rasterecken sind absichtlich kein Dokumentnachweis. Bei einem
    Quad messen wir deshalb sowohl die Seitenrichtung als auch die vier
    Innenwinkel. Nach einem Warp ohne Quad werden die sichtbaren Konturen
    spaeter separat im Diagnoseprogramm vermessen.
    """
    h, w = img.shape[:2]
    eintrag = {"stufe": name, "hoehe": int(h), "breite": int(w)}
    if quad is None:
        return eintrag
    q = _ordne_robust(quad)
    kanten = q[np.arange(4)] - q[np.roll(np.arange(4), -1)]
    winkel = []
    for i in range(4):
        u = q[(i - 1) % 4] - q[i]
        v = q[(i + 1) % 4] - q[i]
        den = np.linalg.norm(u) * np.linalg.norm(v)
        c = float(np.dot(u, v) / den) if den > 1e-9 else 1.0
        winkel.append(float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0)))))
    eintrag.update({
        "quad": [[float(x), float(y)] for x, y in q],
        "seitenwinkel_grad": [round(_winkel_grad(v), 3) for v in kanten],
        "eckwinkel_grad": [round(x, 3) for x in winkel],
    })
    return eintrag

def viereck_bestimmen(src, hinweis=None):
    h, w = src.shape[:2]
    if hinweis is not None and _quad_plausibel(hinweis, h, w):
        # Der Hinweis kommt im echten App-Pfad bereits aus detect.js:
        # dort werden Kandidaten bewertet und auf hochaufgeloesten Kanten
        # verfeinert. Ein zweites, unbeschraenktes scanner.refine_edges()
        # kann auf Text-, Tisch- oder Schattenkanten springen und damit ein
        # zuvor richtiges Quad verschlechtern. Deshalb hier nur normieren,
        # plausibilisieren und einmal warpen; die Python-Suche bleibt der
        # Fallback fuer Aufrufe ohne Hinweis.
        return _ordne_robust(hinweis), "hinweis_js"

    grob = scanner.find_rough_quad(src)
    if grob is None:
        return None, "nichts"
    fein = scanner.refine_edges(src, grob)
    if fein is not None and _quad_plausibel(fein, h, w):
        return _ordne_robust(fein), "pipeline+refine"
    return _ordne_robust(grob), "pipeline"

def _warp_robust(img, quad):
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
    if quad is None:
        return src.copy()
    # Im Vollscan darf die Eckreihenfolge nicht zwischen scanner.order_pts
    # und _ordne_robust wechseln. Gerade stark gedrehte oder perspektivische
    # Quads können mit sum/diff falsch zugeordnet werden; dann werden obere
    # und untere Kante vertauscht oder der Warp zieht Inhalt schief.
    # Der Wrapper verwendet deshalb immer dieselbe robuste Reihenfolge.
    return _warp_robust(src, _ordne_robust(quad))

def _affin_gross(img, A, grenze=1.35):
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
    winkel = scanner.deskew_by_text(warped)
    if not winkel:
        return warped, 0.0, False
    Hh, Ww = warped.shape[:2]
    M = cv2.getRotationMatrix2D((Ww / 2.0, Hh / 2.0), winkel, 1.0)
    return _affin_gross(warped, M), float(winkel), True

def scheren(warped):
    scherung = float(np.clip(scanner.shear_level_lines(warped), -0.035, 0.035))
    if not scherung:
        return warped, 0.0, False
    Ww = warped.shape[1]
    M = np.array([[1, 0, 0], [-scherung, 1, scherung * Ww / 2.0]], np.float64)
    return _affin_gross(warped, M), scherung, True

def _ungerade(n, mindest=3):
    n = int(round(n))
    if n < mindest:
        n = mindest
    return n | 1

def beleuchtungsfeld(gray):
    h, w = gray.shape[:2]
    lang = max(h, w)
    f = 480.0 / lang
    if f < 1.0:
        klein = cv2.resize(gray, (max(8, int(w * f)), max(8, int(h * f))),
                           interpolation=cv2.INTER_AREA)
    else:
        klein = gray.copy()
    kh, kw = klein.shape[:2]
    k = _ungerade(max(kh, kw) * 0.055, 5)
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    feld = cv2.morphologyEx(klein, cv2.MORPH_CLOSE, kern)
    feld = cv2.medianBlur(feld, _ungerade(min(k, 31), 3))
    feld = cv2.bilateralFilter(feld, 9, 18, max(3.0, 0.05 * max(kh, kw)))
    feld = cv2.GaussianBlur(feld, (0, 0), max(1.0, 0.010 * max(kh, kw)))
    return cv2.resize(feld, (w, h), interpolation=cv2.INTER_LINEAR)

def beleuchtung_ausgleichen(bgr, grenze=3.2, dunkler=2.4):
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    feld = beleuchtungsfeld(gray).astype(np.float32)
    ziel = float(np.percentile(feld, 92))
    if ziel < 1.0:
        return bgr.copy()
    gewinn = ziel / np.maximum(feld, 1.0)
    gewinn = np.clip(gewinn, 1.0 / dunkler, grenze)
    out = bgr.astype(np.float32) * gewinn[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)

def _weisspunkt(bgr, abweichung=0.22):
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    schwelle = float(np.percentile(g, 65.0))
    papier = g >= schwelle
    if papier.sum() < 50:
        papier = np.ones_like(g, dtype=bool)
    weiss = []
    for c in range(3):
        werte = bgr[:, :, c][papier]
        weiss.append(float(np.percentile(werte, 82.0)))
    mittel = max(sum(weiss) / 3.0, 1.0)
    unten, oben = mittel * (1.0 - abweichung), mittel * (1.0 + abweichung)
    weiss = [min(max(w, unten), oben) for w in weiss]
    weiss = [max(w, 50.0) for w in weiss]
    return weiss, mittel

def tonwert_spreizen(bgr, staerke=1.0):
    weiss, mittel = _weisspunkt(bgr)
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    schwarz = float(np.percentile(g, 0.4))
    schwarz = min(schwarz, mittel - 60.0)
    schwarz = max(schwarz, 0.0)
    x = bgr.astype(np.float32)
    for c in range(3):
        x[:, :, c] = (x[:, :, c] - schwarz) * (255.0 / max(weiss[c] - schwarz, 1.0))
    hoch = np.clip((x - 228.0) / 32.0, 0.0, 1.0)
    x = x * (1.0 - hoch) + (228.0 + 27.0 * np.sqrt(hoch)) * hoch
    if staerke != 1.0:
        x = bgr.astype(np.float32) * (1.0 - staerke) + x * staerke
    return np.clip(x, 0, 255).astype(np.uint8)

def farbrauschen_daempfen(bgr):
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    a = cv2.medianBlur(a, 5)
    b = cv2.medianBlur(b, 5)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

def hintergrund_weissen(bgr, start=197.0, ende=242.0, tabelle=False):
    """Papier wirklich weiss machen - mit Tabellen-Schutz."""
    # Bei Tabelle: hoehere Schwelle, damit helle Linien bleiben
    if tabelle:
        start = max(start, 205.0)
        ende = max(ende, 248.0)
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    chroma = (bgr.max(axis=2).astype(np.int16) -
              bgr.min(axis=2).astype(np.int16)).astype(np.float32)
    # Linienschutz: erkenne lange gerade Linien und schuetze sie
    linien_maske = None
    if tabelle:
        try:
            # Canny + Hough fuer Linien-Schutz
            edges = cv2.Canny(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), 50, 150)
            lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=70,
                                    minLineLength=int(0.15 * bgr.shape[1]),
                                    maxLineGap=10)
            if lines is not None:
                linien_maske = np.zeros(g.shape, dtype=np.uint8)
                for l in lines:
                    x1,y1,x2,y2 = l[0]
                    cv2.line(linien_maske, (x1,y1), (x2,y2), 255, 2)
                linien_maske = linien_maske.astype(np.float32) / 255.0
        except Exception:
            linien_maske = None

    t = np.clip((g - start) / max(ende - start, 1.0), 0.0, 1.0)
    t = t * t * (3.0 - 2.0 * t)
    t *= np.clip(1.0 - (chroma - 26.0) / 40.0, 0.0, 1.0)
    if linien_maske is not None:
        # Linien nicht weissen
        t = t * (1 - linien_maske * 0.9)
    t = t[..., None]
    out = bgr.astype(np.float32) * (1.0 - t) + 255.0 * t
    return np.clip(out, 0, 255).astype(np.uint8)

def lokaler_kontrast(bgr, clip=1.6, tabelle=False):
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    h, w = l.shape[:2]
    kacheln = (max(2, min(12, w // 180)), max(2, min(12, h // 180)))
    # Bei Tabelle: weniger aggressiv, damit Linien nicht aufdicken
    if tabelle:
        clip = min(clip, 1.1)
    l = cv2.createCLAHE(clipLimit=clip, tileGridSize=kacheln).apply(l)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

def schaerfen(bgr, staerke=0.6, radius=1.0, schwelle=4, tabelle=False):
    # Bei Tabelle: etwas mehr Schaerfe fuer Linien, aber kleiner Radius
    if tabelle:
        staerke = min(0.75, staerke + 0.15)
        radius = min(radius, 0.8)
    weich = cv2.GaussianBlur(bgr, (0, 0), radius)
    diff = bgr.astype(np.float32) - weich.astype(np.float32)
    maske = (np.abs(diff).max(axis=2) > schwelle).astype(np.float32)[..., None]
    out = bgr.astype(np.float32) + staerke * diff * maske
    return np.clip(out, 0, 255).astype(np.uint8)

def sauvola(gray, fenster=None, k=0.22, R=128.0):
    h, w = gray.shape[:2]
    if fenster is None:
        fenster = _ungerade(max(h, w) * 0.035, 15)
    r = fenster // 2
    g = gray.astype(np.float64)
    summe, quadrat = cv2.integral2(g)
    y0 = np.clip(np.arange(h) - r, 0, h)
    y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w)
    x1 = np.clip(np.arange(w) + r + 1, 0, w)
    flaeche = ((y1 - y0)[:, None] * (x1 - x0)[None, :]).astype(np.float64)
    def kasten(iib):
        return (iib[y1[:, None], x1[None, :]] - iib[y0[:, None], x1[None, :]]
                - iib[y1[:, None], x0[None, :]] + iib[y0[:, None], x0[None, :]])
    m = kasten(summe) / flaeche
    varianz = np.maximum(kasten(quadrat) / flaeche - m * m, 0.0)
    s = np.sqrt(varianz)
    T = m * (1.0 + k * (s / R - 1.0))
    return (g > T).astype(np.uint8) * 255

def veredeln(bgr, modus="farbe", tabelle=False, buch=False):
    if modus == "roh":
        return bgr
    # Bei Buch: etwas aggressiveres Licht-Ausgleichen fuer Schatten im Falz
    if buch:
        flach = beleuchtung_ausgleichen(bgr, grenze=3.6, dunkler=2.8)
    else:
        flach = beleuchtung_ausgleichen(bgr)
    flach = farbrauschen_daempfen(flach)
    flach = tonwert_spreizen(flach)
    if modus == "sw":
        g = cv2.cvtColor(flach, cv2.COLOR_BGR2GRAY)
        g = cv2.bilateralFilter(g, 5, 35, 5)
        bw = sauvola(g)
        return cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)
    # Buch: etwas mehr Kontrast, Tabelle: weniger
    if buch:
        flach = lokaler_kontrast(flach, clip=1.5, tabelle=False)
    else:
        flach = lokaler_kontrast(flach, clip=1.3, tabelle=tabelle)
    # Hintergrund weissen
    if buch:
        flach = hintergrund_weissen(flach, start=190.0, ende=238.0, tabelle=False)
    else:
        flach = hintergrund_weissen(flach, tabelle=tabelle)
    # Schaerfen: Buch braucht mehr in der Mitte (oft unscharf durch Woelbung)
    if buch:
        flach = schaerfen(flach, staerke=0.85, radius=1.1, schwelle=3, tabelle=False)
        # Zweiter leichter Scharf-Durchgang fuer Text
        flach = schaerfen(flach, staerke=0.35, radius=0.7, schwelle=5, tabelle=False)
    else:
        flach = schaerfen(flach, tabelle=tabelle)
    if modus == "grau":
        g = cv2.cvtColor(flach, cv2.COLOR_BGR2GRAY)
        return cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
    hsv = cv2.cvtColor(flach, cv2.COLOR_BGR2HSV).astype(np.float32)
    # Buch: Farben etwas mehr kraeftigen (oft blass durch Schatten)
    sat_boost = 1.18 if buch else 1.12
    hsv[..., 1] = np.clip(hsv[..., 1] * sat_boost, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

# ===========================================================================
# Buchkruemmung: UVDoc-Gitter
# ===========================================================================
UVDOC_GH = 45
UVDOC_GW = 31

def _kruemmung(img):
    g = cv2.cvtColor(_klein(img, 700), cv2.COLOR_BGR2GRAY)
    if g.size == 0:
        return 0.0
    bw = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                               cv2.THRESH_BINARY_INV, 31, 10)
    h, w = bw.shape
    breite = cv2.getStructuringElement(
        cv2.MORPH_RECT, (max(3, int(w * 0.05)) | 1, 1))
    konturen, _ = cv2.findContours(cv2.dilate(bw, breite),
                                   cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    sags = []
    for c in konturen:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw < 0.3 * w or ch > 0.05 * h:
            continue
        maske = np.zeros((ch, cw), np.uint8)
        cv2.drawContours(maske, [c - [x, y]], -1, 255, -1)
        band = (bw[y:y + ch, x:x + cw] > 0) & (maske > 0)
        xs, ys = [], []
        for xi in range(0, cw, 3):
            zeilen = np.where(band[:, xi])[0]
            if zeilen.size:
                xs.append(x + xi)
                ys.append(y + float(zeilen.mean()))
        if len(xs) < 20:
            continue
        xs = np.asarray(xs, np.float64)
        ys = np.asarray(ys, np.float64)
        k2 = np.polyfit(xs, ys, 2)
        k1 = np.polyfit(xs, ys, 1)
        xm = np.linspace(xs.min(), xs.max(), 50)
        sags.append(float(np.max(np.abs(np.polyval(k2, xm)
                                        - np.polyval(k1, xm)))))
    return float(np.median(sags)) if sags else 0.0

def _upsample_grid_align_corners(grid, H, W):
    Gh, Gw = grid.shape[1], grid.shape[2]
    if H == Gh and W == Gw:
        return grid
    x_ratio = (Gw - 1) / (W - 1) if W > 1 else 0
    y_ratio = (Gh - 1) / (H - 1) if H > 1 else 0
    xs = np.arange(W, dtype=np.float32) * x_ratio
    ys = np.arange(H, dtype=np.float32) * y_ratio
    x0 = np.floor(xs).astype(np.int32)
    x1 = np.minimum(x0 + 1, Gw - 1)
    fx = xs - x0
    y0 = np.floor(ys).astype(np.int32)
    y1 = np.minimum(y0 + 1, Gh - 1)
    fy = ys - y0
    out = np.empty((2, H, W), dtype=np.float32)
    for c in range(2):
        gc = grid[c]
        for y in range(H):
            y0i = y0[y]; y1i = y1[y]; fyy = fy[y]
            row0 = gc[y0i, x0] * (1 - fx) + gc[y0i, x1] * fx
            row1 = gc[y1i, x0] * (1 - fx) + gc[y1i, x1] * fx
            out[c, y, :] = row0 * (1 - fyy) + row1 * fyy
    return out

def _uvdoc_gitter_anwenden(bgr, gitter, align_corners=True):
    g = np.asarray(gitter, np.float32).reshape(2, UVDOC_GH, UVDOC_GW)
    h, w = bgr.shape[:2]
    quer = w > h
    bild = np.ascontiguousarray(np.rot90(bgr)) if quer else bgr
    H, W = bild.shape[:2]
    if align_corners:
        up = _upsample_grid_align_corners(g, H, W)
    else:
        up = np.stack([cv2.resize(g[k], (W, H), interpolation=cv2.INTER_LINEAR) for k in range(2)])
    mx = ((up[0] + 1.0) * 0.5) * (W - 1.0)
    my = ((up[1] + 1.0) * 0.5) * (H - 1.0)
    mx = np.clip(mx, 0, W - 1)
    my = np.clip(my, 0, H - 1)
    aus = cv2.remap(bild, mx.astype(np.float32), my.astype(np.float32),
                    cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return np.ascontiguousarray(np.rot90(aus, -1)) if quer else aus

def _istTabelle(img, kante=700):
    try:
        klein = _klein(img, kante)
        g = cv2.cvtColor(klein, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(g, 50, 150, apertureSize=3)
        lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=70,
                                minLineLength=max(20, int(0.22 * g.shape[1])),
                                maxLineGap=18)
        if lines is None:
            return False, 0, 0
        horiz = 0
        vert = 0
        for l in lines:
            x1, y1, x2, y2 = l[0]
            ang = np.degrees(np.arctan2(y2-y1, x2-x1))
            length = np.hypot(x2-x1, y2-y1)
            if length < 0.18 * g.shape[1] and length < 0.18 * g.shape[0]:
                continue
            if abs(ang) < 12 or abs(ang) > 168:
                horiz += 1
            elif 78 < abs(ang) < 102:
                vert += 1
        # Etwas empfindlicher fuer kleinere Tabellen (z.B. Rechnungen)
        ist = (horiz >= 4 and vert >= 2) or horiz >= 8 or (horiz >= 3 and vert >= 3)
        return ist, horiz, vert
    except Exception:
        return False, 0, 0

def _linienGeradheit(img, kante=700):
    try:
        klein = _klein(img, kante)
        g = cv2.cvtColor(klein, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(g, 50, 150, apertureSize=3)
        lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=80,
                                minLineLength=int(0.30 * g.shape[1]),
                                maxLineGap=12)
        if lines is None or len(lines) < 3:
            return 0.0
        abweichungen = []
        for l in lines[:20]:
            x1, y1, x2, y2 = l[0]
            length = np.hypot(x2-x1, y2-y1)
            if length < 30:
                continue
            if abs(y2-y1) < abs(x2-x1) * 0.15:
                y_mid = int((y1+y2)/2)
                x_start, x_end = sorted([int(x1), int(x2)])
                band = edges[max(0, y_mid-8):min(g.shape[0], y_mid+9), x_start:x_end]
                if band.size == 0:
                    continue
                ys = []
                for xi in range(band.shape[1]):
                    col = band[:, xi]
                    nz = np.where(col>0)[0]
                    if nz.size:
                        ys.append(float(nz.mean()) + max(0, y_mid-8))
                if len(ys) < 10:
                    continue
                xs = np.linspace(x_start, x_end, len(ys))
                k = np.polyfit(xs, ys, 1)
                y_fit = np.polyval(k, xs)
                dev = np.max(np.abs(np.array(ys) - y_fit))
                abweichungen.append(dev)
        return float(np.median(abweichungen)) if abweichungen else 0.0
    except Exception:
        return 0.0

def _geradheit_erhalten(vor, nach):
    """Verwirft affine Korrekturen nur bei klar messbarer Linien-Verschlechterung."""
    vor = float(vor)
    nach = float(nach)
    return nach <= max(vor * 1.15, vor + 0.5)

def _uvdoc_lohnt(src, hinweis, gitter):
    klein = _klein(src, 900)
    f = klein.shape[1] / float(src.shape[1])
    quad_k = None
    if hinweis is not None:
        q = (np.asarray(hinweis, np.float64) * f)
        if _quad_plausibel(q, klein.shape[0], klein.shape[1]):
            quad_k = _ordne_robust(q)
    if quad_k is None:
        q2 = scanner.find_rough_quad(klein)
        if q2 is not None:
            q3 = scanner.refine_edges(klein, q2)
            quad_k = _ordne_robust(q3 if q3 is not None else q2)
    if quad_k is None:
        return False, 0.0, 0.0
    warped_vor = entzerren(klein, quad_k)
    vorher = _kruemmung(warped_vor)
    ist_tab, _, _ = _istTabelle(warped_vor, kante=700)
    gerad_vor = _linienGeradheit(warped_vor, kante=700)
    if vorher <= 0.45 and gerad_vor <= 0.6:
        return False, vorher, vorher
    try:
        klein_dewarped = _uvdoc_gitter_anwenden(klein, gitter, align_corners=True)
        warped_nach = entzerren(klein_dewarped, quad_k)
    except Exception:
        return False, vorher, vorher
    nachher = _kruemmung(warped_nach)
    gerad_nach = _linienGeradheit(warped_nach, kante=700)
    lohnt_kruemm = nachher < 0.9 * vorher if vorher > 0.45 else True
    if not _geradheit_erhalten(gerad_vor, gerad_nach):
        return False, vorher, nachher
    if ist_tab:
        if vorher > 0.5 and nachher >= vorher * 0.92:
            return False, vorher, nachher
    if vorher <= 0.6 and nachher > vorher * 1.15:
        return False, vorher, nachher
    return (lohnt_kruemm or (ist_tab and gerad_nach < gerad_vor * 0.9)), vorher, nachher

def _uvdoc_lohnt_nach_warp(warped, gitter):
    try:
        vorher = _kruemmung(warped)
        if vorher <= 0.45:
            return False, vorher, vorher
        g = np.asarray(gitter, np.float32).reshape(2, UVDOC_GH, UVDOC_GW)
        H, W = warped.shape[:2]
        up = _upsample_grid_align_corners(g, H, W)
        mx = ((up[0] + 1.0) * 0.5) * (W - 1.0)
        my = ((up[1] + 1.0) * 0.5) * (H - 1.0)
        mx = np.clip(mx, 0, W-1)
        my = np.clip(my, 0, H-1)
        probiert_img = cv2.remap(warped, mx.astype(np.float32), my.astype(np.float32),
                                 cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        nachher = _kruemmung(probiert_img)
        return (nachher < 0.85 * vorher), vorher, nachher
    except Exception:
        return False, 0.0, 0.0

def scan_bgr(src, hinweis=None, streng=False, veredelung="farbe", uvdoc=None):
    meldungen = []
    stufen = []
    info = {"dokument_erkannt": False, "meldungen": meldungen,
            "stufen": stufen}
    uvdoc_angewandt_vor = False
    if uvdoc is not None:
        try:
            lohnt, vorher, nachher = _uvdoc_lohnt(src, hinweis, uvdoc)
        except Exception as f:
            lohnt, vorher, nachher = False, 0.0, 0.0
            meldungen.append("Kruemmungs-Pruefung nicht moeglich (%s)." % type(f).__name__)
        info["kruemmung_vorher"] = round(float(vorher), 2)
        info["kruemmung_nachher"] = round(float(nachher), 2)
        if lohnt:
            try:
                src = _uvdoc_gitter_anwenden(src, uvdoc, align_corners=True)
                stufen.append(_geometrie_stufe(src, "nach_uvdoc_vor_warp"))
                uvdoc_angewandt_vor = True
                info["uvdoc"] = "angewandt_vor"
                meldungen.append("Buchkruemmung geglaettet (Zeilenbiegung %.2f auf %.2f px)." % (vorher, nachher))
            except Exception as fe:
                info["uvdoc"] = "fehler_vor"
                meldungen.append("Kruemmungs-Gitter konnte nicht angewendet werden (%s)." % type(fe).__name__)
        else:
            info["uvdoc"] = "nicht_noetig" if vorher <= 0.45 else "verworfen_vor"
            if vorher > 0.45:
                meldungen.append("Kruemmungs-Glaettung verworfen (haette die Zeilen nicht gerader gemacht: %.2f -> %.2f px)." % (vorher, nachher))
    elif "uvdoc" not in info:
        info["uvdoc"] = "kein_modell"

    quad, quelle = viereck_bestimmen(src, hinweis)
    info["dokument_erkannt"] = quad is not None
    info["quad_quelle"] = quelle
    if quad is None:
        if streng:
            return None, info
        meldungen.append("Kein Dokument-Viereck erkannt - das ganze Bild wird verarbeitet.")
    else:
        info["quad"] = [[float(a), float(b)] for a, b in quad]

    stufen.append(_geometrie_stufe(src, "quad_vor_warp", quad))
    warped = entzerren(src, quad)
    stufen.append(_geometrie_stufe(warped, "nach_perspektiv_warp"))
    ist_tab, h_tab, v_tab = _istTabelle(warped, kante=700)
    gerad_vor = _linienGeradheit(warped, kante=700)
    if ist_tab:
        info["tabelle"] = {"h": h_tab, "v": v_tab, "geradheit": round(gerad_vor, 2)}
        meldungen.append(f"Tabelle erkannt ({h_tab} horiz., {v_tab} vert. Linien, Geradheit {gerad_vor:.2f}px) - schonende Entzerrung.")

    if uvdoc is not None and not uvdoc_angewandt_vor:
        try:
            lohnt2, vor2, nach2 = _uvdoc_lohnt_nach_warp(warped, uvdoc)
            if lohnt2:
                g = np.asarray(uvdoc, np.float32).reshape(2, UVDOC_GH, UVDOC_GW)
                H, W = warped.shape[:2]
                up = _upsample_grid_align_corners(g, H, W)
                mx = ((up[0] + 1.0) * 0.5) * (W - 1.0)
                my = ((up[1] + 1.0) * 0.5) * (H - 1.0)
                mx = np.clip(mx, 0, W-1)
                my = np.clip(my, 0, H-1)
                kandidat = cv2.remap(warped, mx.astype(np.float32), my.astype(np.float32),
                                     cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
                gerad_nach = _linienGeradheit(kandidat, kante=700)
                if _geradheit_erhalten(gerad_vor, gerad_nach):
                    warped = kandidat
                    info["uvdoc"] = "angewandt_nach"
                    meldungen.append(f"Buchkruemmung nach Entzerren geglaettet (Kruemmung {vor2:.2f} -> {nach2:.2f}px).")
                else:
                    info["uvdoc"] = "verworfen_nach_geradheit"
                    meldungen.append(f"Kruemmungs-Glaettung nach Entzerren verworfen (Linien waeren welliger: {gerad_vor:.2f} -> {gerad_nach:.2f}px).")
            else:
                if vor2 > 0.45 and info.get("uvdoc","").startswith("verworfen") == False:
                    info["uvdoc"] = "verworfen_nach"
        except Exception as f2:
            meldungen.append("Kruemmungs-Pruefung nach Entzerren nicht moeglich (%s)." % type(f2).__name__)

    vorher_area = warped.shape[0] * warped.shape[1]
    kandidat, bars = scanner.crop_black_bars(warped)
    if sum(bars):
        if kandidat.size and kandidat.shape[0] * kandidat.shape[1] > 0.45 * vorher_area:
            warped = kandidat
            stufen.append(_geometrie_stufe(warped, "nach_balken_crop"))
            meldungen.append("Schwarze Balken erkannt und entfernt.")
        else:
            meldungen.append("Balken-Schnitt verworfen (haette zu viel abgeschnitten).")

    gx_ = -1
    kandidat, gx = scanner.crop_book_gutter(warped)
    if gx >= 0:
        erlaubt, grund = falz_echt(warped, gx)
        if ist_tab and gx >= 0:
            if (warped.shape[1] - gx) / float(warped.shape[1]) > 0.30:
                erlaubt = False
                grund = "Falz-Verdacht verworfen - Tabelle erkannt, kein Buchfalz."
        if erlaubt and kandidat.size:
            warped = kandidat
            gx_ = gx
        meldungen.append(grund)

    vor = zeilen_guete(warped)
    gerad_dreh_vor = _linienGeradheit(warped, kante=700)
    kandidat, winkel, gemacht = drehen(warped)
    if gemacht:
        gerad_dreh_nach = _linienGeradheit(kandidat, kante=700)
        gerad_ok = _geradheit_erhalten(gerad_dreh_vor, gerad_dreh_nach)
        guete_nach = zeilen_guete(kandidat)
        if not gerad_ok:
            meldungen.append(f"Drehung verworfen (Linien waeren welliger: {gerad_dreh_vor:.2f} -> {gerad_dreh_nach:.2f}px).")
        elif abs(winkel) >= 0.3:
            # deskew_by_text liefert einen robusten Winkel; ein schwacher
            # Projektionsscore darf die Korrektur bei wenig Text nicht blockieren.
            warped = kandidat
            meldungen.append(f"Blatt um {winkel:+.1f} Grad gerade gedreht.")
        elif guete_nach >= vor * (0.98 if ist_tab else 0.99):
            warped = kandidat
            meldungen.append(f"Blatt um {winkel:+.1f} Grad gerade gedreht.")
        else:
            meldungen.append("Drehung verworfen (keine ausreichende Verbesserung).")

    vor = zeilen_guete(warped)
    gerad_aktuell = _linienGeradheit(warped, kante=700)
    kandidat, curve_amp = scanner.flatten_curvature(warped)
    if curve_amp:
        guete_nach = zeilen_guete(kandidat)
        schwelle = 1.08 if ist_tab else 1.02
        if guete_nach >= vor * schwelle:
            gerad_nach = _linienGeradheit(kandidat, kante=700)
            if _geradheit_erhalten(gerad_aktuell, gerad_nach):
                warped = kandidat
                meldungen.append(f"Wellen-Glaettung: Kruemmung bis {curve_amp:.1f}px begradigt.")
            else:
                meldungen.append(f"Wellen-Glaettung verworfen (Linien waeren welliger: {gerad_aktuell:.2f} -> {gerad_nach:.2f}px).")
        else:
            meldungen.append("Wellen-Glaettung verworfen (haette den Text verzogen).")

    if gx_ >= 0:
        if ist_tab:
            meldungen.append("Buch-Entzerrung uebersprungen - Tabelle erkannt.")
        else:
            vor = zeilen_guete(warped)
            gerad_buch_vor = _linienGeradheit(warped, kante=700)
            kandidat, mdev = scanner.dewarp_book_margins(warped)
            gerad_buch_nach = _linienGeradheit(kandidat, kante=700)
            if (mdev and _geradheit_erhalten(gerad_buch_vor, gerad_buch_nach)
                    and zeilen_guete(kandidat) >= vor * 0.99):
                warped = kandidat
                stufen.append(_geometrie_stufe(warped, "nach_buch_rand_entzerrung"))
                meldungen.append(f"Rand-Entzerrung: Textraender um bis zu {mdev:.1f}px begradigt.")
            elif mdev:
                meldungen.append(f"Rand-Entzerrung verworfen (Linien waeren welliger: {gerad_buch_vor:.2f} -> {gerad_buch_nach:.2f}px).")
            kandidat, sfac = scanner.decompress_book_x(warped)
            if sfac > 1.0:
                warped = kandidat
                meldungen.append(f"Falz-Entstauchung: Buchstaben bis Faktor {sfac:.2f} verbreitert.")
            kandidat, lcut = scanner.balance_left_margin(warped)
            if lcut and kandidat.shape[1] > 0.6 * warped.shape[1]:
                warped = kandidat
                meldungen.append(f"Linker Leerrand um {lcut}px gekuerzt.")

    vor = zeilen_guete(warped)
    gerad_scher_vor = _linienGeradheit(warped, kante=700)
    kandidat, scherung, gemacht = scheren(warped)
    if gemacht:
        gerad_scher_nach = _linienGeradheit(kandidat, kante=700)
        guete_nach = zeilen_guete(kandidat)
        if not _geradheit_erhalten(gerad_scher_vor, gerad_scher_nach):
            meldungen.append("Scherung verworfen (Linien waeren welliger).")
        elif abs(scherung) > 0.002 or guete_nach >= vor * 1.01:
            # shear_level_lines verwirft bereits instabile Zeilenneigungen.
            warped = kandidat
            stufen.append(_geometrie_stufe(warped, "nach_scherung"))
            meldungen.append(f"Scherung {scherung:+.4f} ausgeglichen.")
        else:
            meldungen.append("Scherung verworfen (keine ausreichende Verbesserung).")

    info["veredelung"] = veredelung
    buch_seite = (gx_ >= 0)
    if veredelung == "original":
        bw = scanner.mode_bw_smart(warped, book=buch_seite)
        clean0 = scanner.auto_clean(warped)
        ergebnis = scanner.mode_hybrid(clean0, bw, scale=2, orig=warped)
    else:
        if ist_tab:
            ergebnis = veredeln(warped, modus=veredelung, tabelle=True, buch=False)
        else:
            ergebnis = veredeln(warped, modus=veredelung, tabelle=False, buch=buch_seite)

    return ergebnis, info

def scan_rgba(rgba_flat, hoehe, breite, quad=None, veredelung="farbe", uvdoc=None):
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    hybrid, info = scan_bgr(bgr, quad, veredelung=veredelung, uvdoc=uvdoc)
    out = cv2.cvtColor(hybrid, cv2.COLOR_BGR2RGBA)
    h, w = out.shape[:2]
    return out.tobytes(), h, w, info

def quad_aus_rgba(rgba_flat, hoehe, breite):
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    quad = scanner.find_rough_quad(bgr)
    if quad is None:
        return None
    pts = scanner.order_pts(quad)
    return [[float(p[0]), float(p[1])] for p in pts]

def scan_rgba_streng(rgba_flat, hoehe, breite, quad=None, veredelung="farbe", uvdoc=None):
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    hybrid, info = scan_bgr(bgr, quad, streng=True, veredelung=veredelung, uvdoc=uvdoc)
    if hybrid is None:
        return None, 0, 0, info
    out = cv2.cvtColor(hybrid, cv2.COLOR_BGR2RGBA)
    h, w = out.shape[:2]
    return out.tobytes(), h, w, info
