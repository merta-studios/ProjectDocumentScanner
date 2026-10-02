#!/usr/bin/env python3
"""Erzeugt SCHWIERIGE Kamera-Szenen mit bekannten Dokument-Ecken.

Warum eine zweite Testbild-Suite?
---------------------------------
`tools/testbilder.py` deckt die Grundfaelle ab (Blatt auf dunklem Tisch,
Perspektive, Rauschen). Auf echten Geraeten scheitert die Erkennung aber an
etwas anderem, und genau das war die Rueckmeldung:

  * weisses Papier auf weisser Unterlage (Decke, Tisch, Bett) - es gibt
    schlicht keine Kante, an der sich eine Linie festhalten koennte,
  * Papier auf Papier (Stapel, Block, mehrere Zettel) - dort gibt es sogar
    Kanten, aber sie gehoeren alle zum Untergrund statt zum Blatt,
  * gebogene Buchseiten - die "Kante" ist eine Kurve, ein Viereck passt
    nur naeherungsweise.

Dazu kommen die Faelle, die die Nachbearbeitung treffen: harter Schatten,
Blitzlicht, Handschrift.

Ausgabe je Szene:
  <ziel>/<name>.png        - Vorschau (wie die Kamera sie liefert)
  <ziel>/<name>.rgba       - rohe RGBA-Bytes fuer die Node-Tests
  <ziel>/<name>_live*.png  - kleine Sucherbilder (320 px) fuer bench_live
  <ziel>/<name>_flach.png  - NUR bei gebogenen Seiten: die flache Seite,
                             also die Vorlage fuer die Entzerrungs-Messung
  <ziel>/faelle.json       - Groesse, Soll-Ecken, Live-Frames, flach-Datei

Aufruf:  python3 tools/testbilder_hart.py <zielordner>
"""

import json
import os
import sys

import cv2
import numpy as np

rng = np.random.default_rng(20260601)

LIVE_KANTE = 320
LIVE_FRAMES = 6


# ===========================================================================
# Texturen
# ===========================================================================
def tuch(w, h, helligkeit=246, kontrast=7, faser=0.55):
    """Weisse Decke/Bettlaken: Gewebe aus zwei sich kreuzenden Wellen."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # Gewebe: zwei Frequenzen, leicht gegeneinander verdreht
    k = 0.9 * h / 800.0
    muster = (np.sin(xx * 0.9 * k) + np.sin(yy * 1.1 * k) +
              0.6 * np.sin((xx + yy) * 1.7 * k))
    base = helligkeit + kontrast * muster / 2.6
    img = np.repeat(base[:, :, None], 3, axis=2)
    # leichte Fasern
    img += rng.normal(0, faser * 2.2, (h, w, 1))
    img = cv2.GaussianBlur(img.astype(np.float32), (0, 0), 0.6)
    return img


def tisch(w, h, helligkeit=238, streifen=4.0):
    """Weisser, matter Tisch - fast strukturlos, nur ganz leichte Wolken."""
    klein = rng.normal(0, 1.0, (max(8, h // 40), max(8, w // 40), 1))
    klein = cv2.GaussianBlur(klein.astype(np.float32), (0, 0), 2.4)
    wolken = cv2.resize(klein, (w, h), interpolation=cv2.INTER_CUBIC)
    wolken = wolken - wolken.min()
    wolken = wolken / max(wolken.max(), 1e-6) * streifen
    base = np.full((h, w, 3), float(helligkeit), np.float32) + wolken[:, :, None]
    return base + rng.normal(0, 1.6, (h, w, 3))


def dunkles_tuch(w, h):
    base = tuch(w, h, helligkeit=52, kontrast=10, faser=0.8)
    return base


# ===========================================================================
# Dokumentseite
# ===========================================================================
def seite(w, h, art="text", handschrift=False, kontrast=1.0):
    """Flache Seite. kontrast skaliert, wie dunkel die Schrift ist -
    0.35 ist ein blasser Ausdruck, wie er auf echten Fotos vorkommt."""
    img = np.full((h, w, 3), 250, np.uint8)
    ink = int(70 + 140 * (1.0 - min(kontrast, 1.0)))
    if art == "leer":
        img = cv2.GaussianBlur(img, (0, 0), 1.0)
        return img
    y = int(0.10 * h)
    cv2.rectangle(img, (int(0.10 * w), y), (int(0.60 * w), y + int(0.030 * h)),
                  (int(ink * 0.8),) * 3, -1)
    y += int(0.06 * h)
    while y < 0.92 * h:
        for _ in range(int(rng.integers(4, 10))):
            if y > 0.92 * h:
                break
            breite = rng.uniform(0.45, 0.80) * w
            if handschrift:
                # gewellte Linie mit Luecken - wie ein handschriftlicher Eintrag
                xs = np.arange(int(0.10 * w), int(0.10 * w + breite), 2)
                ys = (y + 3 * np.sin(xs / 22.0 + rng.uniform(0, 6)) +
                      rng.normal(0, 1.2, len(xs)))
                pts = np.stack([xs, ys], axis=1).astype(np.int32)
                cv2.polylines(img, [pts], False, (int(ink * 0.6),) * 3,
                              rng.integers(2, 4))
            else:
                cv2.rectangle(img, (int(0.10 * w), y),
                              (int(0.10 * w + breite), y + max(2, int(0.011 * h))),
                              (int(ink * 0.75),) * 3, -1)
            y += int(0.022 * h)
        y += int(0.025 * h)
    # Eckmarken: schmale, mittelgraue Rahmen in allen vier Ecken. Sie sind
    # bewusst SCHWACH - sie sollen nicht bei der Erkennung helfen, sondern
    # im Scan nachweisbar machen, ob das ganze Blatt angekommen ist.
    mk = max(4, int(0.012 * min(w, h)))
    for mx, my in ((0.045, 0.030), (0.955, 0.030), (0.955, 0.970), (0.045, 0.970)):
        x0, y0 = int(mx * w) - mk, int(my * h) - mk
        cv2.rectangle(img, (x0, y0), (x0 + 2 * mk, y0 + 2 * mk), (150, 150, 150), 2)
    img = cv2.GaussianBlur(img, (0, 0), 0.7)
    return img


# ===========================================================================
# Biegung (Buchseite / welliges Blatt)
# ===========================================================================
def biegung(w, h, staerke=0.05, achse="x", bogen=0.35, spinne=0.0):
    """Liefert ein Verschiebungsfeld (dx, dy) fuer eine gebogene Seite.

    achse="x": die Seite kippt um eine senkrechte Achse (Buchfalz/Ruecken),
    dafuer wird der Faktor entlang x groesser. Die Kante nahe der Achse
    wandert am staerksten, die ferne Kante kaum - genau das, was ein Buch
    im Foto macht.

    staerke ist der Anteil der Bildbreite, um den die nahe Kante wandert.
    """
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    fx = (xx / max(w - 1, 1)) * 2.0 - 1.0        # -1 .. 1
    fy = (yy / max(h - 1, 1)) * 2.0 - 1.0

    if achse == "x":
        profil = (1.0 - bogen) + bogen * (1.0 - np.abs(fx)) ** 1.6
        dx = staerke * w * (profil - 0.62)
        dy = 0.18 * staerke * h * np.sin(np.pi * fy) * np.abs(fx) * bogen
    else:
        profil = (1.0 - bogen) + bogen * (1.0 - np.abs(fy)) ** 1.6
        dy = staerke * h * (profil - 0.62)
        dx = 0.18 * staerke * w * np.sin(np.pi * fx) * np.abs(fy) * bogen

    if spinne:                     # leichte Querwelle (Papier wirft Falten)
        dx = dx + spinne * w * 0.012 * np.sin(2.2 * np.pi * fy + 0.7 * np.pi * fx)
        dy = dy + spinne * h * 0.010 * np.sin(1.7 * np.pi * fx + 0.4)

    return dx, dy


# ===========================================================================
# Szene bauen
# ===========================================================================
def szene(name, ecken, w=1280, h=960, untergrund="tuch", seitenart="text",
          kontrast=1.0, handschrift=False, kippen=0.0, kurve=None,
          blitz=False, schatten="weich", stapel=0, unschaerfe=1.0,
          textur_skala=1.0):
    """Baut eine Szene und gibt Bild + Soll-Ecken + flaches Referenzbild zurueck."""
    seite_w, seite_h = 820, 1160
    doc = seite(seite_w, seite_h, art=seitenart, handschrift=handschrift,
                kontrast=kontrast)

    if untergrund == "tuch":
        bg = tuch(w, h)
    elif untergrund == "tuch_dunkel":
        bg = dunkles_tuch(w, h)
    elif untergrund == "tisch":
        bg = tisch(w, h)
    elif untergrund == "tisch_grau":
        bg = tisch(w, h, helligkeit=205, streifen=6.0)
    else:
        bg = tisch(w, h)

    # --- Stapel: mehrere Blaetter unter dem obersten (gleiche Ausrichtung,
    #     winzige Verschiebung). Die Kanten des Stapels sind deutlich
    #     kontrastreicher als die oberste Seite - genau das verwirrt die
    #     Erkennung ("er nimmt den Stapel statt des Blattes").
    ziel = np.float32(ecken)
    bild = bg.copy()
    if stapel > 0:
        for k in range(stapel, 0, -1):
            ab = ziel + np.float32([[-9 * k, 7 * k], [10 * k, 8 * k],
                                    [9 * k, -8 * k], [-8 * k, -7 * k]])
            M = cv2.getPerspectiveTransform(
                np.float32([[0, 0], [seite_w - 1, 0], [seite_w - 1, seite_h - 1],
                            [0, seite_h - 1]]), ab)
            unter = cv2.warpPerspective(
                np.full((seite_h, seite_w, 3), 241 + 4 * (k % 2), np.uint8),
                M, (w, h), flags=cv2.INTER_AREA,
                borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
            m = cv2.warpPerspective(
                np.full((seite_h, seite_w), 255, np.uint8), M, (w, h),
                flags=cv2.INTER_NEAREST)
            m3 = cv2.GaussianBlur(m, (0, 0), 1.1)[:, :, None].astype(np.float32) / 255.0
            sch = cv2.GaussianBlur(m, (0, 0), 5.0).astype(np.float32)[:, :, None] / 255.0
            bild = bild * (1 - 0.16 * sch) * (1 - m3) + unter.astype(np.float32) * m3

    quelle = np.float32([[0, 0], [seite_w - 1, 0], [seite_w - 1, seite_h - 1],
                         [0, seite_h - 1]])
    M = cv2.getPerspectiveTransform(quelle, ziel)
    warped = cv2.warpPerspective(doc, M, (w, h), flags=cv2.INTER_CUBIC,
                                 borderMode=cv2.BORDER_CONSTANT,
                                 borderValue=(0, 0, 0))
    maske = cv2.warpPerspective(np.full((seite_h, seite_w), 255, np.uint8), M,
                                (w, h), flags=cv2.INTER_NEAREST)

    # --- Biegung: Seite UND Maske verschieben (der Untergrund nur zu einem
    #     Teil - er liegt ja weiter hinten).
    if kurve is not None:
        dx, dy = biegung(w, h, **kurve)
        mx, my = np.meshgrid(np.arange(w, dtype=np.float32),
                             np.arange(h, dtype=np.float32))
        m3 = cv2.GaussianBlur(maske, (0, 0), 3.0).astype(np.float32)[:, :, None] / 255.0
        dxg = dx * m3[:, :, 0] + 0.28 * dx * (1 - m3[:, :, 0])
        dyg = dy * m3[:, :, 0] + 0.28 * dy * (1 - m3[:, :, 0])
        warped = cv2.remap(warped, mx + dxg, my + dyg, cv2.INTER_CUBIC,
                           borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
        maske = cv2.remap(maske, mx + dxg, my + dyg, cv2.INTER_NEAREST,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        # Die Soll-Ecken wandern mit demselben Feld (Verschiebung ist klein,
        # die Remap-Richtung daher vernachlaessigbar).
        zx = np.clip(np.round(ziel[:, 0]).astype(int), 0, w - 1)
        zy = np.clip(np.round(ziel[:, 1]).astype(int), 0, h - 1)
        ziel = ziel + np.stack([dx[zy, zx], dy[zy, zx]], axis=1)

    # --- einsetzen
    m3 = cv2.GaussianBlur(maske, (0, 0), 0.7)[:, :, None].astype(np.float32) / 255.0
    bild = warped.astype(np.float32) * m3 + bild * (1 - m3)

    # --- Papierschatten: am wichtigsten bei weiss auf weiss, denn er ist
    #     das EINZIGE, was die Blattkante dort ueberhaupt sichtbar macht.
    if schatten == "weich":
        sm = cv2.GaussianBlur(maske, (0, 0), 22).astype(np.float32) / 255.0
        sm = np.roll(np.roll(sm, 12, axis=0), 12, axis=1) * (1 - m3[:, :, 0])
        bild *= (1 - 0.22 * sm)[:, :, None]
    elif schatten == "hart":
        # harter Schlagschatten quer ueber alles (Fensterkreuz, Hand, Regal)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        kante = 1.0 / (1.0 + np.exp((xx - w * 0.62) / 6.0))
        bild *= (1 - 0.55 * kante)[:, :, None]

    # --- Licht
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if blitz:
        d2 = ((xx - w * 0.5) ** 2 + (yy - h * 0.42) ** 2) / (w * w + h * h)
        lampe = 1.12 - 0.85 * d2
    else:
        lampe = 1.0 - 0.30 * (((xx - w * 0.28) ** 2 + (yy - h * 0.22) ** 2) /
                              (w * w + h * h))
    bild = bild * np.clip(lampe, 0.5, 1.25)[:, :, None]

    # --- Rauschen und Unschaerfe wie eine Handykamera
    bild = np.clip(bild + rng.normal(0, 2.8, bild.shape), 0, 255)
    if unschaerfe:
        bild = cv2.GaussianBlur(bild.astype(np.float32), (0, 0), unschaerfe)
    if kippen:
        Mk = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), kippen, 1.0)
        bild = cv2.warpAffine(bild, Mk, (w, h), flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_REPLICATE)
        R = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), kippen, 1.0)[:, :2]
        ziel = (ziel - np.float32([w / 2.0, h / 2.0])) @ R.T + np.float32([w / 2.0, h / 2.0])
    bild = np.clip(bild, 0, 255).astype(np.uint8)

    # --- flaches Referenzbild (nur bei gebogenen Seiten sinnvoll)
    flach = None
    if kurve is not None:
        W = int(max(np.linalg.norm(ziel[2] - ziel[3]), np.linalg.norm(ziel[1] - ziel[0])))
        H = int(max(np.linalg.norm(ziel[1] - ziel[2]), np.linalg.norm(ziel[0] - ziel[3])))
        Mf = cv2.getPerspectiveTransform(
            np.float32([ziel[0], ziel[1], ziel[2], ziel[3]]),
            np.float32([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]]))
        flach = cv2.warpPerspective(doc, Mf, (W, H), flags=cv2.INTER_CUBIC)

    return {"name": name, "bild": bild, "ecken": ziel.astype(float),
            "flach": flach}


# ===========================================================================
# Die harten Faelle
# ===========================================================================
def rechteck(cx, cy, bw, bh, neig=0.0, persp=0.0):
    p = np.float32([[-bw / 2, -bh / 2], [bw / 2, -bh / 2],
                    [bw / 2, bh / 2], [-bw / 2, bh / 2]])
    c, s = np.cos(neig), np.sin(neig)
    p = p @ np.float32([[c, -s], [s, c]]).T
    p[:, 0] *= 1 + persp * (p[:, 1] / bh)
    return p + np.float32([cx, cy])


def faelle():
    out = []
    W, H = 1280, 960

    # ---- 1. Der Klassiker: weisses Blatt auf weisser Decke.
    out.append(szene("hart_weiss_tuch", rechteck(640, 470, 610, 800),
                     untergrund="tuch"))

    # ---- 2. Weisses Blatt auf weissem Tisch, praktisch ohne Struktur.
    out.append(szene("hart_weiss_tisch", rechteck(630, 480, 640, 820, neig=0.10),
                     untergrund="tisch", schatten="weich"))

    # ---- 3. Blatt auf einem STAPEL aus drei weiteren Blaettern, weiss auf
    #         weiss, alle Kanten dicht beieinander.
    out.append(szene("hart_stapel", rechteck(645, 470, 600, 790, neig=0.06),
                     untergrund="tuch", stapel=3))

    # ---- 4. Dasselbe schraeg (Perspektive) und mit Blitz.
    out.append(szene("hart_stapel_schraeg",
                     rechteck(640, 480, 620, 800, neig=0.14, persp=0.18),
                     untergrund="tuch", stapel=4, blitz=True))

    # ---- 5. Blatt auf hellgrauem Tisch - wenig Kontrast, aber sichtbar.
    out.append(szene("hart_weiss_grau", rechteck(640, 470, 620, 810),
                     untergrund="tisch_grau"))

    # ---- 6. Gebogene Buchseite (Falz links), dunkler Hintergrund.
    out.append(szene("hart_buch_gebogen",
                     rechteck(660, 480, 600, 830, neig=0.03),
                     untergrund="tuch_dunkel",
                     kurve={"staerke": 0.052, "achse": "x", "bogen": 0.85}))

    # ---- 7. Gebogene Seite auf WEISSEM Untergrund - der Extremfall.
    out.append(szene("hart_buch_weiss",
                     rechteck(640, 470, 610, 820),
                     untergrund="tuch",
                     kurve={"staerke": 0.045, "achse": "x", "bogen": 0.95}))

    # ---- 8. Welliges Blatt (Falten) auf weissem Tisch.
    out.append(szene("hart_wellig_weiss",
                     rechteck(645, 480, 600, 800, neig=0.12),
                     untergrund="tisch",
                     kurve={"staerke": 0.030, "achse": "y", "bogen": 0.6,
                            "spinne": 1.0}))

    # ---- 9. Harter Schatten quer ueber Blatt und Untergrund.
    out.append(szene("hart_schatten", rechteck(640, 470, 620, 810),
                     untergrund="tuch", schatten="hart"))

    # ---- 10. Blitzlicht auf weisser Flaeche: heller Kern, dunkle Ecken.
    out.append(szene("hart_blitz_weiss", rechteck(640, 480, 630, 815, neig=0.08),
                     untergrund="tuch", blitz=True))

    # ---- 11. Blasser Ausdruck auf weissem Tisch (Text kaum dunkler).
    out.append(szene("hart_blass", rechteck(640, 470, 615, 805),
                     untergrund="tisch", kontrast=0.30))

    # ---- 12. Handschrift auf weissem Tuch, leicht schief.
    out.append(szene("hart_handschrift", rechteck(640, 480, 605, 795, neig=0.16),
                     untergrund="tuch", handschrift=True))

    # ---- 13. Kontrollfall: dunkler Untergrund, muss weiter funktionieren.
    out.append(szene("hart_kontrolle_dunkel",
                     rechteck(640, 470, 620, 810, neig=0.10, persp=0.15),
                     untergrund="tuch_dunkel"))

    # ---- 14. Nahaufnahme: Blatt laeuft ueber den Rand hinaus.
    out.append(szene("hart_nah", rechteck(640, 480, 920, 1180),
                     untergrund="tuch", kurve={"staerke": 0.03, "achse": "x",
                                               "bogen": 0.7}))

    # ---- 15. Buchseite mit Biegung + Blitz + Schatten (alles zusammen).
    out.append(szene("hart_buch_schwer", rechteck(650, 475, 590, 820, neig=0.09),
                     untergrund="tuch_dunkel", blitz=True, schatten="hart",
                     kurve={"staerke": 0.058, "achse": "x", "bogen": 0.9,
                            "spinne": 0.6}))
    return out


# ===========================================================================
def live_frames(bild, ecken, name, ziel):
    """Sucherbilder wie im echten Betrieb: 320 px, JPEG, Handzittern."""
    h, w = bild.shape[:2]
    f = LIVE_KANTE / max(w, h)
    lw, lh = int(round(w * f)), int(round(h * f))
    frames = []
    for k in range(LIVE_FRAMES):
        dx, dy = rng.normal(0, 0.9, 2)
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        bewegt = cv2.warpAffine(bild, M, (w, h), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_REPLICATE)
        klein = cv2.resize(bewegt, (lw, lh), interpolation=cv2.INTER_AREA)
        klein = np.clip(klein.astype(np.float32) + rng.normal(0, 2.6, klein.shape),
                        0, 255).astype(np.uint8)
        ok, buf = cv2.imencode(".jpg", klein, [cv2.IMWRITE_JPEG_QUALITY, 72])
        klein = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        datei = "%s_live%d" % (name, k)
        cv2.cvtColor(klein, cv2.COLOR_BGR2RGBA).tofile(os.path.join(ziel, datei + ".rgba"))
        cv2.imwrite(os.path.join(ziel, datei + ".png"), klein)
        frames.append(datei)
    return {"name": name, "breite": lw, "hoehe": lh,
            "ecken": [[p[0] * lw / w, p[1] * lh / h] for p in ecken],
            "frames": frames}


def main():
    ziel = sys.argv[1] if len(sys.argv) > 1 else "/tmp/hart"
    os.makedirs(ziel, exist_ok=True)
    liste = []
    live = []
    for f in faelle():
        bild = f["bild"]
        h, w = bild.shape[:2]
        cv2.imwrite(os.path.join(ziel, f["name"] + ".png"), bild)
        cv2.cvtColor(bild, cv2.COLOR_BGR2RGBA).tofile(
            os.path.join(ziel, f["name"] + ".rgba"))
        eintrag = {"name": f["name"], "breite": w, "hoehe": h,
                   "ecken": [[float(a), float(b)] for a, b in f["ecken"]]}
        if f["flach"] is not None:
            name_flach = f["name"] + "_flach"
            cv2.imwrite(os.path.join(ziel, name_flach + ".png"), f["flach"])
            eintrag["flach"] = name_flach
        liste.append(eintrag)
        live.append(live_frames(bild, f["ecken"], f["name"], ziel))
    with open(os.path.join(ziel, "faelle.json"), "w") as fh:
        json.dump(liste, fh, indent=1)
    with open(os.path.join(ziel, "live.json"), "w") as fh:
        json.dump(live, fh, indent=1)
    print("%d schwierige Szenen + %d Live-Frames -> %s"
          % (len(liste), len(live) * LIVE_FRAMES, ziel))


if __name__ == "__main__":
    main()
