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
# Veredelung: aus dem entzerrten Foto ein sauberes Scan-Bild machen
# ===========================================================================
#
# WARUM NEU?
# ----------
# Die Original-Veredelung (scanner.mode_bw_smart + scanner.mode_hybrid) baut
# das Ergebnis aus einer HARTEN Schwarz-Weiss-Maske zusammen: alles, was der
# adaptive Schwellwert nicht als Tinte erkennt, wird reinweiss uebermalt.
# Das erzeugt genau die Fehler, die an den Scans gestoert haben:
#
#   * Loecher in Buchstaben und abgerissene duenne Striche,
#   * helle Hoefe (Halos) um jeden Buchstaben,
#   * Bleistift, Raster, graue Flaechen und Fotos verschwinden ganz,
#   * doppelte Aufloesung (2x Supersampling) ohne echten Mehrwert.
#
# Die neue Veredelung arbeitet stattdessen so, wie es gaengige Scanner-Apps
# und die Literatur zur Dokumentbildverbesserung machen - in Halbtoenen,
# ohne harte Maske:
#
#   1. BELEUCHTUNGSFELD schaetzen und herausrechnen ("flat field").
#      Grundlage: morphologisches Schliessen (schluckt die Tinte) und eine
#      sehr breite Weichzeichnung (laesst nur den Licht-Verlauf uebrig).
#      Die Korrektur wird begrenzt, damit grosse farbige Flaechen nicht
#      ausgebleicht werden - genau dieser Fehler liess Diagramme und
#      Marker-Flaechen im alten Weg verschwinden.
#   2. WEISS- UND SCHWARZPUNKT aus dem Histogramm setzen (Tonwertspreizung)
#      mit sanfter Kurve statt hartem Clipping.
#   3. LOKALER KONTRAST (CLAHE) sehr dezent, damit blasse Bleistiftschrift
#      lesbar wird, ohne Rauschen hochzuziehen.
#   4. SCHAERFEN mit kleinem Radius und Schwelle (Unschaerfemaske). Kleiner
#      Radius = keine Halos.
#
# Fuer Schwarz-Weiss gibt es den Sauvola-Schwellwert (Sauvola & Pietikaeinen
# 2000) - der Standard der Dokumentbinarisierung, deutlich robuster als ein
# globaler oder gleitender Mittelwert, und hier ueber Integralbilder
# berechnet, also schnell genug fuer den Browser.


def _ungerade(n, mindest=3):
    n = int(round(n))
    if n < mindest:
        n = mindest
    return n | 1


def beleuchtungsfeld(gray):
    """Schaetzt, wie hell das Papier OHNE Tinte an jeder Stelle waere.

    Gerechnet wird auf einem kleinen Bild: das ist nicht nur schneller,
    sondern auch glatter (kein Nachziehen einzelner Buchstaben).
    """
    h, w = gray.shape[:2]
    lang = max(h, w)
    f = 480.0 / lang
    if f < 1.0:
        klein = cv2.resize(gray, (max(8, int(w * f)), max(8, int(h * f))),
                           interpolation=cv2.INTER_AREA)
    else:
        klein = gray.copy()
    kh, kw = klein.shape[:2]
    # Kernel so gross, dass eine Textzeile komplett darunter passt
    k = _ungerade(max(kh, kw) * 0.055, 5)
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    feld = cv2.morphologyEx(klein, cv2.MORPH_CLOSE, kern)
    feld = cv2.medianBlur(feld, _ungerade(min(k, 31), 3))
    # Glaetten, ABER die Schattenkante stehen lassen.
    #
    # Ein Gauss waere hier falsch: Ein harter Schlagschatten (Hand, Regal,
    # Fensterkreuz) hat eine SCHARFE Kante. Verschmiert man die im
    # Lichtfeld, bleibt genau an dieser Kante ein dunkler Keil im Scan
    # stehen - der Fehler, der frueher als "Schatten bleibt drin" auffiel.
    # Der Bilateralfilter mittelt nur zwischen aehnlich hellen Nachbarn
    # und laesst die Stufe deshalb scharf.
    # d=9 statt "aus der Sigma berechnen": gleiches Ergebnis, halbe Zeit.
    feld = cv2.bilateralFilter(feld, 9, 18, max(3.0, 0.05 * max(kh, kw)))
    # Reste glaetten, aber nur ganz leicht (sonst ist die Kante wieder weg).
    feld = cv2.GaussianBlur(feld, (0, 0), max(1.0, 0.010 * max(kh, kw)))
    return cv2.resize(feld, (w, h), interpolation=cv2.INTER_LINEAR)


def beleuchtung_ausgleichen(bgr, grenze=3.2, dunkler=2.4):
    """Schatten, Vignette und schraeges Licht herausrechnen.

    WICHTIG: EIN gemeinsamer Verstaerkungsfaktor fuer alle drei Kanaele.
    Je Kanal zu normalisieren wuerde farbiges Papier grau machen und
    farbige Flaechen ausbleichen. Der Faktor wird zusaetzlich begrenzt,
    damit eine grosse dunkle Flaeche (Foto, Balkendiagramm) nicht als
    "Schatten" missverstanden und weiss gerechnet wird.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    feld = beleuchtungsfeld(gray).astype(np.float32)
    ziel = float(np.percentile(feld, 92))
    if ziel < 1.0:
        return bgr.copy()
    gewinn = ziel / np.maximum(feld, 1.0)
    # Aufhellen darf mehr als Abdunkeln: Schatten sollen weg, aber eine
    # grosse helle Flaeche soll nicht kuenstlich dunkel werden.
    gewinn = np.clip(gewinn, 1.0 / dunkler, grenze)
    out = bgr.astype(np.float32) * gewinn[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)


def _weisspunkt(bgr, abweichung=0.22):
    """Weisspunkt JE KANAL aus der Papierflaeche - das ist der Weissabgleich.

    Ohne diesen Schritt bleibt Papier so getoent, wie die Kamera es
    gesehen hat: unter Gluehlicht gelb, im Schatten blau. Genau das
    liess frueher bearbeitete Fotos "schmuddelig" aussehen.

    Gemessen wird nur auf der hellen Haelfte des Bildes (das IST das
    Papier) und die drei Kanaele duerfen nur begrenzt auseinanderlaufen -
    sonst wuerde ein tatsaechlich farbiges Blatt (gelber Notizzettel)
    gewaltsam entfaerbt.
    """
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
    """Weissabgleich + Tonwertspreizung mit weicher Schulter."""
    weiss, mittel = _weisspunkt(bgr)
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    schwarz = float(np.percentile(g, 0.4))
    schwarz = min(schwarz, mittel - 60.0)
    schwarz = max(schwarz, 0.0)

    x = bgr.astype(np.float32)
    for c in range(3):
        x[:, :, c] = (x[:, :, c] - schwarz) * (255.0 / max(weiss[c] - schwarz, 1.0))
    # weiche Schulter oben: alles ueber 228 wird sanft nach 255 gezogen,
    # statt abgeschnitten zu werden. Das haelt Papier sauber weiss, ohne
    # hellen Inhalt (gelber Marker, Raster) zu verschlucken.
    hoch = np.clip((x - 228.0) / 32.0, 0.0, 1.0)
    x = x * (1.0 - hoch) + (228.0 + 27.0 * np.sqrt(hoch)) * hoch
    if staerke != 1.0:
        x = bgr.astype(np.float32) * (1.0 - staerke) + x * staerke
    return np.clip(x, 0, 255).astype(np.uint8)


def farbrauschen_daempfen(bgr):
    """Farbrauschen glaetten, Schaerfe behalten.

    Handykameras rauschen vor allem in der FARBE. Auf einer leeren
    Papierflaeche sieht man das als buntes Gewimmel, das jede folgende
    Kontrastanhebung noch verstaerkt. Deshalb werden in LAB nur die
    beiden Farbkanaele geglaettet - die Helligkeit (und damit jeder
    Buchstabe) bleibt unangetastet.
    """
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    a = cv2.medianBlur(a, 5)
    b = cv2.medianBlur(b, 5)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


def hintergrund_weissen(bgr, start=197.0, ende=242.0):
    """Papier wirklich weiss machen - aber weich und inhaltssicher.

    Die Original-Pipeline hat dafuer eine harte Tintenmaske benutzt und
    alles andere reinweiss uebermalt; dabei gingen duenne Striche,
    Bleistift und Raster verloren. Hier wird stattdessen nur das
    ueberblendet, was ohnehin schon fast weiss UND farblos ist:

      * weicher Uebergang (Smoothstep) statt Schwelle -> keine Kanten,
      * Buntes bleibt verschont -> Marker, Stempel, Logos ueberleben,
      * alles unter ~204 bleibt vollstaendig erhalten -> Bleistift bleibt.
    """
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    chroma = (bgr.max(axis=2).astype(np.int16) -
              bgr.min(axis=2).astype(np.int16)).astype(np.float32)
    t = np.clip((g - start) / max(ende - start, 1.0), 0.0, 1.0)
    t = t * t * (3.0 - 2.0 * t)                     # Smoothstep
    t *= np.clip(1.0 - (chroma - 26.0) / 40.0, 0.0, 1.0)
    t = t[..., None]
    out = bgr.astype(np.float32) * (1.0 - t) + 255.0 * t
    return np.clip(out, 0, 255).astype(np.uint8)


def lokaler_kontrast(bgr, clip=1.6):
    """Sehr dezentes CLAHE auf der Helligkeit (LAB), Farbe bleibt unberuehrt."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    h, w = l.shape[:2]
    kacheln = (max(2, min(12, w // 180)), max(2, min(12, h // 180)))
    l = cv2.createCLAHE(clipLimit=clip, tileGridSize=kacheln).apply(l)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


def schaerfen(bgr, staerke=0.6, radius=1.0, schwelle=4):
    """Unschaerfemaske mit kleinem Radius und Schwelle.

    Kleiner Radius -> keine hellen Hoefe um Buchstaben. Die Schwelle
    verhindert, dass Papierrauschen mitverstaerkt wird.
    """
    weich = cv2.GaussianBlur(bgr, (0, 0), radius)
    diff = bgr.astype(np.float32) - weich.astype(np.float32)
    maske = (np.abs(diff).max(axis=2) > schwelle).astype(np.float32)[..., None]
    out = bgr.astype(np.float32) + staerke * diff * maske
    return np.clip(out, 0, 255).astype(np.uint8)


def sauvola(gray, fenster=None, k=0.22, R=128.0):
    """Sauvola-Schwellwert ueber Integralbilder.

    T(x,y) = m(x,y) * (1 + k * (s(x,y)/R - 1))
    Sauvola & Pietikaeinen, "Adaptive document image binarization",
    Pattern Recognition 33 (2000). Standardverfahren der
    Dokumentbinarisierung - haelt duenne Striche, ohne in leeren Flaechen
    Flecken zu erzeugen (das Problem des gleitenden Mittelwerts).
    """
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


def veredeln(bgr, modus="farbe"):
    """Die neue Veredelung. modus: "farbe" | "grau" | "sw" | "roh"."""
    if modus == "roh":
        return bgr

    flach = beleuchtung_ausgleichen(bgr)          # 1. Licht ausgleichen
    flach = farbrauschen_daempfen(flach)          # 2. Farbrauschen weg
    flach = tonwert_spreizen(flach)               # 3. Weissabgleich + Tonwerte

    if modus == "sw":
        g = cv2.cvtColor(flach, cv2.COLOR_BGR2GRAY)
        g = cv2.bilateralFilter(g, 5, 35, 5)      # Flaechen glaetten, Striche schonen
        bw = sauvola(g)
        return cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)

    flach = lokaler_kontrast(flach, clip=1.3)     # 4. feiner Nahkontrast
    flach = hintergrund_weissen(flach)            # 5. Papier wird Papierweiss
    flach = schaerfen(flach)                      # 6. knackig, ohne Halos

    if modus == "grau":
        g = cv2.cvtColor(flach, cv2.COLOR_BGR2GRAY)
        return cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)

    # Farbe: Saettigung ganz leicht anheben (Marker, Stempel, Logos)
    hsv = cv2.cvtColor(flach, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.12, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


# ===========================================================================
# Hauptlauf
# ===========================================================================
# ===========================================================================
# Buchkruemmung: UVDoc-Gitter (kommt aus detect-uvdoc.js)
# ===========================================================================
# Warum das hier steht und nicht in JavaScript:
#   Das Gitter (2 x 45 x 31 Werte) beschreibt, woher jeder Bildpunkt eines
#   flachgelegten Blattes im Foto stammt. Die Rechnung selbst (ein 8-Mio.-
#   Parameter-Netz) laeuft in detect-uvdoc.js ueber onnxruntime-web - dort
#   gibt es WebAssembly. Das Umrechnen der Bildpunkte macht OpenCV, das in
#   Pyodide ohnehin geladen ist; 45x31 Werte ueber die Leitung zu schicken
#   kostet nichts (11 KB).
#
# GEMESSEN, NICHT GERATEN - und deshalb mit Tor:
#   UVDoc glaettet gebogene Buchseiten hervorragend (echtes Buchfoto:
#   Zeilenkruemmung 1.43 px -> 0.45 px), auf einer bereits geraden Seite
#   kann es aber neue Wellen erzeugen (0.48 px -> 1.08 px). Deshalb wird
#   zuerst gemessen, wie krumm die entzerrte Seite ueberhaupt ist, und das
#   Gitter nur angewendet, wenn es die Zeilen nachweislich gerader macht.

UVDOC_GH = 45          # Gitterhoehe (Modellausgabe)
UVDOC_GW = 31          # Gitterbreite


def _kruemmung(img):
    """Wie stark biegen sich die Textzeilen durch?

    Mass: groesste Abweichung einer Textzeile von ihrer eigenen Geraden
    (Sagitta), Median ueber alle erkannten Zeilen, in Pixel bei 700 px
    Bildbreite. 0 = schnurgerade. Das Mass ist bewusst nicht von der
    Aufloesung abhaengig, damit Schwellen ueberall gleich gelten.
    """
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


def _uvdoc_gitter_anwenden(bgr, gitter):
    """Rechnet das Gitter auf ein Bild an (gleiche Regel wie detect-uvdoc.js:
    Querformate werden vorher gedreht)."""
    g = np.asarray(gitter, np.float32).reshape(2, UVDOC_GH, UVDOC_GW)
    h, w = bgr.shape[:2]
    quer = w > h
    bild = np.ascontiguousarray(np.rot90(bgr)) if quer else bgr
    H, W = bild.shape[:2]
    up = np.stack([cv2.resize(g[k], (W, H), interpolation=cv2.INTER_LINEAR)
                   for k in range(2)])
    mx = ((up[0] + 1.0) * 0.5) * (W - 1.0)
    my = ((up[1] + 1.0) * 0.5) * (H - 1.0)
    aus = cv2.remap(bild, mx.astype(np.float32), my.astype(np.float32),
                    cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return np.ascontiguousarray(np.rot90(aus, -1)) if quer else aus


def _uvdoc_lohnt(src, hinweis, gitter):
    """Prueft auf Arbeitsgroesse, ob das Gitter die Zeilen gerader macht.

    Rueckgabe: (lohnt, krumm_vorher, krumm_nachher). Es wird nur EIN
    zusaetzlicher Entzerrungsdurchgang auf 900 px gerechnet - im Sucher
    faellt das nicht auf, und die Entscheidung ist damit gemessen statt
    geraten.
    """
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

    vorher = _kruemmung(entzerren(klein, quad_k))
    if vorher <= 0.45:
        return False, vorher, vorher          # Seite ist schon gerade
    probiert = _kruemmung(entzerren(_uvdoc_gitter_anwenden(klein, gitter),
                                    quad_k))
    return (probiert < 0.9 * vorher), vorher, probiert


def scan_bgr(src, hinweis=None, streng=False, veredelung="farbe", uvdoc=None):
    """Kompletter Hauptlauf der Original-Pipeline auf einem BGR-Bild.

    Rueckgabe: (hybrid_bgr, info_dict). info_dict enthaelt
    "dokument_erkannt" (bool) und "meldungen" (deutsche Statuszeilen).
    Mit streng=True wird nichts verarbeitet, wenn kein Dokument gefunden
    wurde (die App zeigt dann eine Meldung).
    uvdoc: Gitter aus detect-uvdoc.js (2 x 45 x 31, -1..1) oder None.
    """
    meldungen = []
    info = {"dokument_erkannt": False, "meldungen": meldungen}

    if uvdoc is not None:
        try:
            lohnt, vorher, nachher = _uvdoc_lohnt(src, hinweis, uvdoc)
        except Exception as f:                      # niemals den Scan kippen
            lohnt, vorher, nachher = False, 0.0, 0.0
            meldungen.append("Kruemmungs-Pruefung nicht moeglich (%s)."
                             % type(f).__name__)
        info["kruemmung_vorher"] = round(float(vorher), 2)
        info["kruemmung_nachher"] = round(float(nachher), 2)
        if lohnt:
            src = _uvdoc_gitter_anwenden(src, uvdoc)
            info["uvdoc"] = "angewandt"
            meldungen.append("Buchkruemmung geglaettet (Zeilenbiegung %.2f "
                             "auf %.2f px)." % (vorher, nachher))
        else:
            info["uvdoc"] = "nicht_noetig" if vorher <= 0.45 else "verworfen"
            if vorher > 0.45:
                meldungen.append("Kruemmungs-Glaettung verworfen (haette die "
                                 "Zeilen nicht gerader gemacht: %.2f -> %.2f "
                                 "px)." % (vorher, nachher))
    elif "uvdoc" not in info:
        info["uvdoc"] = "kein_modell"

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

    # ---- Veredelung
    # Standard ist die neue Halbton-Veredelung (siehe oben). Die
    # Original-Variante bleibt ueber veredelung="original" erreichbar -
    # die Datei "scanner" wird dadurch weiterhin nicht angefasst.
    info["veredelung"] = veredelung
    if veredelung == "original":
        bw = scanner.mode_bw_smart(warped, book=(gx_ >= 0))
        clean0 = scanner.auto_clean(warped)
        ergebnis = scanner.mode_hybrid(clean0, bw, scale=2, orig=warped)
    else:
        ergebnis = veredeln(warped, modus=veredelung)

    return ergebnis, info


def scan_rgba(rgba_flat, hoehe, breite, quad=None, veredelung="farbe",
              uvdoc=None):
    """Einstiegspunkt fuer die Web-App (Pyodide)."""
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    hybrid, info = scan_bgr(bgr, quad, veredelung=veredelung, uvdoc=uvdoc)
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


def scan_rgba_streng(rgba_flat, hoehe, breite, quad=None, veredelung="farbe",
                     uvdoc=None):
    """Wie scan_rgba(), bricht aber ab, wenn kein Dokument erkannt wurde.

    Mit mitgegebenem Viereck (Live-Erkennung) gilt das Dokument als
    erkannt, sobald das Viereck plausibel ist - dann meldet die App nicht
    mehr faelschlich "Kein Dokument gefunden", obwohl im Sucher der Rahmen
    sauber auf dem Blatt lag.
    """
    arr = np.frombuffer(bytes(rgba_flat), dtype=np.uint8)
    arr = arr.reshape((int(hoehe), int(breite), 4))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    hybrid, info = scan_bgr(bgr, quad, streng=True, veredelung=veredelung,
                            uvdoc=uvdoc)
    if hybrid is None:
        return None, 0, 0, info
    out = cv2.cvtColor(hybrid, cv2.COLOR_BGR2RGBA)
    h, w = out.shape[:2]
    return out.tobytes(), h, w, info
